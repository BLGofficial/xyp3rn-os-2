# REAPER Integration Specification (Secondary Target & Architecture Validation)

**Status:** Phase 09 Specification (Zero adapter code implemented in this phase)  
**Target Role:** Secondary cross-DAW validation target proving `DAW Core`, `DawAdapter` SDK, `DawCapabilityRegistry`, and JARVIS `DawDelegationCoordinator` are 100% vendor-independent and not subtly tied to FL Studio's constraints.  
**Workstation Host Status (`VERIFIED`):** `reaper.exe` and `reaper.ini` are **NOT installed** on this Windows 11 machine (`C:\Program Files\REAPER (x64)` contains only orphan PNG icon files). Therefore runtime host checks are marked `UNKNOWN` / deferred to post-install verification, while Phase 10 contract validation will run against deterministic `.rpp` + OSC/ReaScript test fixtures.

---

## 1. Official REAPER Integration Mechanisms (Independent Analysis)

### 1.1. ReaScript Engine (`Lua`, `Python`, `EEL2`) & C++ Extension SDK
- **Embedded Native Lua 5.x:** Built directly into REAPER (`no external install`), supports full REAPER API (`reaper.*`), persistent background event loops via `reaper.defer(fn)`, file/pipe mailbox polling, and optional graphics/UI windows.
- **Python ReaScript (`RPR_*`):** Uses an external Python 3 installation enabled under **Preferences -> Plug-ins -> ReaScript**. Allows full standard library networking (`socket`, loopback HTTP/JSON-RPC servers, pipes) running in non-blocking `RPR_defer()` background callbacks cleanly bound to `127.0.0.1`!
- **C++ Extension SDK (`reaper_plugin.h`):** Allows compiled DLL extensions exposing custom main-thread C++ IPC servers and actions (overkill for initial OS3 validation compared to ReaScript Lua/Python + OSC).

### 1.2. Built-In OSC & Web Remote Control Surface
- **OSC (`Preferences -> Control Surfaces -> Add -> OSC`):** Uses declarative `.ReaperOSC` pattern maps over UDP loopback (`127.0.0.1`) for bidirectional feedback and control of transport, track volume/pan/mute/solo/rec-arm, track sends, and focused FX parameters without writing custom C++ extensions.
- **Built-In Web Remote (`reaper_www_root`):** REAPER ships an embedded HTTP endpoint for control/feedback (`fancier.html`, command ID triggers `/_/GET/...`, JSON track/transport polling) over loopback.

### 1.3. Plain-Text Project Format (`.rpp`) & CLI Rendering
- **Structured Text Tree (`.rpp`):**
  - Unlike FL Studio's undocumented binary `.flp`, `.rpp` is a **human-readable plain-text S-expression/XML-like block format** (`<REAPER_PROJECT ...>`, `TEMPO ...`, `<TRACK ...>`, `<VOLPAN ...>`, `<AUXRECV ...>`, `<FXCHAIN ...>`, `<PARMENV ...>`).
  - Third-party VST3 internal plugin presets live as Base64-encoded chunks inside `<VST ...>`, while track names, GUIDs, routing sends, parameters/envelopes, render settings (`<RENDER_CFG ...>`), and media item file references remain cleanly readable and Git-diffable!
- **Headless CLI Rendering (`reaper.exe -renderproject`):**
  - REAPER supports invoking `reaper.exe -renderproject "path\to\project.rpp"` cleanly from CLI (using `<RENDER_CFG>` and Render Matrix inside `.rpp`) to export both Master mixes and configured multi-stem renders programmatically!

---

## 2. Capability Comparison vs. FL Studio 2025

This side-by-side matrix explains **why REAPER is critical for validating `DawAdapter` portability**:

| Capability Area | REAPER API Mechanism | FL Studio 2025 Mechanism | Architectural Contrast for `DAW Core` |
| :--- | :--- | :--- | :--- |
| **Add / Remove Mixer Tracks** | `InsertTrackAtIndex`, `DeleteTrack` (`SUPPORTED` in REAPER) | Fixed 126 inserts (`UNSUPPORTED`) | Proves `DAW Core` checks `manifest.supports('daw.channel.create_delete')` cleanly instead of hardcoding error or assuming support. |
| **Load / Instantiate VST3 Plugin** | `TrackFX_AddByName(track, "VST3: ...", false, -1)` (`SUPPORTED` in REAPER) | MIDI Scripting lacks API (`UNSUPPORTED`) | Proves `Production Intelligence` auto-dispatches `AddFX` patch on REAPER vs manual user step checklist on FL Studio. |
| **FX Enumeration & Ordering** | `TrackFX_GetCount`, `TrackFX_GetFXName`, `TrackFX_CopyToTrack` | `plugins.isValid`, `plugins.getPluginName` (loaded only) | Normalized into identical `PluginSlot[]` abstraction. |
| **Parameter Access (`[0..1]`)** | `TrackFX_GetParamNormalized`, `TrackFX_SetParamNormalized`, `TrackFX_GetParamName`, `TrackFX_GetFormattedParamValue` | `plugins.getParamCount`, `getParamName`, `getParamValue`, `getParamValueString`, `setParamValue` | Both map to identical normalized `PluginParameterTarget` in `Plugin Brain`. |
| **Bus / Send Routing** | `GetTrackNumSends`, `CreateTrackSend`, `RemoveTrackSend`, `SetTrackSendInfo_Value` | `mixer.getRouteSendActive`, `mixer.setRouteTo` | Both map cleanly to universal `BusRoutingEdge[]`. |
| **Automation Envelopes** | `GetTrackEnvelopeByName`, `InsertEnvelopePoint`, `Envelope_SortPoints` (`SUPPORTED` in REAPER) | Spline API `UNSUPPORTED` in MIDI scripts (`processRECEvent` live tweak only) | Capability Registry allows scripted envelope ops only on adapters declaring `SUPPORTED`. |
| **Project Parsing & Save** | Plain-text `.rpp` parser + `Main_SaveProject` (`SUPPORTED`) | Binary `.flp` read-only + `UNSUPPORTED` silent save | Highlights exact `savedProject` tier contract (`liveObserved` sync cleanly with `Main_SaveProject` on REAPER; manual prompt hint on FL). |
| **IPC Bridge** | Direct `127.0.0.1` Web Remote / OSC / Python ReaScript `socket` (`defer`) | Virtual MIDI (`loopMIDI`) SysEx only (no sockets in FL sandbox) | Proves `DawAdapter` abstracts transport layer (SysEx MIDI vs HTTP/OSC/JSON-RPC) completely behind `connect/observe/prepare/execute`. |
| **Rollback Safety** | Capture `beforeState` values OR REAPER undo block (`Undo_BeginBlock` / `Undo_EndBlock` / `Undo_DoUndo2`) | Capture `beforeState` values + `general.saveUndo` / explicit param revert | Standardized `DawExecutionReceipt` holds `beforeState` regardless of host undo model. |

---

## 3. Reproducible Manual Verification Procedures (Post-REAPER Installation)

Because `reaper.exe` is currently absent from this Windows 11 workstation, execute **`EXP-RPR-01`..`EXP-RPR-04`** after installing REAPER (`Evaluation` or `Licensed`) before promoting the REAPER adapter out of fixture validation:

### `EXP-RPR-01`: ReaScript Localhost Bridge & OSC Ping-Pong Benchmark
1. Install REAPER x64 on Windows 11 cleanly.
2. Enable **Preferences -> Control Surfaces -> Add -> OSC** bound exclusively to `127.0.0.1` OR register an OS3 `reaper_xyp3rn_bridge.lua` / Python `RPR_defer()` action script bound to `127.0.0.1`.
3. Send `100` ping & `GetPlayState()` requests; measure P50/P99 RTT (`ms`) and confirm `0` dropped frames.

### `EXP-RPR-02`: Track, FX (`TrackFX_AddByName`), Routing & Parameter Round-Trip Test
1. Create an empty test `.rpp` project.
2. Invoke `InsertTrackAtIndex`, `TrackFX_AddByName(..., "VST3: FabFilter Pro-Q 3", false, -1)`, `CreateTrackSend`, and `TrackFX_SetParamNormalized` -> read back `GetMediaTrackInfo_Value` & `TrackFX_GetParamNormalized`.
3. Trigger `Undo_DoUndo2` / explicit `beforeState` revert and verify state returns byte-for-byte cleanly.

### `EXP-RPR-03`: Plain-Text `.rpp` Parser Fidelity & Save Hash Verification
1. Save a multi-track REAPER project with sends, VST3 FX, and volume envelope points to `%TEMP%\rpp-test.rpp`.
2. Record SHA-256 of `.rpp`, run OS3 `.rpp` parser extracting `<TRACK>`, `<AUXRECV>`, `<FXCHAIN>`, `<PARMENV>`, and cross-check every track/FX/routing against live ReaScript readback.

### `EXP-RPR-04`: Headless Render Matrix (`reaper.exe -renderproject`) Master & Stem Check
1. Configure `.rpp` `<RENDER_CFG>` / Region Render Matrix to output `Master` + `Vocal` + `Beat` WAVs cleanly into a temp directory.
2. Run `"C:\Program Files\REAPER (x64)\reaper.exe" -renderproject "%TEMP%\rpp-test.rpp"` headlessly, verify exit status, SHA-256 of rendered stems, and pass outputs through OS3 `Audio Brain` (`trace.analysis/v1`).
