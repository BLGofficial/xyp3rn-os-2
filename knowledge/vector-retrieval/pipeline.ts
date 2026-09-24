import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { sha256Hex } from '../source-registry/acquire.ts';
import { composePromptInput, composeSourceInput } from './compose.ts';
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
 * Embeds every canonical prompt and source whose composed input changed since its last
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
    const sources = await tx<{ id: string; title: string; metadata: Record<string, unknown>; embedding_input_sha256: string | null }[]>`
      select id, title, metadata, embedding_input_sha256 from sources order by id`;

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
