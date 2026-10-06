import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { sha256Hex } from '../source-registry/acquire.ts';
import { asRole, VAULT_ROLE } from '../source-registry/vault-tools.ts';
import { EXPORT_DIR } from './notes.ts';

/**
 * Obsidian sync tools (F54). write_obsidian_note (external.execute) is the only code that writes into the
 * owner's vault; record_obsidian_sync (vault.write, as xyp_vault) appends the ledger row.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const obj = (tool: string, args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: input must be an object`);
  return args as Record<string, unknown>;
};
const text = (tool: string, field: string, v: unknown): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`${tool}: ${field} must be a non-empty string`);
  return v;
};
const uuid = (tool: string, field: string, v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${tool}: ${field} must be a uuid`);
  return v;
};

/**
 * Checks an export path: posix, relative, under EXPORT_DIR, a `.md` note, no `..`.
 * @param notePath - vault-relative path
 * @returns the path
 * @throws naming the rule broken
 */
export const checkExportPath = (notePath: string): string => {
  if (notePath.includes('\\') || notePath.startsWith('/') || /^[A-Za-z]:/.test(notePath)) throw new Error(`write_obsidian_note: ${notePath} must be a vault-relative posix path`);
  if (notePath.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error(`write_obsidian_note: ${notePath} has an empty, "." or ".." segment`);
  if (!notePath.startsWith(`${EXPORT_DIR}/`)) throw new Error(`write_obsidian_note: the OS writes only under "${EXPORT_DIR}/"; refused ${notePath}`);
  if (!notePath.endsWith('.md')) throw new Error(`write_obsidian_note: ${notePath} is not a .md note`);
  return notePath;
};

const lstatOrNull = async (p: string) => {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/**
 * write_obsidian_note (external.execute): writes one OS note into the vault, only if the file on disk is
 * still what the previewed plan expected (`expectedSha`, or absent when null). Never follows a symbolic
 * link or junction on the way, so a link inside the vault can't redirect the write elsewhere. Writes a
 * temp file beside it and renames, so Obsidian never reads half a note.
 * @returns the tool definition
 */
export const createWriteObsidianNoteTool = (): Tool =>
  defineTool({
    name: 'write_obsidian_note',
    capability: 'external.execute',
    description: `Write one note under "${EXPORT_DIR}/" in the owner's Obsidian vault, only if the file is unchanged since the previewed plan.`,
    handler: async (ctx, args) => {
      const a = obj('write_obsidian_note', args);
      const root = text('write_obsidian_note', 'vaultRoot', a.vaultRoot);
      if (!isAbsolute(root)) throw new Error('write_obsidian_note: vaultRoot must be an absolute path');
      const notePath = checkExportPath(text('write_obsidian_note', 'notePath', a.notePath));
      if (typeof a.content !== 'string') throw new Error('write_obsidian_note: content must be a string');
      const expected = a.expectedSha === null ? null : text('write_obsidian_note', 'expectedSha', a.expectedSha);
      if (expected !== null && !SHA256.test(expected)) throw new Error('write_obsidian_note: expectedSha must be 64 lowercase hex characters or null');

      const rootStat = await lstatOrNull(root);
      if (!rootStat?.isDirectory()) throw new Error(`write_obsidian_note: the vault root is not a folder: ${root}`);
      const target = join(root, ...notePath.split('/'));
      const rel = relative(root, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`write_obsidian_note: ${notePath} resolves outside the vault`);
      // Every existing segment below the root must be a real folder (the last a real file or absent).
      const segs = rel.split(sep);
      for (let i = 1; i <= segs.length; i++) {
        const s = await lstatOrNull(join(root, ...segs.slice(0, i)));
        if (s === null) break;
        if (s.isSymbolicLink()) throw new Error(`write_obsidian_note: ${segs.slice(0, i).join('/')} is a link; the OS never writes through one`);
        if (i < segs.length && !s.isDirectory()) throw new Error(`write_obsidian_note: ${segs.slice(0, i).join('/')} is not a folder`);
      }
      const existing = await lstatOrNull(target);
      const current = existing === null ? null : sha256Hex(new Uint8Array(await readFile(target)));
      if (current !== expected) {
        throw new Error(`write_obsidian_note: ${notePath} changed since the preview (expected ${expected ?? 'no file'}, found ${current ?? 'no file'}); preview the sync again`);
      }
      const bytes = new TextEncoder().encode(a.content);
      await mkdir(join(root, ...notePath.split('/').slice(0, -1)), { recursive: true });
      const tmp = `${target}.${randomUUID()}.xyp-tmp`;
      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await rename(tmp, target);
      } finally {
        await rm(tmp, { force: true });
      }
      const sha256 = sha256Hex(bytes);
      ctx.log('info', `write_obsidian_note: ${notePath} (${current === null ? 'created' : 'updated'})`);
      return { notePath, sha256, previousSha: current };
    },
  });

/**
 * record_obsidian_sync (vault.write): one ledger row, as xyp_vault. The DB checks the path shape, the
 * hashes, and that an import names its Vault file and an export none.
 * @param deps - pool
 * @returns the tool definition
 */
export const createRecordObsidianSyncTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'record_obsidian_sync',
    capability: 'vault.write',
    description: 'Append one Obsidian sync ledger row: a note imported into the Vault, or written by the OS.',
    handler: async (ctx, args) => {
      const a = obj('record_obsidian_sync', args);
      const vaultRoot = text('record_obsidian_sync', 'vaultRoot', a.vaultRoot);
      const notePath = text('record_obsidian_sync', 'notePath', a.notePath);
      const direction = text('record_obsidian_sync', 'direction', a.direction);
      if (direction !== 'import' && direction !== 'export') throw new Error('record_obsidian_sync: direction must be import or export');
      const sha256 = text('record_obsidian_sync', 'sha256', a.sha256);
      const planHash = text('record_obsidian_sync', 'planHash', a.planHash);
      const sourceId = a.sourceId === undefined || a.sourceId === null ? null : uuid('record_obsidian_sync', 'sourceId', a.sourceId);
      const [row] = await asRole(deps.sql, VAULT_ROLE, (tx) => tx<{ id: string }[]>`
        insert into obsidian_sync_events (vault_root, note_path, direction, sha256, source_id, plan_hash, agent_run_id)
        values (${vaultRoot}, ${notePath}, ${direction}, ${sha256}, ${sourceId}, ${planHash}, ${ctx.runId})
        returning id`);
      ctx.log('info', `record_obsidian_sync: ${direction} ${notePath} → ${row!.id}`);
      return { eventId: row!.id };
    },
  });

/**
 * @param deps - pool
 * @returns write_obsidian_note, record_obsidian_sync
 */
export const createObsidianTools = (deps: { readonly sql: Sql }): readonly Tool[] => [createWriteObsidianNoteTool(), createRecordObsidianSyncTool(deps)];
