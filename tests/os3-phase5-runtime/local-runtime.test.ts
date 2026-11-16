import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer } from '../../core/gateway/server.ts';
import { loadOs3RuntimeConfig } from '../../core/runtime/config.ts';
import { createGitCheckpoint, inspectGitRepository } from '../../core/runtime/git-integration.ts';
import { StructuredLogger } from '../../core/runtime/logger.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 5 — Minimal Local Runtime (SQLite, Repositories, Transactions, Locks, Backup, Degraded Vault Mode, Local HTTP Server)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p5-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    const sqlitePath = join(dir, 'db', 'runtime.sqlite');
    await mkdir(vaultRoot, { recursive: true });

    const db = openRuntimeDb(sqlitePath);
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    return { dir, vaultRoot, sqlitePath, db, vault };
  };

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) {
        await rm(d, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it('1. Enforces strict SQLite runtime scope (zero canonical tables) and verifies schema migrations + integrity check', async () => {
    const { db } = await createFixture();
    const integrity = db.checkIntegrity();

    expect(integrity.ok).toBe(true);
    expect(integrity.integrityCheck).toBe('ok');
    expect(integrity.foreignKeyViolations).toBe(0);
    expect(integrity.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(integrity.forbiddenTablesFound).toEqual([]);
    expect(integrity.views).toEqual(['approvals', 'runs']);

    // Querying the `runs` and `approvals` views works directly
    const runsViaView = db.raw.prepare('SELECT COUNT(*) as c FROM runs').get() as { c: number };
    const approvalsViaView = db.raw.prepare('SELECT COUNT(*) as c FROM approvals').get() as { c: number };
    expect(Number(runsViaView.c)).toBe(0);
    expect(Number(approvalsViaView.c)).toBe(0);
  });

  it('2 & 3. Supports typed repositories, transactions (with nested savepoints), job lifecycle, and stale job recovery', async () => {
    const { db } = await createFixture();
    const repos = db.repositories;

    // Transaction with nested savepoint rollback
    db.transaction(() => {
      const job1 = repos.jobs.enqueue({
        id: 'job-tx-1',
        kind: 'workflow',
        name: 'write-lyrics',
        startImmediately: true,
      });
      expect(job1.status).toBe('running');

      // Nested transaction that throws should rollback only the nested savepoint
      expect(() =>
        db.transaction(() => {
          repos.jobs.enqueue({
            id: 'job-tx-rolled-back',
            kind: 'task',
            name: 'should-rollback',
          });
          throw new Error('abort nested savepoint');
        }),
      ).toThrow(/abort nested savepoint/);
    });

    expect(repos.jobs.getById('job-tx-1')?.status).toBe('running');
    expect(repos.jobs.getById('job-tx-rolled-back')).toBeNull();

    // Track agent run linked to job-tx-1
    const run1 = repos.runs.start({
      agentName: 'lyric-architect',
      class: 'Creative',
      domain: 'RECORDS',
      model: 'none',
      input: { song: 'Neon Static' },
      jobId: 'job-tx-1',
      stepId: 'step-1',
    });
    repos.runs.complete(run1.id, { output: { verses: 2 }, tokensUsed: 320, latencyMs: 410 });
    expect(repos.runs.listByJob('job-tx-1')).toHaveLength(1);

    // Cancel a queued job
    const jobToCancel = repos.jobs.enqueue({
      id: 'job-cancel-1',
      kind: 'research',
      name: 'suno-probe',
    });
    const cancelled = repos.jobs.cancel(jobToCancel.id, 'cancelled during test');
    expect(cancelled.status).toBe('cancelled');

    // Stale running job recovery marks orphaned running jobs as error
    const recoveredJobs = repos.jobs.recoverStaleRunningJobs('Process restarted');
    expect(recoveredJobs.some((j) => j.id === 'job-tx-1' && j.status === 'error')).toBe(true);
  });

  it('4 & 5. Implements lock renewal, stale-lock recovery, and online database backup with integrity verification', async () => {
    const { dir, db } = await createFixture();
    const locks = db.repositories.locks;

    // Acquire and renew a lock
    expect(locks.acquire('vault:09_X3LIUS_MUSIC/SONGS/Test.md', 'worker-1', 500)).toBe(true);
    expect(locks.acquire('vault:09_X3LIUS_MUSIC/SONGS/Test.md', 'worker-2', 500)).toBe(false);
    expect(locks.renew('vault:09_X3LIUS_MUSIC/SONGS/Test.md', 'worker-1', 60_000)).toBe(true);
    expect(locks.listActive()).toHaveLength(1);

    // Recover stale locks using a future reference timestamp
    const futureIso = new Date(Date.now() + 120_000).toISOString();
    const recovery = locks.recoverStaleLocks(futureIso);
    expect(recovery.recoveredCount).toBe(1);
    expect(recovery.resourceKeys).toEqual(['vault:09_X3LIUS_MUSIC/SONGS/Test.md']);

    // Online database backup via VACUUM INTO
    const backupFile = join(dir, 'backups', 'runtime-backup.sqlite');
    const backupReport = db.backupDatabase(backupFile);
    expect(backupReport.ok).toBe(true);
    expect(backupReport.integrityOk).toBe(true);
    expect(backupReport.byteSize).toBeGreaterThan(0);

    const reopened = openRuntimeDb(backupFile);
    openDbs.push(reopened);
    expect(reopened.checkIntegrity().ok).toBe(true);
  });

  it('6. Operates without Supabase/PostgreSQL, enforces 127.0.0.1 binding, redacts secrets in logs, supports Git checkpoints, and shuts down gracefully', async () => {
    const { vaultRoot, sqlitePath, db, vault } = await createFixture();

    // Runtime config rejects non-localhost bind address and ignores PostgreSQL/Supabase
    expect(() => loadOs3RuntimeConfig({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/);

    const cfg = loadOs3RuntimeConfig({
      vaultRoot,
      sqlitePath,
      port: 0,
      env: {
        OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.configuredProviders.openrouter).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain('sk-or-v1-');

    // Structured logger redacts secrets in message and context
    const logger = new StructuredLogger({ level: 'debug' });
    const entry = logger.info(
      'auth.test',
      'Using key sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
      {
        apiKey: 'gsk_0123456789abcdef0123456789abcdef',
        nested: 'Bearer secret-jwt-token-value-123456',
      },
    );
    expect(entry?.message).toContain('[REDACTED_SECRET]');
    expect(entry?.context?.apiKey).toBe('[REDACTED_SECRET]');
    expect(entry?.context?.nested).toBe('[REDACTED_SECRET]');

    // Write a note and create a local Git checkpoint in the Vault
    await vault.write({
      vaultPath: '10_INBOX/GitTrackedNote.md',
      content: '---\nschema: "xyp3rn.entity/v3"\nid: "ent-git-1"\ntitle: "Git Tracked"\ndomain: "CORE"\n---\n# Git Tracked\n',
      actor: 'operator',
    });

    const gitCp = await createGitCheckpoint(vaultRoot, 'Initial Vault Git checkpoint');
    expect(gitCp.ok).toBe(true);
    const gitStatus = await inspectGitRepository(vaultRoot);
    expect(gitStatus.isGitRepo).toBe(true);
    expect(gitStatus.clean).toBe(true);

    // Start local HTTP server on 127.0.0.1 (ephemeral port), check /api/health, and shut down gracefully
    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    const handle = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      logger,
    });

    try {
      const res = await fetch(`${handle.url}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.sqliteOpen).toBe(true);
      expect(body.integrityOk).toBe(true);
      expect(Number(body.schemaVersion)).toBeGreaterThanOrEqual(2);
    } finally {
      await handle.close();
    }
  });

  it('7. Acceptance: The Vault remains usable when SQLite is unavailable, and runtime failure never destroys canonical Vault content', async () => {
    const { db, vault } = await createFixture();

    // 1. Promote a canonical note while SQLite is online
    const approval = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'know-resilience-01',
      proposer: 'research-orchestrator',
      request: {},
    });
    db.decideApproval({
      approvalId: approval.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Approved canonical note before SQLite shutdown',
    });

    const canonicalRes = await vault.promote({
      approvalId: approval.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Resilience.md',
      entityId: 'know-resilience-01',
      title: 'Canonical Resilience Rule',
      body: 'Canonical Vault content must survive any runtime or SQLite failure.',
      domain: 'KNOWLEDGE',
      sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
    });

    // 2. Simulate SQLite becoming completely unavailable (closed/offline)
    db.close();
    expect(db.isOpen).toBe(false);

    // 3. Verify canonical Vault content is completely intact and readable without SQLite
    const canonicalDoc = await vault.read('02_KNOWLEDGE/CANONICAL/KNOW-Resilience.md');
    expect(canonicalDoc.sha256).toBe(canonicalRes.sha256);
    expect(canonicalDoc.frontmatter.title).toBe('Canonical Resilience Rule');

    // 4. Verify non-canonical Vault writes, updates, appends, history, and restores STILL work without SQLite!
    const writeOffline = await vault.write({
      vaultPath: '10_INBOX/OfflineNote.md',
      content: [
        '---',
        'schema: "xyp3rn.entity/v3"',
        'id: "ent-offline-01"',
        'title: "Written While SQLite Offline"',
        'domain: "CORE"',
        '---',
        '',
        'Offline body v1.',
      ].join('\n'),
      actor: 'operator',
    });
    expect(writeOffline.revisionNumber).toBe(1);

    const appendOffline = await vault.append({
      vaultPath: '10_INBOX/OfflineNote.md',
      appendText: 'Offline body v2.',
      actor: 'operator',
      expectedSha256: writeOffline.sha256,
    });
    expect(appendOffline.revisionNumber).toBe(2);

    const histOffline = await vault.history('10_INBOX/OfflineNote.md');
    expect(histOffline).toHaveLength(2);

    const restoredOffline = await vault.restore({
      vaultPath: '10_INBOX/OfflineNote.md',
      targetSha256: writeOffline.sha256,
      actor: 'operator',
    });
    expect(restoredOffline.sha256).toBe(writeOffline.sha256);
  });
});
