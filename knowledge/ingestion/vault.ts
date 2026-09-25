import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { sha256Hex } from '../source-registry/acquire.ts';
import { MEDIA_CLASSES, type MediaClass, type RegisteredFile } from '../source-registry/vault-tools.ts';
import { VAULT_CURATOR_AGENT } from './vault-curator.ts';

/**
 * `pnpm vault add` (AOS-01 §6): a local file into the Creative Vault. A controller over dispatch
 * with no authority of its own: every write is an agent run (vault-curator for the file,
 * records-songs for the song link), so each step leaves an agent_runs row.
 */

const BY_EXTENSION: Readonly<Record<string, { readonly mediaClass: MediaClass; readonly mimeType: string }>> = {
  '.txt': { mediaClass: 'document', mimeType: 'text/plain' },
  '.md': { mediaClass: 'document', mimeType: 'text/markdown' },
  '.pdf': { mediaClass: 'document', mimeType: 'application/pdf' },
  '.mp3': { mediaClass: 'audio', mimeType: 'audio/mpeg' },
  '.wav': { mediaClass: 'audio', mimeType: 'audio/wav' },
  '.flac': { mediaClass: 'audio', mimeType: 'audio/flac' },
  '.m4a': { mediaClass: 'audio', mimeType: 'audio/mp4' },
  '.aiff': { mediaClass: 'audio', mimeType: 'audio/aiff' },
  '.ogg': { mediaClass: 'audio', mimeType: 'audio/ogg' },
  '.png': { mediaClass: 'image', mimeType: 'image/png' },
  '.jpg': { mediaClass: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { mediaClass: 'image', mimeType: 'image/jpeg' },
  '.webp': { mediaClass: 'image', mimeType: 'image/webp' },
  '.gif': { mediaClass: 'image', mimeType: 'image/gif' },
};

/**
 * A file's media class. A lyric sheet is never guessed (a .txt may be notes or lyrics): the owner
 * names it with `--as lyric_sheet`.
 * @param path - file path (only its extension is read)
 * @param as - the owner's explicit class, which wins
 * @returns the media class; `other` for an unknown extension
 * @throws when `as` is not a media class
 */
export const mediaClassOf = (path: string, as?: string): MediaClass => {
  if (as !== undefined) {
    if (!(MEDIA_CLASSES as readonly string[]).includes(as)) throw new Error(`--as must be one of ${MEDIA_CLASSES.join(', ')}; got ${as}`);
    return as as MediaClass;
  }
  return BY_EXTENSION[extname(path).toLowerCase()]?.mediaClass ?? 'other';
};

export type VaultAddInput = {
  readonly path: string;
  /** Media class; default from the extension (mediaClassOf). */
  readonly as?: string;
  /** Default: the file name. */
  readonly title?: string;
  readonly language?: string | null;
  readonly tags?: readonly string[];
  /** Links the file to this song (records-songs). */
  readonly songId?: string;
  /** The link's role; default the media class (`lyric-sheet`, `document`, `audio`…). */
  readonly linkRole?: string;
};

export type VaultAddResult = RegisteredFile & {
  readonly linkId: string | null;
  /** agent_runs ids, in order: the curator's, then the link's. */
  readonly runIds: readonly string[];
};

// Hashing, storing and extracting a large file (a WAV, a long PDF) can pass dispatch's 30 s default.
const CURATOR_TIMEOUT_MS = 120_000;

const ok = async (deps: DispatchDeps, agent: string, input: unknown, timeoutMs?: number) => {
  const r = await dispatch(deps, agent, input, timeoutMs ? { timeoutMs } : {});
  if (r.status !== 'success') throw new Error(r.error ?? `${agent} failed (run ${r.runId})`);
  return { runId: r.runId, output: r.output };
};

/**
 * Adds one file to the Creative Vault: hash → vault-curator (store, register, text, tags) → with a
 * song, records-songs links it. The same bytes again return the existing file.
 * @param deps - dispatch deps (the tool set carries the Vault store)
 * @param input - the file and how to describe it
 * @returns the registered file, the link and the runs
 * @throws on an unreadable file, and on any failed run (with its error)
 */
export const addToVault = async (deps: DispatchDeps, input: VaultAddInput): Promise<VaultAddResult> => {
  const path = resolve(input.path);
  const bytes = new Uint8Array(await readFile(path));
  const mediaClass = mediaClassOf(path, input.as);
  const mimeType = BY_EXTENSION[extname(path).toLowerCase()]?.mimeType;
  const add = {
    path, sha256: sha256Hex(bytes), mediaClass, title: input.title ?? basename(path), language: input.language ?? null,
    tags: input.tags ?? [], ...(mimeType ? { mimeType } : {}),
  };
  const curated = await ok(deps, VAULT_CURATOR_AGENT, { add }, CURATOR_TIMEOUT_MS);
  const file = curated.output as RegisteredFile;
  if (input.songId === undefined) return { ...file, linkId: null, runIds: [curated.runId] };
  const role = input.linkRole ?? file.mediaClass.replace('_', '-');
  const linked = await ok(deps, 'records-songs', { link: { songId: input.songId, sourceId: file.sourceId, role } });
  return { ...file, linkId: (linked.output as { linkId: string }).linkId, runIds: [curated.runId, linked.runId] };
};
