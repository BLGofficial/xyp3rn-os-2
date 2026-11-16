# XYP3RN OS 3.0 + DAW Brain — API & UI Adapter Contracts (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Gateway Binding:** `http://127.0.0.1:8077` (Loopback-only; Host/Origin allowlist: `127.0.0.1`, `localhost`; PNA enabled; optional Bearer / `X-XYP-Token`)

---

## 1. Existing Verified OS3 Gateway Endpoints (`core/gateway/server.ts`, `:8077`)

| Method & Path | Purpose | Security / Contract Note |
|---|---|---|
| `GET /api/health` | Runtime, SQLite integrity, Vault file count, agent count, pending approvals | Exempt from Bearer check for liveness probing; loopback Origin checked. |
| `POST /api/jarvis` | Dispatch Jarvis command (`status`, `write`, `search`, `flow`, `@context`, `inspect`) | Enforces `readAccepted` & `askBeforeChange` flags (`256 KB` body cap). |
| `GET /api/jarvis/search` & `/inspect` | Whole-OS codebase + Obsidian Vault search & safe file inspection | Strictly read-only; requires `readAccepted`. |
| `POST /api/jarvis/proposal/decide` | Operator Accept / Decline staged Jarvis change proposals | Records immutable approval decision in SQLite. |
| `GET /api/overview`, `/api/agents`, `/api/workflows`, `/api/runs`, `/api/events` | Telemetry feeds for `UI-xyp3rn` Dashboards | Reads live SQLite runtime + Vault index. |
| `GET /api/vault/{note,search,tree,graph}` | Live Obsidian Markdown, search, folder tree, wikilink topology | Rejects path traversal / escapes via `path-guard`. |
| `GET /api/approvals`, `POST /api/approvals/decide` | List & resolve human approvals (`pending_approvals`) | Agent callers blocked (`approval.decide` = `[]`). |
| `GET /api/research`, `GET /api/records` | Domain overviews (includes `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS`) | Read-only index projection. |
| `GET /api/music/pulse`, `/api/audio/prompts`, `POST /api/audio/{reverse-engineer,save-prompts}` | Spectrum pulse + DSP audio prompt reverse-engineering | Audio binary stays strictly in browser RAM; saves MD notes on operator save only. |

---

## 2. Frozen New Phase 02 Gateway Endpoints (`DAW Brain`, `Plugin Brain`, `Audio Brain`)

### 2.1. DAW Core & Session Endpoints (`/api/daw/*`)

- **`GET /api/daw/adapters`**
  - Lists registered DAW adapters (`fl-studio-2025`, `reaper`), live health status (`online` | `degraded` | `offline`), missing OS prerequisites (e.g., `loopMIDI` detection), and each adapter's full `DawAdapterCapabilityManifest` (`SUPPORTED` | `TEMPLATE_SCOPED` | `READ_ONLY` | `UNSUPPORTED`).
- **`POST /api/daw/sessions/connect`**
  - Body: `{ adapterId: 'fl-studio-2025' | 'reaper', projectPath?: string }`
  - Returns: `{ ok: true, session: DawSessionStateContainer, defaultPermission: 'observe' }`.
  - Always initializes cleanly at `observe` permission tier.
- **`GET /api/daw/sessions/:id/state`**
  - Returns cleanly separated 5-tier session state:
    - `liveObserved` (nullable with live timestamp)
    - `cached` (explicit `stale` boolean)
    - `savedProject` (disk path + `fileSha256` + parsed topology)
    - `proposedModifications` (`DawPatchProposal[]`)
    - `appliedModifications` (`DawExecutionReceipt[]`)
    - `hasUnsavedLiveChanges: boolean`
    - `activeLease: DawSessionLease | null`
- **`POST /api/daw/sessions/:id/lease`**
  - Operator-only endpoint elevating or revoking session permissions (`observe` -> `prepare` / `execute` / `rollback`, bounded TTL in seconds, max `1800s`). Rejects requests missing operator UI Origin/token.
- **`POST /api/daw/sessions/:id/propose`**
  - Body: `{ goal: string, mixStage?: 'mix' | 'master', analysisId?: string }`
  - Runs `Audio Brain` + `Production Intelligence` + `Plugin Brain` (`analyze` + `propose`) to generate a `DawPatchProposal` (`automatedCommands[]` + `manualOperatorSteps[]` for any `UNSUPPORTED` actions).
- **`POST /api/daw/sessions/:id/prepare`**
  - Body: `{ proposalId: string }`
  - Runs target drift verification, gain/ceiling safety clamping, and `beforeState` readback; creates immutable `pending_approvals` row (`itemType = 'daw_patch'`); returns `PreparedDawPatch` (zero host mutation yet!).
