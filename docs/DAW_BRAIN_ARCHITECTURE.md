# XYP3RN DAW Brain Architecture (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze (Design Only — No Implementation)  
**Grounded Baseline:** [DAW_BRAIN_EXISTING_CAPABILITIES.md](audit/DAW_BRAIN_EXISTING_CAPABILITIES.md) · [FL_STUDIO_INTEGRATION_FEASIBILITY.md](audit/FL_STUDIO_INTEGRATION_FEASIBILITY.md)  
**Target DAW #1:** FL Studio 2025 Producer Edition (Windows 11)  
**Validation Target #2:** REAPER (Architecture Portability & Contract Validation Target)

---

## 1. Core Architectural Principle: Strict Vendor Independence

- **DAW Core owns universal musical and session abstractions** (`ProjectSnapshot`, `TrackNode`, `BusRouting`, `PluginSlot`, `PluginParameterTarget`, `AudioTelemetry`, `DawCommand`, `ExecutionPlan`, `EvaluationDelta`).
- **Zero Vendor Coupling in Core:** No file inside `core/daw-brain/core.ts`, `audio-brain/`, `plugin-brain/`, `production-intelligence/`, `session-model.ts`, or `command-gateway.ts` may import FL Studio MIDI constants, `.flp` chunk tags, or REAPER `.rpp` tokens.
- **Explicit Capability Reporting:** Adapters register an immutable `DawAdapterCapabilityManifest`. Any command targeting a capability marked `'unsupported'` (e.g., programmatic plugin insertion on FL Studio 2025 MIDI Scripting) fails fast at pre-flight with `DAW_CAPABILITY_UNSUPPORTED`, never faked via blind GUI macros.
- **Read-Only Default:** Every DAW connection starts strictly in **`observe`** permission mode. Any live state change requires elevating permission scopes through `DawCapabilityRegistry` + `DawCommandGateway` validation, safety clamping, and human/policy approval.

---

## 2. The 13 Frozen DAW Brain Subsystems

### 2.1. `DAW Core` (`core/daw-brain/core.ts`)
- Top-level vendor-agnostic coordinator managing adapter registration, session binding, observation polling, read-only diagnostics, plan preparation, and post-execution verification.
- Holds active `DawSessionState` container separating the 5 mandatory state tiers (`liveObserved`, `cached`, `savedProject`, `proposedModifications`, `appliedModifications`).

### 2.2. `DAW Adapter SDK` (`core/daw-brain/adapter-sdk.ts`)
- Defines the TypeScript interface every DAW adapter must implement:
  - `getManifest(): DawAdapterManifest`
  - `probeHealth(): Promise<DawHealthReport>`
  - `observeSession(): Promise<DawObservedSnapshot>`
  - `parseSavedProject?(projectPath: string): Promise<DawSavedProjectSnapshot>` (optional capability)
  - `prepareCommand(cmd: DawCommand): Promise<PreparedDawPatch>` (dry-run validation against target slots/ranges)
  - `executePrepared(patch: PreparedDawPatch): Promise<DawExecutionReceipt>`
  - `rollbackPatch?(receipt: DawExecutionReceipt): Promise<DawRollbackReceipt>` (only if declared supported)
  - `renderMaster?(req: DawRenderRequest): Promise<DawRenderArtifact>`
- Includes an adapter conformance test harness validating capability honesty (unsupported methods must reject cleanly with `DAW_CAPABILITY_UNSUPPORTED`).

### 2.3. `DAW Capability Registry` (`core/daw-brain/capability-registry.ts`)
- Authorizes every DAW tool, workflow step, and Gateway action against BOTH:
  1. **Security Permission Tier:** `observe` -> `analyze` -> `propose` -> `prepare` -> `execute` -> `approve` -> `rollback`.
  2. **Adapter Capability Declaration:** `supported` | `template-scoped` | `read-only` | `unsupported`.
- Enforces the session default (`observe` only) until an operator explicitly grants a bounded session lease (TTL + allowed scopes) in SQLite `daw_session_leases`.

### 2.4. `DAW Session Model` (`core/daw-brain/session-model.ts`)
Strictly isolates **five non-interchangeable state representations** so live DAW inspection never corrupts or impersonates saved project truth:

| State Tier | Mutable By | Persistence | Authoritative For |
|---|---|---|---|
| **1. `liveObserved`** | `DAW State Observer` via adapter telemetry | Ephemeral memory + SQLite snapshot header | What the running DAW instance reports right now (faders, active plugin params, transport BPM, mute flags). |
| **2. `cached`** | Background observer / last successful poll | SQLite `daw_session_cache` (TTL stamped) | Offline fallback inspection when DAW is closed; always visibly stamped `stale/cached`. |
| **3. `savedProject`** | Read-only project parser (`.flp` / `.rpp`) or user save watch | Immutable SHA-256 checksum + Obsidian summary note | What is actually committed on disk inside the DAW project file right now. |
| **4. `proposedModifications`** | `Production Intelligence` / `DAW Agent Team` | Memory + SQLite `pending_approvals` + Obsidian draft note | Unapplied structured patches (`DawCommand[]`) with bounded deltas, pre-checks, and rollback hints. |
| **5. `appliedModifications`** | `DAW Command Gateway` after `executePrepared()` receipt | Append-only SQLite `daw_command_journal` + Audit Engine | Changes sent to the live DAW session whose **project file may still be unsaved** (`dirtyInLiveHost: true` until next `savedProject` hash match). |

### 2.5. `DAW State Observer` (`core/daw-brain/observer.ts`)
- Periodically or on-demand polls active adapters in read-only mode (`observe` capability), computes structural diff against previous `liveObserved` & `savedProject` hashes, detects manual operator tweaks (`externalDawEditDetected`), and updates `cached` snapshots safely without locking the UI thread.

### 2.6. `DAW Event System` (`core/daw-brain/events.ts`)
- Typed event emitter bridged directly into OS3's `Event Bus`:
  - `daw.adapter.connected` / `disconnected` / `degraded`
  - `daw.session.observed` / `drift_detected` (live vs saved divergence)
  - `daw.transport.changed` (`bpm`, `playing`, `recording`)
  - `daw.plugin.inventory_updated`
  - `daw.audio.analyzed` / `headroom_alert`
  - `daw.command.proposed` / `prepared` / `approved` / `executed` / `denied` / `rolled_back`

### 2.7. `DAW Command Gateway` (`core/daw-brain/command-gateway.ts`)
- The **sole execution choke point** for mutating actions (`prepare` -> `approve` -> `execute` -> `verify` -> `audit`):
  1. Verifies session permission lease + adapter capability support (`CapabilityRegistry`).
  2. Verifies target object exists in latest `liveObserved` snapshot (prevents stale track/slot offsets).
  3. Enforces **Audio Safety Clamps**: rejects absolute fader boost `> +3.0 dB` per step, rejects master fader boosts above `0.0 dBFS` unity without explicit bypass override, validates normalized `[0.0, 1.0]` parameter bounds.
  4. Captures `beforeState` snapshot for deterministic rollback (`plugins.getParamValue` / `mixer.getTrackVolume`).
  5. Requires human approval row (`pending_approvals`) when command risk >= `prepare` structural change or operator policy requires confirmation.
  6. Dispatches atomic batch to `adapter.executePrepared()`, verifies post-state observation matches intent, logs immutable `daw_command_journal` row, and emits `daw.command.executed`.

### 2.8. `Plugin Brain` (`core/daw-brain/plugin-brain/`)
- Cross-DAW plugin intelligence subsystem:
  - **Host Scanner (Read-Only):** Inventories VST3 (`C:\Program Files\Common Files\VST3`), VST2 (`C:\Program Files\VSTPlugins`), CLAP, and FL Studio 2025 stock capabilities into Obsidian canonical/knowledge catalogs (`09_X3LIUS_MUSIC/PLUGINS/`).
  - **Edition Filter Engine:** Flags Image-Line Signature/All-Plugins tools (e.g., `Harmor`, `Gross Beat`, `Newtone`, `Vocodex`) as `UNLICENSED_OR_TRIAL` under **Producer Edition** baseline unless verified unlocked.
  - **Semantic Parameter Normalizer:** Maps raw vendor parameter indices (`paramIdx 14` on FabFilter Pro-Q vs `paramIdx 3` on Fruity Parametric EQ 2) to canonical audio concepts (`eq.low_cut_hz`, `comp.ratio`, `limiter.ceiling_db`) so `Production Intelligence` stays vendor-agnostic!

