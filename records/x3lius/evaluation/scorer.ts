import { LLM_TIMEOUT_MS } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import type { TrialScorer } from '../../../research-intelligence/experiments/engine.ts';
import { CRITIC_AGENT, type CriticOutput } from './critic.ts';

/** The 6C scoring method once the Critic exists (Phase 12). */
export const CRITIC_SCORER_ID = 'critic:x3lius-evaluation';

/**
 * Trial score = rules passed / rules checked (user decision, spec §8), rounded to 4 decimals as
 * experiment_runs.score (numeric(5,4)) stores it.
 * @returns the score, or null when no rule was checked (never 1 for "nothing to check")
 */
export const scoreOf = (c: { readonly checked: number; readonly passed: number }): number | null =>
  c.checked === 0 ? null : Math.round((c.passed / c.checked) * 10_000) / 10_000;

/**
 * The Critic-backed 6C scorer: one Critic pass (no revision) on the artifact a trial names.
 * A trial with no artifactId, a failed Critic run or zero rules checked scores null with the reason.
 * @param deps - dispatch dependencies
 * @returns the TrialScorer recordTrial takes
 */
export const criticScorer = (deps: DispatchDeps): TrialScorer => ({
  id: CRITIC_SCORER_ID,
  score: async (output) => {
    const artifactId = (output as { artifactId?: unknown } | null)?.artifactId;
    if (typeof artifactId !== 'string') return { score: null, inputs: { reason: 'the trial output names no artifactId: nothing for the Critic to check' } };
    const r = await dispatch(deps, CRITIC_AGENT, { artifactId }, { timeoutMs: LLM_TIMEOUT_MS });
    if (r.status === 'error') return { score: null, inputs: { reason: `the Critic run failed: ${r.error}`, agentRunId: r.runId } };
    const { id: critiqueId, counts } = (r.output as CriticOutput).critique;
    const score = scoreOf(counts);
    return score === null
      ? { score, inputs: { reason: 'no canonical rule applies to this artifact (0 checked)', critiqueId } }
      : { score, inputs: { critiqueId, passed: counts.passed, checked: counts.checked, violations: counts.violations } };
  },
});
