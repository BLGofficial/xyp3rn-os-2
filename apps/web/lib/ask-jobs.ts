import type { AskRefs } from '../../../core/orchestrator/ask';

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
};

type Job = { readonly userId: string; readonly fingerprint: string; readonly createdAt: number; view: AskView };

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 500;
export const MAX_RUNNING_PER_USER = 2;
const jobs = new Map<string, Job>();
const keyOf = (userId: string, requestId: string) => `${userId}\n${requestId}`;

/** The caller's own job, or undefined (another user's id never matches). */
export const findJob = (userId: string, requestId: string) => jobs.get(keyOf(userId, requestId));

/**
 * Registers a job synchronously (call right after `findJob`, with no await between, so two
 * identical submissions cannot both start work). `work` runs once and is never retried.
 * @returns the job, or a reason it was refused
 */
export const createJob = (
  userId: string, requestId: string, fingerprint: string, initial: AskView,
  work?: () => Promise<AskView>, failed?: () => AskView,
): Job | 'busy' | 'full' => {
  const now = Date.now();
  for (const [k, j] of jobs) if (j.view.state === 'done' && now - j.createdAt > TTL_MS) jobs.delete(k);
  if (work && [...jobs.values()].filter((j) => j.userId === userId && j.view.state === 'running').length >= MAX_RUNNING_PER_USER) return 'busy';
  if (jobs.size >= MAX_JOBS) {
    const oldestDone = [...jobs].find(([, j]) => j.view.state === 'done');
    if (!oldestDone) return 'full';
    jobs.delete(oldestDone[0]);
  }
  const job: Job = { userId, fingerprint, createdAt: now, view: initial };
  jobs.set(keyOf(userId, requestId), job);
  if (work) {
    work().then((v) => { job.view = v; }, (error: unknown) => {
      console.error('mercury ask failed:', error instanceof Error ? error.message : error);
      job.view = failed!();
    });
  }
  return job;
};
