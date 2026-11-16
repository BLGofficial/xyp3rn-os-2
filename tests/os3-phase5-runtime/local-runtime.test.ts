import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer } from '../../core/gateway/server.ts';
import { loadOs3RuntimeConfig } from '../../core/runtime/config.ts';
import { createGitCheckpoint, inspectGitRepository } from '../../core/runtime/git-integration.ts';
import { StructuredLogger } from '../../core/runtime/logger.ts';
import {
  applySqliteMigrations,
  inspectSqliteFile,
  LATEST_SQLITE_SCHEMA_VERSION,
  openRuntimeDb,
  openRuntimeDbWithRecovery,
  restoreSqliteDatabase,
  type SqliteRuntimeDb,
} from '../../core/sqlite/client.ts';
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

  it('8. Verifies v3 migrations, atomic migration rollback on SQL failure, reopened FK enforcement, and canonical-table prohibition', async () => {
    const { sqlitePath, db } = await createFixture();
    const integrity = db.checkIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(integrity.tables).toContain('daw_sessions');
    expect(integrity.tables).toContain('daw_session_leases');
    expect(integrity.tables).toContain('daw_command_journal');
    expect(integrity.tables).toContain('daw_audio_analyses');

    // Close and reopen existing DB -> verify PRAGMA foreign_keys remains ON
    db.close();
    const reopened = openRuntimeDb(sqlitePath);
    openDbs.push(reopened);

    expect(() =>
      reopened.repositories.dawLeases.grant({
        sessionId: 'non-existent-session',
        maxPermission: 'observe',
        grantedBy: 'blago',
      }),
    ).toThrow(/FOREIGN KEY/i);

    // Failed custom migration rolls back atomically inside applySqliteMigrations
    const mem = new DatabaseSync(':memory:');
    try {
      expect(() =>
        applySqliteMigrations(mem, [
          { version: 1, name: 'ok-init', sql: 'CREATE TABLE t_ok (id TEXT PRIMARY KEY);' },
          {
            version: 2,
            name: 'broken-mig',
            sql: 'CREATE TABLE t_partial (id TEXT); SELECT * FROM nonexistent_table_triggering_rollback;',
          },
        ]),
      ).toThrow();

      const tables = mem
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_partial'`)
        .all();
      expect(tables).toHaveLength(0);
      const maxVer = (mem.prepare('SELECT MAX(version) as v FROM schema_meta').get() as { v: number }).v;
      expect(maxVer).toBe(1);
    } finally {
      mem.close();
    }

    // Creating a forbidden canonical table (`songs` or `plugins`) fails checkIntegrity()
    reopened.raw.exec('CREATE TABLE songs (id TEXT PRIMARY KEY);');
    const badIntegrity = reopened.checkIntegrity();
    expect(badIntegrity.ok).toBe(false);
    expect(badIntegrity.forbiddenTablesFound).toContain('songs');
  });

  it('9. Manages approved DAW operational entities with constraints and immutable command journal triggers', async () => {
    const { db } = await createFixture();
    const repos = db.repositories;

    const session = repos.dawSessions.upsert({
      id: 'daw-sess-fl25-01',
      adapterId: 'fl-studio-2025',
      hostVersion: '25.1.0',
      projectPath: 'D:/Projects/NeonStatic.flp',
      savedSha256: 'abc123saved',
      cachedSnapshot: { tempoBpm: 140, playing: false },
      status: 'connected',
    });
    expect(session.adapterId).toBe('fl-studio-2025');

    const lease = repos.dawLeases.grant({
      id: 'lease-01',
      sessionId: session.id,
      maxPermission: 'execute',
      grantedBy: 'blago',
      allowedTargets: ['mixer.channel.1'],
      ttlMs: 60_000,
    });
    expect(repos.dawLeases.getActiveForSession(session.id)?.id).toBe(lease.id);

    // Expired lease is no longer active past expiration cutoff
    expect(
      repos.dawLeases.getActiveForSession(session.id, new Date(Date.now() + 120_000).toISOString()),
    ).toBeNull();

    // Command journal requires errorDetail on status='failed' and forbids UPDATE/DELETE
    expect(() =>
      repos.dawCommandJournal.append({
        sessionId: session.id,
        capabilityId: 'mixer.set_volume',
        targetRef: 'mixer.channel.1',
        command: { gainDb: -3 },
        status: 'failed',
      }),
    ).toThrow(/CHECK constraint failed/i);

    const receipt = repos.dawCommandJournal.append({
      sessionId: session.id,
      capabilityId: 'mixer.set_volume',
      targetRef: 'mixer.channel.1',
      command: { gainDb: -3 },
      beforeState: { gainDb: 0 },
      afterState: { gainDb: -3 },
      status: 'executed',
    });
    expect(receipt.status).toBe('executed');

    expect(() =>
      db.raw.prepare('UPDATE daw_command_journal SET status = ? WHERE id = ?').run('denied', receipt.id),
    ).toThrow(/immutable/i);
    expect(() =>
      db.raw.prepare('DELETE FROM daw_command_journal WHERE id = ?').run(receipt.id),
    ).toThrow(/forbidden/i);

    const analysis = repos.dawAudioAnalyses.record({
      sessionId: session.id,
      sourceKind: 'bounce_wav',
      sourceSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      traceAnalysis: { integratedLufs: -11.2, truePeakDbtp: -1.0 },
      traceReport: { passed: true },
    });
    expect(repos.dawAudioAnalyses.list({ sessionId: session.id })).toHaveLength(1);
    expect(analysis.sourceKind).toBe('bounce_wav');
  });

  it('10. Applies retention policy to disposable/expired runtime state without deleting sealed immutable history', async () => {
    const { db } = await createFixture();
    const repos = db.repositories;

    // Seed sealed immutable entries
    const run = repos.runs.start({ agentName: 'health-check', input: {} });
    repos.runs.complete(run.id, { output: { ok: true } });
    const job = repos.jobs.enqueue({ kind: 'task', name: 'immutable-job', startImmediately: true });
    repos.jobs.complete(job.id, { ok: true });

    // Seed DAW session WITH journal entry and one disposable closed DAW session WITHOUT journal entries
    repos.dawSessions.upsert({ id: 'sess-linked', adapterId: 'reaper', hostVersion: '7.2', status: 'closed' });
    repos.dawCommandJournal.append({
      sessionId: 'sess-linked',
      capabilityId: 'transport.play',
      targetRef: 'transport',
      command: { action: 'play' },
      status: 'executed',
    });
    repos.dawSessions.upsert({ id: 'sess-disposable', adapterId: 'reaper', hostVersion: '7.2', status: 'closed' });
    repos.dawLeases.grant({
      id: 'lease-old',
      sessionId: 'sess-disposable',
      maxPermission: 'observe',
      grantedBy: 'blago',
      ttlMs: 500,
    });
    repos.sessions.upsert({ id: 'ui-old-session', source: 'ui' });
    repos.locks.acquire('temp:lock', 'worker-1', 500);
    repos.dawAudioAnalyses.record({
      sessionId: 'sess-disposable',
      sourceKind: 'browser_dsp',
      sourceSha256: 'abc',
      traceAnalysis: { lufs: -12 },
      traceReport: { ok: true },
    });

    // Run retention with reference 45 days in the future
    const futureRef = new Date(Date.now() + 45 * 86_400_000).toISOString();
    const retention = repos.maintenance.prune({
      referenceIso: futureRef,
      sessionMaxAgeDays: 30,
      closedDawSessionMaxAgeDays: 30,
      audioAnalysisMaxAgeDays: 30,
      leaseExpiredGraceDays: 7,
    });

    expect(retention.expiredLocksRemoved).toBe(1);
    expect(retention.expiredLeasesPruned).toBe(1);
    expect(retention.staleSessionsRemoved).toBe(1);
    expect(retention.closedDawSessionsRemoved).toBe(1);
    expect(retention.audioAnalysesRemoved).toBe(1);
    // Journal-referenced DAW session & sealed history MUST survive!
    expect(repos.dawSessions.getById('sess-linked')).not.toBeNull();
    expect(repos.dawSessions.getById('sess-disposable')).toBeNull();
    expect(retention.retainedImmutableCounts.agentRuns).toBeGreaterThanOrEqual(1);
    expect(retention.retainedImmutableCounts.jobs).toBeGreaterThanOrEqual(1);
    expect(retention.retainedImmutableCounts.dawCommandJournal).toBe(1);
  });

  it('11 & 12. Restores from verified backups, rejects corrupted backups, and recovers corrupted databases via quarantine', async () => {
    const { dir, sqlitePath, db } = await createFixture();

    const job = db.repositories.jobs.enqueue({
      id: 'job-backup-sentinel',
      kind: 'workflow',
      name: 'write-lyrics',
      startImmediately: true,
    });
    db.repositories.jobs.complete(job.id, { saved: true });

    const backupPath = join(dir, 'backups', 'healthy-backup.sqlite');
    const bReport = db.backupDatabase(backupPath);
    expect(bReport.ok).toBe(true);
    db.close();

    // 1. Corrupt primary DB bytes on disk + inspectSqliteFile detects corruption
    await writeFile(sqlitePath, 'CORRUPTED NON-SQLITE HEADER GARBAGE DATA', 'utf8');
    const corruptInspect = inspectSqliteFile(sqlitePath);
    expect(corruptInspect.corrupt).toBe(true);
    expect(corruptInspect.ok).toBe(false);

    // 2. Corrupted backup must be refused BEFORE touching targetPath
    const corruptBackupPath = join(dir, 'backups', 'bad-backup.sqlite');
    await writeFile(corruptBackupPath, 'NOT A SQLITE BACKUP', 'utf8');
    expect(() =>
      restoreSqliteDatabase({ backupPath: corruptBackupPath, targetPath: sqlitePath }),
    ).toThrow(/corrupted SQLite backup/i);

    // 3. Recover primary DB automatically from healthy backup while quarantining corrupt original
    const recoveredFromBackup = openRuntimeDbWithRecovery(sqlitePath, {
      backupPaths: [corruptBackupPath, backupPath],
      quarantineDir: join(dir, 'quarantine'),
    });
    openDbs.push(recoveredFromBackup.db);

    expect(recoveredFromBackup.recovered).toBe(true);
    expect(recoveredFromBackup.source).toBe('backup');
    expect(recoveredFromBackup.restoredFromBackupPath).toBe(backupPath);
    expect(recoveredFromBackup.quarantinePath).toBeTruthy();
    expect(recoveredFromBackup.db.getJob('job-backup-sentinel')?.status).toBe('success');
    const quarantineContent = await readFile(recoveredFromBackup.quarantinePath!, 'utf8');
    expect(quarantineContent).toBe('CORRUPTED NON-SQLITE HEADER GARBAGE DATA');
    recoveredFromBackup.db.close();

    // 4. Corrupt DB again with NO available backup -> quarantines & rebuilds clean v3 DB
    await writeFile(sqlitePath, 'ANOTHER CORRUPTION WITHOUT BACKUP', 'utf8');
    const rebuilt = openRuntimeDbWithRecovery(sqlitePath, {
      quarantineDir: join(dir, 'quarantine'),
    });
    openDbs.push(rebuilt.db);
    expect(rebuilt.recovered).toBe(true);
    expect(rebuilt.source).toBe('fresh-rebuild');
    expect(rebuilt.db.checkIntegrity().ok).toBe(true);
    expect(
      rebuilt.db.listEvents({ eventType: 'runtime.db.recovered', limit: 10 }).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
