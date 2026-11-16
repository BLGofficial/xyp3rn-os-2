import type { DatabaseSync } from 'node:sqlite';
import { SQLITE_DDL } from './schema.ts';

export type SqliteMigrationSpec = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

/**
 * Forbidden canonical knowledge tables that must NEVER be created inside local SQLite.
 * Canonical content lives exclusively in the external Obsidian Vault.
 */
export const FORBIDDEN_CANONICAL_SQLITE_TABLES = [
  'canonical_claims',
  'knowledge_sources',
  'knowledge_chunks',
  'research_projects',
  'research_questions',
  'evidence_items',
  'findings',
  'contradictions',
  'experiments',
  'songs',
  'lyrics',
  'releases',
  'tracks',
  'rights_splits',
] as const;

export const ALLOWED_RUNTIME_SQLITE_TABLES = [
  'schema_meta',
  'agent_runs',
  'jobs',
  'locks',
  'sessions',
  'runtime_events',
  'pending_approvals',
  'index_state',
  'index_meta',
] as const;

export const SQLITE_MIGRATIONS: readonly SqliteMigrationSpec[] = [
  {
    version: 1,
    name: '0001_os3_minimal_runtime_tables',
    sql: SQLITE_DDL,
  },
  {
    version: 2,
    name: '0002_os3_runs_and_approvals_views',
    sql: `
      CREATE VIEW IF NOT EXISTS runs AS
      SELECT
        id,
        agent_name,
        class,
        domain,
        model,
        input_json,
        output_json,
        tokens_used,
        latency_ms,
        status,
        error_detail,
        job_id,
        step_id,
        created_at,
        completed_at
      FROM agent_runs;

      CREATE VIEW IF NOT EXISTS approvals AS
      SELECT
        id,
        item_type,
        item_id,
        status,
        request_json,
        proposer,
        approver,
        reason,
        created_at,
        decided_at
      FROM pending_approvals;
    `,
  },
] as const;

/**
 * Applies all pending SQLite runtime schema migrations inside a transaction.
 */
export const applySqliteMigrations = (db: DatabaseSync): {
  readonly currentVersion: number;
  readonly appliedVersions: readonly number[];
} => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const rows = db.prepare('SELECT version FROM schema_meta ORDER BY version ASC').all() as {
    version: number;
  }[];
  const existing = new Set<number>(rows.map((r) => Number(r.version)));
  const appliedVersions: number[] = [];

  for (const mig of SQLITE_MIGRATIONS) {
    if (existing.has(mig.version)) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(mig.sql);
      db.prepare('INSERT OR IGNORE INTO schema_meta (version, applied_at) VALUES (?, ?)').run(
        mig.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT;');
      appliedVersions.push(mig.version);
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  const maxRow = db.prepare('SELECT MAX(version) as v FROM schema_meta').get() as { v: number | null };
  return {
    currentVersion: Number(maxRow?.v ?? 0),
    appliedVersions,
  };
};
