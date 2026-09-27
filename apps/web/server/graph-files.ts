import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Sql } from '../../../core/db/client.ts';
import { asWeb } from './loaders.ts';

/**
 * The repository-file viewer's one door (AOS-04 Plan C1 Task 7, design §15.2 file safety). The browser sends an
 * opaque index id, never a path: the path comes from the database, is joined under its root's real path, must
 * still resolve inside that root with no symlink at the end, and the bytes must hash to the indexed checksum.
 * Anything else is refused with a reason and no bytes.
 */

// The index roots the web serves from: this checkout, as `repo` (Plan C1 choice 2). graph-ops scans the same.
export const INDEX_ROOTS: Readonly<Record<string, string>> = { repo: join(import.meta.dirname, '..', '..', '..') };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_BYTES = 262_144;

export type IndexedFile = {
  readonly id: string; readonly root: string; readonly path: string; readonly sha256: string; readonly sizeBytes: number; readonly mime: string | null;
  readonly textIndexed: boolean; readonly ownerDomain: string | null; readonly ownershipBasis: string; readonly indexedAt: string;
};
export type Opened =
  | { readonly ok: true; readonly file: IndexedFile; readonly text: string | null; readonly truncated: boolean; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'not-found' | 'missing' | 'escaped' | 'unreadable' }
  | { readonly ok: false; readonly reason: 'changed'; readonly indexed: string; readonly current: string };

const refuse = (reason: 'not-found' | 'missing' | 'escaped' | 'unreadable'): Opened => ({ ok: false, reason });

/**
 * @param sql - the app's pool (the row is read as xyp_web)
 * @param id - indexed_files.id, as the browser sent it
 * @param o.roots - each index root's directory (the web passes { repo: <this checkout> })
 * @param o.maxBytes - the text preview's cap; a longer text is cut at the last line break before it
 * @returns the file with its text (null for a binary or oversize file) and bytes, or the reason it was refused
 */
export const openIndexedFile = async (sql: Sql, id: string, o: { readonly roots: Readonly<Record<string, string>>; readonly maxBytes?: number }): Promise<Opened> => {
  if (!UUID.test(id)) return refuse('not-found');
  const [row] = await asWeb(sql, (tx) => tx<{
    id: string; root: string; path: string; sha256: string | null; size_bytes: string; mime: string | null; text_indexed: boolean;
    owner_domain: string | null; ownership_basis: string; status: string; indexed_at: Date;
  }[]>`select id, root, path, sha256, size_bytes::text, mime, text_indexed, owner_domain::text, ownership_basis, status, indexed_at
       from indexed_files where id = ${id}`);
  if (!row) return refuse('not-found');
  if (row.status === 'missing') return refuse('missing');
  if (row.status !== 'present' || row.sha256 === null) return refuse('unreadable');
  const dir = o.roots[row.root];
  if (!dir) return refuse('not-found');

  const rootReal = await realpath(dir);
  const abs = join(rootReal, ...row.path.split('/'));
  const real = await realpath(abs).catch(() => null);
  if (real === null) return refuse('missing');
  // Inside the root, and not a symlink: the index never records one, so a symlink here was swapped in.
  if (!real.startsWith(rootReal + sep) || (await lstat(abs)).isSymbolicLink()) return refuse('escaped');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(real));
  } catch {
    return refuse('unreadable');
  }
  const current = createHash('sha256').update(bytes).digest('hex');
  if (current !== row.sha256) return { ok: false, reason: 'changed', indexed: row.sha256, current };

  const max = o.maxBytes ?? PREVIEW_BYTES;
  let text: string | null = null;
  let truncated = false;
  if (row.text_indexed) {
    if (bytes.length > max) {
      const head = new TextDecoder().decode(bytes.subarray(0, max)).replace(/�$/, '');
      const cut = head.lastIndexOf('\n');
      text = cut >= 0 ? head.slice(0, cut + 1) : head;
      truncated = true;
    } else {
      text = new TextDecoder().decode(bytes);
    }
  }
  return {
    ok: true, text, truncated, bytes,
    file: {
      id: row.id, root: row.root, path: row.path, sha256: row.sha256, sizeBytes: Number(row.size_bytes), mime: row.mime, textIndexed: row.text_indexed,
      ownerDomain: row.owner_domain, ownershipBasis: row.ownership_basis, indexedAt: row.indexed_at.toISOString(),
    },
  };
};

/**
 * The web's viewer entry: openIndexedFile over INDEX_ROOTS.
 * @param sql - the app's pool
 * @param id - indexed_files.id from the URL
 * @returns see openIndexedFile
 */
export const openRepoFile = (sql: Sql, id: string): Promise<Opened> => openIndexedFile(sql, id, { roots: INDEX_ROOTS });
