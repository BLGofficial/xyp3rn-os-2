# XYP3RN OS 3.0 + DAW Brain — Data Architecture Specification (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Baseline:** [DATA_ARCHITECTURE.md](os3/architecture/DATA_ARCHITECTURE.md) · [core/sqlite/schema.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/sqlite/schema.ts)

---

## 1. Storage Ownership Partitioning

| Store | Location | Owns | Authority Rule |
|---|---|---|---|
| **External Obsidian Vault** | `OBSIDIAN_VAULT_PATH` (`C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain`) | Knowledge notes, 52+ agents (`04_AGENTS/`), workflows (`05_WORKFLOWS/`), architecture/ADR docs, research briefs/evidence/findings, X3LIUS songs/lyrics/packages, audio-extracted prompts (`09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/`), approved Plugin Profiles, Mix Rubrics, DAW Production Plans, Governance policies. | **Sole canonical content store.** Every write passes through `VaultEngine`; canonical paths require human `PromotionGate`. |
| **Content-Addressed Binary Store** | `<vault>/.vault/` & `<vault>/.vault-revisions/` | Audio/image/PDF binaries (`<sha256>`) and pre-overwrite file revisions (`<sha256>.blob` + `.meta.json`). | Immutable SHA-256 content addressing; imported Web UI audio players use ephemeral RAM `ObjectURL` unless saved explicitly. |
| **Local WAL SQLite Runtime DB** | `.local-db/xyp3rn-os3.sqlite` (`core/sqlite/`) | `schema_meta`, `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, derived `index_state`/`index_meta`, plus **new Phase 02 DAW operational tables** (`daw_sessions`, `daw_session_leases`, `daw_command_journal`, `daw_render_jobs`). | Operational execution state & **disposable derived cache only**. Enforces `FORBIDDEN_CANONICAL_SQLITE_TABLES` (`songs`, `lyrics`, `canonical_claims`, etc. banned). |
| **DAW Project Files** | User Workstation DAW folders (`.flp`, `.rpp`) | Binary/text DAW native project files on local filesystem. | Read-only inspected by OS3 via hash-verified snapshots (`savedProject`). **Never mutated directly in binary by OS3.** |
| **Legacy PostgreSQL (`core/db/`)** | `supabase/migrations/` (inactive at runtime) | Transitional Records parity reference & legacy OS2 tables (`apps/web/`). | Frozen offline; retained solely for parity verification and emergency rollback (`Rule 10`). |
| **Browser `localStorage` (`UI-xyp3rn`)** | Client browser storage | `xyp3rn.constellation.status.v1`, `xyp3rn.jarvis.session.v1`, `xyp3rn.ui.prefs.v1`. | Presentation preferences only; zero secrets or canonical truth. |

---

## 2. New Phase 02 Vault Entity Schemas (Obsidian YAML Frontmatter `v3`)

### 2.1. Plugin Profile (`xyp3rn.daw-plugin/v3`)
**Path:** `09_X3LIUS_MUSIC/PLUGINS/<vendor>-<plugin-slug>.md`
```yaml
---
schema: "xyp3rn.daw-plugin/v3"
id: "plugin-fabfilter-pro-q3"
type: "daw_plugin_profile"
title: "FabFilter Pro-Q 3"
domain: "RECORDS"
sector: "09_X3LIUS_MUSIC"
status: "canonical" # Promotion-gated if overriding system catalog
version: 1
source_sha256: "..."
plugin_format: "vst3" # fl-native | vst3 | vst2 | clap
vendor: "FabFilter"
install_path: "C:/Program Files/Common Files/VST3/FabFilter Pro-Q 3.vst3"
edition_requirement: "third-party-licensed" # producer | signature | all-plugins | third-party-licensed
category: "eq"
semantic_params:
  band1.freq_hz: { canonicalKey: "eq.band1.freq", minHz: 10, maxHz: 30000 }
  band1.gain_db: { canonicalKey: "eq.band1.gain", minDb: -30, maxDb: 30, clampStepDb: 3.0 }
