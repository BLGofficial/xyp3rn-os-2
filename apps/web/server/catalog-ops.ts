import { join } from 'node:path';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { loadWorkflow, runWorkflow } from '../../../core/workflow-engine/engine.ts';
import { uploadFiles, type Upload } from './ops.ts';

/**
 * The Command Center's writes (AOS-02 §6): each is an agent run through dispatch, or a Records
 * workflow (register-track: lookup → catalog; schedule-release: the Rights check → the calendar). The
 * server actions only call these. A refusal is thrown with the agent's or the DB's reason.
 */

const WORKFLOWS = join(import.meta.dirname, '..', '..', '..', 'records', 'workflows');

const run = async <T>(deps: DispatchDeps, agent: string, input: unknown): Promise<T> => {
  const r = await dispatch(deps, agent, input);
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return r.output as T;
};

const flow = async <T>(deps: DispatchDeps, file: string, input: Record<string, unknown>): Promise<T> => {
  const r = await runWorkflow(deps, loadWorkflow(join(WORKFLOWS, file), deps.registry), input);
  if (r.status !== 'success') throw new Error(r.error ?? `${file} failed (workflow run ${r.workflowRunId})`);
  return r.output as T;
};

const catalog = <T>(deps: DispatchDeps, op: string, args: unknown) => run<T>(deps, 'records-catalog', { [op]: args });

export type Registration = {
  readonly takeId?: string;
  readonly sourceId?: string;
  readonly release: { readonly id: string } | { readonly title: string; readonly artist: string; readonly kind: string };
  readonly position: number;
  readonly title?: string;
  /** Links the new track to this song (records-songs, role `release`). */
  readonly songId?: string;
};

/**
 * Registers a recording (a Suno take or a Vault audio file) as a track, through register-track.
 * @param deps - dispatch deps
 * @param r - the recording, the release (existing draft or new), position, optional title and song
 * @returns the release and track ids
 */
export const registerTrack = async (deps: DispatchDeps, r: Registration): Promise<{ releaseId: string; trackId: string; createdRelease: boolean }> => {
  const out = await flow<{ releaseId: string; trackId: string; createdRelease: boolean }>(deps, 'register-track.workflow.yaml', {
    takeId: r.takeId ?? null, sourceId: r.sourceId ?? null, release: r.release, position: r.position, title: r.title ?? null, mixReportArtifactId: null,
  });
  if (r.songId) await run(deps, 'records-songs', { link: { songId: r.songId, trackId: out.trackId, role: 'release' } });
  return out;
};

/** @returns the split set written */
export const writeSplits = (deps: DispatchDeps, trackId: string, splits: readonly { payee: string | null; percentage: number }[]) =>
  catalog<{ trackId: string; version: number }>(deps, 'splits', { trackId, splits });

/** @returns the code set: an ISRC on a track or a UPC on a release, once */
export const assignCode = (deps: DispatchDeps, a: { trackId: string; isrc: string } | { releaseId: string; upc: string }) => catalog(deps, 'assign', a);

/** @returns the new person */
export const addPerson = (deps: DispatchDeps, name: string) => catalog<{ personId: string }>(deps, 'person', { name });

/** @returns the alias added */
export const addAlias = (deps: DispatchDeps, personId: string, alias: string) => catalog(deps, 'alias', { personId, alias });

/** @returns the credit (the person by id, or by any of their names or aliases) */
export const credit = (deps: DispatchDeps, c: { personId?: string; person?: string; role: string; songId?: string; trackId?: string; note?: string }) =>
  catalog<{ creditId: string; personId: string }>(deps, 'credit', c);

/** @returns the retraction */
export const uncredit = (deps: DispatchDeps, creditId: string, reason: string) => catalog(deps, 'uncredit', { creditId, reason });

/** @returns the link */
export const link = (deps: DispatchDeps, l: { releaseId?: string; trackId?: string; platform: string; url: string }) =>
  catalog<{ linkId: string }>(deps, 'link', l);

/** @returns the retraction */
export const unlink = (deps: DispatchDeps, linkId: string, reason: string) => catalog(deps, 'unlink', { linkId, reason });

/**
 * Artwork from an uploaded image: the image goes into the Vault first (vault-curator), then the release
 * points at it (records-catalog). Uploads never name a path (AOS-01 F36).
 * @param deps - dispatch deps
 * @param releaseId - the release
 * @param image - the uploaded image
 * @returns the release and the Vault file
 */
export const setArtwork = async (deps: DispatchDeps, releaseId: string, image: Upload) => {
  const [added] = await uploadFiles(deps, [image], { as: 'image' });
  return catalog<{ releaseId: string; sourceId: string }>(deps, 'artwork', { releaseId, sourceId: added!.file.sourceId });
};

/** @returns the delivery event */
export const recordDelivery = (deps: DispatchDeps, d: { releaseId: string; distributor: string; status: string; note?: string }) => catalog(deps, 'delivery', d);

/** @returns the release, scheduled on the date once the Rights check passes (schedule-release) */
export const scheduleRelease = (deps: DispatchDeps, s: { releaseId: string; releaseDate: string }) =>
  flow<{ releaseId: string; status: string; releaseDate: string }>(deps, 'schedule-release.workflow.yaml', s);

/** @returns the release, marked released (on or after its date) */
export const markReleased = (deps: DispatchDeps, releaseId: string) =>
  run<{ releaseId: string; status: string }>(deps, 'records-release-calendar', { release: { releaseId } });

/** @returns the new task */
export const createTask = (deps: DispatchDeps, t: { title: string; songId?: string; releaseId?: string; dueDate?: string }) =>
  run<{ taskId: string }>(deps, 'records-tasks', { create: t });

/** @returns the task's new status */
export const moveTask = (deps: DispatchDeps, taskId: string, status: string, note?: string) =>
  run<{ taskId: string; status: string }>(deps, 'records-tasks', { move: { taskId, status, ...(note ? { note } : {}) } });
