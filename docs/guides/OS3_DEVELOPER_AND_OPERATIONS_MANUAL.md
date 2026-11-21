# XYP3RN OS 3.0 + DAW Brain — Developer Experience & Operations Manual (Phase 25)

This manual provides complete step-by-step operational procedures for local installation, environment setup, startup/shutdown, Vault initialization, SQLite & OS2 migrations, FL Studio 2025 & REAPER adapter setup, test/build execution, backup/restore, and troubleshooting, plus the master documentation index.

---

## 1. Installation

1. **System Prerequisites (Windows 11 x64):**
   - **Node.js `>= 22.x`** (provides built-in `node:sqlite`; zero Docker or PostgreSQL required for OS3 runtime).
   - **pnpm** (`pnpm.cmd` on Windows PowerShell) for `officialFolderofXYP3RNOS`.
   - **npm** (`npm.cmd` on Windows PowerShell) for `UI-xyp3rn`.
   - **Git** for Vault and repository version checkpoints.
2. **Install Dependencies:**
   ```powershell
   cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
   pnpm.cmd install

   cd "C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn"
   npm.cmd install
   ```

---

## 2. Environment Setup

Create or inspect `.env.local` in `C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS`:

```ini
# Required: External Obsidian Vault path
OBSIDIAN_VAULT_PATH=C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain
OBSIDIAN_SYNC_MODE=bidirectional

# Local SQLite runtime database & backup folder
XYP_SQLITE_PATH=.local-db/xyp3rn-os3.sqlite
XYP_BACKUP_DIR=.local-db/backups

# Localhost HTTP Gateway (strictly 127.0.0.1)
XYP_GATEWAY_HOST=127.0.0.1
XYP_GATEWAY_PORT=8077

# Optional Security Hardening (recommended for shared workstations)
# XYP_GATEWAY_TOKEN=<random-32-byte-hex-token>
# XYP_REQUIRE_AUTH=1

# Optional DAW Brain Runtime Toggle (defaults to enabled; set to 1 to run OS3 without DAW Brain)
# XYP_DISABLE_DAW_BRAIN=0

# Optional UI repository location for start-os3.ps1
XYP_UI_REPO_PATH=C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn
```

---

## 3. Startup and Shutdown

- **Single-Command Full Stack Startup (Vault Scan + OS3 Gateway `:8077` + `UI-xyp3rn` `:3000`):**
  ```powershell
  cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
  pnpm.cmd start:os3
  ```
- **Manual Two-Terminal Startup:**
  - **Terminal 1 — OS3 Gateway (`http://127.0.0.1:8077`):**
    ```powershell
    cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
    pnpm.cmd gateway:os3
    ```
  - **Terminal 2 — Primary Constellation UI (`http://127.0.0.1:3000`):**
    ```powershell
    cd "C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn"
    npm.cmd run start -- -H 127.0.0.1 -p 3000
    ```
- **Graceful Shutdown:**
  - Press `Ctrl+C` (`SIGINT`/`SIGTERM`). The Gateway releases its singleton instance lock (`.local-db/xyp3rn-os3.sqlite.instance.lock` and SQLite `runtime:gateway:singleton`), closes active HTTP sockets, and closes SQLite cleanly.

---

## 4. Vault Initialization

```powershell
cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
pnpm.cmd vault:os3 provision   # Non-destructively provisions 14 sectors, 32 templates/schemas, 52 agents, 7 core workflows
pnpm.cmd vault:os3 scan        # Populates SQLite index_state, FTS5 search index, and wikilinks graph
pnpm.cmd vault:os3 validate    # Audits frontmatter YAML, schema rules, unique IDs, and 0 leaked secrets
```
*(Note: `provisionOs3Vault()` never overwrites existing Vault files.)*

---

## 5. Database & OS2-to-OS3 Migration

- **SQLite Runtime Schema Migrations (`core/sqlite/schema-migrations.ts`):**
  - Applied automatically and idempotently whenever `openRuntimeDb()` starts (`LATEST_SQLITE_SCHEMA_VERSION = 3`).
  - Verify schema & integrity via `GET http://127.0.0.1:8077/api/health` (`schemaVersion: 3`, `integrityOk: true`, `migrationComplete: true`).
- **OS2 Research Intelligence Migration (`Phase 19`):**
  ```powershell
  pnpm.cmd research:migrate --vault "C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain" --dry-run --report "docs/os3/migration/RESEARCH_MIGRATION_PARITY_REPORT.md"
  ```
- **OS2 X3LIUS Records & Music Migration (`Phase 20`):**
  ```powershell
  pnpm.cmd records:migrate --vault "C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain" --dry-run --report-out "docs/os3/migration/RECORDS_MUSIC_PARITY_REPORT.md"
  ```

