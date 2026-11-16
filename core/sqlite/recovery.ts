import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ALLOWED_RUNTIME_SQLITE_TABLES,
  FORBIDDEN_CANONICAL_SQLITE_TABLES,
  LATEST_SQLITE_SCHEMA_VERSION,
} from './schema-migrations.ts';

export type SqliteFileInspection = {
  readonly path: string;
  readonly exists: boolean;
  readonly ok: boolean;
  readonly corrupt: boolean;
  readonly integrityCheck: string;
  readonly foreignKeyViolations: number;
  readonly schemaVersion: number;
  readonly forbiddenTablesFound: readonly string[];
  readonly error: string | null;
};

export type SqliteRestoreReport = {
  readonly ok: boolean;
  readonly backupPath: string;
  readonly targetPath: string;
  readonly quarantinePath: string | null;
  readonly byteSize: number;
  readonly integrityOk: boolean;
  readonly restoredAt: string;
};

/**
 * Safely inspects an on-disk SQLite file for header validity, B-tree corruption,
 * foreign-key integrity, and canonical table prohibition without mutating it.
 */
export const inspectSqliteFile = (dbPath: string): SqliteFileInspection => {
  const abs = resolve(dbPath);
  if (!existsSync(abs)) {
    return {
      path: abs,
      exists: false,
      ok: false,
      corrupt: false,
      integrityCheck: 'missing',
      foreignKeyViolations: 0,
      schemaVersion: 0,
      forbiddenTablesFound: [],
      error: `Database file not found: ${abs}`,
    };
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(abs, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check;').all() as Record<string, unknown>[];
    const integrityCheck = String(Object.values(rows[0] ?? {})[0] ?? 'unknown');

    const fkRows = db.prepare('PRAGMA foreign_key_check;').all() as Record<string, unknown>[];
    const tableRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`)
      .all() as { name: string }[];

    const tables = tableRows.map((r) => String(r.name));
    const forbiddenSet = new Set<string>(FORBIDDEN_CANONICAL_SQLITE_TABLES);
    const allowedSet = new Set<string>(ALLOWED_RUNTIME_SQLITE_TABLES);
    const forbiddenTablesFound = tables.filter((t) => forbiddenSet.has(t) || !allowedSet.has(t));

    let schemaVersion = 0;
    if (tables.includes('schema_meta')) {
      const verRow = db.prepare('SELECT MAX(version) as v FROM schema_meta').get() as { v: number | null } | undefined;
      schemaVersion = Number(verRow?.v ?? 0);
    }

    const corrupt = integrityCheck.toLowerCase() !== 'ok';
    const ok = !corrupt && fkRows.length === 0 && forbiddenTablesFound.length === 0 && schemaVersion >= 1;
    return {
      path: abs,
      exists: true,
      ok,
      corrupt,
      integrityCheck,
      foreignKeyViolations: fkRows.length,
      schemaVersion,
      forbiddenTablesFound,
      error: corrupt ? `PRAGMA integrity_check failed: ${integrityCheck}` : null,
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      path: abs,
      exists: true,
      ok: false,
      corrupt: true,
      integrityCheck: 'corrupt',
      foreignKeyViolations: 0,
      schemaVersion: 0,
      forbiddenTablesFound: [],
      error: msg,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close error on broken handle
    }
  }
};

/**
 * Moves a corrupted or superseded SQLite database (+ WAL/SHM sidecars) cleanly
 * into a quarantine directory instead of deleting or silently overwriting evidence.
 */
export const quarantineSqliteArtifacts = (dbPath: string, quarantineDir?: string): string | null => {
  const abs = resolve(dbPath);
  if (!existsSync(abs)) return null;

  const qDir = resolve(quarantineDir ?? join(dirname(abs), '.quarantine'));
  mkdirSync(qDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const qBase = join(qDir, `${basename(abs)}.corrupt-${stamp}-${randomUUID().slice(0, 6)}`);

  renameSync(abs, qBase);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${abs}${suffix}`;
    if (existsSync(sidecar)) {
      renameSync(sidecar, `${qBase}${suffix}`);
    }
  }
  return qBase;
};

/**
 * Atomically restores `targetPath` from a verified SQLite backup file.
 * Refuses missing or corrupted backups; preserves any existing target DB in `.quarantine/`.
 */
export const restoreSqliteDatabase = (options: {
  readonly backupPath: string;
  readonly targetPath: string;
  readonly quarantineDir?: string | undefined;
}): SqliteRestoreReport => {
  const backupAbs = resolve(options.backupPath);
  const targetAbs = resolve(options.targetPath);

  const backupCheck = inspectSqliteFile(backupAbs);
  if (!backupCheck.exists) {
    throw new Error(`Cannot restore SQLite database: backup file does not exist (${backupAbs})`);
  }
  if (!backupCheck.ok || backupCheck.corrupt) {
    throw new Error(
      `Refusing to restore corrupted SQLite backup (${backupAbs}): ${backupCheck.error ?? backupCheck.integrityCheck}`,
    );
  }

  mkdirSync(dirname(targetAbs), { recursive: true });
  const tempPath = join(dirname(targetAbs), `.restore-${process.pid}-${randomUUID()}.sqlite`);

  let quarantinePath: string | null = null;
  try {
    copyFileSync(backupAbs, tempPath);
    const stagedCheck = inspectSqliteFile(tempPath);
    if (!stagedCheck.ok || stagedCheck.corrupt) {
      throw new Error(`Staged SQLite restore copy failed integrity check: ${stagedCheck.error ?? stagedCheck.integrityCheck}`);
    }

    quarantinePath = quarantineSqliteArtifacts(targetAbs, options.quarantineDir);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      rmSync(`${targetAbs}${suffix}`, { force: true });
    }
    renameSync(tempPath, targetAbs);

    const finalCheck = inspectSqliteFile(targetAbs);
    const st = statSync(targetAbs);
    const integrityOk = finalCheck.ok && !finalCheck.corrupt && finalCheck.schemaVersion >= Math.min(1, LATEST_SQLITE_SCHEMA_VERSION);
    if (!integrityOk) {
      throw new Error(`Restored SQLite database failed post-swap verification: ${finalCheck.error ?? finalCheck.integrityCheck}`);
    }

    return {
      ok: true,
      backupPath: backupAbs,
      targetPath: targetAbs,
      quarantinePath,
      byteSize: st.size,
      integrityOk: true,
      restoredAt: new Date().toISOString(),
    };
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
};
