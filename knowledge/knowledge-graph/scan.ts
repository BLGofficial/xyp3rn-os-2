import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';
import type { VaultStore } from '../source-registry/vault-store.ts';
import { declaredOwner, excludedBy, isText, mimeOf, ownerOf, TEXT_LIMIT, validIndexPath } from './scope.ts';

/**
 * The file index scan (AOS-04 Plan C1 Task 2, design §15.2): walks each root, hashes what changed, records who
 * owns each file, marks what disappeared, checks the Vault's bytes, and seals one `index_scans` row with the
 * counts. Writes as xyp_indexer only. The run row commits first, so a scan that fails is still on record.
 */

export const INDEXER_ROLE = 'xyp_indexer';

export type ScanRoot = { readonly id: string; readonly dir: string };
export type ScanCounts = {
  /** Files the scope admits (not excluded): indexed + failed. */
  readonly eligible: number;
  readonly indexed: number;
  /** Unreadable files plus paths the index can't hold. */
  readonly failed: number;
  readonly unsupportedPaths: number;
  /** Rows now missing in the scanned roots (files seen before and gone). */
  readonly missing: number;
  /** Excluded entries per rule; an excluded directory counts once and is never entered. */
  readonly excluded: Readonly<Record<string, number>>;
  readonly unreadableDirs: number;
  readonly vault: { readonly present: number; readonly missing: number; readonly corrupt: number };
};
export type ScanResult = {
  readonly scanId: string;
  readonly status: 'success' | 'error';
  readonly counts: ScanCounts;
  /** Unreadable files and directories, by path (never an excluded or unsupported one). */
  readonly failures: readonly { readonly path: string; readonly error: string }[];
  readonly error?: string;
};
export type ScanOptions = {
  readonly roots: readonly ScanRoot[];
  readonly trigger: 'cli' | 'boot' | 'owner';
  readonly store: Pick<VaultStore, 'has' | 'get'>;
  /** Rehash every file, and verify every Vault file's bytes, instead of trusting size and mtime. */
  readonly full?: boolean | undefined;
  /** The file reader (a seam: tests inject an unreadable file). */
  readonly read?: ((abs: string) => Promise<Uint8Array>) | undefined;
};