---

## 6. DAW Adapter Setup (Universal DAW Brain)

- DAW Brain is **optional at runtime**: if no DAW is installed or running, OS3 boots normally and `/api/daw/overview` reports `connectionSummary.state = 'disconnected'` with explicit `missingPrerequisites`.
- To disable DAW Brain completely at runtime, set `XYP_DISABLE_DAW_BRAIN=1` before launching `pnpm.cmd gateway:os3`.
- All DAW adapters start in `connected_read_only` (`observe`) mode by default. Any mutating command (`transport.control`, `mixer.fader_pan_mute`, `plugin.bypass`) requires:
  1. Adapter running in `controlled_safe_v1` profile.
  2. An active time-bounded human session lease (`POST /api/daw/sessions/lease`).
  3. Stage 1–7 dry-run & proposal (`POST /api/daw/commands/propose`).
  4. Distinct human operator approval (`POST /api/daw/commands/decide`, `F35-D2`).

---

## 7. FL Studio 2025 Integration Setup

1. **Install Virtual MIDI Loopback (`loopMIDI` by Tobias Erichsen):**
   - Create two virtual ports named **`XYP3RN_IN`** and **`XYP3RN_OUT`**.
2. **Install the OS3 Controller Script:**
   - Copy `core/daw-adapters/fl-studio-2025/controller/XYP3RN_Brain/device_XYP3RNBrain.py` to:
     `C:\Users\<User>\Documents\Image-Line\FL Studio\Settings\Hardware\XYP3RN_Brain\device_XYP3RNBrain.py`
3. **Configure FL Studio MIDI Settings (`F10`):**
   - Assign **Output** `XYP3RN_OUT` and **Input** `XYP3RN_IN` (controller type: `XYP3RN Brain`) on matching port number.
4. **Verify Host Probe:**
   ```powershell
   node core/daw-adapters/fl-studio-2025/probe-cli.ts
   ```
   *(Full manual verification guide: `docs/daw/FL_STUDIO_2025_ADAPTER_MANUAL_TEST_GUIDE.md`.)*

---

## 8. REAPER Integration Setup

1. **Install Cockos REAPER (`>= 6.0`, recommended `7.x` x64)** to `C:\Program Files\REAPER (x64)\reaper.exe`.
2. **Load ReaScript Loopback Bridge:**
   - Copy `core/daw-adapters/reaper/reascript/xyp3rn_reaper_bridge.lua` into `%APPDATA%\REAPER\Scripts\`.
   - In REAPER: `Actions -> Show action list -> Load ReaScript...`, select `xyp3rn_reaper_bridge.lua`, and run it (binds strictly to `127.0.0.1:8088/rpc`).
3. **Optional Bridge Authentication:**
   - Configure a shared `bridgeToken` (`X-XYP-Bridge-Token`) in `HttpReaperBridgeTransport`.
   *(Full REAPER specification: `docs/daw/REAPER_ADAPTER.md` & `docs/daw/REAPER_SPEC.md`.)*

---

## 9. Test Commands

- **Complete Postgres-Free OS3 + DAW Brain Suite (`officialFolderofXYP3RNOS`):**
  ```powershell
  cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
  pnpm.cmd test:os3
  ```
- **DAW Brain Focused Suite (`officialFolderofXYP3RNOS`):**
  ```powershell
  pnpm.cmd test:daw
  ```
- **Primary UI Suite (`UI-xyp3rn`):**
  ```powershell
  cd "C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn"
  npm.cmd test
  ```

---

## 10. Build & Static Analysis Commands

```powershell
# 1. OS3 Backend Typecheck
cd "C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS"
pnpm.cmd typecheck

# 2. UI-xyp3rn Typecheck, Zero-Warning ESLint, and Production Build
cd "C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

---

## 11. Backup and Restore

- **Vault Snapshot & Single-Note Restore:**
  - `await vault.snapshot('label', 'blago-operator')` writes a SHA-256 manifest to `<VaultRoot>/.vault-revisions/snapshots/`.
  - `await vault.restore({ vaultPath, targetSha256, actor, reason })` restores any non-canonical note revision while preserving pre-restore history.
- **Vault Git Checkpoint:**
  - `await createGitCheckpoint(vaultRoot, 'checkpoint message')`.
