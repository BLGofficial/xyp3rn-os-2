import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { LATEST_SQLITE_SCHEMA_VERSION, type SqliteRuntimeDb } from '../sqlite/client.ts';
import { OS3_VAULT_DIRS } from '../vault-engine/path-guard.ts';
import { loadOs3RuntimeConfig, type Os3RuntimeConfig, type Os3RuntimeConfigOverrides } from './config.ts';

export const SINGLETON_LOCK_KEY = 'runtime:gateway:singleton';

export type VaultAvailabilityReport = {
  readonly available: boolean;
  readonly mode: 'ready' | 'degraded_unavailable';
  readonly vaultRoot: string;
  readonly missingSectors: readonly string[];
  readonly reason: string | null;
};

export type MigrationCompletenessReport = {
  readonly complete: boolean;
  readonly sqliteSchemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly incompleteReasons: readonly string[];
};

export type StartupRecoveryReport = {
  readonly recoveredLocksCount: number;
  readonly recoveredJobIds: readonly string[];
};

export type RuntimeSingletonLease = {
  readonly lockKey: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly lockFilePath: string | null;
  readonly release: () => void;
};

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
};

/**
 * Safely inspects whether the configured Obsidian Vault directory is mounted/readable
 * and checks for required sector directories without crashing the OS3 runtime.
 */
export const inspectVaultAvailability = (vaultRoot: string): VaultAvailabilityReport => {
  try {
    const st = fs.statSync(vaultRoot);
    if (!st.isDirectory()) {
      return {
        available: false,
        mode: 'degraded_unavailable',
        vaultRoot,
        missingSectors: [...OS3_VAULT_DIRS],
        reason: `Configured vaultRoot "${vaultRoot}" is not a directory`,
      };
    }
    const missingSectors: string[] = [];
    for (const sector of OS3_VAULT_DIRS) {
      const sectorPath = join(vaultRoot, sector);
      if (!fs.existsSync(sectorPath)) {
        missingSectors.push(sector);
      }
    }
    return {
      available: true,
      mode: 'ready',
      vaultRoot,
      missingSectors,
      reason: null,
    };
  } catch (err) {
    return {
      available: false,
      mode: 'degraded_unavailable',
      vaultRoot,
      missingSectors: [...OS3_VAULT_DIRS],
      reason: `Vault unavailable at "${vaultRoot}": ${(err as Error).message}`,
    };
  }
};

/**
 * Detects incomplete SQLite or Vault migrations (unapplied schema versions,
 * interrupted running migration jobs, active migration locks, or on-disk markers).
 */
export const detectIncompleteMigrations = (
  db: SqliteRuntimeDb,
  vaultRoot: string,
): MigrationCompletenessReport => {
  const incompleteReasons: string[] = [];
  let sqliteSchemaVersion = 0;

  if (!db.isOpen) {
    incompleteReasons.push('Runtime SQLite database is closed or unavailable');
  } else {
    const integrity = db.checkIntegrity();
    sqliteSchemaVersion = integrity.schemaVersion;
    if (!integrity.ok) {
      incompleteReasons.push(`SQLite integrity check failed: ${integrity.integrityCheck}`);
    }
    if (sqliteSchemaVersion < LATEST_SQLITE_SCHEMA_VERSION) {
      incompleteReasons.push(
        `SQLite schema version ${sqliteSchemaVersion} is behind expected version ${LATEST_SQLITE_SCHEMA_VERSION}`,
      );
    }

    const runningMigrationJobs = db
      .listJobs(100)
      .filter((j) => j.name.toLowerCase().includes('migrat') && j.status === 'running');
    if (runningMigrationJobs.length > 0) {
      incompleteReasons.push(
        `Detected ${runningMigrationJobs.length} unsealed running migration job(s): ${runningMigrationJobs.map((j) => j.id).join(', ')}`,
      );
    }

    const migrationLocks = db.listLocks().filter((l) => l.resourceKey.startsWith('migration:'));
    if (migrationLocks.length > 0) {
      incompleteReasons.push(
        `Detected active migration lock(s): ${migrationLocks.map((l) => l.resourceKey).join(', ')}`,
      );
    }
  }

  try {
    const markerPath = join(vaultRoot, '.migration-in-progress.json');
    if (fs.existsSync(markerPath)) {
      incompleteReasons.push(`Detected unfinished migration marker at "${markerPath}"`);
    }
  } catch {
    // Ignore fs errors if vaultRoot is currently unmounted (handled by inspectVaultAvailability)
  }

  return {
    complete: incompleteReasons.length === 0,
    sqliteSchemaVersion,
    expectedSchemaVersion: LATEST_SQLITE_SCHEMA_VERSION,
    incompleteReasons,
  };
};

