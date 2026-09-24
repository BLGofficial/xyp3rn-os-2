import { routeRequest, type RouteDecision, type RoutableDomain } from './router.ts';

/**
 * Top-level entry the whole OS sits behind (Phase 5): classify first, dispatch second.
 * Pure planning — the caller runs the returned workflow through the Workflow Engine. Ambiguous
 * and unroutable requests are sent back for clarification; there is no default domain.
 */

/** Phase that registers each domain's entrypoint workflow. Until then, requests are held. */
export const ENTRYPOINT_PHASE: Readonly<Record<RoutableDomain, string>> = {
  RESEARCH_INTELLIGENCE: '6A',
  RECORDS: '7',
  TECH: '14',
  GOVERNANCE: '15',
};

/** A domain entrypoint: a workflow spec path, or a named runtime service (e.g. research). */
export type Entrypoint = string | { readonly service: string };
export type Entrypoints = Readonly<Partial<Record<RoutableDomain, Entrypoint>>>;

export type RequestPlan =
  | { readonly action: 'run-workflow'; readonly workflow: string; readonly input: { readonly request: string }; readonly route: RouteDecision }
  | { readonly action: 'run-service'; readonly service: string; readonly input: { readonly request: string }; readonly route: RouteDecision }
  | { readonly action: 'hold'; readonly reason: string; readonly route: RouteDecision }
  | { readonly action: 'clarify'; readonly reason: string; readonly route: RouteDecision };

/**
 * Plans what to do with a raw request.
 * @param request - user text
 * @param entrypoints - domain → entrypoint workflow path, as registered so far
 * @returns run-workflow / run-service (routed + registered), hold (routed, not built yet), or clarify
 */
export const planRequest = (request: string, entrypoints: Entrypoints): RequestPlan => {
  const route = routeRequest(request);
  if (route.status === 'ambiguous') {
    return { action: 'clarify', route, reason: `ambiguous between ${[...route.candidates].sort().join(' and ')} (margin ${route.margin}); say which` };
  }
  if (route.status === 'unroutable') return { action: 'clarify', route, reason: 'no domain matched; rephrase with domain terms' };
  const entry = entrypoints[route.domain];
  if (!entry) {
    return { action: 'hold', route, reason: `no entrypoint registered for ${route.domain} yet (built in Phase ${ENTRYPOINT_PHASE[route.domain]})` };
  }
  return typeof entry === 'string'
    ? { action: 'run-workflow', workflow: entry, input: { request }, route }
    : { action: 'run-service', service: entry.service, input: { request }, route };
};

/** Entrypoints registered so far. Phases 7, 14 and 15 add theirs here. */
export const ENTRYPOINTS: Entrypoints = {
  RESEARCH_INTELLIGENCE: { service: 'run-research' }, // Phase 6A: research-intelligence/entrypoint.ts
  RECORDS: { service: 'x3lius-music-system' }, // Phase 7: records/x3lius/entrypoint.ts
};
