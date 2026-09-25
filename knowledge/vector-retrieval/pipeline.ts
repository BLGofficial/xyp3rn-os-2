import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { sha256Hex } from '../source-registry/acquire.ts';
import { composeArtifactInput, composePromptInput, composeSourceInput, composeVaultFileInput, type VaultInput } from './compose.ts';
import { toVectorLiteral, type Embedder } from './embedder.ts';

/** DB role for embedding writes: embedding columns only, never content (Phase 3 migration). */
export const EMBEDDER_ROLE = 'xyp_embedder';

export type EmbedStats = {
  readonly model: string;
  readonly canonical_prompts: { embedded: number; skipped: number; truncated: number };
  readonly sources: { embedded: number; skipped: number; truncated: number };
};

/** Model id is part of the hash: switching models re-embeds everything rather than mixing spaces. */
const inputHash = (model: string, input: string): string => sha256Hex(new TextEncoder().encode(`${model}\n${input}`));

const asEmbedder = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(EMBEDDER_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * Embeds every canonical prompt and knowledge source whose composed input changed since its last
 * embedding (or that has none). Idempotent: unchanged input hash → skipped, zero writes.
 * @param sql - pool allowed to SET ROLE xyp_embedder
 * @param embedder - loaded embedding model
 * @returns per-table embedded/skipped/truncated counts
 */
export const embedPending = async (sql: Sql, embedder: Embedder): Promise<EmbedStats> =>
  asEmbedder(sql, async (tx) => {
    const stats = {
      model: embedder.model,
      canonical_prompts: { embedded: 0, skipped: 0, truncated: 0 },
      sources: { embedded: 0, skipped: 0, truncated: 0 },
    };

    const prompts = await tx<{ id: string; title: string; body: string; structured: Record<string, unknown> | null; embedding_input_sha256: string | null }[]>`
      select id, title, body, structured, embedding_input_sha256 from canonical_prompts order by id`;
    const moduleTitles = await tx<{ source_id: string; titles: string[] }[]>`
      select source_id, array_agg(title order by slug, version) as titles from modules
      where source_id is not null group by source_id`;
    const titlesBySource = new Map(moduleTitles.map((r) => [r.source_id, r.titles]));
    // Knowledge sources only (AOS-01): a Vault-only file is the owner's material, indexed in
    // vault_embeddings by embedVault, never in the knowledge corpus agents ground on.
    const sources = await tx<{ id: string; title: string; metadata: Record<string, unknown>; embedding_input_sha256: string | null }[]>`
      select id, title, metadata, embedding_input_sha256 from knowledge_sources order by id`;

    const work = [
      ...prompts.map((r) => ({ table: 'canonical_prompts' as const, id: r.id, prev: r.embedding_input_sha256, input: composePromptInput(r) })),
      ...sources.map((r) => ({ table: 'sources' as const, id: r.id, prev: r.embedding_input_sha256, input: composeSourceInput(r, titlesBySource.get(r.id) ?? []) })),
    ].map((w) => ({ ...w, hash: inputHash(embedder.model, w.input) }));

    const pending = work.filter((w) => w.prev !== w.hash);
    for (const w of work) if (w.prev === w.hash) stats[w.table].skipped++;

    const vectors = await embedder.embed(pending.map((w) => w.input));
    for (const [i, w] of pending.entries()) {
      const e = vectors[i]!;
      await tx.unsafe(
        `update public.${w.table}
         set embedding = $1::extensions.vector, embedding_model = $2, embedding_input_sha256 = $3,
             embedding_truncated = $4, embedded_at = now()
         where id = $5`,
        [toVectorLiteral(e.vector), embedder.model, w.hash, e.truncated, w.id],
      );
      stats[w.table].embedded++;
      if (e.truncated) stats[w.table].truncated++;
    }
    return stats;
  });

type VaultKind = 'artifact' | 'source' | 'research_finding';
type Counts = { embedded: number; skipped: number; truncated: number };
export type VaultEmbedStats = { readonly model: string } & Readonly<Record<VaultKind, Counts>>;

/**
 * Fills the vault corpus index (AOS-01, A3): every creative artifact version (brief + text), every
 * Vault file (title, tags, then up to 4k characters of its text) and every research finding (its
 * claim), one vault_embeddings row per entity and model. Idempotent the same way as embedPending:
 * an unchanged input hash is skipped with zero writes. Knowledge rows are never touched.
 * @param sql - pool allowed to SET ROLE xyp_embedder
 * @param embedder - loaded embedding model
 * @returns per-kind embedded/skipped/truncated counts
 */
export const embedVault = async (sql: Sql, embedder: Embedder): Promise<VaultEmbedStats> =>
  asEmbedder(sql, async (tx) => {
    const stats = {
      model: embedder.model,
      artifact: { embedded: 0, skipped: 0, truncated: 0 },
      source: { embedded: 0, skipped: 0, truncated: 0 },
      research_finding: { embedded: 0, skipped: 0, truncated: 0 },
    };
    const artifacts = await tx<{ id: string; brief: string; body: unknown }[]>`select id, brief, body from creative_artifacts order by id`;
    const files = await tx<{ id: string; title: string; text: string | null; tags: string[] }[]>`
      select s.id, s.title, t.text,
             array(select g.label from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id order by g.label) as tags
      from sources s left join source_texts t on t.source_id = s.id
      where s.storage is not null order by s.id`;
    const findings = await tx<{ id: string; claim: string }[]>`select id, claim from research_findings order by id`;
    const prev = new Map((await tx<{ entity_kind: VaultKind; entity_id: string; input_sha256: string }[]>`
      select entity_kind, entity_id, input_sha256 from vault_embeddings where model = ${embedder.model}`)
      .map((r) => [`${r.entity_kind}:${r.entity_id}`, r.input_sha256]));

    const work = [
      ...artifacts.map((r) => ({ kind: 'artifact' as const, id: r.id, ...composeArtifactInput(r) })),
      ...files.map((r) => ({ kind: 'source' as const, id: r.id, ...composeVaultFileInput(r) })),
      ...findings.map((r) => ({ kind: 'research_finding' as const, id: r.id, input: r.claim, cut: false } satisfies VaultInput & { kind: VaultKind; id: string })),
    ].map((w) => ({ ...w, hash: inputHash(embedder.model, w.input) }));
    const pending = work.filter((w) => prev.get(`${w.kind}:${w.id}`) !== w.hash);
    for (const w of work) if (!pending.includes(w)) stats[w.kind].skipped++;

    const vectors = await embedder.embed(pending.map((w) => w.input));
    for (const [i, w] of pending.entries()) {
      const e = vectors[i]!;
      const truncated = w.cut || e.truncated;
      await tx`
        insert into vault_embeddings (entity_kind, entity_id, embedding, model, input_sha256, truncated)
        values (${w.kind}, ${w.id}, ${toVectorLiteral(e.vector)}::extensions.vector, ${embedder.model}, ${w.hash}, ${truncated})
        on conflict (entity_kind, entity_id, model) do update
          set embedding = excluded.embedding, input_sha256 = excluded.input_sha256, truncated = excluded.truncated, updated_at = now()`;
      stats[w.kind].embedded++;
      if (truncated) stats[w.kind].truncated++;
    }
    return stats;
  });
