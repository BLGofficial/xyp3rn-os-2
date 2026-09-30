import { randomUUID } from 'node:crypto';
import { formatReply, refsOf, runPlan, type AskResult, type RunnablePlan } from '../../../core/orchestrator/ask.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { answerLookup, summarizerFromEnv, type LookupAnswer } from '../../../core/orchestrator/lookup.ts';
import { ENTRYPOINTS, planRequest } from '../../../core/orchestrator/orchestrate.ts';
import { cancelJob, createJob, findJob, MAX_DEEP_PER_USER, MAX_RUNNING_PER_USER, runningCount, type AskView } from '../lib/ask-jobs.ts';
import { runDeep, runSkill, type HeadlessOutcome } from '../lib/claude-headless.ts';
import type { SkillName } from '../lib/skills.ts';
import { selectTier } from '../lib/tiers.ts';

/**
 * Mercury's Ask (JARVIS Prompt 04 gap: the assistant surface). The command input's Ask button calls
 * `startAsk`; the answer or the running job is shown on /ask/[id]. Tiers (apps/web/lib/tiers.ts):
 * 1 skill and 3 deep run Claude Code headless (needs LLM_ENGINE=claude-code), 2 lookup reads stored
 * data, 4 plan goes through the same front door as `pnpm ask`. A refusal throws: the action turns it
 * into ?error= on the page.
 */

export type AskRunners = {
  readonly engine: boolean;
  readonly answerLookup: (question: string) => Promise<LookupAnswer>;
  /** No abort: a plan job cannot be cancelled (ask-jobs.ts), its run keeps its own records. */
  readonly runPlan: (plan: RunnablePlan) => Promise<AskResult>;
  readonly runSkill: (skill: SkillName, text: string, opts?: { readonly signal?: AbortSignal }) => Promise<HeadlessOutcome>;
  readonly runDeep: (text: string, opts?: { readonly signal?: AbortSignal }) => Promise<HeadlessOutcome>;
};

/** The live runners: the web runtime's deps and pool, and the server's environment. */
export const askRunners = (deps: DispatchDeps, env: Readonly<Record<string, string | undefined>> = process.env): AskRunners => {
  const summarize = summarizerFromEnv(env);
  return {
    engine: env.LLM_ENGINE === 'claude-code',
    answerLookup: (q) => answerLookup(deps.sql, q, summarize),
    runPlan: (plan) => runPlan(deps, plan),
    runSkill, runDeep,
  };
};

/**
 * Starts (or answers) one request.
 * @param owner - the signed-in owner (jobs are only visible to them)
 * @param input - the typed text; `skill` from a skill button; `deep` from the Deep task box
 * @returns the request id for /ask/[id]
 * @throws Error with the reason shown to the owner (empty, engine off, unknown skill, caps)
 */
export const startAsk = async (
  owner: string,
  input: { readonly text: string; readonly skill?: string; readonly deep?: boolean },
  runners: AskRunners,
): Promise<string> => {
  const text = input.text.trim();
  if (!text) throw new Error('Type a request first');
  const tier = selectTier(text, { ...(input.skill ? { skill: input.skill } : {}), deep: input.deep === true, engine: runners.engine });
  if (tier.kind === 'engine-off') throw new Error('Skills and deep tasks need LLM_ENGINE=claude-code on the Mercury server');
  if (tier.kind === 'invalid-skill') throw new Error('Unknown skill');
  const requestId = randomUUID();
  const done = (view: Omit<AskView, 'requestId' | 'state'>) => { createJob(owner, requestId, text, { requestId, state: 'done', ...view }); return requestId; };
  const running = (view: Omit<AskView, 'requestId' | 'state' | 'status'>, work: (signal: AbortSignal) => Promise<AskView>, failed: string) => {
    if (runningCount(owner) >= MAX_RUNNING_PER_USER) throw new Error('Two requests are already running; wait for one or cancel it');
    const job = createJob(owner, requestId, text, { requestId, state: 'running', status: 'running', ...view }, work,
      () => ({ requestId, state: 'done', status: 'error', action: view.action, route: view.route, reply: failed }));
    if (typeof job === 'string') throw new Error(job === 'full' ? 'Too many requests are stored; try again shortly' : 'Two requests are already running; wait for one or cancel it');
    return requestId;
  };

  if (tier.kind === 'skill' || tier.kind === 'deep') {
    if (tier.kind === 'deep' && runningCount(owner, 'deep') >= MAX_DEEP_PER_USER) throw new Error('A deep task is already running; wait for it or cancel it');
    const route = { status: tier.kind, ...(tier.kind === 'skill' ? { domain: tier.skill } : {}) };
    return running(
      { action: tier.kind, route, reply: tier.kind === 'skill' ? 'Working. Claude Code is running the skill.' : 'Working. Claude Code is on it.' },
      async (signal) => {
        const r = tier.kind === 'skill' ? await runners.runSkill(tier.skill, tier.text, { signal }) : await runners.runDeep(tier.text, { signal });
        return { requestId, state: 'done', action: tier.kind, route, status: r.ok ? 'success' : 'error', reply: r.reply, ...(r.sessionId ? { sessionId: r.sessionId } : {}) };
      },
      'Claude Code did not finish. It was not retried.',
    );
  }

  if (tier.kind === 'lookup') {
    let a: LookupAnswer;
    try { a = await runners.answerLookup(text); } catch (error) {
      console.error('mercury ask lookup:', error instanceof Error ? error.message : error);
      return done({ action: 'lookup', route: { status: 'lookup' }, status: 'error', reply: 'Could not read stored data right now. Try again, or ask it as a normal request.' });
    }
    return done({ action: 'lookup', route: { status: 'lookup' }, status: a.source, reply: a.reply });
  }

  const plan = planRequest(text, ENTRYPOINTS);
  const route = { status: plan.route.status, ...('domain' in plan.route ? { domain: plan.route.domain } : {}) };
  if (plan.action === 'hold' || plan.action === 'clarify') return done({ action: plan.action, route, status: plan.action, reply: formatReply(plan) });
  return running(
    { action: plan.action, route, reply: 'Working. The run is still in progress.' },
    async () => {
      const outcome = await runners.runPlan(plan);
      const refs = refsOf(outcome);
      return { requestId, state: 'done', action: plan.action, route, status: outcome.result.status, reply: formatReply(plan, outcome), refs, ...(refs.approvalIds.length ? { approvalRequired: true } : {}) };
    },
    'The run did not finish. It was not retried; its records are in Workflows and Research.',
  );
};

/** The owner's own job view, or undefined (unknown id, another owner's job, or forgotten after a restart). */
export const getAsk = (owner: string, requestId: string): AskView | undefined => findJob(owner, requestId)?.view;

/** Cancels the owner's running skill or deep job (a plan run cannot be cancelled: see ask-jobs.ts). */
export const cancelAsk = (owner: string, requestId: string) => cancelJob(owner, requestId);
