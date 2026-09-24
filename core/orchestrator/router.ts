import type { Domain } from '../contracts/taxonomy.ts';

/**
 * Request router (Phase 5, user decision: explicit keyword rules). Classifies a raw request into
 * one top-level domain BEFORE anything is dispatched. Deterministic; every decision carries the
 * matched terms as evidence. Close calls are reported as `ambiguous`, never guessed.
 *
 * Targets are the four F5 domains. CORE and KNOWLEDGE are infrastructure, not destinations.
 */

export const ROUTABLE_DOMAINS = ['RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH', 'GOVERNANCE'] as const satisfies readonly Domain[];
export type RoutableDomain = (typeof ROUTABLE_DOMAINS)[number];

/**
 * [term, weight]. 3 = the term alone identifies the domain; 2 = strong signal; 1 = weak signal
 * that only counts alongside others. Terms match whole words with an optional plural "s".
 * "rights" is Governance-only on purpose: rights *data* (splits) is Records, rights *checks* are
 * Governance (F3) — so "rights on this track" lands as ambiguous, which is the honest answer.
 */
export const ROUTING_LEXICON: Readonly<Record<RoutableDomain, ReadonlyArray<readonly [string, number]>>> = {
  RESEARCH_INTELLIGENCE: [
    ['research', 3], ['best current method', 3], ['experiment', 3], ['evidence', 3], ['hypothesis', 2],
    ['finding', 2], ['investigate', 2], ['benchmark', 2], ['what works', 2], ['study', 2], ['changelog', 2],
    ['model version', 2], ['contradiction', 2], ['compare', 1],
  ],
  RECORDS: [
    ['song', 3], ['songwriting', 3], ['lyric', 3], ['verse', 3], ['chorus', 3], ['album', 3], ['catalog', 3],
    ['isrc', 3], ['upc', 3], ['rights split', 3], ['x3lius', 3], ['vocal dna', 3], ['hook', 2], ['beat', 2],
    ['track', 2], ['release', 2], ['split', 2], ['vocal', 2], ['arrangement', 2], ['production', 2], ['mix', 2],
    ['master', 2], ['mastering', 2], ['suno', 1],
  ],
  TECH: [
    ['plugin', 3], ['vst', 3], ['vst3', 3], ['trace', 3], ['backlog', 3], ['r&d', 3], ['audio tool', 3],
    ['feature', 2], ['prototype', 2], ['api', 2], ['sdk', 2], ['codebase', 2], ['product', 2], ['meter', 2],
  ],
  GOVERNANCE: [
    ['license', 3], ['licensing', 3], ['copyright', 3], ['legal', 3], ['rights', 3], ['permission', 3],
    ['approval', 3], ['compliance', 3], ['compliant', 3], ['audit', 3], ['provenance', 3], ['rbac', 3],
    ['clearance', 3], ['contract', 2], ['approve', 2], ['authorized', 2], ['cleared', 2],
  ],
};

/** Top two domains closer than this (in weight points) → ambiguous. */
export const AMBIGUITY_MARGIN = 2;

type Scores = Readonly<Record<RoutableDomain, number>>;
type Evidence = Readonly<Record<RoutableDomain, readonly string[]>>;

export type RouteDecision =
  | { readonly status: 'routed'; readonly domain: RoutableDomain; readonly margin: number; readonly scores: Scores; readonly evidence: Evidence }
  | { readonly status: 'ambiguous'; readonly candidates: readonly RoutableDomain[]; readonly margin: number; readonly scores: Scores; readonly evidence: Evidence }
  | { readonly status: 'unroutable'; readonly scores: Scores; readonly evidence: Evidence };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matcher = (term: string) => new RegExp(`(?<![\\w])${escape(term)}s?(?![\\w])`, 'i');

/**
 * Classifies a request.
 * @param request - raw user request text
 * @returns routed (one domain), ambiguous (candidates within the margin), or unroutable
 */
export const routeRequest = (request: string): RouteDecision => {
  const scores = {} as Record<RoutableDomain, number>;
  const evidence = {} as Record<RoutableDomain, string[]>;
  for (const d of ROUTABLE_DOMAINS) {
    const hits = ROUTING_LEXICON[d].filter(([term]) => matcher(term).test(request));
    scores[d] = hits.reduce((a, [, w]) => a + w, 0);
    evidence[d] = hits.map(([term]) => term);
  }
  const ranked = [...ROUTABLE_DOMAINS].sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  if (scores[top] === 0) return { status: 'unroutable', scores, evidence };
  const margin = scores[top] - scores[ranked[1]!];
  if (margin < AMBIGUITY_MARGIN) {
    const candidates = ranked.filter((d) => scores[d] > 0 && scores[top] - scores[d] < AMBIGUITY_MARGIN);
    return { status: 'ambiguous', candidates, margin, scores, evidence };
  }
  return { status: 'routed', domain: top, margin, scores, evidence };
};