/**
 * Recovers stale locks and interrupted running jobs left behind by a prior crash or forced exit.
 */
export const recoverInterruptedRuntimeState = (
  db: SqliteRuntimeDb,
  reason = 'Recovered interrupted job during OS3 runtime startup',
): StartupRecoveryReport => {
  if (!db.isOpen) {
    return { recoveredLocksCount: 0, recoveredJobIds: [] };
  }
  const lockRec = db.recoverStaleLocks();
  const recoveredJobs = db.repositories.jobs.recoverStaleRunningJobs(reason);
  const recoveredJobIds = recoveredJobs.map((j) => j.id);

  if (lockRec.recoveredCount > 0 || recoveredJobIds.length > 0) {
    try {
      db.appendEvent({
        eventType: 'runtime.startup.recovered',
        domain: 'CORE',
        actor: 'system',
        payload: {
          recoveredLocksCount: lockRec.recoveredCount,
          recoveredJobIds,
          reason,
        },
      });
    } catch {
      // Non-fatal if event sink is busy
    }
  }

  return {
    recoveredLocksCount: lockRec.recoveredCount,
    recoveredJobIds,
  };
};

/**
 * Prevents unauthorized duplicate runtime instances against the same SQLite database / lockfile.
 * Automatically reclaims stale locks left by dead PIDs.
 */
