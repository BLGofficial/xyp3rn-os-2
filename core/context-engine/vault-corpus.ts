import type postgres from 'postgres';
import { artifactText } from '../../knowledge/vector-retrieval/compose.ts';
import { toVectorLiteral, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';

/**
 * The vault corpus (AOS-01, A3): the owner's search over their own material (lyric and other
 * artifact versions, Vault files, research findings) next to canonical knowledge. Read-only, as
 * the caller's xyp_runtime transaction. Never an agent's grounding: agents use the knowledge corpus.
 */

export type VaultItemKind = 'canonical' | 'source' | 'file' | 'artifact' | 'research_finding';

export type VaultItem = {
  readonly kind: VaultItemKind;
  /** The row: canonical_prompts, sources, creative_artifacts (the version) or research_findings. */
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly similarity: number;
  /** For an artifact: its lineage (root id), this version and its schema. */
  readonly lineage: { readonly id: string; readonly version: number; readonly schemaId: string } | null;
  /** For a Vault file. */
  readonly mediaClass: string | null;
  /** Songs with a live link to the item (the artifact's lineage, or the file). */
  readonly songs: readonly { readonly id: string; readonly title: string }[];
};

export type VaultBundle = {
  readonly query: string;
  readonly corpus: 'vault';
  readonly model: string;
  readonly items: readonly VaultItem[];
  readonly diagnostics: { readonly knowledgeHits: number; readonly vaultHits: number };
};

export const DEFAULT_VAULT_LIMIT = 10;
const SNIPPET_CHARS = 280;
const snippet = (t: string) => (t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t);
const UNLINKED: VaultItem['songs'] = [];

/**
 * Ranks knowledge (xyp_match_knowledge) and vault (xyp_match_vault) hits together by similarity.
 * One item per artifact lineage (its best-matching version) and per source (a promoted knowledge
 * source can hit in both indexes).
 * @param tx - an xyp_runtime transaction (read only)
 * @param embedder - the model the vault index was built with
 * @param query - the owner's search text
 * @param limit - items returned
 * @returns the ranked, hydrated items
 */
export const searchVault = async (tx: postgres.TransactionSql, embedder: Embedder, query: string, limit: number): Promise<VaultBundle> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('vault search: limit must be an integer from 1 to 100');
  const [q] = await embedder.embed([query]);
  const vec = toVectorLiteral(q!.vector);
  const knowledge = await tx<{ entity_table: 'canonical_prompts' | 'sources'; entity_id: string; similarity: number }[]>`
    select entity_table, entity_id, similarity from xyp_match_knowledge(${vec}::extensions.vector, ${limit})`;
  // Over-fetch: several versions of one lineage collapse to one item.
  const vault = await tx<{ entity_kind: 'artifact' | 'source' | 'research_finding'; entity_id: string; similarity: number }[]>`
    select entity_kind, entity_id, similarity from xyp_match_vault(${vec}::extensions.vector, ${limit * 4}, ${embedder.model})`;
  const known = (table: string) => knowledge.filter((r) => r.entity_table === table).map((r) => r.entity_id);
  const inVault = (kind: string) => vault.filter((r) => r.entity_kind === kind).map((r) => r.entity_id);
  const promptIds = known('canonical_prompts');
  const sourceIds = [...new Set([...known('sources'), ...inVault('source')])];
  const artifactIds = inVault('artifact');
  const findingIds = inVault('research_finding');

  const prompts = new Map((await tx<{ id: string; title: string; body: string }[]>`
    select id, title, body from canonical_prompts where id = any(${promptIds}::uuid[])`).map((r) => [r.id, r]));
  const sources = new Map((await tx<{ id: string; title: string; media_class: string | null; text: string | null }[]>`
    select s.id, s.title, s.media_class, t.text from sources s left join source_texts t on t.source_id = s.id where s.id = any(${sourceIds}::uuid[])`)
    .map((r) => [r.id, r]));
  const artifacts = new Map((await tx<{ id: string; lineage_id: string; version: number; schema_id: string; brief: string; body: unknown }[]>`
    select id, lineage_id, version, schema_id, brief, body from creative_artifacts where id = any(${artifactIds}::uuid[])`).map((r) => [r.id, r]));
  const findings = new Map((await tx<{ id: string; claim: string }[]>`
    select id, claim from research_findings where id = any(${findingIds}::uuid[])`).map((r) => [r.id, r]));
  const lineageIds = [...new Set([...artifacts.values()].map((a) => a.lineage_id))];
  const songsOf = new Map<string, { id: string; title: string }[]>();
  for (const l of await tx<{ target_id: string; song_id: string; title: string }[]>`
    select l.target_id, s.id as song_id, s.title from current_song_links l join current_songs s on s.id = l.song_id
    where l.target_id = any(${[...lineageIds, ...sourceIds]}::uuid[]) order by s.title, s.id`) {
    songsOf.set(l.target_id, [...(songsOf.get(l.target_id) ?? []), { id: l.song_id, title: l.title }]);
  }

  const base = { lineage: null, mediaClass: null, songs: UNLINKED } as const;
  const hydrate = (kind: string, id: string, similarity: number): VaultItem => {
    if (kind === 'canonical_prompts') {
      const p = prompts.get(id)!;
      return { ...base, kind: 'canonical', id, title: p.title, snippet: snippet(p.body), similarity };
    }
    if (kind === 'sources' || kind === 'source') {
      const s = sources.get(id)!;
      return {
        ...base, kind: s.media_class === null ? 'source' : 'file', id, title: s.title, snippet: snippet(s.text ?? s.title), similarity,
        mediaClass: s.media_class, songs: songsOf.get(id) ?? UNLINKED,
      };
    }
    if (kind === 'artifact') {
      const a = artifacts.get(id)!;
      return {
        ...base, kind: 'artifact', id, title: a.brief, snippet: snippet(artifactText(a.body)), similarity,
        lineage: { id: a.lineage_id, version: a.version, schemaId: a.schema_id }, songs: songsOf.get(a.lineage_id) ?? UNLINKED,
      };
    }
    const f = findings.get(id)!;
    return { ...base, kind: 'research_finding', id, title: f.claim, snippet: snippet(f.claim), similarity };
  };

  const hits = [
    ...knowledge.map((h) => hydrate(h.entity_table, h.entity_id, Number(h.similarity))),
    ...vault.map((h) => hydrate(h.entity_kind, h.entity_id, Number(h.similarity))),
  ].sort((a, b) => b.similarity - a.similarity || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const items = hits.filter((h) => {
    const key = h.lineage ? `lineage:${h.lineage.id}` : `${h.kind === 'file' || h.kind === 'source' ? 'source' : h.kind}:${h.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
  return { query, corpus: 'vault', model: embedder.model, items, diagnostics: { knowledgeHits: knowledge.length, vaultHits: vault.length } };
};
