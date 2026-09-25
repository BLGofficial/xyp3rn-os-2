import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../core/db/client.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// AOS-01: `pnpm vault` as the owner runs it: a real process against a throwaway migrated database
// and a temporary Vault store. Proves the wiring (connection, tool set, store location, exit codes);
// the behaviour behind each command is proven in vault-ingest.test.ts.

let db: TestDb;
const files = mkdtempSync(join(tmpdir(), 'aos01-cli-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos01-cli-vault-'));

beforeAll(async () => {
  db = await createTestDb('aos01_vault_cli', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
  rmSync(files, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

const vault = (...args: string[]) => {
  const url = new URL(databaseUrl());
  url.pathname = `/${db.name}`;
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'records', 'vault', 'cli.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, XYP_DATABASE_URL: url.toString(), XYP_VAULT_DIR: vaultDir }, timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, any> };
};

describe('pnpm vault', () => {
  it('song create → add a lyric sheet to it → edit → approve; the store is XYP_VAULT_DIR', async () => {
    const song = vault('song', 'create', '--title', '[FIXTURE] Night City', '--artist', 'X3LIUS', '--language', 'en');
    expect(song.code, song.err).toBe(0);
    const songId = song.json().songId as string;

    const sheet = join(files, 'night-city.txt');
    writeFileSync(sheet, '[Verse 1]\nNight city lights\n[Chorus]\nWe run tonight\n');
    const added = vault('add', sheet, '--as', 'lyric_sheet', '--language', 'en', '--song', songId, '--tags', 'New Era,demo');
    expect(added.code, added.err).toBe(0);
    const { file, lyrics } = added.json();
    expect(file).toMatchObject({ status: 'added', mediaClass: 'lyric_sheet' });
    expect(lyrics).toMatchObject({ version: 1, warnings: [] });
    expect(spawnSync('ls', [join(vaultDir, (file.sha256 as string).slice(0, 2))], { encoding: 'utf8' }).stdout.trim()).toBe(file.sha256);

    const edit = join(files, 'night-city-v2.txt');
    writeFileSync(edit, '[Verse 1]\nNight city lights, neon rain\n[Chorus]\nWe run tonight\n');
    const edited = vault('edit', lyrics.artifactId, edit);
    expect(edited.code, edited.err).toBe(0);
    expect(edited.json()).toMatchObject({ lineageId: lyrics.lineageId, version: 2 });

    const approved = vault('approve', lyrics.artifactId, '--reason', '[FIXTURE] v1 is the take');
    expect(approved.code, approved.err).toBe(0);
    expect(approved.json()).toMatchObject({ status: 'approved', version: 1, approvedVersion: 1 });
    expect((await db.sql`select decided_by from approval_queue where item_id = ${lyrics.artifactId}`)[0]).toEqual({ decided_by: 'owner' });

    const links = await db.sql`select kind, role from current_song_links where song_id = ${songId} order by created_at`;
    expect(links).toEqual([{ kind: 'source', role: 'lyric-sheet' }, { kind: 'artifact_lineage', role: 'lyrics' }]);
  });

  it('song revise, link and unlink', () => {
    const songId = vault('song', 'create', '--title', '[FIXTURE] Outro', '--artist', 'X3LIUS').json().songId as string;
    expect(vault('song', 'revise', songId, '--status', 'writing').json()).toEqual({ songId, revision: 2 });
    const doc = join(files, 'outro-notes.md');
    writeFileSync(doc, '# Outro\n\nFade on the pad, no drums.\n');
    const fileId = vault('add', doc).json().file.sourceId as string;
    const link = vault('song', 'link', songId, '--file', fileId, '--role', 'notes');
    expect(link.code, link.err).toBe(0);
    expect(link.json()).toMatchObject({ kind: 'source', targetId: fileId, role: 'notes' });
    const unlink = vault('song', 'unlink', link.json().linkId, '--reason', '[FIXTURE] wrong song');
    expect(unlink.json()).toMatchObject({ retracted: true });
  });

  it('export, then import into the same database: nothing new, every record skipped', () => {
    const out = join(files, 'export');
    const exported = vault('export', out);
    expect(exported.code, exported.err).toBe(0);
    const { records, blobs } = exported.json();
    expect(records).toBeGreaterThan(0);
    expect(blobs).toBe(2);
    const imported = vault('import', out);
    expect(imported.code, imported.err).toBe(0);
    expect(imported.json()).toEqual({ records, inserted: 0, skipped: records, blobs });
    expect(vault('export', out)).toMatchObject({ code: 1, err: expect.stringMatching(/not empty/) });
  });

  it('usage errors exit 2 with the reason; a refused operation exits 1 with the agent\'s error', () => {
    expect(vault('approve', '00000000-0000-4000-8000-000000000000')).toMatchObject({ code: 2, err: expect.stringMatching(/--reason/) });
    expect(vault('frobnicate')).toMatchObject({ code: 2, err: expect.stringMatching(/unknown command/) });
    expect(vault('add', join(files, 'x.txt'), '--bogus', '1')).toMatchObject({ code: 2 });
    expect(vault('song', 'link', '00000000-0000-4000-8000-000000000000')).toMatchObject({ code: 2, err: expect.stringMatching(/exactly one of --artifact/) });
    const missing = vault('song', 'revise', '00000000-0000-4000-8000-000000000000', '--status', 'writing');
    expect(missing).toMatchObject({ code: 1, err: expect.stringMatching(/no song/) });
  });
});