tags: ["daw-brain", "plugin", "vst3", "eq"]
---
# Usage Notes, Mix Character & Safe Ranges
```

### 2.2. DAW Session Audit & Mix Report (`xyp3rn.daw-session-report/v3`)
**Path:** `09_X3LIUS_MUSIC/DAW_SESSIONS/<date>-<project-slug>.md`
```yaml
---
schema: "xyp3rn.daw-session-report/v3"
id: "daw-sess-20261116-neon-static"
type: "daw_session_report"
title: "Neon Static — FL Studio 2025 Mix Diagnostic"
domain: "RECORDS"
sector: "09_X3LIUS_MUSIC"
status: "draft"
version: 1
source_sha256: "..."
daw_host: "fl-studio-2025"
daw_edition: "producer"
project_file_path: "D:/Projects/NeonStatic.flp"
saved_project_sha256: "e3b0c44..."
live_observed_at: "2026-11-16T18:00:00.000Z"
live_dirty_unsaved: true
trace_analysis_id: "trace-run-001"
tags: ["daw-brain", "session-report", "x3lius"]
---
```

### 2.3. Approved Production / Channel Chain Knowledge (`xyp3rn.daw-chain-recipe/v3`)
**Path:** `09_X3LIUS_MUSIC/MIX_CHAINS/<slug>.md` (canonical promotion required if entering global OS3 canon)
- Records portable signal chain stages (`subtractive-eq -> vocal-comp -> dynamic-deess -> plate-send`), mapped abstractly to `semantic_params` rather than raw FL slot numbers.

---

## 3. Five-Tier DAW Session State Data Model (Strict Discrimination Rule)

```ts
export type DawSessionStateContainer = {
  readonly sessionId: string;
  readonly adapterId: 'fl-studio-2025' | 'reaper';
  readonly hostVersion: string;
  /** 1. Live telemetry read directly from running DAW API right now. Never writes to project file. */
  readonly liveObserved: DawObservedSnapshot | null;
  /** 2. Latest persisted snapshot in SQLite for offline inspection; explicitly stamped stale=true when live stream down. */
  readonly cached: { readonly snapshot: DawObservedSnapshot; readonly capturedAt: string; readonly stale: boolean } | null;
  /** 3. Read-only parse of `.flp`/`.rpp` file on disk + SHA-256 fingerprint. Never inferred from RAM alone. */
  readonly savedProject: { readonly filePath: string; readonly fileSha256: string; readonly topology: DawSavedTopology; readonly parsedAt: string } | null;
  /** 4. Candidate patches generated by Audio Brain / Production Intelligence awaiting prepare -> approve -> execute. */
  readonly proposedModifications: readonly DawPatchProposal[];
  /** 5. Executed receipts against RAM host; tracks whether savedProject SHA has updated since patch execution. */
  readonly appliedModifications: readonly DawExecutionReceipt[];
};
```

**Divergence Invariant:** Whenever `liveObserved` differs from `savedProject.topology` OR `appliedModifications.some(m => !m.confirmedSavedOnDisk)`, `SessionModel` sets `hasUnsavedLiveChanges = true`, surfacing clear warnings to the operator before any `/R` CLI master bounce runs on stale disk saves!

---

## 4. New OS3 Runtime SQLite Tables (Extension to `core/sqlite/schema-migrations.ts`)

Added purely for runtime operational tracking (zero canonical prose or plugin libraries duplicated):

1. **`daw_sessions`**: `id`, `adapter_id`, `host_version`, `project_path`, `saved_sha256`, `cached_snapshot_json`, `cached_at`, `status`, `created_at`, `updated_at`.
2. **`daw_session_leases`**: `id`, `session_id`, `max_permission` (`'observe'|'analyze'|'propose'|'prepare'|'execute'|'rollback'`), `granted_by`, `allowed_targets_json`, `expires_at`, `revoked_at`.
3. **`daw_command_journal`**: `id`, `session_id`, `approval_id`, `capability_id`, `target_ref`, `command_json`, `before_state_json`, `after_state_json`, `status` (`'prepared'|'executed'|'failed'|'rolled_back'|'denied'`), `error_detail`, `executed_at` — **protected by SQLite `BEFORE UPDATE / BEFORE DELETE` immutability triggers** matching `agent_runs` & `runtime_events`.
4. **`daw_audio_analyses`**: `id`, `session_id`, `source_kind` (`'bounce_wav'|'trace_vst'|'browser_dsp'`), `source_sha256`, `trace_analysis_json`, `trace_report_json`, `created_at` (replaces PostgreSQL storage used previously by `tech/trace/server.ts`).
