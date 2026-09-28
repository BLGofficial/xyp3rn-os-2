import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';
import type { VaultStore } from '../source-registry/vault-store.ts';
import { declaredOf, type DeclaredEdge, type DeclaredNode } from './declared.ts';
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

// Bulk writes go through unnest() over one array per column: one parameter per column whatever the row count,
// and plain tagged templates that both the root's TypeScript and Next's build type-check. Every array is sent as
// text[] and cast per column in the select: postgres.js serializes a boolean[] or jsonb[] parameter element by
// element with its own rules (a 'true' string becomes false; a JSON string is encoded twice), Postgres parses text.
const txt = (xs: readonly (string | number | boolean | null)[]): (string | null)[] => xs.map((x) => (x === null ? null : String(x)));

const insertRows = async (tx: postgres.TransactionSql, rows: readonly Row[]): Promise<Map<string, string>> => {
  if (rows.length === 0) return new Map();
  const col = <K extends keyof Row>(k: K) => txt(rows.map((r) => { const v = r[k]; return v instanceof Date ? v.toISOString() : v as string | number | boolean | null; }));
  const written = await tx<{ id: string; path: string }[]>`
    insert into indexed_files (root, path, sha256, size_bytes, mime, mtime, text_indexed, owner_domain, ownership_basis, status, error, first_scan_id, last_scan_id, indexed_at)
    select u.root, u.path, u.sha256, u.size_bytes::bigint, u.mime, u.mtime::timestamptz, u.text_indexed::boolean, u.owner_domain::public.xyp_domain,
           u.ownership_basis, u.status, u.error, u.first_scan_id::uuid, u.last_scan_id::uuid, u.indexed_at::timestamptz
    from unnest(${col('root')}::text[], ${col('path')}::text[], ${col('sha256')}::text[], ${col('size_bytes')}::text[], ${col('mime')}::text[],
                ${col('mtime')}::text[], ${col('text_indexed')}::text[], ${col('owner_domain')}::text[], ${col('ownership_basis')}::text[],
                ${col('status')}::text[], ${col('error')}::text[], ${col('first_scan_id')}::text[], ${col('last_scan_id')}::text[], ${col('indexed_at')}::text[])
      as u(root, path, sha256, size_bytes, mime, mtime, text_indexed, owner_domain, ownership_basis, status, error, first_scan_id, last_scan_id, indexed_at)
    on conflict (root, path) do update set
      sha256 = excluded.sha256, size_bytes = excluded.size_bytes, mime = excluded.mime, mtime = excluded.mtime,
      text_indexed = excluded.text_indexed, owner_domain = excluded.owner_domain, ownership_basis = excluded.ownership_basis,
      status = excluded.status, error = excluded.error, last_scan_id = excluded.last_scan_id, indexed_at = excluded.indexed_at
    returning id, path`;
  return new Map(written.map((w) => [w.path, w.id]));
};

type Changed = { readonly rel: string; readonly text: string; readonly sha256: string; readonly owner: ReturnType<typeof ownerOf> };

/**
 * Replaces the declarations of every file read this scan (and of every file gone missing or unreadable), then
 * writes the new ones. An id another file already declares stays with that file (the first path, sorted, on a
 * tie in this scan); the loser gets a `declares` diagnostic and none of that unit's nodes or edges.
 */
