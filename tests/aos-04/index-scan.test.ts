import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { excludedBy, ownerOf, validIndexPath } from '../../knowledge/knowledge-graph/scope.ts';
import { scanRoots, type ScanResult } from '../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertRun } from '../helpers/records-fixture.ts';
import { linkTo } from '../helpers/symlink.ts';

// AOS-04 Plan C1 Task 2: the scan. A fixture root built here (the real checkout is never walked by this test);
// the index rows written as xyp_indexer; counts that add up; nothing excluded ever named.

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const OVERSIZE = 1_048_577;
const LOCKED = 'docs/locked.md';
// A backslash is a separator on Windows, so that filesystem cannot hold the unsupported-path fixture at all.
const ODD = process.platform === 'win32' ? 0 : 1;

let db: TestDb;
let root: string;
let vaultDir: string;
let outsideDir: string;
let first: ScanResult;

const put = async (rel: string, body: string | Uint8Array) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), body);
};
// Tests run as root here, where mode 000 doesn't stop a read: the unreadable file is an injected EACCES.
const read = async (abs: string): Promise<Buffer> => {
  if (abs === join(root, LOCKED)) throw Object.assign(new Error(`EACCES: permission denied, open '${abs}'`), { code: 'EACCES' });
  return readFile(abs);
};
const scan = (o: { full?: boolean; rootId?: string } = {}) =>
  scanRoots(db.sql, { roots: [{ id: o.rootId ?? 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir), full: o.full, read });
const fileRow = async (path: string) =>
  (await db.sql<{ id: string; sha256: string | null; status: string; owner_domain: string | null; ownership_basis: string; text_indexed: boolean; first_scan_id: string; last_scan_id: string; error: string | null }[]>`
    select id, sha256, status, owner_domain::text, ownership_basis, text_indexed, first_scan_id, last_scan_id, error from indexed_files where root = 'repo' and path = ${path}`)[0];

beforeAll(async () => {
  db = await createTestDb('aos04_scan', { migrated: true });
  root = await mkdtemp(join(tmpdir(), 'xyp-index-'));
  vaultDir = await mkdtemp(join(tmpdir(), 'xyp-vault-'));
  await put('records/a.ts', "export const a = '[FIXTURE] a';\n");
  await put('records/b.md', '[FIXTURE] b\n');
  await put('agents/fixture-scan.agent.md', '---\nname: fixture-scan\nclass: Execution\ndomain: RECORDS\ntools: []\nmodel: none\n---\n\n# [FIXTURE]\n');
  await put('docs/y.md', '[FIXTURE] y\n');
  await put(LOCKED, '[FIXTURE] locked\n');
  await put('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  await put('big.txt', 'x'.repeat(OVERSIZE));
  if (ODD) await put('odd\\name.txt', '[FIXTURE] a backslash is a legal Linux filename but not an index path\n');
  // Excluded, and never named anywhere the scan writes:
  await put('.env', 'SECRET=[FIXTURE]\n');
  await put('.env.example', 'SECRET=\n');
  await put('id_rsa', '[FIXTURE] not a key\n');
  await put('notes.bak', '[FIXTURE] backup\n');
  await put('node_modules/pkg/index.js', '');
  await put('.git/HEAD', 'ref: refs/heads/main\n');
  await put('.vault/ab/abc', '');
  outsideDir = await mkdtemp(join(tmpdir(), 'xyp-outside-'));
  await writeFile(join(outsideDir, 'hostname'), '[FIXTURE] outside the root\n');
  linkTo(join(outsideDir, 'hostname'), join(root, 'escape-link'));
  linkTo(join(root, 'records', 'a.ts'), join(root, 'records', 'alias.ts'));
  first = await scan();
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await rm(root, { recursive: true, force: true });
  await rm(vaultDir, { recursive: true, force: true });
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
});

describe('scope', () => {
  it('excludes by rule, at any depth, and names the rule', () => {
    expect(excludedBy('.env', false)).toBe('credentials');
    expect(excludedBy('apps/web/.env.local', false)).toBe('credentials');
    expect(excludedBy('.env.example', false)).toBe('credentials');
    expect(excludedBy('keys/server.pem', false)).toBe('credentials');
    expect(excludedBy('apps/web/node_modules', true)).toBe('dependencies');
    expect(excludedBy('apps/web/.next', true)).toBe('build-output');
    expect(excludedBy('tsconfig.tsbuildinfo', false)).toBe('build-output');
    expect(excludedBy('.git', true)).toBe('vcs');
    expect(excludedBy('.local-db', true)).toBe('runtime-state');
    expect(excludedBy('.vault', true)).toBe('runtime-state');
    expect(excludedBy('a.orig', false)).toBe('backups');
    expect(excludedBy('docs/ARCHITECTURE.md', false)).toBeNull();
    expect(excludedBy('.gitignore', false)).toBeNull();
  });

  it('mirrors the database path rule', () => {
    for (const ok of ['a', 'docs/ARCHITECTURE.md', '.nvmrc', 'apps/web/app/[id]/page.tsx']) expect(validIndexPath(ok)).toBe(true);
    for (const bad of ['', '/a', 'a/', 'a//b', '../a', 'a/./b', 'C:/a', 'a\\b', 'a\nb']) expect(validIndexPath(bad)).toBe(false);
  });

  it('owns a file by registration, then by domain path, else Shared', () => {
    expect(ownerOf('agents/x.agent.md', { domain: 'RECORDS', basis: 'frontmatter' })).toEqual({ domain: 'RECORDS', basis: 'frontmatter' });
    expect(ownerOf('records/x.ts', null)).toEqual({ domain: 'RECORDS', basis: 'domain-path' });
    expect(ownerOf('research-intelligence/x.ts', null)).toEqual({ domain: 'RESEARCH_INTELLIGENCE', basis: 'domain-path' });
    for (const shared of ['docs/ARCHITECTURE.md', 'apps/web/app/page.tsx', 'tests/x.test.ts', 'supabase/x.sql', 'scripts/x.ts', 'agents/x.agent.md', 'README.md']) {
      expect(ownerOf(shared, null)).toEqual({ domain: null, basis: 'shared' });
    }
  });
});

describe('the first scan', () => {
  it('adds up: eligible = indexed + failed, excluded counted per rule, sealed success', async () => {
    expect(first.status).toBe('success');
    expect(first.counts).toMatchObject({
      eligible: 7 + ODD, indexed: 6, failed: 1 + ODD, missing: 0,
      excluded: { credentials: 3, backups: 1, dependencies: 1, vcs: 1, 'runtime-state': 1, symlink: 1, 'symlink-escape': 1 },
    });
    expect(first.failures.map((f) => f.path).sort()).toEqual([LOCKED].sort());
    expect(first.failures.find((f) => f.path === LOCKED)!.error).toMatch(/EACCES/);
    const [run] = await db.sql<{ status: string; counts: unknown; trigger: string; finished_at: Date | null }[]>`
      select status, counts, trigger, finished_at from index_scans where id = ${first.scanId}`;
    expect(run).toMatchObject({ status: 'success', trigger: 'cli', counts: first.counts });
    expect(run!.finished_at).not.toBeNull();
  });

  it.skipIf(!ODD)('counts a path the index cannot hold as failed, without naming it', () => {
    expect(first.counts.unsupportedPaths).toBe(1);
    expect(JSON.stringify(first)).not.toContain('odd');
  });

  it('never names an excluded file, in the result or the database', async () => {
    const text = JSON.stringify(first) + JSON.stringify(await db.sql`select path from indexed_files`);
    for (const secret of ['.env', 'id_rsa', 'notes.bak', 'node_modules', '.git/', '.vault', 'escape-link', 'hostname']) expect(text).not.toContain(secret);
  });

  it('owns the agent by frontmatter, records/ by path, docs/ as Shared', async () => {
    expect(await fileRow('agents/fixture-scan.agent.md')).toMatchObject({ owner_domain: 'RECORDS', ownership_basis: 'frontmatter' });
    expect(await fileRow('records/a.ts')).toMatchObject({ owner_domain: 'RECORDS', ownership_basis: 'domain-path' });
    expect(await fileRow('docs/y.md')).toMatchObject({ owner_domain: null, ownership_basis: 'shared' });
  });

  it('hashes binaries and oversize text but indexes only readable text', async () => {
    expect(await fileRow('image.png')).toMatchObject({ status: 'present', text_indexed: false });
    expect((await fileRow('big.txt'))!.sha256).toBe(sha('x'.repeat(OVERSIZE)));
    expect(await fileRow('big.txt')).toMatchObject({ text_indexed: false });
    expect(await fileRow('records/a.ts')).toMatchObject({ status: 'present', text_indexed: true, sha256: sha("export const a = '[FIXTURE] a';\n") });
  });

  it('records the unreadable file with its error and no checksum', async () => {
    expect(await fileRow(LOCKED)).toMatchObject({ status: 'unreadable', sha256: null });
    expect((await fileRow(LOCKED))!.error).toMatch(/EACCES/);
  });

  it('never follows a symlink: the inside one is indexed once under its real path, the outside one not at all', async () => {
    expect(await fileRow('records/alias.ts')).toBeUndefined();
    expect(await fileRow('records/a.ts')).toBeDefined();
    expect(await fileRow('escape-link')).toBeUndefined();
  });
});

describe('rescans', () => {
  it('keeps unchanged files, rehashes a modified one, splits a rename, marks a deletion missing', async () => {
    const before = await fileRow('records/a.ts');
    await writeFile(join(root, 'records/b.md'), '[FIXTURE] b, edited\n');
    await rename(join(root, 'docs/y.md'), join(root, 'docs/z.md'));
    await unlink(join(root, 'records/alias.ts'));
    const again = await scan();
    expect(again.status).toBe('success');
    expect(again.counts.missing).toBe(1);
    const a = await fileRow('records/a.ts');
    expect(a).toMatchObject({ first_scan_id: before!.first_scan_id, last_scan_id: again.scanId, sha256: before!.sha256 });
    expect((await fileRow('records/b.md'))!.sha256).toBe(sha('[FIXTURE] b, edited\n'));
    // Same bytes, two identities: a rename is never merged by content.
    expect(await fileRow('docs/y.md')).toMatchObject({ status: 'missing', sha256: sha('[FIXTURE] y\n') });
    expect(await fileRow('docs/z.md')).toMatchObject({ status: 'present', sha256: sha('[FIXTURE] y\n'), first_scan_id: again.scanId });

    await unlink(join(root, 'records/a.ts'));
    const third = await scan();
    expect(await fileRow('records/a.ts')).toMatchObject({ status: 'missing' });
    expect(third.counts.missing).toBe(2);
  });

  it('trusts size and mtime on a quick scan, and rehashes everything on --full', async () => {
    const p = join(root, 'records/b.md');
    const st = await stat(p);
    await writeFile(p, '[FIXTURE] B, EDITED\n'); // same length, different bytes
    await utimes(p, st.atime, st.mtime);
    await scan();
    expect((await fileRow('records/b.md'))!.sha256).toBe(sha('[FIXTURE] b, edited\n'));
    const full = await scan({ full: true });
    expect(full.status).toBe('success');
    expect((await fileRow('records/b.md'))!.sha256).toBe(sha('[FIXTURE] B, EDITED\n'));
  });
});

describe('the Vault check', () => {
  it('records Vault bytes present, missing, and corrupt on a full scan', async () => {
    const store = createLocalVaultStore(vaultDir);
    const kept = new TextEncoder().encode(`[FIXTURE] kept ${randomUUID()}`);
    const { sha256: keptSha } = await store.put(kept);
    const lostSha = sha(`[FIXTURE] lost ${randomUUID()}`);
    const damaged = new TextEncoder().encode(`[FIXTURE] damaged ${randomUUID()}`);
    const { sha256: damagedSha } = await store.put(damaged);
    await writeFile(join(vaultDir, damagedSha.slice(0, 2), damagedSha), '[FIXTURE] overwritten');
    const runId = await insertRun(db.sql, 'vault-curator', 'Execution');
    const ids: Record<string, string> = {};
    for (const [key, s, size] of [['kept', keptSha, kept.length], ['lost', lostSha, 10], ['damaged', damagedSha, damaged.length]] as const) {
      ids[key] = await asCommitted(db.sql, 'xyp_vault', async (tx) => (await tx<{ id: string }[]>`
        insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, storage, media_class, language, agent_run_id)
        values ('file', ${`vault://${s}`}, ${`[FIXTURE] ${key}`}, ${s}, 'text/plain', ${size}, 'local-vault', 'document', 'en', ${runId})
        returning id`)[0]!.id);
    }
    const quick = await scan();
    expect(quick.counts.vault).toEqual({ present: 2, missing: 1, corrupt: 0 });
    const full = await scan({ full: true });
    expect(full.counts.vault).toEqual({ present: 1, missing: 1, corrupt: 1 });
    const rows = await db.sql<{ source_id: string; status: string }[]>`select source_id, status from index_vault_status`;
    expect(Object.fromEntries(rows.map((r) => [r.source_id, r.status]))).toEqual({ [ids.kept!]: 'present', [ids.lost!]: 'missing', [ids.damaged!]: 'corrupt' });
  });
});

describe('a failed scan', () => {
  it('is sealed error with the database message, and leaves the index as it was', async () => {
    const before = await db.sql`select count(*)::int as n from indexed_files`;
    const bad = await scan({ rootId: 'Bad Root' });
    expect(bad.status).toBe('error');
    const [run] = await db.sql<{ status: string; error: string }[]>`select status, error from index_scans where id = ${bad.scanId}`;
    expect(run!.status).toBe('error');
    expect(run!.error).toMatch(/indexed_files_root_check/);
    expect(await db.sql`select count(*)::int as n from indexed_files`).toEqual(before);
  });
});
