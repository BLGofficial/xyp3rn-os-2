# XYP3RN OS 3.0 + DAW Brain — Minimal SQLite Runtime Store (Phase 05)

**Status:** Phase 05 Implementation Delivered  
**Package Root:** [core/sqlite/](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/client.ts)  
**Engine:** Node built-in `node:sqlite` (`DatabaseSync`) — zero external SQL services at runtime.

---

## 1. Boundary & Canonical Prohibition

Local SQLite stores **only** operational execution state, lease/lock coordination, immutable audit/command trails, and rebuildable index cache. It MUST NEVER become a second authoritative Knowledge Layer.

- **Approved Runtime Tables (`ALLOWED_RUNTIME_SQLITE_TABLES`):**
  - Core OS3 (`v1`): `schema_meta`, `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`, `index_meta`.
  - Compatibility Views (`v2`): `runs` (over `agent_runs`), `approvals` (over `pending_approvals`).
  - DAW Operational (`v3`, per [OS3_DATA_ARCHITECTURE.md](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/docs/OS3_DATA_ARCHITECTURE.md) §4): `daw_sessions`, `daw_session_leases`, `daw_command_journal`, `daw_audio_analyses`.
- **Forbidden Canonical Tables (`FORBIDDEN_CANONICAL_SQLITE_TABLES`):**
  `canonical_claims`, `knowledge_sources`, `knowledge_chunks`, `research_projects`, `research_questions`, `evidence_items`, `findings`, `contradictions`, `experiments`, `songs`, `lyrics`, `releases`, `tracks`, `rights_splits`, `agents`, `workflows`, `plugins`, `plugin_profiles`, `plugin_chains`, `daw_knowledge`, `mix_references`, `canonical_prompts`, `prompt_variants`, `dsp_concepts`.
  Checked automatically by `SqliteRuntimeDb.checkIntegrity()` and `inspectSqliteFile()`.
- **Legacy SQL Preservation:** Existing PostgreSQL / Supabase migrations (`supabase/migrations/`, `core/db/`) are left completely unmodified.

---

## 2. Schema, Versioned Migrations, Constraints & Indexes

Implemented in [schema.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/schema.ts) and [schema-migrations.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/schema-migrations.ts) (`LATEST_SQLITE_SCHEMA_VERSION = 3`):

| Migration | Scope | Constraints & Immutability Triggers | Indexes |
|---|---|---|---|
| `v1` (`0001_os3_minimal_runtime_tables`) | `schema_meta`, `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`, `index_meta` | `CHECK` state/error-detail invariants, `UNIQUE (item_type, item_id)`, seal triggers (`trg_agent_runs_seal`, `trg_jobs_seal`, `trg_pending_approvals_seal`), strict append-only triggers (`trg_*_no_delete`, `trg_runtime_events_no_update`) | `idx_agent_runs_agent_created`, `idx_agent_runs_status`, `idx_agent_runs_job`, `idx_jobs_kind_status`, `idx_jobs_created`, `idx_locks_expires`, `idx_runtime_events_type`, `idx_runtime_events_target`, `idx_pending_approvals_status`, `idx_index_state_{sector,domain,sha256,title}` |
| `v2` (`0002_os3_runs_and_approvals_views`) | `runs`, `approvals` views | Read-only views projecting `agent_runs` and `pending_approvals` | Uses base table indexes |
| `v3` (`0003_os3_daw_runtime_tables`) | `daw_sessions`, `daw_session_leases`, `daw_command_journal`, `daw_audio_analyses` | Non-empty text checks, `status` / `max_permission` / `source_kind` enums, FKs (`ON DELETE CASCADE` on leases, `ON DELETE RESTRICT` on journal -> sessions/approvals, `ON DELETE SET NULL` on analyses), `trg_daw_command_journal_no_update`, `trg_daw_command_journal_no_delete` | `idx_daw_sessions_adapter_status`, `idx_daw_sessions_updated`, `idx_daw_leases_session_active`, `idx_daw_journal_session_time`, `idx_daw_journal_status`, `idx_daw_audio_session_time`, `idx_daw_audio_sha` |

Every migration executes inside an isolated `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` transaction in `applySqliteMigrations()` and records applied versions in `schema_meta`.

---

## 3. Typed Data-Access Layer & Concurrency Policy

