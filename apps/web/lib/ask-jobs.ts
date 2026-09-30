import type { AskRefs } from '../../../core/orchestrator/ask.ts';

/**
 * Status and deduplication for Mercury requests, keyed by (session user id, client request id).
 * chisle: in-process memory, the smallest reliable mechanism with the DB-free test path. The
 * durable record of the work stays in workflow_runs / research_runs / agent_runs (ids in `refs`).
 * A server restart forgets jobs: polling then gets 404, never a false "done". Single Next process.
 */

export type AskView = {
  readonly requestId: string;
  readonly state: 'running' | 'done';
  readonly action: string;
  readonly route: { readonly status: string; readonly domain?: string };
  /** hold | clarify | running | success | error | clarify (music sub-domain) */
  readonly status: string;
  readonly reply: string;
  readonly refs?: AskRefs;
  readonly approvalRequired?: boolean;
  readonly sessionId?: string;
};

type Job = { readonly userId: string; readonly fingerprint: string; readonly createdAt: number; view: AskView; readonly controller: AbortController };

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 500;
export const MAX_RUNNING_PER_USER = 2;
export const MAX_DEEP_PER_USER = 1;
const jobs = new Map<string, Job>();
const keyOf = (userId: string, requestId: string) => `${userId}\n${requestId}`;

/** The caller's own job, or undefined (another user's id never matches). */
export const findJob = (userId: string, requestId: string) => jobs.get(keyOf(userId, requestId));

/** Running jobs for a user, optionally only one action (e.g. 'deep'). */
export const runningCount = (userId: string, action?: string) =>
  [...jobs.values()].filter((j) => j.userId === userId && j.view.state === 'running' && (!action || j.view.action === action)).length;

/**
 * Cancels the caller's own running job: aborts its work (a headless run is killed) and marks it done.
 * Only skill/deep jobs (headless Claude Code, killable via the signal) can be cancelled: a running
 * `plan` job ignores the signal (runPlan has no abort wiring), so cancelling it would free its
 * concurrency slot while the run kept going underneath, letting a resubmit bypass the per-user cap.
 * @returns 'not-found' for an unknown, finished or other user's job; 'not-cancellable' for a running
 * job whose action is not skill/deep
 */
export const cancelJob = (userId: string, requestId: string): 'cancelled' | 'not-found' | 'not-cancellable' => {
  const job = jobs.get(keyOf(userId, requestId));
  if (!job || job.view.state !== 'running') return 'not-found';
  if (job.view.action !== 'skill' && job.view.action !== 'deep') return 'not-cancellable';
  job.view = { ...job.view, state: 'done', status: 'cancelled', reply: 'Cancelled. Runs it had already started may stay marked running in Live Events.' };
  job.controller.abort(new Error('cancelled'));
  return 'cancelled';
};

/**
 * Registers a job synchronously (call right after `findJob`, with no await between, so two
 * identical submissions cannot both start work). `work` runs once and is never retried. Never
 * overwrites an existing entry for the key: a caller that awaited between its own `findJob` and
 * this call (the lookup tier reads its answer first) must re-check the outcome itself.
 * @returns the job, or a reason it was refused ('exists': another job claimed this id meanwhile)
 */
export const createJob = (
  userId: string, requestId: string, fingerprint: string, initial: AskView,
  work?: (signal: AbortSignal) => Promise<AskView>, failed?: () => AskView,
): Job | 'busy' | 'full' | 'exists' => {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.view.state === 'done' && now - j.createdAt > TTL_MS) jobs.delete(k);
  const key = keyOf(userId, requestId);
  if (jobs.has(key)) return 'exists';
  if (work && runningCount(userId) >= MAX_RUNNING_PER_USER) return 'busy';
  if (jobs.size >= MAX_JOBS) {
    const oldestDone = [...jobs].find(([, j]) => j.view.state === 'done');
    if (!oldestDone) return 'full';
    jobs.delete(oldestDone[0]);
  }
  const job: Job = { userId, fingerprint, createdAt: now, view: initial, controller: new AbortController() };
  jobs.set(key, job);
  if (work) {
    work(job.controller.signal).then((v) => { if (job.view.status !== 'cancelled') job.view = v; }, (error: unknown) => {
      if (job.view.status === 'cancelled') return;
      console.error('mercury ask failed:', error instanceof Error ? error.message : error);
      job.view = failed!();
    });
  }
  return job;
};