### 2.9. `Audio Brain` (`core/daw-brain/audio-brain/`)
- Unifies `tech/trace` (`trace.analysis/v1`, `trace.report/v1`), `records/x3lius/mix-rubric.yaml`, and `core/gateway/audio-reverse-engineer.ts` natively onto OS3 (`SQLite + VaultEngine`, zero Postgres):
  - Evaluates rendered DAW master/bus WAVs, user imported browser audio telemetry, or future TRACE VST3 telemetry.
  - Detects clipping, true-peak overshoots (`> -1.0 dBTP`), sub-bass mono correlation collapse, muddy low-mid masking (`200–500 Hz`), dynamic over-limiting (`crest < 6 dB`), and vocal presence gaps.
  - Emits structured diagnostic targets (`raise/lower` by `X dB`) consumed by `Production Intelligence`.

### 2.10. `Production Intelligence` (`core/daw-brain/production-intelligence/`)
- Translates musical goals, Obsidian production knowledge, `Audio Brain` diagnostics, and `Plugin Brain` normalized inventories into concrete `proposedModifications` (`DawCommand[]` plans + human-step checklists when a DAW capability is manual-only, e.g., *"Insert FabFilter Pro-Q 3 on Mixer Bus 4 before applying proposed cut"*).

### 2.11. `DAW Agent Team` (`04_AGENTS/DAW_*.md`)
Strictly single-class agents wired into `Tool Registry` (gated by **Owner Approval** before creation in Phase 05+):
- `daw-session-observer` (`Knowledge` | capability: `daw.observe`, `context.read`)
- `daw-plugin-advisor` (`Knowledge` | capability: `daw.observe`, `plugin.read`)
- `daw-audio-analyst` (`Research` / `Knowledge` | capability: `daw.analyze`, `trace.read`)
- `daw-mix-planner` (`Planning` / `Creative` | capability: `daw.propose`, `daw.prepare`)
- `daw-execution-operator` (`Execution` | capability: `daw.execute` + `daw.rollback` ONLY on human-approved patches!)

### 2.12. `DAW Evaluation Engine` (`core/daw-brain/evaluation-engine.ts`)
- Verifies execution outcomes objectively:
  - Compares `liveObserved` pre-patch vs post-patch values.
  - Triggers or ingests post-change render WAV analysis (`Audio Brain`) against canonical mix rubrics (`x3lius-mix-master`).
  - Scores improvement vs regression (`LUFS`, `truePeak`, `crestFactor`, tonal curve, stereo sub-width) and triggers automatic rollback recommendation (`PROPOSE_ROLLBACK`) if metrics degrade past safety thresholds.

### 2.13. `DAW Workflow Library` (`05_WORKFLOWS/DEFINITIONS/daw-*.workflow.yaml`)
Vendor-independent YAML DAG specifications stored in Vault:
- `daw-observe-diagnose`: `Observe Session -> Inventory Active Plugins -> Analyze Latest Bounce -> Report Diagnostics` (100% read-only `observe` + `analyze`).
- `daw-mix-assist-patch`: `Observe -> Audio Brain Diff -> Resolve Plugin Semantic Targets -> Propose Bounded Patch -> Human Approve -> Prepare/Execute -> Evaluate Post-State`.
- `daw-render-verify`: `Check Saved Project Clean -> Trigger Headless Master Render -> Run TRACE Rubric Check -> Archive Report to Vault`.
- `daw-template-preflight`: `Verify Loaded Template Bus/Slot Topology against X3LIUS Production Blueprint`.

---

## 3. Multi-DAW Portability Strategy: FL Studio 2025 vs. REAPER

- **FL Studio 2025 Adapter (`adapters/fl-studio/`):**
  - Uses sandboxed Python MIDI Controller script (`device_XYP3RNBrain.py`) over external Windows virtual MIDI loopback (`loopMIDI`) SysEx framing for `observe` + bounded `execute` on **loaded** channels, mixer tracks, and plugin params; `FL64.exe /R /Ewav` for headless master verification; read-only `.flp` inspector for saved-project topology; declares **`plugin.load` / `track.create` as `unsupported`**.
- **REAPER Validation Adapter (`adapters/reaper/`):**
  - Validates the **exact same `DawAdapter` SDK** against REAPER's architecture: `.rpp` human-readable project file parser/inspector + OSC / ReaScript local bridge + full CLI batch/render + dynamic FX instantiation support (`supported` in REAPER vs `unsupported` in FL Studio!). Because REAPER is not yet installed locally, Phase 03/04 contract tests validate `.rpp` & OSC protocol handling deterministically in Vitest, leaving live host binary tests gated cleanly behind REAPER installation.