const writeDeclared = async (
  tx: postgres.TransactionSql, rootId: string, scanId: string, fileIds: ReadonlyMap<string, string>, stale: readonly string[],
  changed: readonly Changed[], files: ReadonlySet<string>,
) => {
  if (stale.length > 0) {
    await tx`delete from index_edges where file_id = any(${stale}::uuid[])`;
    await tx`delete from index_nodes where file_id = any(${stale}::uuid[])`;
  }
  const byFile = [...changed].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)).map((c) => ({ c, d: declaredOf({ rootId, rel: c.rel, text: c.text, owner: c.owner, files }) }));
  const wanted = byFile.flatMap(({ d }) => d.nodes.map((n) => n.id));
  const taken = new Map((await tx<{ id: string; path: string }[]>`
    select n.id, f.path from index_nodes n join indexed_files f on f.id = n.file_id where n.id = any(${wanted})`).map((r) => [r.id, r.path]));
  const nodes: (DeclaredNode & { fileId: string; sha256: string })[] = [];
  const edges: (DeclaredEdge & { fileId: string; sha256: string })[] = [];
  for (const { c, d } of byFile) {
    const fileId = fileIds.get(c.rel)!;
    const dropped = new Set<string>();
    for (const n of d.nodes) {
      // A workflow's steps go with it: a duplicate workflow drops its whole unit.
      const unit = n.kind === 'workflow_step' ? `workflow:${n.id.slice('workflow_step:'.length, n.id.indexOf('#'))}` : n.id;
      if (dropped.has(unit)) {
        dropped.add(n.id);
        continue;
      }
      const owner = taken.get(n.id);
      if (owner !== undefined) {
        dropped.add(n.id);
        edges.push({ relation: 'declares', fromId: `file:${rootId}/${c.rel}`, toId: null, line: n.line, detail: `duplicate ${n.id} (declared in ${owner})`, fileId, sha256: c.sha256 });
        continue;
      }
      taken.set(n.id, c.rel);
      nodes.push({ ...n, fileId, sha256: c.sha256 });
    }
    for (const e of d.edges) if (!dropped.has(e.fromId)) edges.push({ ...e, fileId, sha256: c.sha256 });
  }
  if (nodes.length > 0) {
    await tx`
      insert into index_nodes (id, kind, title, owner_domain, ownership_basis, file_id, line, revision, scan_id, detail)
      select u.id, u.kind, u.title, u.owner_domain::public.xyp_domain, u.basis, u.file_id::uuid, u.line::int, u.revision, ${scanId}, u.detail::jsonb
      from unnest(${txt(nodes.map((n) => n.id))}::text[], ${txt(nodes.map((n) => n.kind))}::text[], ${txt(nodes.map((n) => n.title))}::text[],
                  ${txt(nodes.map((n) => n.ownerDomain))}::text[], ${txt(nodes.map((n) => n.basis))}::text[], ${txt(nodes.map((n) => n.fileId))}::text[],
                  ${txt(nodes.map((n) => n.line))}::text[], ${txt(nodes.map((n) => n.revision))}::text[], ${txt(nodes.map((n) => JSON.stringify(n.detail)))}::text[])
        as u(id, kind, title, owner_domain, basis, file_id, line, revision, detail)`;
  }
  if (edges.length > 0) {
    await tx`
      insert into index_edges (relation, from_id, to_id, file_id, line, detail, revision, scan_id)
      select u.relation, u.from_id, u.to_id, u.file_id::uuid, u.line::int, u.detail, u.revision, ${scanId}
      from unnest(${txt(edges.map((e) => e.relation))}::text[], ${txt(edges.map((e) => e.fromId))}::text[], ${txt(edges.map((e) => e.toId))}::text[],
                  ${txt(edges.map((e) => e.fileId))}::text[], ${txt(edges.map((e) => e.line))}::text[], ${txt(edges.map((e) => e.detail))}::text[],
                  ${txt(edges.map((e) => e.sha256))}::text[])
        as u(relation, from_id, to_id, file_id, line, detail, revision)`;
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
        const changed: Changed[] = [];
        const files = new Set(found.files.map((f) => f.rel).filter(validIndexPath));
        for (const f of found.files) {
          counts.eligible++;
          if (!validIndexPath(f.rel)) {
            counts.unsupportedPaths++;
            counts.failed++;
            continue;
          }
          // Rounded, not truncated: a preserved mtime comes back through float seconds (utimes), a hair either side.
          const mtime = new Date(Math.round(f.mtimeMs));
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
          const text = textIndexed ? new TextDecoder().decode(bytes) : null;
          const owner = ownerOf(f.rel, text === null ? null : declaredOwner(f.rel, text));
          const hash = sha256(bytes);
          rows.push({ ...base, sha256: hash, mime, text_indexed: textIndexed, owner_domain: owner.domain, ownership_basis: owner.basis, status: 'present', error: null });
          if (text !== null) changed.push({ rel: f.rel, text, sha256: hash, owner });
          counts.indexed++;
        }
        const fileIds = await insertRows(tx, rows);
        if (unchanged.length > 0) await tx`update indexed_files set last_scan_id = ${scanId} where id = any(${unchanged}::uuid[])`;
        // Seen before, not now: gone (or renamed, which is a new path). Never deleted: history stays inspectable.
        const gone = await tx<{ id: string }[]>`
          update indexed_files set status = 'missing', error = null where root = ${root.id} and last_scan_id <> ${scanId} and status <> 'missing' returning id`;
        // Every file written this scan (read, or now unreadable) and every file now missing loses its old declarations.
        await writeDeclared(tx, root.id, scanId, fileIds, [...fileIds.values(), ...gone.map((g) => g.id)], changed, files);
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
