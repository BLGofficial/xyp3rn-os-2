/**
 * Context ranking formula (no black box):
 *   direct hit      score = cosine similarity
 *   1-hop neighbour score = parent score x PREDICATE_WEIGHTS[predicate][direction]
 * An entity reached several ways keeps its max score and every reason.
 */

export type ContextTable = 'canonical_prompts' | 'modules' | 'sources';
export type EntityRef = { readonly table: ContextTable; readonly id: string };

/** A directed edge; `via` names the row or FK it came from so every hop is traceable. */
export type Edge = { readonly from: EntityRef; readonly predicate: string; readonly to: EntityRef; readonly via: string };

export type Reason =
  | { readonly kind: 'vector'; readonly similarity: number }
  | {
      readonly kind: 'graph';
      readonly predicate: string;
      readonly direction: 'out' | 'in';
      readonly parent: EntityRef;
      readonly parentScore: number;
      readonly weight: number;
      readonly via: string;
    };

export type Ranked = { readonly ref: EntityRef; readonly score: number; readonly reasons: readonly Reason[] };

/**
 * How much of a hit's relevance flows to a neighbour, per edge type and direction.
 * - depends_on out 0.8: the hit's prerequisite is strongly relevant; in 0.6: things built on it.
 * - precedes 0.7 both ways: adjacent steps of the same sequence.
 * - module_of out 0.6: the phase/module a prompt belongs to (FK canonical_prompts.module_id).
 * - derived_from out 0.5: provenance. In 0: a source fans out to every entry derived from it,
 *   which says nothing about their relevance to the query — never expanded.
 * Unknown predicates are skipped and reported, never given an implicit weight.
 */
type Weights = { readonly out: number; readonly in: number };

export const PREDICATE_WEIGHTS = {
  depends_on: { out: 0.8, in: 0.6 },
  precedes: { out: 0.7, in: 0.7 },
  module_of: { out: 0.6, in: 0 },
  derived_from: { out: 0.5, in: 0 },
} as const satisfies Readonly<Record<string, Weights>>;

const weightsFor = (predicate: string): Weights | undefined =>
  (PREDICATE_WEIGHTS as Readonly<Record<string, Weights>>)[predicate];

const keyOf = (r: EntityRef) => `${r.table}:${r.id}`;
const same = (a: EntityRef, b: EntityRef) => a.table === b.table && a.id === b.id;

/**
 * Result quotas. Separate on purpose: measured gte-small similarities cluster in ~0.85-0.92, so
 * any neighbour (parent x weight <= 0.8) scores below every direct hit and a single top-N cut
 * would never include the graph half. Scores keep their meaning; inclusion is by quota.
 */
export type RankLimits = { readonly direct: number; readonly expanded: number };

const byScore = (a: Ranked, b: Ranked) =>
  b.score - a.score || a.ref.table.localeCompare(b.ref.table) || a.ref.id.localeCompare(b.ref.id);

/**
 * Ranks direct vector hits plus their 1-hop graph neighbours.
 * @param hits - vector matches with cosine similarity
 * @param edges - every edge touching any hit, either direction
 * @param limits - top `direct` vector-matched entities + top `expanded` graph-only entities
 * @returns items sorted by score desc (ties: table, id) and the predicates that were skipped
 */
export const rankContext = (
  hits: ReadonlyArray<{ readonly ref: EntityRef; readonly similarity: number }>,
  edges: readonly Edge[],
  limits: RankLimits,
): { items: Ranked[]; skippedPredicates: string[] } => {
  const acc = new Map<string, { ref: EntityRef; score: number; reasons: Reason[] }>();
  const add = (ref: EntityRef, score: number, reason: Reason) => {
    const cur = acc.get(keyOf(ref));
    if (cur) {
      cur.score = Math.max(cur.score, score);
      cur.reasons.push(reason);
    } else {
      acc.set(keyOf(ref), { ref, score, reasons: [reason] });
    }
  };
  const skipped = new Set<string>();

  for (const h of hits) add(h.ref, h.similarity, { kind: 'vector', similarity: h.similarity });
  for (const h of hits) {
    for (const e of edges) {
      const direction = same(e.from, h.ref) ? 'out' : same(e.to, h.ref) ? 'in' : undefined;
      if (!direction) continue;
      const weights = weightsFor(e.predicate);
      if (!weights) {
        skipped.add(e.predicate);
        continue;
      }
      const weight = weights[direction];
      if (weight === 0) continue;
      add(direction === 'out' ? e.to : e.from, h.similarity * weight, {
        kind: 'graph',
        predicate: e.predicate,
        direction,
        parent: h.ref,
        parentScore: h.similarity,
        weight,
        via: e.via,
      });
    }
  }

  const all = [...acc.values()];
  const isDirect = (r: Ranked) => r.reasons.some((x) => x.kind === 'vector');
  const items = [
    ...all.filter(isDirect).sort(byScore).slice(0, limits.direct),
    ...all.filter((r) => !isDirect(r)).sort(byScore).slice(0, limits.expanded),
  ].sort(byScore);
  return { items, skippedPredicates: [...skipped].sort() };
};
