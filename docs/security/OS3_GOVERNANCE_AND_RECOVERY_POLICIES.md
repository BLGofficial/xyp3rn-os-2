# OS3 + DAW Brain Governance, Observability & Recovery Policies (Phase 23)

**Scope:** Primary OS3 Kernel (`officialFolderofXYP3RNOS`), SQLite Runtime Store, Obsidian Vault Engine, DAW Brain / Plugin Brain / Audio Brain subsystems, and `UI-xyp3rn` Operator Interface.

---

## 1. Governance Policy Definitions (11 Domains)

### 1.1 Canonical Writes Policy
- **Rule:** Direct writes, appends, updates, conflict overrides, or unapproved restores to `CANONICAL_PATH_PREFIXES` (`00_SYSTEM/`, `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/`, `02_KNOWLEDGE/CANONICAL/`, `02_KNOWLEDGE_LAYER/`, `06_GOVERNANCE/`, `08_GOVERNANCE/`, `10_DAW_BRAIN/CAPABILITIES/`, `10_DAW_BRAIN/ADAPTERS/`, `10_DAW_BRAIN/MIX_MASTER_REFS/`, `canonical/`, and root docs other than `README.md`) are **forbidden** (`VaultPermissionError: CANONICAL_WRITE_FORBIDDEN`).
- **Exception Path:** Only `VaultEngine.promote()` / `VaultPromotionGate.promote()` may commit canonical files after independent human approval and provenance validation.

### 1.2 Knowledge Promotion Policy
- **Rule:** Promotion requires:
  1. An existing SQLite approval record with `status = 'approved'`.
  2. Non-agent, non-self human approver (`approver !== proposer` and not matching `AGENT_OR_SYSTEM_ACTOR_RE`).
  3. Non-empty provenance / `sourceRefs`.
  4. Schema validation (`validateEntityContent`) with zero `SECRET_DETECTED` or YAML issues.
- **Audit:** Immutable revision snapshot, SHA-256 checksum, and `vault.audit` (`operation='promote'`) event recorded in SQLite.

### 1.3 Agent Registration Policy
- **Rule:** Agents loaded by `Os3VaultAgentRegistry` from `04_AGENTS/*.agent.md` must declare valid `xyp3rn.agent/v3` frontmatter, kebab-case `name`, valid `class` (`Execution`, `Research`, `Strategy`, etc.), domain, model allowlist (`VALID_MODEL_RE`), and explicit capability/tool lists consistent with `CLASS_CAPABILITIES`.
- **Fail-Closed Hot-Reload:** Malformed agent files are quarantined into `failures` without overwriting the active snapshot; retired/archived/superseded agents are excluded from live execution.

### 1.4 Tool Registration & Execution Policy
- **Rule:** Tools registered in `Os3ToolRegistry` must declare snake_case names, non-empty stable IDs, valid `Capability`, allowed `AgentClass[]` subset of `CLASS_CAPABILITIES[capability]`, typed `inputSchema`/`outputSchema` (`additionalProperties` & path/shell guards via `disallowUnsafePathsOrShell`), explicit `timeoutMs`, and `defaultDeny: true`.
- **Execution Enforcement:** Non-implemented (`implemented: false`), shell-enabled, or unrestricted-FS tools fail closed at registration/execution unless explicitly sandboxed and human-approved.

### 1.5 Workflow Execution Policy
- **Rule:** `Os3WorkflowEngine` / `/api/workflows/run` validates declarative DAG YAML files, checks acyclicity and `requiredInputs`, resolves step agents against the live `Os3VaultAgentRegistry`, executes steps under per-run SQLite jobs (`jobs` + `agent_runs`), and prevents direct execution of `Execution`-restricted mutations by non-`Execution` agents (`403 PERMISSION_DENIED`).

