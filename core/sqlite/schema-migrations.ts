import type { DatabaseSync } from 'node:sqlite';
import { SQLITE_DDL } from './schema.ts';

export type SqliteMigrationSpec = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

export const LATEST_SQLITE_SCHEMA_VERSION = 3;

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
  'agents',
  'workflows',
  'plugins',
  'plugin_profiles',
  'plugin_chains',
  'daw_knowledge',
  'mix_references',
  'canonical_prompts',
  'prompt_variants',
  'dsp_concepts',
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
  'daw_sessions',
  'daw_session_leases',
  'daw_command_journal',
  'daw_audio_analyses',
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
  {
    version: 3,
    name: '0003_os3_daw_runtime_tables',
    sql: `
      -- 10. daw_sessions: Operational DAW connection & cached live observation state (NEVER canonical knowledge)
      CREATE TABLE IF NOT EXISTS daw_sessions (
        id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL CHECK (length(trim(adapter_id)) > 0),
        host_version TEXT NOT NULL CHECK (length(trim(host_version)) > 0),
        project_path TEXT,
        saved_sha256 TEXT,
        cached_snapshot_json TEXT,
        cached_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('connected', 'stale', 'disconnected', 'closed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_daw_sessions_adapter_status ON daw_sessions (adapter_id, status);
      CREATE INDEX IF NOT EXISTS idx_daw_sessions_updated ON daw_sessions (updated_at DESC);

      -- 11. daw_session_leases: Bounded capability leases above observe-only baseline
      CREATE TABLE IF NOT EXISTS daw_session_leases (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES daw_sessions(id) ON DELETE CASCADE,
        max_permission TEXT NOT NULL CHECK (
          max_permission IN ('observe', 'analyze', 'propose', 'prepare', 'execute', 'rollback')
        ),
        granted_by TEXT NOT NULL CHECK (length(trim(granted_by)) > 0),
        allowed_targets_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_daw_leases_session_active ON daw_session_leases (session_id, expires_at DESC);

      -- 12. daw_command_journal: Immutable append-only command receipts (before/after state)
      CREATE TABLE IF NOT EXISTS daw_command_journal (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES daw_sessions(id) ON DELETE RESTRICT,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE RESTRICT,
        capability_id TEXT NOT NULL CHECK (length(trim(capability_id)) > 0),
        target_ref TEXT NOT NULL CHECK (length(trim(target_ref)) > 0),
        command_json TEXT NOT NULL,
        before_state_json TEXT,
        after_state_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'executed', 'failed', 'rolled_back', 'denied')),
        error_detail TEXT,
        executed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CHECK (status != 'failed' OR (error_detail IS NOT NULL AND length(trim(error_detail)) > 0))
      );

      CREATE INDEX IF NOT EXISTS idx_daw_journal_session_time ON daw_command_journal (session_id, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_daw_journal_status ON daw_command_journal (status, executed_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_daw_command_journal_no_update
      BEFORE UPDATE ON daw_command_journal
      BEGIN
        SELECT RAISE(ABORT, 'daw_command_journal is immutable; updates are forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_daw_command_journal_no_delete
      BEFORE DELETE ON daw_command_journal
      BEGIN
        SELECT RAISE(ABORT, 'daw_command_journal is append-only; deletion is forbidden');
      END;

      -- 13. daw_audio_analyses: Transient operational TRACE & browser DSP telemetry store
      CREATE TABLE IF NOT EXISTS daw_audio_analyses (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES daw_sessions(id) ON DELETE SET NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('bounce_wav', 'trace_vst', 'browser_dsp')),
        source_sha256 TEXT NOT NULL CHECK (length(trim(source_sha256)) > 0),
        trace_analysis_json TEXT NOT NULL,
        trace_report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_daw_audio_session_time ON daw_audio_analyses (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_daw_audio_sha ON daw_audio_analyses (source_sha256);
    `,
  },
] as const;

/**
 * Applies pending SQLite runtime schema migrations atomically (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`).
 */
export const applySqliteMigrations = (
  db: DatabaseSync,
  migrations: readonly SqliteMigrationSpec[] = SQLITE_MIGRATIONS,
): {
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

  for (const mig of migrations) {
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
