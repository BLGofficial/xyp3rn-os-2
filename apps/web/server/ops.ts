import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Sql } from '../../../core/db/client.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { decideArtifact, type ArtifactDecision } from '../../../governance/approvals.ts';
import { addAndImport } from '../../../records/vault/import.ts';
import type { LyricVersion } from '../../../records/vault/lyric-editor.ts';
import { loadEmbedder, type Embedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { embedVault } from '../../../knowledge/vector-retrieval/pipeline.ts';

/**
 * What the UI writes (AOS-01 §9, A2): every change is an agent run through dispatch, and approval
 * is the owner's decision (xyp_decide_artifact). The server actions only call these.
 */

const run = async <T>(deps: DispatchDeps, agent: string, input: unknown): Promise<T> => {
  const r = await dispatch(deps, agent, input);
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return r.output as T;
};

export type Upload = { readonly name: string; readonly bytes: Uint8Array };
export type UploadOptions = { readonly as?: string; readonly language?: string; readonly tags?: readonly string[]; readonly songId?: string; readonly title?: string };

/**
 * Adds uploaded files to the Vault. Each upload is written by this server to its own temp directory
 * under its base name (the browser never supplies a path; register_vault_file reads what the OS
 * process can read), added with addAndImport, then the temp copy is removed.
 * @param deps - dispatch deps (their tool set carries the Vault store)
 * @param files - name and bytes of each upload
 * @param o - media class, language, tags and song for every file in the batch
 * @returns addAndImport's result per file, in order
 */
export const uploadFiles = async (deps: DispatchDeps, files: readonly Upload[], o: UploadOptions) => {
  const out: Awaited<ReturnType<typeof addAndImport>>[] = [];
  for (const f of files) {
    const name = basename(f.name.replaceAll('\\', '/')).trim();
    if (name === '' || name === '.' || name === '..') throw new Error('upload: every file needs a file name');
    const dir = await mkdtemp(join(tmpdir(), 'xyp-upload-'));
    try {
      const path = join(dir, name);
      await writeFile(path, f.bytes, { flag: 'wx' });
      out.push(await addAndImport(deps, {
        path, ...(o.as ? { as: o.as } : {}), ...(o.language ? { language: o.language } : {}), ...(o.title ? { title: o.title } : {}),
        ...(o.tags && o.tags.length > 0 ? { tags: o.tags } : {}), ...(o.songId ? { songId: o.songId } : {}),
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return out;
};

/**
 * The owner approves or rejects one version.
 * @param sql - the app's pool (allowed to SET ROLE service_role)
 * @param artifactId - the version
 * @param decision - approve or reject
 * @param reason - why (required)
 * @param approver - who (XYP_OWNER, else "owner")
 * @returns the decision and the approved pointer
 */
export const decide = (sql: Sql, artifactId: string, decision: 'approve' | 'reject', reason: string, approver: string): Promise<ArtifactDecision> =>
  decideArtifact(sql, artifactId, { decision, approver, reason });

/** @returns the next version the owner's text became */
export const editLyrics = (deps: DispatchDeps, e: { readonly parentId: string; readonly text: string; readonly language?: string }) =>
  run<LyricVersion>(deps, 'x3lius-lyric-editor', { edit: e });

export type SongFields = { readonly title?: string; readonly artist?: string; readonly language?: string | null; readonly genre?: string | null; readonly status?: string; readonly notes?: string | null };

/** @returns the new song and its first revision */
export const songCreate = (deps: DispatchDeps, f: SongFields & { readonly title: string; readonly artist: string }) =>
  run<{ songId: string; revision: number }>(deps, 'records-songs', { create: f });

/** @returns the song and its new revision */
export const songRevise = (deps: DispatchDeps, f: SongFields & { readonly songId: string }) =>
  run<{ songId: string; revision: number }>(deps, 'records-songs', { revise: f });

/** @returns the new link */
export const songLink = (deps: DispatchDeps, l: { readonly songId: string; readonly role?: string } & Record<string, string | undefined>) =>
  run<{ linkId: string; kind: string; targetId: string }>(deps, 'records-songs', { link: l });

/** @returns the retracted link */
export const songUnlink = (deps: DispatchDeps, u: { readonly linkId: string; readonly reason: string }) =>
  run<{ linkId: string; retracted: true }>(deps, 'records-songs', { unlink: u });

/**
 * Index now (AOS-04 Plan C1, §15.2 item 5): runs the Vault index (`pnpm embed`'s Vault half) so a saved file becomes
 * searchable by meaning. It indexes every pending Vault entity, not only one file; a failure leaves every saved
 * file as it was and is reported, never hidden.
 * @param sql - the app's pool
 * @param load - the embedder (a seam: the model by default)
 * @returns ok with the model, or the error
 */
export const indexVaultFile = async (sql: Sql, load: () => Promise<Embedder> = loadEmbedder): Promise<{ ok: true; model: string } | { ok: false; error: string }> => {
  try {
    const e = await load();
    await embedVault(sql, e);
    return { ok: true, model: e.model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};