### 1.6 DAW Actions Policy (DAW-Specific Controls)
Every mutating DAW action traverses the 11-stage `DawCommandGateway` pipeline enforcing all 10 required controls:
1. **DAW Instance Identity Verification:** `verifyDawInstanceIdentity` matches `expectedDawId`, `expectedAdapterId`, and observed snapshot provenance (`session.dawId` / `session.adapterId`).
2. **Project Identity Verification:** `verifyProjectIdentity` verifies `expectedProjectId`, normalized `expectedProjectPath`, and optional `expectedProjectSha256`.
3. **State Freshness Checks:** `verifyStateFreshness` rejects `disconnected`, `closed`, `degraded_cached`, `stale`, or aged observations exceeding `maxStateAgeMs` (`defaultMaxStateAgeMs = 15_000 ms`).
4. **Capability Verification:** `DawCapabilityRegistry` confirms adapter support and rejects `UNSUPPORTED` capabilities before input validation.
5. **Explicit Command Authorization:** Default-deny `INITIAL_PERMITTED_DAW_CAPABILITIES` allowlist (`daw.transport.control`, `daw.mixer.fader_pan_mute`, `daw.plugin.bypass`), prohibited kinds (`ALWAYS_PROHIBITED_COMMAND_KINDS`), safety bounds (`minGainDeltaDb..maxGainDeltaDb`, `minBpm..maxBpm`), and active scoped session leases (`DawSessionLease`).
6. **Risk Classification:** Classifies every command into `read_only`, `reversible`, `potentially_destructive`, `irreversible`, or `unsupported` with explicit `riskLevel` and `approvalRequirement`.
7. **Dry-Run Support:** Side-effect-free simulation (`DawDryRunEngine`) computes `beforeState`, predicted diff, and warnings without touching live DAW state.
8. **Human Approval Gate:** Single-use human approval in SQLite (`#consumedApprovalIds` replay lock after execution; F35/D2 self-approval ban; `human_strong` / `confirmDangerous` required for high-risk or no-rollback actions).
9. **Execution Audit:** Single-shot execution guarded by `#inFlightCommandIds`, `#completedCommandIds`, `#completedIdempotencyKeys`, timeout/abort cancellation, and immutable SQLite `daw_commands` + receipt records.
10. **Postcondition Validation:** Live adapter readback (`adapter.observe`) verifies predicted postcondition state (`verifyPostcondition`), triggering automatic recovery/rollback on mismatch (`DAW_POSTCONDITION_FAILED`).

### 1.7 Plugin Parameter Changes Policy
- **Rule:** `plugin.param_write` and `plugin.load_remove` are **excluded from default permitted capabilities** (`INITIAL_PERMITTED_DAW_CAPABILITIES` excludes them). Parameter ranges must normalize cleanly `[0.0, 1.0]` and pass adapter bounds + explicit policy opt-in + human approval before mutating any DAW slot.
- **Metadata Ingestion Boundary:** `PluginCatalogRegistry` enforces `MAX_PLUGIN_INGEST_BATCH = 2000`, `MAX_PLUGIN_PARAMS = 2048`, prototype key blocking, control-char sanitization, and never promotes knowledge articles into `verified_installed` host truth.

### 1.8 Audio Processing Policy
- **Rule:** Audio Brain (`AudioBrain`) is strictly read-only analysis (`acquisition -> decode -> DSP -> MIR -> diagnostics -> recommendations`). Destructive host audio operations (`audio.destructive_process`) are prohibited (`ALWAYS_PROHIBITED_COMMAND_KINDS`).
- **Acquisition & Decoding Limits:** Regular files only (no symlinks by default), `MAX_AUDIO_FILE_BYTES = 64 MiB`, `MAX_WAV_FRAME_COUNT = 16_000_000`, `sampleRateHz` in `[8_000, 384_000]`, pre/post-read consistency check, and zero internal DAW RAM buffer tapping (`assertNoUnsupportedDawAudioTap`). Reverse-engineered prompts extract Markdown specs only and never store raw audio binaries in Vault.

### 1.9 Records Modification Policy (`06_RECORDS` / `09_X3LIUS_MUSIC`)
- **Rule:** Song, lyric, contributor credit, split proposal, master version, and provenance fields obey strict schema validation (`validateEntityContent`), unified contributor namespaces, version-pinned split totals (100% / unassigned explicitly flagged), and non-destructive retractions instead of silent deletion or overwrite (`writeMode` defaults to `no-overwrite` or `compare-and-swap`). DAW sessions link to catalog records without replacing canonical Records authority.

### 1.10 Release & Distribution Operations Policy
- **Rule:** Unattended publishing (`distribution.publish`) is permanently banned (`ALWAYS_PROHIBITED_COMMAND_KINDS`). Master readiness checks enforce human approval of master mixes, clipping ceilings, valid ISRC/UPC & platform URL constraints, and explicit operator release scheduling safeguards.

### 1.11 Archive & Supersession Policy (`12_ARCHIVE`)
- **Rule:** Governed by `core/vault-engine/vault-archive.ts` (`archiveVaultNote`, `supersedeVaultNote`). Canonical notes reject direct archival/supersession outside Promotion Gate. Only `RETIRED` and `SUPERSEDED` subdirectories in `12_ARCHIVE/` are permitted; archiving notes already inside archive sectors is refused; working notes superseded receive compare-and-swap status transitions with `superseded_by`, `superseded_at`, and `previous_sha256`.

---

## 2. Observability Structured Event Contract

All durable runtime and security events append to SQLite `runtime_events` and stream through `StructuredLogger` (`core/runtime/logger.ts`), stripping API keys (`sk-or-v1-`, `sk-ant-`, `sk-proj-`, `ghp_`, `github_pat_`, `gsk_`, `AIza`), PEM keys, bearer headers, query-string tokens, DB credential URIs, and raw audio buffers (`channelData`, `pcmSamples`, `audioBuffer`, `audioBase64`, `rawBytes`).