- **SQLite Online Backup & Restore:**
  - `db.backupDatabase('.local-db/backups/os3-backup.sqlite')` executes online backup and verifies `PRAGMA integrity_check === 'ok'`.
  - Stop Gateway and call `restoreSqliteDatabase(backupPath, sqlitePath)` (or delete `.local-db/xyp3rn-os3.sqlite` and run `pnpm.cmd vault:os3 scan` to rebuild the index from the Obsidian Vault).
  *(Detailed guide: `docs/os3/operations/BACKUP_RESTORE_GUIDE.md`.)*

---

## 12. Troubleshooting

| Symptom / Error Code | Cause | Resolution |
| :--- | :--- | :--- |
| `OS3_DUPLICATE_RUNTIME_INSTANCE` | Another `gateway:os3` daemon is already running against the same `XYP_SQLITE_PATH`. | Stop the existing gateway process (or if it crashed hard, restart — stale PID locks are auto-reclaimed when the holder PID is no longer alive). |
| `vaultAvailable: false` (`degraded_unavailable`) on `/api/health` | `OBSIDIAN_VAULT_PATH` drive/folder is unmounted or misconfigured. | Verify `OBSIDIAN_VAULT_PATH` in `.env.local` points to the existing Obsidian Vault directory. |
| `OS3_INCOMPLETE_MIGRATION_DETECTED` | `.migration-in-progress.json` marker or unsealed `migration` job exists. | Inspect migration logs, re-run `pnpm.cmd research:migrate` or `pnpm.cmd records:migrate` (both are idempotent), and remove stale marker once parity verifies `ok: true`. |
| `DAW_HOST_OFFLINE` on FL Studio connect | `FL64.exe` is not running, `loopMIDI` ports `XYP3RN_IN`/`XYP3RN_OUT` are missing, or `device_XYP3RNBrain.py` is not enabled. | Run `node core/daw-adapters/fl-studio-2025/probe-cli.ts` and complete Section 7 setup. |
| `401 UNAUTHORIZED` / `403 FORBIDDEN` in `UI-xyp3rn` | `XYP_GATEWAY_TOKEN` mismatch or non-localhost `Origin`/`Host` header, or agent identity supplied as human `approver`. | Access UI via `http://127.0.0.1:3000`, match `XYP_GATEWAY_TOKEN`, and use a distinct human approver identity (`F35-D2`). |

---

## 13. Master Documentation Index (All 16 Finalized Guides)

1. **Master Architecture:** `docs/OS3_MASTER_ARCHITECTURE.md` & `docs/DAW_BRAIN_ARCHITECTURE.md`
2. **Module Contracts:** `docs/OS3_MODULE_CONTRACTS.md`
3. **API Reference:** `docs/OS3_API_CONTRACTS.md`
4. **Vault Conventions:** `docs/VAULT_FOUNDATION.md` & `docs/VAULT_ENGINE.md`
5. **Agent Development Guide:** `docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md` (Section 1) & `docs/AGENT_AND_TOOL_REGISTRY.md`
6. **Tool Development Guide:** `docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md` (Section 2) & `docs/AGENT_AND_TOOL_REGISTRY.md`
7. **Workflow Development Guide:** `docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md` (Section 3) & `docs/JARVIS_AND_WORKFLOW_ENGINE.md`
8. **DAW Adapter SDK Guide:** `docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md` (Section 4) & `docs/daw/DAW_ADAPTER_REQUIREMENTS.md`
9. **FL Studio Integration Guide:** `docs/daw/FL_STUDIO_2025_ADAPTER_MANUAL_TEST_GUIDE.md` & `docs/daw/FL_STUDIO_2025_SPEC.md`
10. **REAPER Integration Guide:** `docs/daw/REAPER_ADAPTER.md` & `docs/daw/REAPER_SPEC.md`
11. **Plugin Brain Guide:** `docs/daw/PLUGIN_BRAIN.md`
12. **Audio Brain Guide:** `docs/daw/AUDIO_BRAIN.md`
13. **DAW Safety Guide:** `docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md` (Section 5), `docs/daw/DAW_COMMAND_GATEWAY.md`, & `docs/security/OS3_GOVERNANCE_AND_RECOVERY_POLICIES.md`
14. **Production Workflows:** `docs/daw/DAW_EVALUATION_AND_WORKFLOWS.md`
15. **Operations Manual:** `docs/guides/OS3_DEVELOPER_AND_OPERATIONS_MANUAL.md` (this document) & `docs/os3/operations/BACKUP_RESTORE_GUIDE.md`
16. **Migration Documentation:** `docs/OS3_MIGRATION_PLAN.md`, `docs/research/PHASE_19_RESEARCH_MIGRATION.md`, `docs/records/PHASE_20_RECORDS_MUSIC_MIGRATION.md`, & `docs/os3/migration/SQL_RETIREMENT_REPORT.md`