export const acquireRuntimeSingletonLock = (
  db: SqliteRuntimeDb,
  sqlitePath: string,
  options: {
    readonly ownerId?: string | undefined;
    readonly pid?: number | undefined;
    readonly ttlMs?: number | undefined;
    readonly rejectSameProcessDuplicate?: boolean | undefined;
  } = {},
): RuntimeSingletonLease => {
  const pid = options.pid ?? process.pid;
  const ownerId = options.ownerId ?? `os3-gateway-pid-${pid}`;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const rejectSamePid = options.rejectSameProcessDuplicate ?? true;
  const lockFilePath =
    sqlitePath && sqlitePath !== ':memory:' ? `${sqlitePath}.instance.lock` : null;

  // 1. Check companion PID lockfile if file-backed
  if (lockFilePath && fs.existsSync(lockFilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(lockFilePath, 'utf8')) as {
        readonly pid?: number;
        readonly ownerId?: string;
      };
      const holderPid = Number(raw.pid ?? 0);
      const holderOwner = String(raw.ownerId ?? '');
      if (holderPid > 0 && isProcessAlive(holderPid)) {
        if (holderPid !== pid || (rejectSamePid && holderOwner !== ownerId)) {
          const err = new Error(
            `OS3_DUPLICATE_RUNTIME_INSTANCE: Another OS3 runtime instance (pid=${holderPid}, owner="${holderOwner}") is already active on "${sqlitePath}"`,
          ) as Error & { code: string };
          err.code = 'OS3_DUPLICATE_RUNTIME_INSTANCE';
          throw err;
        }
      } else {
        // Stale lockfile from dead process -> remove it before acquiring
        fs.rmSync(lockFilePath, { force: true });
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'OS3_DUPLICATE_RUNTIME_INSTANCE') {
        throw err;
      }
      fs.rmSync(lockFilePath, { force: true });
    }
  }

  // 2. Check SQLite locks table
  if (db.isOpen) {
    db.recoverStaleLocks();
    const existingLock = db.listLocks().find((l) => l.resourceKey === SINGLETON_LOCK_KEY);
    if (existingLock) {
      const pidMatch = /pid-(\d+)/.exec(existingLock.ownerId);
      const holderPid = pidMatch ? Number(pidMatch[1]) : 0;
      const holderAlive = holderPid > 0 ? isProcessAlive(holderPid) : true;
      if (!holderAlive) {
        db.releaseLock(SINGLETON_LOCK_KEY, existingLock.ownerId);
      } else if (existingLock.ownerId !== ownerId || rejectSamePid) {
        const err = new Error(
          `OS3_DUPLICATE_RUNTIME_INSTANCE: Runtime singleton lock "${SINGLETON_LOCK_KEY}" is already held by active instance "${existingLock.ownerId}"`,
        ) as Error & { code: string };
        err.code = 'OS3_DUPLICATE_RUNTIME_INSTANCE';
        throw err;
      }
    }

    const acquired = db.acquireLock(SINGLETON_LOCK_KEY, ownerId, ttlMs);
    if (!acquired) {
      const err = new Error(
        `OS3_DUPLICATE_RUNTIME_INSTANCE: Failed to acquire runtime singleton lock "${SINGLETON_LOCK_KEY}"`,
      ) as Error & { code: string };
      err.code = 'OS3_DUPLICATE_RUNTIME_INSTANCE';
      throw err;
    }
  }

  if (lockFilePath) {
    try {
      fs.mkdirSync(dirname(lockFilePath), { recursive: true });
      fs.writeFileSync(
        lockFilePath,
        JSON.stringify({ pid, ownerId, sqlitePath, acquiredAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {
      // Ignore lockfile write error if directory is read-only
    }
  }

  let released = false;
  return {
    lockKey: SINGLETON_LOCK_KEY,
    ownerId,
    pid,
    lockFilePath,
    release: () => {
      if (released) return;
      released = true;
      if (db.isOpen) {
        try {
          db.releaseLock(SINGLETON_LOCK_KEY, ownerId);
        } catch {
          // Ignore if DB already closed
        }
      }
      if (lockFilePath) {
        try {
          fs.rmSync(lockFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
};

export type Os3ReleasePreflightResult = {
  readonly config: Os3RuntimeConfig;
  readonly dawBrainEnabled: boolean;
  readonly vaultAvailability: VaultAvailabilityReport;
  readonly migrationStatus: MigrationCompletenessReport;
  readonly startupRecovery: StartupRecoveryReport;
};

/**
 * Executes complete startup validation for the OS3 Release Candidate runtime.
 */
export const preflightOs3ReleaseRuntime = (
  db: SqliteRuntimeDb,
  options: Os3RuntimeConfigOverrides & {
    readonly dawBrainEnabled?: boolean | undefined;
    readonly strictVaultRequired?: boolean | undefined;
    readonly failOnIncompleteMigration?: boolean | undefined;
    readonly recoverInterruptedJobs?: boolean | undefined;
  } = {},
): Os3ReleasePreflightResult => {
  const env = options.env ?? process.env;
  const config = loadOs3RuntimeConfig(options);

  if (env.XYP_REQUIRE_AUTH === '1' && !env.XYP_GATEWAY_TOKEN?.trim()) {
    throw new Error(
      'OS3_STARTUP_CONFIG_INVALID: XYP_REQUIRE_AUTH=1 requires a non-empty XYP_GATEWAY_TOKEN',
    );
  }

  const dawBrainEnabled =
    options.dawBrainEnabled !== undefined
      ? options.dawBrainEnabled
      : env.XYP_DISABLE_DAW_BRAIN !== '1' && env.XYP_ENABLE_DAW_BRAIN !== '0';

  const vaultAvailability = inspectVaultAvailability(config.vaultRoot);
  if (options.strictVaultRequired && !vaultAvailability.available) {
    const err = new Error(
      `OS3_STARTUP_VAULT_UNAVAILABLE: ${vaultAvailability.reason ?? 'Vault unavailable'}`,
    ) as Error & { code: string };
    err.code = 'OS3_STARTUP_VAULT_UNAVAILABLE';
    throw err;
  }

  const startupRecovery =
    options.recoverInterruptedJobs !== false
      ? recoverInterruptedRuntimeState(db)
      : { recoveredLocksCount: 0, recoveredJobIds: [] };

  const migrationStatus = detectIncompleteMigrations(db, config.vaultRoot);
  if (options.failOnIncompleteMigration && !migrationStatus.complete) {
    const err = new Error(
      `OS3_INCOMPLETE_MIGRATION_DETECTED: ${migrationStatus.incompleteReasons.join('; ')}`,
    ) as Error & { code: string };
    err.code = 'OS3_INCOMPLETE_MIGRATION_DETECTED';
    throw err;
  }

  return {
    config,
    dawBrainEnabled,
    vaultAvailability,
    migrationStatus,
    startupRecovery,
  };
};
