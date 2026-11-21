# FL Studio 2025 Adapter — Capability Evidence, Integration Logs & Known Limitations

**Adapter ID:** `fl-studio-2025` (`core/daw-adapters/fl-studio-2025/`)  
**Release Scope:** Phase 11 Read-Only Observation Release (`v1`)  
**Workstation Baseline:** Windows 11 · Executed via `node core/daw-adapters/fl-studio-2025/probe-cli.ts` (`2026-11-21T03:57:07Z`)

---

## 1. Capability Evidence

### 1.1 Declared Capability Contract (`FL_STUDIO_2025_CAPABILITIES`)

| Capability ID | Declared Support | Verified Mechanism | Evidence Source |
| :--- | :--- | :--- | :--- |
| `daw.health.probe` | `READ_ONLY` | Process probe + WinMM `midiInGetDevCapsW`/`midiOutGetDevCapsW` + SysEx `PING_REQ`/`PING_RESP` | `host-probe.ts`, `midi-transport.ts` |
| `daw.version.inspect` | `READ_ONLY` | PE `FileVersion` + Python `ui.getVersion(midi.VER_FullVersionAndEdition)` + `general.getVersion()` | `midi.py` lines 658–666, `device_XYP3RNBrain.py` |
| `daw.session.inspect` | `READ_ONLY` | Live SysEx state container paired with optional read-only `.flp` SHA-256 saved project check | `fl-studio-adapter.ts`, `flp-inspector.ts` |
| `daw.transport.read` | `READ_ONLY` | `transport.isPlaying()`, `isRecording()`, `getLoopMode()`, `getSongPos(SONGLENGTH_MS)`, `mixer.getCurrentTempo(0)` | `device_XYP3RNBrain.py`, `midi.py` |
| `daw.mixer.read` | `READ_ONLY` | `mixer.trackCount()`, `getTrackName()`, `getTrackVolume()`, `getTrackPan()`, `isTrackMuted()`, `isTrackSolo()`, `getTrackPeaks(PEAK_LR)` | `device_XYP3RNBrain.py` |
| `daw.routing.read` | `READ_ONLY` | `channels.getTargetFxTrack()`, `mixer.getRouteSendActive(src, dst)` | `device_XYP3RNBrain.py` |
| `daw.plugin.inventory_live` | `READ_ONLY` | `plugins.isValid(idx, slot)`, `plugins.getPluginName(idx, slot)` across Channel Rack & Mixer slots | `device_XYP3RNBrain.py` |
| `daw.plugin.params_read` | `READ_ONLY` | Bounded `plugins.getParamCount/Name/Value/ValueString` inspection (`maxParamsPerPlugin: 32`) | `device_XYP3RNBrain.py`, `fl-studio-adapter.ts` |
| `daw.project.flp_inspect` | `READ_ONLY` | Read-only `FLhd`/`FLdt` container parser (`open(..., 'r')` + SHA-256 pre/post equality) | Verified on 8 real `.flp` files below |
| `daw.plugin.database_scan` | `READ_ONLY` | Read-only scan of VST3/VST2 dirs & FL `Presets\Plugin database\`; Producer Edition flagging | `155` local plugin entries scanned |
| `daw.track.create_delete` | `UNSUPPORTED` | Absent in FL Studio MIDI Scripting API (fixed 126-insert mixer) | Image-Line API + `fl-studio-adapter.ts` |
| `daw.plugin.load_remove` | `UNSUPPORTED` | Absent in FL Studio MIDI Scripting API (cannot load/delete plugins) | Image-Line API + `fl-studio-adapter.ts` |
| `daw.project.save` / `flp_write` | `UNSUPPORTED` | Binary `.flp` writes blocked by safety policy; no silent save API | `assertFlpMutationBlocked()` |
| `daw.automation.edit` | `UNSUPPORTED` | No Playlist Automation Clip spline inspection/edit API in MIDI scripting | `DawAvailability: unsupported` |
| `daw.audio.pcm_tap` | `UNSUPPORTED` | Controller sandbox exposes momentary peak floats only (no live PCM/FFT stream) | Image-Line `mixer` API |
| `daw.render.split_stems` | `UNSUPPORTED` | CLI `/R` lacks native multi-stem split-mixer flag | Image-Line CLI spec |
| `daw.transport.control`, `daw.mixer.*`, `daw.plugin.param_write`, `daw.plugin.bypass` | `UNSUPPORTED` (Phase 11 lock) | Intentionally disabled in Phase 11 read-only release; rejected pre-dispatch & in `execute()` + Python `ERR_READ_ONLY` (`0x7E`) | `fl-studio-adapter.test.ts` test 6 |

### 1.2 Live Workstation Host & `.flp` Probe Evidence

Observed directly via `node core/daw-adapters/fl-studio-2025/probe-cli.ts` (`2026-11-21T03:57:07.991Z`):
- **Detected Binaries:**
  - `C:\Program Files\Image-Line\FL Studio 2025\FL64.exe` -> `FileVersion: 25.1.6.4997` (`hasCompanionDataDirs: false`, missing `Data, Plugins, Shared, System`).
  - `C:\Program Files\Image-Line\FL Studio 2026\FL64.exe` -> `FileVersion: 26.1.1.5547` (`hasCompanionDataDirs: true`).
- **Detected WinMM Ports:**
  - MIDI IN (`2`): `[0] StudioRack`, `[1] SG Device I/O`.
  - MIDI OUT (`3`): `[0] Microsoft GS Wavetable Synth`, `[1] StudioRack`, `[2] SG Device I/O`.
- **Detected Prerequisites Missing for Live SysEx Session:** `loopMidiInstalled: false`, `XYP3RN_IN` / `XYP3RN_OUT` missing, `device_XYP3RNBrain.py` not yet copied to user `Documents\Image-Line\FL Studio\Settings\Hardware\XYP3RN_Brain\`, and `runningProcesses: []`.
- **Read-Only `.flp` Verification Across `8` Real Workstation Projects (`hashUnchangedAfterRead: true` on 8/8):**
  - `aa.flp`: `25.1.6.4997` (`ppq: 96`, `tempoBpm: 140`, `4/4`).
  - `recording template.flp`: `25.1.6.4997` (`ppq: 96`, `tempoBpm: 140`, `4/4`, `31` mixer track names, `10` plugins).
  - `COLDINMYEYES.flp`: `26.1.1.5547` (`ppq: 96`, `4/4`, `4` channels, `8` mixer track names, `tempoBpm: unknown` explicitly flagged).
  - `Project_1.flp`, `Project_2.flp`, `Project_3.flp`, `rec.flp`: `25.1.6.4997`, `Project_4.flp`: `26.1.1.5547` — all hashed identically pre/post read; obfuscated scalar tempo tokens cleanly flagged as `unknown`.
- **Local Plugin Inventory Scan (`discoverInstalledPlugins()`):** `155` total (`19` `.vst3`, `4` VST2 `.dll`, `132` native `.fst` presets; `18` flagged `excluded_by_edition_unless_purchased` under Producer Edition baseline).

---

## 2. Workstation Integration Logs (Sample Captured Output)

Verbatim excerpt from `probe-cli.ts` `integrationLogs`:

```json
[
  {
    "seq": 2,
    "timestamp": "2026-11-21T03:57:10.775Z",
    "level": "info",
    "event": "fl.host.probed",
    "sessionId": null,
    "details": {
      "installsFound": [
        "FL Studio 2025:25.1.6.4997",
        "FL Studio 2026:26.1.1.5547"
      ],
      "runningPids": [],
      "loopMidiInstalled": false,
      "configuredPortsReady": false,
      "missingPrerequisites": [
        "Virtual MIDI loopback ports (XYP3RN_IN / XYP3RN_OUT) not found on Windows WinMM — install loopMIDI and create loopback ports",
        "Controller script not installed at \"C:\\Users\\blago\\Documents\\Image-Line\\FL Studio\\Settings\\Hardware\\XYP3RN_Brain\\device_XYP3RNBrain.py\"",
        "No live FL64.exe process running"
      ]
    }
  },
  {
    "seq": 4,
    "timestamp": "2026-11-21T03:57:10.788Z",
    "level": "info",
    "event": "fl.project.flp_inspected",
    "sessionId": null,
    "details": {
      "projectPath": "C:\\Users\\blago\\Documents\\Image-Line\\FL Studio\\Projects\\COLDINMYEYES\\COLDINMYEYES.flp",
      "flVersion": "26.1.1.5547",
      "sha256": "1b7f9b0044d8d7d59d4781f5f86e4c91e1bba75a9a2dc6bc0d094647114f50c2",
      "channels": 4,
      "plugins": 1,
      "warnings": 1
    }
  }
]
```

Runtime sessions also log `fl.connect.started`, `fl.connect.succeeded` / `fl.connect.failed`, `fl.session.observed`, `fl.sysex.push_delta`, `fl.health.offline` / `fl.health.degraded`, `fl.disconnect.completed`, `fl.mutation.refused_validation`, and `fl.mutation.refused_execute` (retrievable via `adapter.getIntegrationLogs()`).

---

## 3. Known Limitations

1. **Live SysEx Loopback Prerequisite (`loopMIDI`):** Windows 11 host does not currently have `loopMIDI` installed (`loopMidiInstalled: false`). Until the operator installs `loopMIDI` (`XYP3RN_IN` / `XYP3RN_OUT`) and copies `device_XYP3RNBrain.py` into FL Studio Settings, live WinMM SysEx transport tests run against `MockFlMidiTransport` (`FXT-MIDI-01`) and live `connectSession('fl-studio-2025')` fails closed with `DAW_HOST_OFFLINE`.
2. **Observation-Only Scope (Phase 11 v1):** All mutating operations are intentionally locked (`UNSUPPORTED`). Enabling bounded writes requires explicit future-phase capability unlock + approval policy.
3. **FL Studio API Gaps (Permanent Unless Image-Line Expands Controller SDK):** No programmatic track/channel add/delete, no programmatic plugin insert/remove, no Piano Roll clip note/timeline audio clip dump, no Automation Clip spline read/write, no live PCM audio tap, and no silent save-as API.
4. **Modern `.flp` Scalar Obfuscation:** Newer FL Studio 25/26 projects can store masked or omitted scalar tempo/time-signature tokens; `flp-inspector.ts` explicitly reports these as `unknown` rather than emitting guessed numeric values.
5. **Workstation `FL Studio 2025\` Companion Directory Anomaly:** `FL Studio 2025\FL64.exe` (`25.1.6.4997`) lacks sibling `Data/`, `Plugins/`, `Shared/`, and `System/` folders on this machine, whereas `FL Studio 2026\` (`26.1.1.5547`) contains the full runtime tree; connecting against `26.1.1.5547` triggers `DawVersionManager` `degraded_read_only` mode automatically.
