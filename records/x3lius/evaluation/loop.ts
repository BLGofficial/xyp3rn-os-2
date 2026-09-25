import type postgres from 'postgres';
import { quoteIdent } from '../../../core/db/client.ts';
import { LLM_TIMEOUT_MS } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { CRITIC_AGENT, type CriticOutput } from './critic.ts';
import { REVISION_AGENT, type RevisionOutput } from './revision.ts';

/**
 * The Phase 12 loop controller: Critic → Revision → Critic … on one artifact lineage, dispatched
 * through the Orchestrator (every run authorized and logged). A service, not an agent: it owns no
 * capability; its role may only queue an escalation (spec §7).
 */

/**
 * At most 3 revisions (so at most 4 Critic passes). Why 3: each round is two model calls, and a
 * call took minutes on the free route in the Phase 9 live runs, so 3 rounds + the final pass is at
 * most 7 calls; three targeted edit rounds that fail to clear the violations are unlikely to be
 * cleared by a fourth, and the stall rule ends a stuck loop sooner. User decision (ARCHITECTURE);
 * changing it is a new flagged decision, never a silent edit.
 */
export const MAX_REVISIONS = 3;
/** The loop's DB role (migration 20260925100000): EXECUTE on xyp_escalate_critique, nothing else. */
export const LOOP_ROLE = 'xyp_evaluation_loop';

export type Pass = { readonly critiqueId: string; readonly artifactId: string; readonly schemaId: string; readonly checked: number; readonly violations: number };
export type Decision =
  | { readonly kind: 'stop'; readonly outcome: 'converged' | 'no_rules' }
  | { readonly kind: 'escalate'; readonly reason: 'studio_work' | 'iteration_cap' | 'stall' }
  | { readonly kind: 'revise' };
export type Outcome = 'converged' | 'no_rules' | 'studio_work' | 'iteration_cap' | 'stall' | 'revision_failed' | 'error';
export type LoopResult = {
  readonly outcome: Outcome;
  readonly revisions: number;
  readonly critiqueIds: readonly string[];
  readonly artifactIds: readonly string[];
  /** Violations per Critic pass, in order. */
  readonly counts: readonly number[];
  readonly escalationId?: string;
  readonly error?: string;
};

/**
 * What to do after a Critic pass: the first matching row of spec §7 wins.
 * @param passes - every pass so far, in order (pass n+1 reviewed the version revision n wrote)
 * @param maxRevisions - the cap (default MAX_REVISIONS)
 * @returns stop, escalate with a reason, or revise
 */
export const decide = (passes: readonly Pass[], maxRevisions = MAX_REVISIONS): Decision => {
  const last = passes.at(-1)!;
  const revisions = passes.length - 1;
  if (last.checked === 0) return { kind: 'stop', outcome: 'no_rules' };
  if (last.violations === 0) return { kind: 'stop', outcome: 'converged' };
  if (last.schemaId === MIX_REPORT_SCHEMA_ID) return { kind: 'escalate', reason: 'studio_work' };
  if (revisions >= maxRevisions) return { kind: 'escalate', reason: 'iteration_cap' };
  if (revisions > 0 && last.violations >= passes.at(-2)!.violations) return { kind: 'escalate', reason: 'stall' };
  return { kind: 'revise' };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The artifact's version and its lineage's latest version, read as xyp_runtime. */
const lineageHead = async (deps: DispatchDeps, artifactId: string) => {
  const rows = (await deps.sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
    return tx<{ version: number; head_id: string; head_version: number }[]>`
      select a.version, h.id as head_id, h.version as head_version
      from creative_artifacts a
      join lateral (select id, version from creative_artifacts where lineage_id = a.lineage_id order by version desc limit 1) h on true
      where a.id = ${artifactId}`;
  })) as { version: number; head_id: string; head_version: number }[];
  return rows[0];
};

/**
 * Runs the loop on one artifact version until it converges, has no rules to check, or escalates.
 * @param deps - dispatch dependencies (registry, tools, handlers, LLM runner)
 * @param artifactId - the latest version of its lineage
 * @param options - `maxRevisions` (default 3), `timeoutMs` per run (default LLM_TIMEOUT_MS)
 * @returns the outcome, every critique and version in order, violations per pass, and the escalation id when queued
 * @throws Error on a malformed or unknown id, or a version that isn't its lineage's latest (revising it would fork history)
 */
export const evaluate = async (deps: DispatchDeps, artifactId: string, options: { readonly maxRevisions?: number; readonly timeoutMs?: number } = {}): Promise<LoopResult> => {
  if (!UUID.test(artifactId)) throw new Error(`evaluate: ${JSON.stringify(artifactId)} is not an artifact id (a uuid)`);
  const max = options.maxRevisions ?? MAX_REVISIONS;
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const head = await lineageHead(deps, artifactId);
  if (!head) throw new Error(`evaluate: no artifact ${artifactId}`);
  if (head.head_id !== artifactId) {
    throw new Error(`evaluate: artifact ${artifactId} is v${head.version}; the latest version of its lineage is ${head.head_id} (v${head.head_version}). Evaluate that one: revising an older version would fork the history.`);
  }

  const passes: Pass[] = [];
  const artifactIds = [artifactId];
  const result = (outcome: Outcome, extra: { escalationId?: string; error?: string } = {}): LoopResult => ({
    outcome, revisions: artifactIds.length - 1, critiqueIds: passes.map((p) => p.critiqueId), artifactIds: [...artifactIds], counts: passes.map((p) => p.violations), ...extra,
  });
  const escalate = async (reason: 'studio_work' | 'iteration_cap' | 'stall' | 'revision_failed', error?: string): Promise<LoopResult> => {
    const request = {
      reason, revisions: artifactIds.length - 1, maxRevisions: max, critiqueIds: passes.map((p) => p.critiqueId), artifactIds, counts: passes.map((p) => p.violations),
      ...(error ? { error } : {}),
    };
    const rows = (await deps.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${quoteIdent(LOOP_ROLE)}`);
      return tx<{ id: string }[]>`select public.xyp_escalate_critique(${passes.at(-1)!.critiqueId}, ${tx.json(request as postgres.JSONValue)}) as id`;
    })) as { id: string }[];
    return result(reason, { escalationId: rows[0]!.id, ...(error ? { error } : {}) });
  };

  let current = artifactId;
  let previous: string | undefined;
  for (;;) {
    const c = await dispatch(deps, CRITIC_AGENT, { artifactId: current, ...(previous ? { previousCritiqueId: previous } : {}) }, { timeoutMs });
    // A failed Critic run is a system fault, not a creative stall: logged in agent_runs, no queue item.
    if (c.status === 'error') return result('error', { error: c.error ?? 'Critic run failed' });
    const out = c.output as CriticOutput;
    passes.push({ critiqueId: out.critique.id, artifactId: current, schemaId: out.critique.schemaId, checked: out.critique.counts.checked, violations: out.critique.counts.violations });
    previous = out.critique.id;
    const d = decide(passes, max);
    if (d.kind === 'stop') return result(d.outcome);
    if (d.kind === 'escalate') return escalate(d.reason);
    const r = await dispatch(deps, REVISION_AGENT, { critiqueId: previous }, { timeoutMs });
    if (r.status === 'error') return escalate('revision_failed', r.error ?? 'Revision run failed');
    current = (r.output as RevisionOutput).artifact.id;
    artifactIds.push(current);
  }
};
