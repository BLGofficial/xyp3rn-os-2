import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRoots } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, type TestDb } from '../../../tests/helpers/db.ts';
import { openIndexedFile } from './graph-files.ts';

// AOS-04 Plan C1 Task 7 (design §15.2, file safety): the viewer takes an opaque index id, resolves the path from
// the database, re-checks the real path against the root, verifies the checksum, and caps what it returns.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let db: TestDb;
const root = mkdtempSync(join(tmpdir(), 'aos04-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos04-files-vault-'));
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const idOf = async (path: string) => (await db.sql<{ id: string }[]>`select id from indexed_files where root = 'repo' and path = ${path}`)[0]!.id;
const open = (id: string, maxBytes?: number) => openIndexedFile(db.sql, id, { roots: { repo: root }, ...(maxBytes ? { maxBytes } : {}) });
const BIG = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, '0')} [FIXTURE] ${'x'.repeat(40)}`).join('\n') + '\n';

beforeAll(async () => {
  db = await createTestDb('aos04_files', { migrated: true });
  put('docs/readme.md', '# [FIXTURE] readme\n');
  put('docs/script.html', '<script>alert("[FIXTURE]")</script>\n');
  put('docs/big.txt', BIG);
  put('docs/swapped.md', '[FIXTURE] about to become a symlink\n');
  put('docs/edited.md', '[FIXTURE] before\n');
  put('docs/gone.md', '[FIXTURE] about to be deleted\n');
  put('image.png', '\x89PNG\r\n\x1a\n\x00\x00');
  expect((await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir) })).status).toBe('success');
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('openIndexedFile', () => {
  it('opens an indexed text file by its opaque id, with its checksum', async () => {
    const r = await open(await idOf('docs/readme.md'));
    expect(r).toMatchObject({ ok: true, text: '# [FIXTURE] readme\n', truncated: false, file: { path: 'docs/readme.md', sha256: sha('# [FIXTURE] readme\n'), root: 'repo' } });
  });

  it('refuses anything that is not an indexed id: paths, traversal, drive letters, UNC, unknown uuids', async () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'docs/readme.md', 'C:\\Windows\\win.ini', '\\\\server\\share\\x', randomUUID(), '']) {
      expect(await open(bad)).toEqual({ ok: false, reason: 'not-found' });
    }
  });

  it('refuses a file swapped for a symlink after the scan, and returns no bytes', async () => {
    const id = await idOf('docs/swapped.md');
    unlinkSync(join(root, 'docs/swapped.md'));
    symlinkSync('/etc/passwd', join(root, 'docs/swapped.md'));
    const r = await open(id);
    expect(r).toEqual({ ok: false, reason: 'escaped' });
  });

  it('refuses a row whose path escapes the root, even if the database held one', async () => {
    // Defence in depth: a directory symlink inside the root that points outside. The scan never follows it; a row
    // naming a path through it (written here directly, as a tampered index would) must still be refused.
    const id = await idOf('docs/readme.md');
    const outside = mkdtempSync(join(tmpdir(), 'aos04-outside-'));
    try {
      symlinkSync(outside, join(root, 'linked-dir'));
      await db.sql`update indexed_files set path = 'linked-dir/readme.md' where id = ${id}`;
      writeFileSync(join(outside, 'readme.md'), '# [FIXTURE] readme\n');
      expect(await open(id)).toEqual({ ok: false, reason: 'escaped' });
    } finally {
      await db.sql`update indexed_files set path = 'docs/readme.md' where id = ${id}`;
      unlinkSync(join(root, 'linked-dir'));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to show a file that changed since the scan, naming both checksums', async () => {
    const id = await idOf('docs/edited.md');
    writeFileSync(join(root, 'docs/edited.md'), '[FIXTURE] after\n');
    expect(await open(id)).toEqual({ ok: false, reason: 'changed', indexed: sha('[FIXTURE] before\n'), current: sha('[FIXTURE] after\n') });
  });

  it('says missing for a file deleted since the scan', async () => {
    const id = await idOf('docs/gone.md');
    unlinkSync(join(root, 'docs/gone.md'));
    expect(await open(id)).toEqual({ ok: false, reason: 'missing' });
  });

  it('truncates a long text at a line boundary and says so', async () => {
    const r = await open(await idOf('docs/big.txt'), 4096);
    expect(r).toMatchObject({ ok: true, truncated: true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.text!.length).toBeLessThanOrEqual(4096);
    expect(r.text!.endsWith('\n')).toBe(true);
    expect(BIG.startsWith(r.text!)).toBe(true);
  });

  it('returns markup as plain text (the page escapes it) and no text for a binary', async () => {
    const html = await open(await idOf('docs/script.html'));
    expect(html).toMatchObject({ ok: true, text: '<script>alert("[FIXTURE]")</script>\n' });
    const png = await open(await idOf('image.png'));
    expect(png).toMatchObject({ ok: true, text: null, file: { textIndexed: false } });
  });
});
