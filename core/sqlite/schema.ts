/**
 * XYP3RN OS 3.0 — Minimal Local SQLite Runtime Schema.
 *
 * Architectural ownership (OS 3.0 Master Context):
 * SQLite owns ONLY operational runtime state and disposable index state:
 *   1. agent_runs        — append-then-seal execution log
 *   2. jobs              — workflow / research / index / task job queue and runs
 *   3. locks             — resource & file concurrency locks
 *   4. sessions          — operator & Jarvis console sessions
 *   5. runtime_events    — append-only runtime & Vault audit trail
 *   6. pending_approvals — human approval queue (Promotion Gate, splits, artifacts)
 *   7. index_state       — disposable structural cache of Obsidian Vault files (NEVER canonical)
 *   8. index_meta        — last scan metadata and counters
 *
 * Canonical knowledge, agent definitions, workflows, research and creative records
 * live as Markdown/YAML inside the external Obsidian Vault.
 */

export const SQLITE_SCHEMA_VERSION = 1;

export const SQLITE_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 1. agent_runs: Every agent execution writes one row and seals on completion.
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  class TEXT,
  domain TEXT,
  model TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT,
  tokens_used INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'error')),
  error_detail TEXT,
  job_id TEXT,
  step_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  CHECK (
    (status = 'pending' AND completed_at IS NULL) OR
    (status IN ('success', 'error') AND completed_at IS NOT NULL)
  ),
  CHECK (status != 'error' OR (error_detail IS NOT NULL AND length(trim(error_detail)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created ON agent_runs (agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs (status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs (job_id);

CREATE TRIGGER IF NOT EXISTS trg_agent_runs_seal
BEFORE UPDATE ON agent_runs
BEGIN
  SELECT CASE
    WHEN OLD.status != 'pending' THEN
      RAISE(ABORT, 'agent_runs row is sealed once status leaves pending')
    WHEN NEW.id != OLD.id
      OR NEW.agent_name != OLD.agent_name
      OR COALESCE(NEW.class, '') != COALESCE(OLD.class, '')
      OR COALESCE(NEW.domain, '') != COALESCE(OLD.domain, '')
      OR NEW.input_json != OLD.input_json
      OR NEW.created_at != OLD.created_at THEN
      RAISE(ABORT, 'agent_runs identity columns are immutable')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_runs_no_delete
BEFORE DELETE ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent_runs is append-only; deletion is forbidden');
END;

-- 2. jobs: Workflows, research runs, indexing runs, and background tasks.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('workflow', 'research', 'ingest', 'index', 'task')),
  name TEXT NOT NULL,
  spec_sha256 TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'error', 'cancelled')),
  failed_step TEXT,
  skipped_steps_json TEXT NOT NULL DEFAULT '[]',
  error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL) OR
    (status IN ('success', 'error', 'cancelled') AND completed_at IS NOT NULL)
  ),
  CHECK (status != 'error' OR (error_detail IS NOT NULL AND length(trim(error_detail)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_jobs_seal
BEFORE UPDATE ON jobs
WHEN OLD.status IN ('success', 'error', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'jobs row is sealed once terminal');
END;

CREATE TRIGGER IF NOT EXISTS trg_jobs_no_delete
BEFORE DELETE ON jobs
BEGIN
  SELECT RAISE(ABORT, 'jobs is append-only; deletion is forbidden');
END;

-- 3. locks: Cooperative and advisory resource locks with TTL expiration.
CREATE TABLE IF NOT EXISTS locks (
  resource_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks (expires_at);

-- 4. sessions: Operator & Jarvis session state and bounded exchange log.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL DEFAULT 'owner',
  source TEXT NOT NULL CHECK (source IN ('cli', 'http', 'voice', 'ui')),
  active_sector TEXT,
  selected_job_id TEXT,
  exchanges_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 5. runtime_events: Strictly append-only audit and runtime event stream.
CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  domain TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_path TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  checksum_sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events (event_type, id DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_events_target ON runtime_events (target_path, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_update
BEFORE UPDATE ON runtime_events
BEGIN
  SELECT RAISE(ABORT, 'runtime_events is immutable; updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_delete
BEFORE DELETE ON runtime_events
BEGIN
  SELECT RAISE(ABORT, 'runtime_events is append-only; deletion is forbidden');
END;

-- 6. pending_approvals: Human-in-the-loop approval queue (F35 D2 invariant: nothing auto-approves).
CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (
    item_type IN (
      'knowledge_candidate',
      'split_proposal',
      'artifact_version',
      'critique_escalation',
      'rd_backlog_item',
      'vault_promotion'
    )
  ),
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  request_json TEXT NOT NULL,
  proposer TEXT NOT NULL,
  approver TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  UNIQUE (item_type, item_id),
  CHECK (
    (status = 'pending' AND approver IS NULL AND decided_at IS NULL) OR
    (status IN ('approved', 'rejected') AND approver IS NOT NULL AND length(trim(approver)) > 0 AND reason IS NOT NULL AND length(trim(reason)) > 0 AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals (status, created_at ASC);

CREATE TRIGGER IF NOT EXISTS trg_pending_approvals_seal
BEFORE UPDATE ON pending_approvals
BEGIN
  SELECT CASE
    WHEN OLD.status != 'pending' THEN
      RAISE(ABORT, 'pending_approvals row is sealed once decided')
    WHEN NEW.id != OLD.id
      OR NEW.item_type != OLD.item_type
      OR NEW.item_id != OLD.item_id
      OR NEW.request_json != OLD.request_json
      OR NEW.proposer != OLD.proposer
      OR NEW.created_at != OLD.created_at THEN
      RAISE(ABORT, 'pending_approvals request columns are immutable')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_pending_approvals_no_delete
BEFORE DELETE ON pending_approvals
BEGIN
  SELECT RAISE(ABORT, 'pending_approvals is append-only; deletion is forbidden');
END;

-- 7. index_state: Non-canonical structural index of the Obsidian Vault (rebuildable from disk).
CREATE TABLE IF NOT EXISTS index_state (
  vault_path TEXT PRIMARY KEY,
  sector TEXT NOT NULL,
  file_ext TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT NOT NULL,
  domain TEXT,
  doc_type TEXT,
  status TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  wikilinks_json TEXT NOT NULL DEFAULT '[]',
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  frontmatter_error TEXT,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_index_state_sector ON index_state (sector);
CREATE INDEX IF NOT EXISTS idx_index_state_domain ON index_state (domain);
CREATE INDEX IF NOT EXISTS idx_index_state_sha256 ON index_state (sha256);
CREATE INDEX IF NOT EXISTS idx_index_state_title ON index_state (title);

-- 8. index_meta: Key-value metadata for structural/semantic index scans.
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;
