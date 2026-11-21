# XYP3RN DAW Adapter Operational Requirements (Phase 09 Specification)

**Status:** Phase 09 Specification (No adapters implemented yet)  
**Architectural Alignment:** Phase 02 [DAW_BRAIN_ARCHITECTURE.md](../DAW_BRAIN_ARCHITECTURE.md) · [OS3_MODULE_CONTRACTS.md](../OS3_MODULE_CONTRACTS.md) · Phase 07 [daw-tool-contracts.ts](../../core/tool-registry/daw-tool-contracts.ts) · Phase 08 [daw-delegation-contract.ts](../../core/orchestrator/daw-delegation-contract.ts)

---

## 1. DAW Detection & Host Environment Discovery

At startup and on `GET /api/daw/adapters`, `DAW Core` discovers host availability read-only without blocking OS3 boot:

1. **Executable & Binary Probe:**
   - Check known install roots (`C:\Program Files\Image-Line\FL Studio 2025\FL64.exe`, `FL Studio 2026\FL64.exe`, `C:\Program Files\REAPER (x64)\reaper.exe`).
   - Verify companion runtime folders exist (for FL Studio, check `Documents\Image-Line\FL Studio\Settings\Hardware\` controller installation AND warn explicitly if `FL Studio 2025\` lacks companion `Plugins/`/`Shared/` folders relative to `FL Studio 2026\`).
   - Check active running OS processes read-only (never inject DLLs or attach debuggers).
2. **Transport Prerequisite Detection:**
   - **FL Studio:** Enumerate Windows MIDI IN/OUT ports to confirm configured virtual loopback ports (e.g., `XYP3RN_IN`, `XYP3RN_OUT`) exist. If missing -> mark transport health `offline` with exact remediation `"Virtual MIDI loopback driver (e.g., loopMIDI) missing on host"`.
   - **REAPER:** Check configured local loopback OSC / ReaScript endpoint (`127.0.0.1`). If `reaper.exe` absent -> mark `unavailable_not_installed`.
3. **Host Independence Rule:** Missing DAW processes, missing `loopMIDI`, or absent REAPER binaries must **never** prevent OS3 Gateway, Vault, Context Engine, or Research/Records agents from booting (`healthy_degraded_daw`).

---

## 2. Connection Lifecycle State Machine

Every `DawSession` managed by `DAW Core` + SQLite `daw_sessions` follows a strict deterministic state machine:

```text
  [DISCONNECTED]
        │  connectSession(adapterId, projectPath?)
        ▼
    [PROBING] ──(missing driver / timeout / incompatible API version)──► [DEGRADED_CACHED] (if cached snapshot exists) or [OFFLINE]
        │ (handshake + API version + manifest verified)
        ▼
  [CONNECTED_READ_ONLY]  <───(Default on connect! permission = 'observe')
        │  grantDawLease(maxPermission >= 'prepare', ttlMs <= 1800s)
        ▼
  [LEASED_MUTABLE] ──────(lease expired / revoked / drift / operator Panic Revoke)──► [CONNECTED_READ_ONLY]
        │  disconnect() / process exit / 3 missed heartbeats
        ▼
     [CLOSED] (session immutable history retained per Phase 05 retention rules)
```

**Mandatory Safety Rules:**
- Every connection **always boots in `CONNECTED_READ_ONLY`** (`permission = 'observe'`).
- Any mutating command while in `CONNECTED_READ_ONLY`, `DEGRADED_CACHED`, or `OFFLINE` is denied immediately (`DAW_PERMISSION_DENIED` / `DAW_LEASE_REQUIRED`) and logged.

---

## 3. Health Checks & Latency Monitoring

- **Heartbeat Interval:** Lightweight `probeHealth()` every `3_000 ms` while SSE clients or active DAW sessions are connected; on-demand probe prior to any `prepare` or `execute` dispatch.
- **Health Criteria:**
  - `online`: Handshake responded within `< 250 ms` (FL SysEx) / `< 100 ms` (REAPER loopback), host version matches manifest, MIDI/IPC port open.
  - `degraded`: Process alive but heartbeat slow (`250 ms – 1500 ms`), stale cache returned, or edition/template validation incomplete.
  - `offline`: `3` consecutive heartbeat timeouts OR OS port/socket closed -> transitions SQLite `daw_sessions.status` to `'stale'`/`'disconnected'`, freezes live observations into `cachedSnapshot`, emits `daw.adapter.disconnected`.

---

## 4. Session Discovery & Five-Tier State Reconciliation

Adapters MUST never conflate **what is in DAW RAM right now** with **what is saved on disk** or **canonical Obsidian knowledge**:

1. **Discovery:** On connect, read active project title/tempo/track count/loaded plugins (`liveObserved`) and separately hash (`SHA-256`) any matching `savedProject` file (`.flp` / `.rpp`).
2. **Unsaved Divergence Detection (`hasUnsavedLiveChanges`):**
   - Compare latest `liveObserved` hash/signature against last seen `savedProject` parse snapshot (`tempo`, track names, route graph, loaded plugin signature) and track whether user/script mutations occurred since last confirmed save.
   - Expose clear flag to UI/JARVIS before running CLI renders (`FL64.exe /R`) because CLI renders read disk `.flp`, not RAM!
3. **Cache Isolation:** If DAW exits mid-session, `cached` snapshot carries `sourceTier: 'cached_stale'` and `authoritativeForKnowledge: false` (already enforced in Phase 06 `core/context-engine/daw-context.ts`).

---

## 5. State Synchronization & Coalesced Event Handling

- **Push + Poll Hybrid:**
  - **FL Studio:** Hardware script hooks `OnRefresh(HW_Dirty_*)` to emit coalesced delta frames (debounced ~`40 ms`) when user adjusts faders/transport in GUI, backed by bounded `2,500 ms` full integrity sync.
  - **REAPER:** Polls `GetProjectStateChangeCount()` inside `defer()` loop (~`50 ms`) and pushes only when change counter increments.
- **OS3 Event Bus Integration:**
  - Emits typed events (`daw.session.connected`, `daw.session.observed`, `daw.session.drift_detected`, `daw.command.prepared`, `daw.command.executed`, `daw.command.denied`, `daw.command.rolled_back`).
  - Telemetry listeners must never block command/rollback paths or store audio PCM in SQLite.

---

## 6. Command Dispatch Pipeline, Approval & Safety Clamps

Every DAW state mutation follows an immutable 5-stage choke point (`DawCommandGateway`):

1. **`Propose`:** Agents or UI generate structured `DawCommand[]` proposals (`proposedModifications`), annotating any `UNSUPPORTED` step with `manualOperatorSteps`.
2. **`Prepare` (`prepare` lease):**
   - Verify capability support in `DawAdapterManifest`. Reject `UNSUPPORTED` immediately (`501 DAW_CAPABILITY_UNSUPPORTED`).
   - Verify live target exists in current session snapshot (`targetRef` track/slot/paramIdx checksum match -> else `409 DAW_TARGET_DRIFT`).
   - Capture exact `beforeState` readback from host (`paramValue`, `trackVol`, `plugMute`).
   - Enforce **Audio Safety Clamps:**
     - Gain delta `<= +3.0 dB` per patch.
     - Block positive gain boosts pushing Master bus above `0.0 dBFS` unity without explicit override.
     - Validate normalized `[0.0, 1.0]` parameter range.
   - Stage immutable approval request row in SQLite `pending_approvals`.
3. **`Approve` (`approve` — Human-Only):** Operator decides (`approved` / `rejected`). Self-approval blocked.
4. **`Execute` (`execute` active TTL lease):**
   - Re-check lease not expired/revoked, approval `approved`, and live target not drifted since `prepare`.
   - Transmit command over bounded adapter transport.
   - **Mandatory Post-Write Readback Verification:** Query host `plugins.getParamValue` / `mixer.getTrackVolume` (`<= 250 ms` settle window) to confirm intended value took effect.
   - Append immutable `beforeState` + `afterState` receipt to SQLite `daw_command_journal` + `runtime_events`.
5. **`Rollback` (`rollback` where supported):** Re-applies captured `beforeState` values from receipt if evaluation detects acoustic regression or operator cancels. Fails explicitly if out-of-band structural overwrite invalidated target indices.

---

## 7. Timeout Budgets, Retries & Failure Recovery

| Operation Category | Default Timeout | Retry Policy | Recovery Behavior on Timeout / Failure |
| :--- | :--- | :--- | :--- |
| Health Probe & Transport Read | `2,500 ms` | `maxRetries: 1`, `backoff: 50 ms` | Transition session to `degraded`/`stale`; serve last `cached` snapshot stamped stale. |
| Mixer / Routing / Plugin / Param Inspection | `5,000–7,500 ms` | `maxRetries: 1`, `backoff: 50 ms` | Abort incomplete multi-frame SysEx sweep cleanly; retain previous consistent snapshot rather than half-torn tracks. |
| Audio / Project Offline Inspection | `10,000–15,000 ms` | `maxRetries: 1`, `backoff: 100 ms` | Guarantee read-only SHA-256 unchanged; return structured diagnostic error without mutating files. |
| Mutating Patch `execute` / `rollback` | `10,000 ms` | **`maxRetries: 0` (Zero blind retries!)** | **Never blindly retry live host mutations;** capture post-timeout readback to reconcile true host state before unlocking session! |
| Headless Master Render (`/R` / `-renderproject`) | `180,000 ms` configurable | `maxRetries: 0` | Terminate orphaned render child process cleanly on timeout/cancel; clean partial `.wav` temp artifacts. |

---

## 8. Version Compatibility Policy

- Each adapter declares `minSupportedHostVersion`, `testedHostVersions[]`, and `apiVersion` (`general.getVersion()` for FL Studio; `GetAppVersion()` for REAPER).
- **Exact Policy on Version Mismatch:**
  - Older than minimum supported version -> refuse connection cleanly (`DAW_UNSUPPORTED_HOST_VERSION`).
  - Newer untested build (e.g., `FL Studio 26.1.1.5547` when targeting `25.1.6` baseline) -> connect in `CONNECTED_READ_ONLY` with diagnostic banner `"Untested host version — mutating execute leases disabled until verified"`, allowing safe observation while protecting projects against silent API shift!
