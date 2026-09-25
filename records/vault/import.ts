import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { addToVault, type VaultAddInput, type VaultAddResult } from '../../knowledge/ingestion/vault.ts';
import { asRole } from '../../knowledge/source-registry/vault-tools.ts';
import { LYRIC_EDITOR_AGENT, type LyricVersion } from './lyric-editor.ts';
import { SONGS_AGENT } from './songs-agent.ts';

export type ImportedSheet = LyricVersion & {
  readonly linkId: string | null;
  /** agent_runs ids, in order: the editor's, then the link's. */
  readonly runIds: readonly string[];
};

const ok = async (deps: DispatchDeps, agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return { runId: r.runId, output: r.output };
};

/**
 * A Vault lyric sheet → an x3lius.lyrics/v2 lineage (AOS-01 §6.4): x3lius-lyric-editor writes v1
 * (a draft), then, with a song, records-songs links the lineage as its `lyrics`. A controller over
 * dispatch: each step is an agent run.
 * @param deps - dispatch deps
 * @param input - the Vault file (media class lyric_sheet) and, optionally, its song
 * @returns the version written, the link and the runs
 * @throws on any failed run, with its error (e.g. a mixed-script word, a file that is not a lyric sheet)
 */
export const importLyricSheet = async (deps: DispatchDeps, input: { readonly sourceId: string; readonly songId?: string }): Promise<ImportedSheet> => {
  const edited = await ok(deps, LYRIC_EDITOR_AGENT, { import: { sourceId: input.sourceId } });
  const v = edited.output as LyricVersion;
  if (input.songId === undefined) return { ...v, linkId: null, runIds: [edited.runId] };
  const linked = await ok(deps, SONGS_AGENT, { link: { songId: input.songId, artifactId: v.lineageId, role: 'lyrics' } });
  return { ...v, linkId: (linked.output as { linkId: string }).linkId, runIds: [edited.runId, linked.runId] };
};

/** A lyric sheet's earlier import, found instead of writing a second lineage. */
export type PriorImport = { readonly artifactId: string; readonly lineageId: string; readonly version: number; readonly alreadyImported: true };

/**
 * The version an earlier import wrote from this Vault file, if any (its contextRefs cite the file).
 * @param deps - pool; reads as xyp_runtime, read only
 * @param sourceId - the lyric sheet's source id
 * @returns the imported version, or null
 */
export const priorImport = async (deps: Pick<DispatchDeps, 'sql'>, sourceId: string): Promise<PriorImport | null> => {
  const [r] = await asRole(deps.sql, 'xyp_runtime', (tx) => tx<{ id: string; lineage_id: string; version: number }[]>`
    select id, lineage_id, version from creative_artifacts
    where agent_name = ${LYRIC_EDITOR_AGENT} and context_refs @> ${tx.json([{ kind: 'vault-file', sourceId }])}
    order by created_at limit 1`, 'read only');
  return r ? { artifactId: r.id, lineageId: r.lineage_id, version: r.version, alreadyImported: true } : null;
};

/**
 * `pnpm vault add` end to end: addToVault, then, for a lyric sheet, importLyricSheet. A sheet is
 * imported once: adding the same bytes again returns the lineage the first import wrote. (Two
 * concurrent first adds of one sheet could each import it; the Vault has one owner, so this is
 * not guarded.)
 * @param deps - dispatch deps
 * @param input - as addToVault
 * @returns the file, and the lyric version (new or prior) for a lyric sheet, else null
 */
export const addAndImport = async (
  deps: DispatchDeps,
  input: VaultAddInput,
): Promise<{ readonly file: VaultAddResult; readonly lyrics: (ImportedSheet & { readonly alreadyImported: false }) | PriorImport | null }> => {
  const file = await addToVault(deps, input);
  if (file.mediaClass !== 'lyric_sheet') return { file, lyrics: null };
  const prior = await priorImport(deps, file.sourceId);
  if (prior) return { file, lyrics: prior };
  const imported = await importLyricSheet(deps, { sourceId: file.sourceId, ...(input.songId ? { songId: input.songId } : {}) });
  return { file, lyrics: { ...imported, alreadyImported: false } };
};
