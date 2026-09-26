import { join } from 'node:path';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { loadWorkflow, runWorkflow } from '../../../core/workflow-engine/engine.ts';
import { SECTION_KINDS } from '../../../records/x3lius/creative/schemas.ts';
import type { StudioVersion } from '../../../records/x3lius/studio/editor.ts';
import type { TagSection } from '../../../records/x3lius/studio/tags.ts';
import { uploadFiles, type Upload } from './ops.ts';

/**
 * Studio's writes (AOS-03 §6): each is an agent run through dispatch (x3lius-studio-editor,
 * suno-submitter) or the build-suno-package workflow. The server actions only call these. A refusal
 * is thrown with the agent's or the DB's reason.
 */

const BUILD_PACKAGE = join(import.meta.dirname, '..', '..', '..', 'records', 'workflows', 'build-suno-package.workflow.yaml');

const run = async <T>(deps: DispatchDeps, agent: string, input: unknown): Promise<T> => {
  const r = await dispatch(deps, agent, input);
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return r.output as T;
};

/**
 * A form field as a list: split on line breaks and commas (`any`, for short entries such as styles to
 * exclude or cues), or on line breaks only (`lines`, for notes, which may hold commas). Trimmed; blanks dropped.
 * @param raw - the field's text
 * @param by - what separates entries
 * @returns the entries
 */
export const list = (raw: string, by: 'any' | 'lines' = 'any'): string[] =>
  raw.split(by === 'lines' ? /\r?\n/ : /\r?\n|,/).map((x) => x.trim()).filter((x) => x !== '');

/**
 * The tag set form's rows as sections: one row per section kind, in song-structure order; a row counts
 * when its `include:<kind>` box is ticked.
 * @param get - reads a form field (null when absent)
 * @returns the sections the owner included
 */
export const tagSections = (get: (key: string) => string | null): TagSection[] =>
  SECTION_KINDS.filter((kind) => get(`include:${kind}`)).map((kind) => ({
    kind, label: (get(`label:${kind}`) ?? '').trim(), numbered: get(`numbered:${kind}`) === 'on', cues: list(get(`cues:${kind}`) ?? ''),
  }));

export type RecipeFields = {
  readonly name: string; readonly style: string; readonly excludeStyles?: readonly string[]; readonly mood?: readonly string[];
  readonly production?: readonly string[]; readonly notes?: readonly string[]; readonly parentId?: string;
};

/** @returns the recipe version written (a new lineage, or the next version of parentId's) */
export const writeRecipe = (deps: DispatchDeps, r: RecipeFields) => run<StudioVersion>(deps, 'x3lius-studio-editor', { recipe: r });

/** @returns the tag set version written (a new lineage, or the next version of parentId's) */
export const writeTagSet = (deps: DispatchDeps, t: { readonly name: string; readonly sections: readonly TagSection[]; readonly notes?: readonly string[]; readonly parentId?: string }) =>
  run<StudioVersion>(deps, 'x3lius-studio-editor', { tagSet: t });

/** @returns the default tag set (the code labels) as a new lineage */
export const defaultTagSet = (deps: DispatchDeps) => run<StudioVersion>(deps, 'x3lius-studio-editor', { defaultTagSet: {} });

export type PackageInput = {
  readonly songId: string; readonly lyricsArtifactId: string; readonly styleRecipeArtifactId: string; readonly tagSetArtifactId: string;
  readonly title: string; readonly sunoModel: string;
};

/**
 * A Suno prompt package for a song, through build-suno-package (the package, then its link to the song).
 * @param deps - dispatch deps
 * @param p - the song, the three versions, the title and the Suno model
 * @returns the package id and its link
 */
export const buildPackage = async (deps: DispatchDeps, p: PackageInput): Promise<{ readonly packageId: string; readonly linkId: string }> => {
  const r = await runWorkflow(deps, loadWorkflow(BUILD_PACKAGE, deps.registry), p);
  if (r.status !== 'success') throw new Error(r.error ?? `build-suno-package failed (workflow run ${r.workflowRunId})`);
  return r.output as { packageId: string; linkId: string };
};

/** @returns the manual submission (refused, with every reason, while the package isn't ready) */
export const handOff = (deps: DispatchDeps, packageId: string) =>
  run<{ submissionId: string; status: string }>(deps, 'suno-submitter', { submit: { packageId, adapter: 'manual' } });

/**
 * The result of a manual handoff: the audio goes into the Vault first (vault-curator), then it is
 * recorded as a take of the attempt (suno-submitter capture). Uploads never name a path. The file is not
 * linked to the song: the take is the song's through its package, and bytes already in the Vault (and
 * perhaps already linked) are the same file, not a second link.
 * @param deps - dispatch deps
 * @param t - the attempt, the uploaded audio and an optional title
 * @returns the take and its Vault file
 */
export const importTake = async (
  deps: DispatchDeps,
  t: { readonly submissionId: string; readonly upload: Upload; readonly title?: string },
): Promise<{ readonly takeId: string; readonly sourceId: string }> => {
  const [added] = await uploadFiles(deps, [t.upload], { as: 'audio' });
  const sourceId = added!.file.sourceId;
  const c = await run<{ takes: { id: string }[]; alreadyCaptured: number }>(deps, 'suno-submitter', {
    capture: { submissionId: t.submissionId, takes: [{ sourceId, ...(t.title ? { title: t.title } : {}) }] },
  });
  if (c.takes.length === 0) throw new Error('that audio file is already a take of this attempt');
  return { takeId: c.takes[0]!.id, sourceId };
};

/** @returns the rating (the latest is the take's current one) */
export const rateTake = (deps: DispatchDeps, r: { readonly takeId: string; readonly rating: number; readonly keep?: string; readonly change?: string }) =>
  run<{ ratingId: string; rating: number }>(deps, 'suno-submitter', { rate: r });