type Found = { readonly rel: string; readonly abs: string; readonly size: number; readonly mtimeMs: number };
type Row = {
  root: string; path: string; sha256: string | null; size_bytes: number; mime: string | null; mtime: Date; text_indexed: boolean;
  owner_domain: string | null; ownership_basis: string; status: 'present' | 'unreadable'; error: string | null;
  first_scan_id: string; last_scan_id: string; indexed_at: Date;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const asIndexer = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${INDEXER_ROLE}`);
    return fn(tx);
  }) as Promise<T>;

// Never follows a symlink: one inside the root is a second name for a file the walk reaches anyway; one outside,
// or broken, would read beyond the scope. Both are counted, neither indexed.
const walk = async (
  rootReal: string, dir: string, relDir: string,
  out: { files: Found[]; excluded: Record<string, number>; failures: { path: string; error: string }[] },
): Promise<void> => {
  const bump = (rule: string) => { out.excluded[rule] = (out.excluded[rule] ?? 0) + 1; };
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    out.failures.push({ path: `${relDir}/`, error: message(e) });
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) {
      const target = await realpath(abs).catch(() => null);
      bump(target !== null && target.startsWith(rootReal + sep) ? 'symlink' : 'symlink-escape');
      continue;
    }
    if (e.isDirectory()) {
      const rule = excludedBy(rel, true);
      if (rule) bump(rule);
      else await walk(rootReal, abs, rel, out);
      continue;
    }
    if (!e.isFile()) {
      bump('special-file');
      continue;
    }
    const rule = excludedBy(rel, false);
    if (rule) {
      bump(rule);
      continue;
    }
    const st = await lstat(abs);
    out.files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
  }
};

const insertRows = async (tx: postgres.TransactionSql, rows: readonly Row[]) => {
  // Chunked: Postgres takes at most 65 535 parameters per statement.
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await tx`
      insert into indexed_files ${tx(chunk as Row[], 'root', 'path', 'sha256', 'size_bytes', 'mime', 'mtime', 'text_indexed', 'owner_domain', 'ownership_basis', 'status', 'error', 'first_scan_id', 'last_scan_id', 'indexed_at')}
      on conflict (root, path) do update set
        sha256 = excluded.sha256, size_bytes = excluded.size_bytes, mime = excluded.mime, mtime = excluded.mtime,
        text_indexed = excluded.text_indexed, owner_domain = excluded.owner_domain, ownership_basis = excluded.ownership_basis,
        status = excluded.status, error = excluded.error, last_scan_id = excluded.last_scan_id, indexed_at = excluded.indexed_at`;
  }
};

/**
 * Scans the roots into the file index and checks the Vault's bytes.
 * @param sql - a pool that may `set role xyp_indexer`
 * @param o - roots, trigger, the Vault store, `full` and the reader seam
 * @returns the sealed scan: its id, status, counts and failures
 */
export const scanRoots = async (sql: Sql, o: ScanOptions): Promise<ScanResult> => {
  const read = o.read ?? ((abs: string) => readFile(abs));
  const [run] = await asIndexer(sql, (tx) => tx<{ id: string }[]>`
    insert into index_scans (trigger, roots) values (${o.trigger}, ${tx.json(o.roots.map((r) => ({ id: r.id, dir: r.dir })))}) returning id`);
  const scanId = run!.id;
  const excluded: Record<string, number> = {};
  const failures: { path: string; error: string }[] = [];
  const counts = { eligible: 0, indexed: 0, failed: 0, unsupportedPaths: 0, missing: 0, unreadableDirs: 0, vault: { present: 0, missing: 0, corrupt: 0 } };

  try {
    await asIndexer(sql, async (tx) => {
      // One scan at a time: a boot scan and an owner's Rescan would otherwise race on the same rows.
      await tx`select pg_advisory_xact_lock(hashtext('xyp_index_scan'))`;
      const now = new Date();
      for (const root of o.roots) {
        const rootReal = await realpath(root.dir);
        const found: { files: Found[]; excluded: Record<string, number>; failures: { path: string; error: string }[] } = { files: [], excluded, failures: [] };
        await walk(rootReal, rootReal, '', found);
        counts.unreadableDirs += found.failures.length;
        failures.push(...found.failures);

        const prev = new Map((await tx<{ id: string; path: string; size_bytes: string; mtime: Date; status: string }[]>`
          select id, path, size_bytes::text, mtime, status from indexed_files where root = ${root.id}`).map((r) => [r.path, r]));
        const rows: Row[] = [];
        const unchanged: string[] = [];
        for (const f of found.files) {
          counts.eligible++;
          if (!validIndexPath(f.rel)) {
            counts.unsupportedPaths++;
            counts.failed++;
            continue;
          }
          const mtime = new Date(Math.trunc(f.mtimeMs));
          const p = prev.get(f.rel);
          if (!o.full && p && p.status === 'present' && Number(p.size_bytes) === f.size && p.mtime.getTime() === mtime.getTime()) {
            unchanged.push(p.id);
            counts.indexed++;
            continue;
          }
          const base = { root: root.id, path: f.rel, size_bytes: f.size, mtime, first_scan_id: scanId, last_scan_id: scanId, indexed_at: now };
          let bytes: Uint8Array;
          try {
            bytes = await read(f.abs);
          } catch (e) {
            const owner = ownerOf(f.rel, null);
            rows.push({ ...base, sha256: null, mime: mimeOf(f.rel), text_indexed: false, owner_domain: owner.domain, ownership_basis: owner.basis, status: 'unreadable', error: message(e) });
            failures.push({ path: f.rel, error: message(e) });
            counts.failed++;
            continue;
          }
          const mime = mimeOf(f.rel);
          const textIndexed = bytes.length <= TEXT_LIMIT && isText(bytes, mime);
          const owner = ownerOf(f.rel, textIndexed ? declaredOwner(f.rel, new TextDecoder().decode(bytes)) : null);
          rows.push({ ...base, sha256: sha256(bytes), mime, text_indexed: textIndexed, owner_domain: owner.domain, ownership_basis: owner.basis, status: 'present', error: null });
          counts.indexed++;
        }
        await insertRows(tx, rows);
        if (unchanged.length > 0) await tx`update indexed_files set last_scan_id = ${scanId} where id = any(${unchanged}::uuid[])`;
        // Seen before, not now: gone (or renamed, which is a new path). Never deleted: history stays inspectable.
        await tx`update indexed_files set status = 'missing', error = null where root = ${root.id} and last_scan_id <> ${scanId} and status <> 'missing'`;
        const [m] = await tx<{ n: number }[]>`select count(*)::int as n from indexed_files where root = ${root.id} and status = 'missing'`;
        counts.missing += m!.n;
      }

      // The Vault: bytes are content-addressed, so presence is `has`; a full scan also re-hashes them (`get` verifies).
      const vault = await tx<{ id: string; checksum_sha256: string }[]>`select id, checksum_sha256 from sources where storage is not null`;
      for (const s of vault) {
        let status: 'present' | 'missing' | 'corrupt';
        if (o.full) {
          status = await o.store.get(s.checksum_sha256).then(() => 'present' as const, (e) => (/corrupt/.test(message(e)) ? 'corrupt' as const : 'missing' as const));
        } else {
          status = (await o.store.has(s.checksum_sha256)) ? 'present' : 'missing';
        }
        counts.vault[status]++;
        await tx`
          insert into index_vault_status (source_id, status, checked_at, scan_id) values (${s.id}, ${status}, ${now}, ${scanId})
          on conflict (source_id) do update set status = excluded.status, checked_at = excluded.checked_at, scan_id = excluded.scan_id`;
      }

      const sealed = { ...counts, excluded };
      await tx`update index_scans set status = 'success', finished_at = clock_timestamp(), counts = ${tx.json(sealed)} where id = ${scanId}`;
    });
    return { scanId, status: 'success', counts: { ...counts, excluded }, failures };
  } catch (e) {
    const error = message(e);
    await asIndexer(sql, (tx) => tx`update index_scans set status = 'error', finished_at = clock_timestamp(), error = ${error} where id = ${scanId}`);
    return { scanId, status: 'error', counts: { ...counts, excluded }, failures, error };
  }
};