| # | Event Domain | Structured Event Type(s) |
|---|---|---|
| 1 | Agent executions | `agent.run.completed`, orchestrator lifecycle events |
| 2 | Workflow executions | `workflow.completed`, job state transitions |
| 3 | Vault operations | `vault.audit` (`write`, `update`, `append`, `promote`, `restore`, `snapshot`, `resolveConflict`), `vault.write.denied` |
| 4 | DAW observations | `daw.instance.discovered`, `daw.version.checked`, `daw.session.observed`, `daw.session.stale`, `daw.session.drift_detected` |
| 5 | DAW commands | `daw.command.proposed`, `daw.command.dry_run`, `daw.command.prepared`, `daw.command.executed`, `daw.command.denied`, `daw.command.cancelled`, `daw.command.timed_out`, `daw.command.rolled_back` |
| 6 | Plugin analysis | `daw.plugin.analyzed` |
| 7 | Audio analysis | `daw.audio.analyzed`, `daw.audio.rejected` (`sourceSha256`, `verdict`, `durationSec` only — no audio bytes) |
| 8 | Approvals | `approval.decided`, `governance.self_approval_blocked`, `daw.lease.granted`, `daw.lease.revoked` |
| 9 | Errors | `runtime.error`, gateway `http.error`, adapter error receipts |
| 10 | Recovery | `daw.command.recovered`, `daw.adapter.disconnected`, SQLite `restoreSqliteDatabase`, Vault `restore()` |

---

## 3. Operational Recovery Procedures (8 Runbooks)

1. **Vault Backup:** Run `VaultEngine.snapshot('scheduled-backup', 'operator')` to write a SHA-256 verified manifest to `.vault-revisions/snapshots/<id>.json` and back up all sector Markdown files + `.vault-revisions/` offline via immutable copy (excluding secrets).
2. **SQLite Backup:** Pause writes or execute an online SQLite backup copy (checking WAL checkpoint completion), then validate the copy with `inspectSqliteFile(backupPath)` (`PRAGMA integrity_check = ok`, `PRAGMA foreign_key_check = 0 violations`, no `FORBIDDEN_CANONICAL_SQLITE_TABLES`). Restore atomically using `restoreSqliteDatabase()` (`core/sqlite/recovery.ts`), which quarantines corrupted targets into `.quarantine/`.
3. **Records Backup:** Export `06_RECORDS/` & `09_X3LIUS_MUSIC/` Markdown notes together with SQLite `daw_audio_analyses` / `daw_commands` / `approvals` snapshot manifests so master version approvals and split lineage retain dual cryptographic provenance (`sha256` + revision chain).
4. **Index Rebuilding:** If `sqlite` FTS5 or link tables lag behind Vault Markdown files, execute `pnpm.cmd vault:os3 scan` (`VaultEngine.scanVault({ full: true })`) to recompute SHA-256 digests, FTS5 tokens, and wikilink edges deterministically from disk.
5. **Interrupted Job Recovery:** On Gateway restart after crash/abort, query SQLite `jobs` in `'running'` or `'queued'` state and active `locks` (`expires_at <= now` auto-evicted); mark stale orphaned jobs failed with diagnostic error detail and release/expire deadlocks before re-queuing idempotent workflows.
6. **DAW Disconnection Recovery:** When `HttpReaperBridgeTransport` / FL MIDI bridge drops, `DawConnectionManager` transitions connection state to `degraded_cached` / `disconnected` and emits `daw.adapter.degraded` / `daw.adapter.disconnected`; mutating commands immediately fail closed (`DAW_HOST_OFFLINE` / `DAW_STALE_STATE`). Operator recovery runs `POST /api/daw/connections/probe`, reconnects session, and executes `POST /api/daw/sessions/refresh` before preparing new commands.
7. **Project State Mismatch Handling:** If `expectedProjectId`, normalized `expectedProjectPath`, `expectedProjectSha256`, or `expectedBeforeDigest` diverges (or project `.flp`/`.rpp` shifts mid-session), gateway halts with `DAW_PROJECT_MISMATCH` / `DAW_TARGET_DRIFT`. Re-observe live host state via `refreshSession()`, re-run `dryRun` / `prepare`, and obtain fresh approval against the updated project digest.
8. **Command Failure Recovery:** On `DAW_TIMEOUT`, `DAW_CANCELLED`, or `DAW_POSTCONDITION_FAILED`, `DawCommandGateway` invokes `#attemptInterruptedRecovery()` to re-observe state and attempt automatic rollback strictly if `rollbackSupported === true`; otherwise marks receipt failed/no-rollback (`DAW_ROLLBACK_UNSUPPORTED`) for manual operator host reconciliation (`rollbackReceipt`).
