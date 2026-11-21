import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DawGatewayController, setDawGatewayController } from '../../core/gateway/daw-gateway.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { loadOs3RuntimeConfig } from '../../core/runtime/config.ts';
import {
  acquireRuntimeSingletonLock,
  detectIncompleteMigrations,
  inspectVaultAvailability,
  preflightOs3ReleaseRuntime,
  recoverInterruptedRuntimeState,
} from '../../core/runtime/release-startup.ts';
import {
  openRuntimeDb,
  restoreSqliteDatabase,
  type SqliteRuntimeDb,
} from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const makeAbsentDawProbe = () => ({
  probeHost: async () =>
    ({
      probedAt: new Date().toISOString(),
      installations: [],
      runningProcesses: [],
      midiInPorts: [],
      midiOutPorts: [],
      loopMidiInstalled: false,
      configuredInPortFound: false,
      configuredOutPortFound: false,
      controllerScriptPath: 'none',
      controllerScriptInstalled: false,
      userProjectsRoot: '',
      pluginDatabaseRoot: '',
      missingPrerequisites: ['host_not_running', 'loopmidi_missing'],
      warnings: [],
    }) as never,
  discoverProjects: () => [],
  scanInstalledPlugins: () => [],
});

describe('Phase 25 — XYP3RN OS3 + DAW Brain Release Candidate Readiness', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const openServers: Os3GatewayServerHandle[] = [];
  const openControllers: DawGatewayController[] = [];

  afterEach(async () => {
    while (openControllers.length > 0) {
      openControllers.pop()?.core.dispose();
    }
    while (openServers.length > 0) {
      await openServers.pop()!.close().catch(() => undefined);
    }
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeReleaseFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p25-rc-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    const sqlitePath = join(dir, 'runtime.sqlite');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(sqlitePath);
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    return { dir, vaultRoot, sqlitePath, db, vault };
  };

  it('1. Validates startup configuration (127.0.0.1 binding, port & auth checks) and recovers interrupted jobs/locks on boot', async () => {
    const { vaultRoot, sqlitePath, db, vault } = await makeReleaseFixture();

    // Non-loopback bindings rejected at config and server startup layers
    expect(() => loadOs3RuntimeConfig({ host: '0.0.0.0', vaultRoot, sqlitePath })).toThrow(/127\.0\.0\.1/);
    expect(() => loadOs3RuntimeConfig({ host: '192.168.1.25', vaultRoot, sqlitePath })).toThrow(/127\.0\.0\.1/);
    expect(() => loadOs3RuntimeConfig({ port: 99999, vaultRoot, sqlitePath })).toThrow(/Invalid OS 3\.0 Runtime port/);
    expect(() =>
      preflightOs3ReleaseRuntime(db, {
        vaultRoot,
        sqlitePath,
        env: { XYP_REQUIRE_AUTH: '1' },
      }),
    ).toThrow(/OS3_STARTUP_CONFIG_INVALID/);

    // Simulate interrupted job and expired lock from a crashed runtime
    db.enqueueJob({
      id: 'job-p25-interrupted',
      kind: 'workflow',
      name: 'retrieve-and-summarize',
      startImmediately: true,
    });
    db.acquireLock('vault:01_CORE/stale-lock.md', 'crashed-worker', -10);

    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    const server = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      recoverInterruptedOnBoot: true,
    });
    openServers.push(server);

    expect(server.host).toBe('127.0.0.1');
    expect(server.startupRecovery.recoveredJobIds).toContain('job-p25-interrupted');
    expect(db.repositories.jobs.getById('job-p25-interrupted')?.status).toBe('error');

    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      vaultAvailable: boolean;
      migrationComplete: boolean;
      startupRecovery: { recoveredJobIds: string[] };
    };
    expect(health.ok).toBe(true);
    expect(health.vaultAvailable).toBe(true);
    expect(health.migrationComplete).toBe(true);
    expect(health.startupRecovery.recoveredJobIds).toContain('job-p25-interrupted');
  });

  it('2. Prevents unauthorized duplicate runtime instances and releases singleton lock cleanly on shutdown', async () => {
    const { sqlitePath, db, vault } = await makeReleaseFixture();
    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

    const server1 = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      enforceSingletonLock: true,
      singletonOwnerId: 'os3-gateway-instance-1',
    });
    openServers.push(server1);

    // Second runtime instance attempting to bind against the same SQLite DB is blocked
    await expect(
      startOs3GatewayServer(runtime, {
        host: '127.0.0.1',
        port: 0,
        enforceSingletonLock: true,
        singletonOwnerId: 'os3-gateway-instance-2',
      }),
    ).rejects.toThrow(/OS3_DUPLICATE_RUNTIME_INSTANCE/);

    // Direct singleton lock acquisition also blocks duplicate owner
    expect(() =>
      acquireRuntimeSingletonLock(db, sqlitePath, {
        ownerId: 'os3-gateway-unauthorized',
        rejectSameProcessDuplicate: true,
      }),
    ).toThrow(/OS3_DUPLICATE_RUNTIME_INSTANCE/);

    // After server1 shuts down cleanly, a new instance can acquire the lock and start
    await server1.close();
    openServers.pop();

    const server2 = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      enforceSingletonLock: true,
      singletonOwnerId: 'os3-gateway-instance-2',
    });
    openServers.push(server2);
    expect(server2.port).toBeGreaterThan(0);
  });

  it('3. Handles unavailable Vault safely without crashing OS3 and detects incomplete migrations', async () => {
    const { dir, vaultRoot, db, vault } = await makeReleaseFixture();
    const missingVaultPath = join(dir, 'unmounted-vault');

    // Vault availability check never throws on missing directory
    const avail = inspectVaultAvailability(missingVaultPath);
    expect(avail.available).toBe(false);
    expect(avail.mode).toBe('degraded_unavailable');

    // Strict mode blocks startup when requested
    expect(() =>
      preflightOs3ReleaseRuntime(db, {
        vaultRoot: missingVaultPath,
        strictVaultRequired: true,
      }),
    ).toThrow(/OS3_STARTUP_VAULT_UNAVAILABLE/);

    // Default degraded mode boots Gateway cleanly when Vault becomes unavailable
    await rm(vaultRoot, { recursive: true, force: true });
    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    const server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
    openServers.push(server);

    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      vaultAvailable: boolean;
      vaultMode: string;
    };
    expect(health.ok).toBe(true);
    expect(health.vaultAvailable).toBe(false);
    expect(health.vaultMode).toBe('degraded_unavailable');

    // Incomplete migration detection via running migration job or on-disk marker
    await mkdir(vaultRoot, { recursive: true });
    const markerFile = join(vaultRoot, '.migration-in-progress.json');
    await writeFile(markerFile, JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');

    const incReport = detectIncompleteMigrations(db, vaultRoot);
    expect(incReport.complete).toBe(false);
    expect(incReport.incompleteReasons.some((r) => r.includes('.migration-in-progress.json'))).toBe(true);

    await expect(
      startOs3GatewayServer(runtime, {
        host: '127.0.0.1',
        port: 0,
        failOnIncompleteMigration: true,
      }),
    ).rejects.toThrow(/OS3_INCOMPLETE_MIGRATION_DETECTED/);

    await rm(markerFile, { force: true });
    const cleanReport = detectIncompleteMigrations(db, vaultRoot);
    expect(cleanReport.complete).toBe(true);
  });

  it('4. Keeps DAW Brain optional at runtime and handles absent DAWs + unsupported integrations cleanly', async () => {
    const { db, vault } = await makeReleaseFixture();
    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

    // A. DAW Brain disabled at runtime (`dawBrainEnabled: false`)
    const disabledServer = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      dawBrainEnabled: false,
    });
    openServers.push(disabledServer);

    const [healthRes, ovRes, connectAttemptRes] = await Promise.all([
      fetch(`${disabledServer.url}/api/health`),
      fetch(`${disabledServer.url}/api/daw/overview`),
      fetch(`${disabledServer.url}/api/daw/connections/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapterId: 'fl-studio-2025' }),
      }),
    ]);

    expect(healthRes.status).toBe(200);
    expect(((await healthRes.json()) as { dawBrainEnabled: boolean }).dawBrainEnabled).toBe(false);

    expect(ovRes.status).toBe(200);
    const disabledOv = (await ovRes.json()) as {
      ok: boolean;
      dawBrainEnabled: boolean;
      status: string;
    };
    expect(disabledOv.ok).toBe(true);
    expect(disabledOv.dawBrainEnabled).toBe(false);
    expect(disabledOv.status).toBe('disabled_optional');
    expect(connectAttemptRes.status).toBe(503);

    await disabledServer.close();
    openServers.pop();

    // B. DAW Brain enabled with absent FL Studio and REAPER on workstation
    const absentProbe = makeAbsentDawProbe();
    const controller = new DawGatewayController(runtime, {
      flHostProbe: absentProbe,
      reaperHostProbe: absentProbe,
    });
    openControllers.push(controller);
    setDawGatewayController(runtime, controller);

    const enabledServer = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      dawBrainEnabled: true,
    });
    openServers.push(enabledServer);

    const liveOvRes = await fetch(`${enabledServer.url}/api/daw/overview`);
    expect(liveOvRes.status).toBe(200);
    const liveOv = (await liveOvRes.json()) as {
      ok: boolean;
      connectionSummary: { state: string; connectedSessions: number };
      capabilities: { unsupported: ReadonlyArray<{ capabilityId: string; unsupportedReason?: string }> };
    };
    expect(liveOv.ok).toBe(true);
    expect(liveOv.connectionSummary.state).toBe('disconnected');
    expect(liveOv.connectionSummary.connectedSessions).toBe(0);
    expect(liveOv.capabilities.unsupported.length).toBeGreaterThan(0);
    expect(
      liveOv.capabilities.unsupported.some((c) => c.capabilityId === 'daw.track.create_delete'),
    ).toBe(true);
  });

  it('5. Executes complete Vault snapshot/restore and SQLite online backup/restore with integrity verification', async () => {
    const { dir, sqlitePath, db, vault } = await makeReleaseFixture();

    // 1. Write and update a Vault note, create a Vault snapshot, and restore to revision 1
    const v1 = await vault.write({
      vaultPath: '10_INBOX/ReleaseBackupNote.md',
      content:
        '---\nschema: "xyp3rn.entity/v3"\nid: "ent-rc-bkp-1"\ntitle: "Release Backup Note"\ndomain: "CORE"\n---\n# Version 1 Content\n',
      actor: 'blago-operator',
    });

    await vault.update({
      vaultPath: '10_INBOX/ReleaseBackupNote.md',
      content:
        '---\nschema: "xyp3rn.entity/v3"\nid: "ent-rc-bkp-1"\ntitle: "Release Backup Note"\ndomain: "CORE"\n---\n# Version 2 Mutated Content\n',
      actor: 'blago-operator',
      expectedSha256: v1.sha256,
    });

    const snap = await vault.snapshot('rc-pre-restore-checkpoint', 'blago-operator');
    expect(snap.totalFiles).toBeGreaterThan(10);

    await vault.restore({
      vaultPath: '10_INBOX/ReleaseBackupNote.md',
      targetSha256: v1.sha256,
      actor: 'blago-operator',
      reason: 'Phase 25 release candidate restore verification',
    });

    const restoredNote = await vault.read('10_INBOX/ReleaseBackupNote.md');
    expect(restoredNote.body).toContain('Version 1 Content');

    // 2. Online SQLite backup and full database restore
    const backupFile = join(dir, 'backups', 'rc-backup.sqlite');
    const bkp = db.backupDatabase(backupFile);
    expect(bkp.integrityOk).toBe(true);
    expect(bkp.byteSize).toBeGreaterThan(0);

    // Mutate runtime DB after backup, then restore from backup and verify state reverted
    db.enqueueJob({ id: 'job-after-backup', kind: 'task', name: 'transient' });
    expect(db.repositories.jobs.getById('job-after-backup')).not.toBeNull();

    db.close();
    openDbs.pop();

    const restoreRes = restoreSqliteDatabase({ backupPath: backupFile, targetPath: sqlitePath });
    expect(restoreRes.ok).toBe(true);
    expect(restoreRes.integrityOk).toBe(true);

    const reopened = openRuntimeDb(sqlitePath);
    openDbs.push(reopened);
    expect(reopened.checkIntegrity().ok).toBe(true);
    expect(reopened.repositories.jobs.getById('job-after-backup')).toBeNull();
  });
});