- **`POST /api/daw/sessions/:id/execute`**
  - Body: `{ patchId: string, approvalId: string }`
  - Verifies active `execute` lease + `approved` row in `pending_approvals` + fresh target hash -> calls `DawCommandGateway.executePatch()` -> returns `DawExecutionReceipt` (with `beforeState` & `afterState` readback).
- **`POST /api/daw/sessions/:id/rollback`**
  - Body: `{ receiptId: string }`
  - Restores recorded `beforeState` if adapter supports `daw.action.rollback`; returns `422 UNSUPPORTED` otherwise.
- **`POST /api/daw/sessions/:id/render`**
  - Body: `{ outputDir?: string, format?: 'wav' }`
  - Triggers headless `FL64.exe /R` (or `reaper -renderproject`) strictly against `savedProject` disk file (warns & blocks if `hasUnsavedLiveChanges` unless `allowStaleSavedFile: true` acknowledged!).

### 2.2. Plugin Brain Endpoints (`/api/plugins/*`)
- **`GET /api/plugins/inventory?host=fl-studio-2025&edition=producer`**
  - Returns scanned local VST3/VST2/CLAP + FL Producer Edition compatibility flags (`usable` | `edition_excluded` | `unverified`).
- **`POST /api/plugins/scan`**
  - Triggers read-only scan of standard host VST directories (`C:\Program Files\Common Files\VST3`, `VSTPlugins`) + semantic parameter map sync into `09_X3LIUS_MUSIC/PLUGINS/`.

### 2.3. Audio Brain Unified Endpoints (`/api/audio-brain/*`)
- **`POST /api/audio-brain/analyze`**
  - Accepts either `{ wavVaultPath }` or `{ traceAnalysis: trace.analysis/v1 }` or `{ telemetry: AudioAcousticTelemetry }` + `stage: 'mix' | 'master'`.
  - Runs unified TRACE rubric + acoustic diagnostics cleanly in OS3 SQLite + Vault without touching Postgres `:5432`.
- **`GET /api/audio-brain/analyses?sessionId=...`**
  - Returns recent quantified loudness/tonal/stereo/crest checks & evaluation deltas (`Evaluation Engine`).

### 2.4. Real-Time SSE Telemetry Stream
- **`GET /api/events/stream?topics=daw.*,audio.*`**
  - Server-Sent Events (`text/event-stream`) pushing coalesced `daw.session.observed`, `daw.audio.headroom_alert`, `daw.command.executed`, and approval updates to `UI-xyp3rn`.

---

## 3. Standardized Error Envelope & Codes

All API errors return:
```json
{
  "ok": false,
  "code": "DAW_CAPABILITY_UNSUPPORTED",
  "error": "FL Studio 2025 MIDI Scripting API does not support programmatic plugin instantiation (daw.plugin.load_remove).",
  "manualRemediation": "Insert 'FabFilter Pro-Q 3' onto Mixer Insert 4 manually in FL Studio, then retry /prepare."
}
```

Frozen Error Codes:
- `400 DAW_INVALID_INPUT` / `INVALID_VAULT_PATH`
- `401 UNAUTHORIZED` (invalid `XYP_GATEWAY_TOKEN`)
- `403 FORBIDDEN_ORIGIN` / `DAW_PERMISSION_DENIED` (active lease is `observe`, approval missing, or self-approval blocked)
- `409 DAW_TARGET_DRIFT` / `VAULT_CONFLICT` (`expectedSha256` or live slot mismatch)
- `422 DAW_SAFETY_VIOLATION` (gain/ceiling clamp triggered) / `PLUGIN_EDITION_EXCLUDED`
- `501 DAW_CAPABILITY_UNSUPPORTED` (adapter explicitly marks capability `UNSUPPORTED` — never faked!)
- `503 DAW_HOST_OFFLINE` (`loopMIDI` or DAW closed; returns cached session availability hint)

---

## 4. `UI-xyp3rn` UI Adapter Contract Extension

`UI-xyp3rn` extends [lib/os3-adapter.ts](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/lib/os3-adapter.ts) with pure typed client functions (`lib/daw-adapter.ts`) adhering to ADR-0005:
- Never throws uncaught exceptions when `:8077` is down; returns `{ ok: false, mode: 'offline', data: null, error }`.
- Renders distinct visual badges differentiating **LIVE RAM**, **CACHED (STALE)**, **SAVED PROJECT (.flp/.rpp)**, **PROPOSED PATCH**, and **APPLIED (UNSAVED)** states cleanly in UI views.
- Keeps existing Constellation (`MapScreen`, `ConstellationCanvas`, `DashboardsView`, `KnowledgeGraphView`, `JarvisView`) 100% intact.
