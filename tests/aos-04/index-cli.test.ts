import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../core/db/client.ts';
import { formatScan, formatStatus, indexStatus } from '../../knowledge/knowledge-graph/status.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// AOS-04 Plan C1 Task 4: `pnpm index scan | status`. The CLI is run for real (it scans this checkout, read-only,
// into a throwaway database); what it prints must be what the database holds.

let db: TestDb;
let vaultDir: string;
const cli = (...args: string[]) => {
  const url = new URL(databaseUrl());
  url.pathname = `/${db.name}`;
  const r = spawnSync('node', ['knowledge/knowledge-graph/cli.ts', ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, XYP_DATABASE_URL: url.toString(), XYP_VAULT_DIR: vaultDir },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(async () => {
  db = await createTestDb('aos04_cli', { migrated: true });
  vaultDir = await mkdtemp(join(tmpdir(), 'xyp-cli-vault-'));
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await rm(vaultDir, { recursive: true, force: true });
});

describe('pnpm index', () => {
  it('scan prints the counts the sealed scan row holds', () => {
    const r = cli('scan');
    expect(r.err).not.toMatch(/Error/);
    expect(r.code).toBe(0);
    return db.sql<{ id: string; counts: { eligible: number; indexed: number; failed: number } }[]>`
      select id, counts from index_scans order by started_at desc limit 1`.then(([last]) => {
      expect(r.out).toContain(`index scan ${last!.id}: success`);
      expect(r.out).toContain(`eligible ${last!.counts.eligible} · indexed ${last!.counts.indexed} · failed ${last!.counts.failed}`);
      expect(last!.counts.eligible).toBeGreaterThan(400);
    });
  }, 60_000);

  it('status prints the last scan and the diagnostics count, as indexStatus reads them', async () => {
    const s = await indexStatus(db.sql);
    const r = cli('status');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`last scan ${s.lastScan!.id} (cli): success`);
    expect(r.out).toContain(`diagnostics ${s.diagnostics.unresolved + s.diagnostics.dangling} (unresolved ${s.diagnostics.unresolved} · dangling ${s.diagnostics.dangling})`);
    expect(r.out).toContain(`files present ${s.files.present} · missing ${s.files.missing} · unreadable ${s.files.unreadable}`);
  }, 60_000);

  it('refuses an unknown command with the usage line', () => {
    const r = cli('frobnicate');
    expect(r.code).toBe(1);
    expect(r.err).toContain('usage: pnpm index scan [--full] | status');
  });
});

describe('formatting', () => {
  it('names failed paths and excluded rules, never an excluded file', () => {
    const lines = formatScan({
      scanId: '00000000-0000-4000-8000-000000000000', status: 'success', failures: [{ path: 'docs/locked.md', error: 'EACCES: permission denied' }],
      counts: { eligible: 3, indexed: 2, failed: 1, unsupportedPaths: 0, missing: 1, unreadableDirs: 0, excluded: { credentials: 2, 'symlink-escape': 1 }, vault: { present: 1, missing: 0, corrupt: 0 } },
    }).join('\n');
    expect(lines).toContain('eligible 3 · indexed 2 · failed 1 (unsupported paths 0) · missing 1');
    expect(lines).toContain('excluded: credentials 2 · symlink-escape 1');
    expect(lines).toContain('vault: present 1 · missing 0 · corrupt 0');
    expect(lines).toContain('docs/locked.md: EACCES: permission denied');
  });

  it('says when there has been no scan', () => {
    expect(formatStatus({ lastScan: null, diagnostics: { unresolved: 0, dangling: 0 }, files: { present: 0, missing: 0, unreadable: 0 } })).toContain('no scan yet: run pnpm index scan');
  });
});
