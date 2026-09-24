import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { Domain } from '../contracts/taxonomy.ts';
import { quoteIdent, type Sql } from '../db/client.ts';
import { toVectorLiteral, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { createLruCache } from './lru-cache.ts';
import { rankContext, type ContextTable, type Edge, type EntityRef, type RankLimits, type Reason } from './rank.ts';

/** The runtime's read-only DB role (Phase 3 migration). Retrieval can't write anything. */
export const CONTEXT_ROLE = 'xyp_runtime';
/** Default quotas: 8 vector hits + up to 4 graph-only neighbours (see RankLimits for why). */
export const DEFAULT_LIMITS: RankLimits = { direct: 8, expanded: 4 };
/** Cache eviction: LRU at 256 entries, 15-minute TTL, and a knowledge-generation key (below). */
export const CACHE_MAX_ENTRIES = 256;
export const CACHE_TTL_MS = 15 * 60_000;
const SNIPPET_CHARS = 280;

export type ContextItem = {
  readonly ref: EntityRef;
  readonly slug: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly domain: Domain | null;
  readonly score: number;
  readonly reasons: readonly Reason[];
  /** Human-readable form of `reasons`. */
  readonly why: string;
  /** The ingested source this row traces back to (null only for rows with no source_id). */
  readonly source: { readonly id: string; readonly uri: string } | null;
};

export type ContextBundle = {
  readonly query: string;
  readonly model: string;
  readonly generation: string;
  readonly cache: 'hit' | 'miss';
  readonly items: readonly ContextItem[];
  readonly diagnostics: {
    readonly vectorHits: number;
    readonly edgesConsidered: number;
    readonly skippedPredicates: readonly string[];
    readonly skippedEntityTypes: readonly string[];
  };
};

export type ContextEngine = {
  readonly retrieve: (query: string, options?: { readonly limits?: RankLimits }) => Promise<ContextBundle>;
};

const RELATION_TABLES: Readonly<Record<string, ContextTable>> = {
  source: 'sources',
  module: 'modules',
  canonical_prompt: 'canonical_prompts',
};

const asRuntime = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(CONTEXT_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * Changes whenever canonical knowledge, sources or relations change (row count or newest
 * write), so a cached bundle can never outlive the knowledge it was built from.
 */
const generationOf = async (tx: postgres.TransactionSql): Promise<string> => {
  const [g] = await tx<{ g: string }[]>`
    select concat_ws('|',
      (select count(*) || '@' || coalesce(max(updated_at)::text, '-') from canonical_prompts),
      (select count(*) || '@' || coalesce(max(updated_at)::text, '-') from modules),
      (select count(*) || '@' || coalesce(max(updated_at)::text, '-') from sources),
      (select count(*) || '@' || coalesce(max(created_at)::text, '-') from relations)) as g`;
  return g!.g;
};

const describe = (r: Reason, slugOf: (ref: EntityRef) => string): string =>
  r.kind === 'vector'
    ? `vector similarity ${r.similarity.toFixed(4)}`
    : `${r.predicate} (${r.direction}) from ${slugOf(r.parent)}: ${r.parentScore.toFixed(4)} x ${r.weight} via ${r.via}`;

/**
 * Creates the Context Engine: query → ranked, fully traceable context bundle.
 * @param sql - pool allowed to SET ROLE xyp_runtime
 * @param embedder - the same model the stored vectors were made with
 * @returns retrieve(query, { limits })
 */
export const createContextEngine = (sql: Sql, embedder: Embedder): ContextEngine => {
  const cache = createLruCache<Omit<ContextBundle, 'cache'>>({ maxEntries: CACHE_MAX_ENTRIES, ttlMs: CACHE_TTL_MS });

  const retrieve: ContextEngine['retrieve'] = async (query, options = {}) => {
    const limits = options.limits ?? DEFAULT_LIMITS;
    const generation = await asRuntime(sql, generationOf);
    const key = createHash('sha256').update(JSON.stringify({ query, limits, generation, model: embedder.model })).digest('hex');
    const cached = cache.get(key);
    if (cached) return { ...cached, cache: 'hit' };

    const [queryVec] = await embedder.embed([query]);
    const bundle = await asRuntime(sql, async (tx) => {
      const hits = await tx<{ entity_table: ContextTable; entity_id: string; similarity: number }[]>`
        select entity_table, entity_id, similarity
        from xyp_match_knowledge(${toVectorLiteral(queryVec!.vector)}::extensions.vector, ${limits.direct})`;
      const hitRefs = hits.map((h) => ({ ref: { table: h.entity_table, id: h.entity_id }, similarity: Number(h.similarity) }));

      // 1-hop: every relations edge touching a hit (either end), plus each prompt hit's module FK.
      const relKeys = hitRefs.map((h) => `${Object.keys(RELATION_TABLES).find((k) => RELATION_TABLES[k] === h.ref.table)}:${h.ref.id}`);
      const rels = relKeys.length
        ? await tx<{ id: string; subject_type: string; subject_id: string; predicate: string; object_type: string; object_id: string }[]>`
            select id, subject_type::text, subject_id, predicate, object_type::text, object_id from relations
            where subject_type::text || ':' || subject_id = any(${relKeys})
               or object_type::text || ':' || object_id = any(${relKeys})`
        : [];
      const skippedEntityTypes = new Set<string>();
      const edges: Edge[] = [];
      for (const r of rels) {
        const from = RELATION_TABLES[r.subject_type];
        const to = RELATION_TABLES[r.object_type];
        if (!from || !to) {
          skippedEntityTypes.add(!from ? r.subject_type : r.object_type);
          continue;
        }
        edges.push({ from: { table: from, id: r.subject_id }, predicate: r.predicate, to: { table: to, id: r.object_id }, via: `relations:${r.id}` });
      }
      const promptHitIds = hitRefs.filter((h) => h.ref.table === 'canonical_prompts').map((h) => h.ref.id);
      if (promptHitIds.length) {
        const fk = await tx<{ id: string; module_id: string }[]>`
          select id, module_id from canonical_prompts where id = any(${promptHitIds}::uuid[])`;
        for (const r of fk) {
          edges.push({
            from: { table: 'canonical_prompts', id: r.id },
            predicate: 'module_of',
            to: { table: 'modules', id: r.module_id },
            via: 'fk:canonical_prompts.module_id',
          });
        }
      }

      const ranked = rankContext(hitRefs, edges, limits);

      // Hydrate every ranked ref from its own table — an unresolvable ref is a bug, not a gap.
      const ids = (t: ContextTable) => ranked.items.filter((i) => i.ref.table === t).map((i) => i.ref.id);
      const rows = new Map<string, { slug: string | null; title: string; text: string; domain: Domain | null; source_id: string | null; source_uri: string | null }>();
      for (const r of await tx<{ id: string; slug: string; title: string; body: string; domain: Domain; source_id: string | null; uri: string | null }[]>`
        select cp.id, cp.slug, cp.title, cp.body, m.domain, cp.source_id, s.uri
        from canonical_prompts cp join modules m on m.id = cp.module_id left join sources s on s.id = cp.source_id
        where cp.id = any(${ids('canonical_prompts')}::uuid[])`) {
        rows.set(`canonical_prompts:${r.id}`, { slug: r.slug, title: r.title, text: r.body, domain: r.domain, source_id: r.source_id, source_uri: r.uri });
      }
      for (const r of await tx<{ id: string; slug: string; title: string; description: string | null; domain: Domain; source_id: string | null; uri: string | null }[]>`
        select m.id, m.slug, m.title, m.description, m.domain, m.source_id, s.uri
        from modules m left join sources s on s.id = m.source_id
        where m.id = any(${ids('modules')}::uuid[])`) {
        rows.set(`modules:${r.id}`, { slug: r.slug, title: r.title, text: r.description ?? '', domain: r.domain, source_id: r.source_id, source_uri: r.uri });
      }
      for (const r of await tx<{ id: string; title: string; uri: string }[]>`
        select id, title, uri from sources where id = any(${ids('sources')}::uuid[])`) {
        rows.set(`sources:${r.id}`, { slug: null, title: r.title, text: r.title, domain: null, source_id: r.id, source_uri: r.uri });
      }

      const slugOf = (ref: EntityRef) => {
        const row = rows.get(`${ref.table}:${ref.id}`);
        return row?.slug ?? `${ref.table}:${ref.id}`;
      };
      const items: ContextItem[] = ranked.items.map((it) => {
        const row = rows.get(`${it.ref.table}:${it.ref.id}`);
        if (!row) throw new Error(`context item ${it.ref.table}:${it.ref.id} does not resolve to a row`);
        return {
          ref: it.ref,
          slug: row.slug,
          title: row.title,
          snippet: row.text.length > SNIPPET_CHARS ? `${row.text.slice(0, SNIPPET_CHARS)}…` : row.text,
          domain: row.domain,
          score: it.score,
          reasons: it.reasons,
          why: it.reasons.map((r) => describe(r, slugOf)).join('; '),
          source: row.source_id && row.source_uri ? { id: row.source_id, uri: row.source_uri } : null,
        };
      });

      return {
        query,
        model: embedder.model,
        generation,
        items,
        diagnostics: {
          vectorHits: hits.length,
          edgesConsidered: edges.length,
          skippedPredicates: ranked.skippedPredicates,
          skippedEntityTypes: [...skippedEntityTypes].sort(),
        },
      };
    });

    cache.set(key, bundle);
    return { ...bundle, cache: 'miss' };
  };

  return { retrieve };
};
