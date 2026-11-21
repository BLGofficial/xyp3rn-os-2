# FL Studio 2025 Producer Edition Adapter — Manual Test Guide

**Target Environment:** Windows 11 · FL Studio 2025 Producer Edition (`FL64.exe` `25.1.6.4997` or `FL Studio 2026` `26.1.1.5547`)  
**Scope:** Phase 11 Read-Only Observation Release (`core/daw-adapters/fl-studio-2025/`)

---

## Prerequisites Before Live Connection Tests

1. **Install Virtual MIDI Loopback (`loopMIDI`):**
   - Download & launch `loopMIDI` (Tobias Erichsen).
   - Create **two distinct loopback ports**:
     - `XYP3RN_IN` (OS3 Node -> FL Studio controller input)
     - `XYP3RN_OUT` (FL Studio controller output -> OS3 Node reader)
2. **Install the Read-Only Hardware Script:**
   - Copy `core/daw-adapters/fl-studio-2025/controller/XYP3RN_Brain/device_XYP3RNBrain.py` to:
     `C:\Users\blago\Documents\Image-Line\FL Studio\Settings\Hardware\XYP3RN_Brain\device_XYP3RNBrain.py`
3. **Bind MIDI Ports Inside FL Studio:**
   - Open FL Studio -> **Options -> MIDI Settings**.
   - Under **Output**, select `XYP3RN_OUT` and assign Port `205` (example unused port).
   - Under **Input**, select `XYP3RN_IN`, enable **Enable**, set **Controller type** to **`XYP3RN DAW Brain (Read-Only)`**, and set matching Port `205`.
   - Open **View -> Script output** to observe controller console logs.

---

## Reproducible Manual Test Procedures

### `MT-FL-01`: Missing DAW & Missing `loopMIDI` Failure Handling
1. Close all `FL64.exe` windows and quit `loopMIDI` (if running).
2. Run:
   `node --env-file-if-exists=.env.local core/daw-adapters/fl-studio-2025/probe-cli.ts`
3. **Verify:**
   - Probe succeeds read-only without crashing OS3.
   - `discoveredInstances` reports FL binaries on disk (`reachable: false`, `processId: null`).
   - `missingPrerequisites` explicitly lists missing `XYP3RN_IN` / `XYP3RN_OUT` loopback ports and absent `FL64.exe` process.
   - Attempting `connectSession('fl-studio-2025')` fails cleanly with `DAW_HOST_OFFLINE` instead of returning fake DAW state.

### `MT-FL-02`: DAW Detection & Version / Edition Handshake
1. Launch `loopMIDI` with `XYP3RN_IN` and `XYP3RN_OUT`.
2. Launch `C:\Program Files\Image-Line\FL Studio 2025\FL64.exe` (or `FL Studio 2026\FL64.exe`) and check **Help -> About**.
3. Run `probe-cli.ts`.
4. **Verify:**
   - Live PID for `FL64.exe` appears in `runningProcesses`.
   - Both `XYP3RN_IN` and `XYP3RN_OUT` appear in `midiInPorts` / `midiOutPorts`.
   - In FL Studio **View -> Script output**, `[XYP3RN DAW Brain Read-Only] Initialized: 2025.1.0-readonly` is printed cleanly.

### `MT-FL-03`: Project Discovery & Read-Only `.flp` Hash Invariant
1. Open an existing project (e.g., `COLDINMYEYES.flp` or `Project_1.flp`) inside FL Studio.
2. Hash the `.flp` beforehand in PowerShell: `Get-FileHash <path.flp> -Algorithm SHA256`.
3. Call `adapter.discoverProjects()` and `adapter.inspectSavedProject(<path.flp>)`.
4. **Verify:**
   - SHA-256 pre-read equals SHA-256 post-read (`hashUnchangedAfterRead: true`).
   - Extracted channel names, mixer insert labels, sample paths, and plugin names match FL Studio GUI.
   - Any obfuscated FL 25/26 scalar fields (e.g., masked tempo tokens) appear explicitly as `unknown` rather than fabricated numbers.

### `MT-FL-04`: Connection & Live State Observation (`Observe`)
1. Connect via `DawCore`: `const sess = await dawCore.connectSession('fl-studio-2025')`.
2. Inspect `sess.connection.status` -> must equal `'connected_read_only'`.
3. Toggle Play/Stop in FL Studio GUI, adjust BPM by `+2 BPM`, and move Mixer Insert 1 fader.
4. Call `dawCore.refreshSession(sess.sessionId)` and verify subscriber events (`OnRefresh` `HW_Dirty_*`).
5. **Verify:**
   - Live `transport.tempo.bpm`, `transport.playing`, `mixerChannels`, `routing`, `plugins`, and `parameters` update accurately with `freshness: 'observed'` and `provenance.sourceEvidence` naming `XYP3RN_IN <-> XYP3RN_OUT`.
   - Unsupported fields (`automationLanes`, `audioClips`, `midiClips`, `markers`, `regions`) report `status: 'unsupported'` and appear in `sess.unknownFields`.

### `MT-FL-05`: Disconnection & Offline Degradation
1. While connected, close FL Studio OR delete/disable `XYP3RN_OUT` inside `loopMIDI`.
2. Call `dawCore.checkHealth(sess.sessionId)`.
3. **Verify:**
   - `health.healthy === false` and `health.reachable === false`.
   - Session transitions cleanly to `degraded_cached`, `stale: true`, `observed: null`, preserving `cached` for read-only inspection without impersonating live FL state.

### `MT-FL-06`: Recovery After Reconnect
1. Re-enable `XYP3RN_OUT` in `loopMIDI` and reload/re-init controller script inside FL Studio MIDI Settings.
2. Call `dawCore.refreshSession(sess.sessionId)` and `dawCore.checkHealth(sess.sessionId)`.
3. **Verify:**
   - `healthCheck` returns `healthy: true`, `reachable: true`.
   - New live observations restore `freshness: 'observed'` and `stale: false`.

### `MT-FL-07`: Version Mismatch Handling
1. Connect `FlStudio2025Adapter` against **FL Studio 2026 (`26.1.1.5547`)** (exceeds `maxTestedHostVersion: '25.1.9999'`).
   - **Verify:** Connects strictly with `versionCompatibility: 'degraded_read_only'` (mutations disabled).
2. Test against simulated/older FL Studio `< 24.0.0` (e.g., `21.2.3`) or controller API `< 20`:
   - **Verify:** Refuses connection cleanly with `DAW_UNSUPPORTED_HOST_VERSION`.

### `MT-FL-08`: Unsupported Features & Strict Read-Only Mutation Refusal
1. Attempt any mutating command (`transport.control`, `mixer.volume_pan_mute`, `mixer.routing_write`, `plugin.param_write`, `plugin.load_remove`, `track.create_delete`, `project.save`) through `DawCore` or `adapter.execute()`.
2. **Verify:**
   - Returns `DAW_CAPABILITY_UNSUPPORTED` (`ok: false`, `status: 'unsupported'`).
   - FL Studio state, project files, mixer faders, plugins, and transport remain completely untouched.
   - Refusal entry is recorded inside `adapter.getIntegrationLogs()`.