### 3.1 Repository Interfaces ([repositories.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/repositories.ts))
`createRuntimeRepositories(db)` exposes strongly typed repositories on `db.repositories`:
- Core runtime: `runs` (`RunsRepository`), `jobs` (`JobsRepository`), `locks` (`LocksRepository`), `approvals` (`ApprovalsRepository`), `events` (`EventsRepository`), `sessions` (`SessionsRepository`), `indexState` (`IndexStateRepository`).
- DAW runtime: `dawSessions` (`DawSessionsRepository`), `dawLeases` (`DawLeasesRepository`), `dawCommandJournal` (`DawCommandJournalRepository`), `dawAudioAnalyses` (`DawAudioAnalysesRepository`).
- Operations: `maintenance` (`RuntimeMaintenanceRepository` — `prune`, `checkIntegrity`, `backup`, `transaction`).

### 3.2 Concurrency & Locking Policy ([client.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/client.ts))
- Connection PRAGMAs applied unconditionally on every open (`SqliteRuntimeDb` constructor):
  - `PRAGMA foreign_keys = ON;` (re-enabled on every reopen, not only migration `v1`)
  - `PRAGMA journal_mode = WAL;` (file-backed DBs)
  - `PRAGMA synchronous = NORMAL;`
  - `PRAGMA busy_timeout = 5000;`
  - `PRAGMA temp_store = MEMORY;`
- Transactions (`db.transaction(fn)`): top-level calls acquire immediate write serialization via `BEGIN IMMEDIATE`; nested calls use named `SAVEPOINT sp_os3_<depth>` so partial inner failures roll back cleanly without aborting outer work.
- Locks & stale recovery: `acquireLock()`, `renewLock()`, `releaseLock()`, `recoverStaleLocks()`, and `recoverStaleRunningJobs()` execute inside transactions; expired locks (`expires_at <= now`) are purged automatically on contention checks.

---

## 4. Retention, Online Backup & Corrupt-DB Recovery

### 4.1 Retention Policy (`db.pruneRuntimeState(policy)`)
Prunes **only disposable or expired runtime records** inside a single transaction while keeping all sealed audit/run/job/approval/command history intact:
- Removes expired resource `locks` (`expires_at <= referenceIso`).
- Prunes expired or revoked `daw_session_leases` past `leaseExpiredGraceDays` (default `7`).
- Prunes idle operator `sessions` past `sessionMaxAgeDays` (default `30`).
- Prunes transient `daw_audio_analyses` past `audioAnalysisMaxAgeDays` (default `30`).
- Prunes `'closed'` / `'disconnected'` `daw_sessions` past `closedDawSessionMaxAgeDays` (default `30`) ONLY when unreferenced by `daw_command_journal`.
- Emits `runtime.retention.pruned` summary with `retainedImmutableCounts` into `runtime_events`.

### 4.2 Online Backup & Safe Restoration ([client.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/client.ts), [recovery.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/recovery.ts))
- **Backup (`db.backupDatabase(destPath)`):** flushes WAL (`PRAGMA wal_checkpoint(TRUNCATE)`), writes a clean snapshot via `VACUUM INTO`, verifies `PRAGMA integrity_check` read-only on the snapshot, and logs `runtime.db.backup`.
- **Backup Restoration (`restoreSqliteDatabase({ backupPath, targetPath })`):** validates the backup first (`inspectSqliteFile`, rejecting missing or corrupted backups before touching target), copies through a temporary staging file, quarantines any existing target + `-wal`/`-shm` sidecars into `.quarantine/`, removes stale WAL sidecars, swaps atomically, and re-verifies integrity.
- **Corruption Recovery (`openRuntimeDbWithRecovery(dbPath, { backupPaths })`):** inspects existing DB files before returning a live handle; if corrupted (`SQLITE_CORRUPT`, truncated bytes, invalid header, or integrity failure), quarantines the damaged files cleanly, restores from the newest verified backup (or initializes a clean `v3` DB if none exists), and logs `runtime.db.recovered`.

---

## 5. Verification Commands

```powershell
pnpm.cmd typecheck
pnpm.cmd vitest run tests/os3-phase1/sqlite-runtime.test.ts tests/os3-phase5-runtime/local-runtime.test.ts
```
