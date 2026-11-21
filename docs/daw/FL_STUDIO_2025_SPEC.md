# FL Studio 2025 (Producer Edition) — Technical Integration Specification

**Status:** Phase 09 Specification (Zero adapter code implemented in this phase)  
**Target Workstation:** Windows 11 Pro (`10.0.26300` x64) · Target DAW: **FL Studio 2025 Producer Edition** (`FL64.exe` `25.1.6.4997`)

---

## 1. Workstation Evidence Observed Directly on Host

Local read-only filesystem & PnP inspection established the following ground-truth baseline before any assumptions:

1. **Critical Multi-Version Installation Anomaly Observed:**
   - `C:\Program Files\Image-Line\FL Studio 2025\` currently contains ONLY binaries/registry artifacts: `FL64.exe` (`25.1.6.4997`), `FL64 (scaled).exe`, `FL64 (2).exe`, `FL64 (scaled) (2).exe`, `FLEngine_x64.dll`, `FLEngine_x64 (2).dll`, and `FL Studio 25.1.reg` — it has **no** `Data/`, `Plugins/`, `Shared/`, or `System/` subdirectories inside `FL Studio 2025\`.
   - `C:\Program Files\Image-Line\FL Studio 2026\` (`26.1.1.5547`) holds the complete runtime asset layout: `Artwork/`, `Data/`, `Help/`, `Plugins/Fruity/`, `Shared/Python/` (**Python 3.12** via `python312.dll`, `python312.zip`, `Lib/midi.py`, `Lib/utils.py`), `Shared/ILPluginScanner64.exe`, `Shared/ILRemoteServer_x64.dll`, and `System/Hardware specific/`.
   - **Pre-Implementation Requirement (`EXP-FL-01`):** Operator must verify whether `FL Studio 2025\FL64.exe` launches cleanly as Producer Edition alongside `FL Studio 2026\` or whether the 2025 folder is a leftover binary snapshot after upgrading to `26.1.1.5547`. Adapter detection must validate the active launching `FL64.exe` path rather than assuming subdirectories under `FL Studio 2025\`.
2. **User Data & Scripting Directories:**
   - Hardware scripts path exists: `C:\Users\blago\Documents\Image-Line\FL Studio\Settings\Hardware\` (containing vendor scripts such as `Akai FL Studio Fire\device_Fire.py`, `Solid State Logic\device_SSL.py`, `MackieCU\device_MackieCU_Ext.py`, `Novation\*`, `Arturia\*`, `NI Komplete Kontrol\*`).
   - Empty/user script folders exist: `Settings\Audio scripts`, `Settings\Piano roll scripts`, `Settings\FL Studio Remote Scripts`.
   - Existing `.flp` project fixtures exist for read-only parser testing under `Documents\Image-Line\FL Studio\Projects\` (`COLDINMYEYES\COLDINMYEYES.flp`, `Project_1..Project_4`).
3. **MIDI & Audio Devices Observed (`Get-PnpDevice`):**
   - Audio interfaces/drivers: `Focusrite USB Audio`, `Waves SoundGrid`, `VB-Audio Virtual Cable`, `AMD High Definition Audio Device`, `FL Studio ASIO`.
   - MIDI interfaces: Only `Microsoft GS Wavetable Synth` and inactive/unknown Windows MIDI entries exist — **zero virtual MIDI loopback ports (`loopMIDI`, `LoopBe`, etc.) are currently installed**.
4. **VST Plugin Environment:**
   - `29` entries in `C:\Program Files\Common Files\VST3\` (including `TRACE.vst3`, `FabFilter`, `iZotope`, `oeksound`, `Celemony`, `Antares`, `MasteringTheMix`, `Black Salt Audio`, `Cradle`, `Nuro Audio`, `ARCHON.vst3`, `Musik Hack`, `WaveShell1-VST3 16.x`, `Cymatics*`).
   - `5` entries in `C:\Program Files\VSTPlugins\`.

---

## 2. Detailed Investigation by Integration Mechanism

### 2.1. Available Scripting Interfaces & Python Capabilities
1. **MIDI Controller Scripting (`Settings\Hardware\<ControllerName>\device_*.py`):**
   - **Runtime:** Embedded CPython inside FL Studio (`python312.dll` verified in `FL Studio 2026\Shared\Python\`, supporting standard Image-Line built-in modules: `arrangement`, `channels`, `device`, `general`, `launchMapPages`, `mixer`, `patterns`, `playlist`, `plugins`, `screen`, `transport`, `ui`, `midi`, `utils`).
   - **Edition Support:** Available in all desktop editions including Producer Edition.
   - **Security Sandbox (`VERIFIED`):** Even though CPython stdlib DLLs ship alongside FL Studio, the controller runtime sandbox blocks network sockets (`socket`, `urllib`, `http`), `subprocess`, and arbitrary external host IPC so third-party controller scripts cannot exfiltrate data or host open HTTP servers inside FL Studio.
2. **Piano Roll Scripting (`Settings\Piano roll scripts\*.pyscript`):**
   - Uses Image-Line `flpianoroll` Python API to read/write notes and markers inside the focused pattern's Piano Roll.
   - **Limitation:** Strictly user-invoked from the Piano Roll menu (`Tools -> Scripting`); cannot be triggered remotely by Node.js or external MIDI messages (`UNSUPPORTED` remote dispatch).
3. **Edison Audio Scripting (`Settings\Audio scripts\*.pyscript`):**
   - Image-Line deprecated old Pascal `paxCompiler` Edison scripts in favor of Python `.pyscript` execution inside Edison (`Run script`), strictly interactive from Edison's UI and inaccessible from the MIDI controller script thread.
4. **VFX Script (`Plugins\Fruity\Effects\VFX Script`):**
   - Runs internal Patcher note/voice Python scripts inside Patcher signal flow; not a general DAW orchestration RPC surface.

### 2.2. MIDI Input/Output & Controller / Remote-Control Mechanisms
- **Sole Official External Live IPC Channel:** Virtual Windows MIDI loopback driver (e.g., `loopMIDI` creating dedicated `XYP3RN-TO-FL` and `FL-TO-XYP3RN` ports) paired with a first-party OS3 hardware controller script (`device_XYP3RNBrain.py`) registered in FL Studio MIDI Settings (`Input` port == `Output` port).
- **Wire Protocol Strategy:**
  - Universal Non-Real-Time / Educational Manufacturer SysEx ID framing (`0xF0 0x7D ... 0xF7`) via `device.midiOutSysex(bytes)` and `OnSysEx(event)`.
  - Every payload must pass 7-bit MIDI encoding (nibblized UTF-8/JSON or compact binary frames, since all bytes between `0xF0` and `0xF7` must have MSB = `0`) with a sequence correlation ID and CRC-16 frame integrity check.
  - Because `loopMIDI` is **not installed yet**, live bidirectional IPC is `EXPERIMENTAL` until the operator installs `loopMIDI` and completes `EXP-FL-01`/`EXP-FL-02`.
- **Event Callbacks:** FL Studio pushes `OnInit()`, `OnDeInit()`, `OnIdle()` (periodic tick ~20ms), `OnMidiIn(event)`, `OnSysEx(event)`, and `OnRefresh(flags)` (masking `midi.HW_Dirty_Mixer_Sel`, `HW_Dirty_Mixer_Controls`, `HW_Dirty_ControlValues`, `HW_Dirty_Names`, `HW_Dirty_Patterns`, `HW_Dirty_Tracks`, `HW_Dirty_Undo`).

### 2.3. Mixer, Routing, Plugin & Parameter Visibility and Control
Inspecting local `midi.py` (`761` lines) and `device_Fire.py` / `device_MackieCU_Ext.py` / `device_SSL_Ext.py` confirms exact supported mechanisms:

| Subsystem | Supported Live Read APIs | Supported Live Write APIs | Verified Hard Limitations |
| :--- | :--- | :--- | :--- |
| **Transport** | `transport.isPlaying()`, `isRecording()`, `getSongPos()`, `getLoopMode()`, `mixer.getCurrentTempo()` | `transport.start()`, `stop()`, `record()`, `setLoopMode()`, `globalTransport(FPT_*)`, `processRECEvent(REC_Tempo, ...)` | No silent headless project save (`FPT_Save` triggers UI focus); tempo jumps must be safety-clamped (`20–300 BPM`). |
| **Mixer Inserts (`0..125`)** | `mixer.trackCount()`, `getTrackName()`, `getTrackVolume()`, `getTrackPan()`, `isTrackMuted()`, `isTrackSolo()`, `getTrackPeaks()`, `getRouteSendActive(src, dst)` | `mixer.setTrackVolume()`, `setTrackPan()`, `muteTrack()`, `soloTrack()`, `setRouteTo(src, dst, val)`, `REC_Mixer_EQ_*` | Fixed 126-insert mixer architecture (Master `0`, Inserts `1..125`, Current `126/127`). Cannot create or delete inserts (`UNSUPPORTED`). `getTrackPeaks()` returns peak floats only (no spectral/LUFS buffer). |
| **Channel Rack** | `channels.channelCount()`, `getChannelName()`, `getChannelColor()`, `getTargetFxTrack()`, `isChannelMuted()`, `isChannelSolo()`, `getGridBit()` | `selectOneChannel()`, `muteChannel()`, `soloChannel()`, `midiNoteOn()`, `setGridBit()`, `processRECEvent(REC_Chan_FXTrack, ...)` | **Cannot add, replace, or delete Channel Rack instruments** via MIDI Python (`UNSUPPORTED`). |
| **Plugins & Params** | `plugins.isValid(idx, slotIdx)`, `plugins.getPluginName()`, `getParamCount()`, `getParamName()`, `getParamValue()`, `getParamValueString()`, `processRECEvent(REC_Plug_Mute, 0, REC_GetValue)` | `plugins.setParamValue(val, paramIdx, idx, slotIdx)`, `general.processRECEvent(mixer.getTrackPluginId(trk, slot) + midi.REC_Plug_Mute, val, midi.REC_SetAll)` | **Cannot instantiate, load, move, or remove plugins** (`UNSUPPORTED`). Parameter counts vary widely across VST3 wrappers (`FabFilter` vs multi-shell `WaveShell`); normalized `[0.0, 1.0]` mapping differs per plugin wrapper and requires `Plugin Brain` calibration + readback verification. |
| **Automation** | Limited current value query (`REC_GetValue`) | Real-time REC automation tweak recording during armed transport | **Cannot** programmatically inspect or edit Playlist Automation Clip envelopes/points (`UNSUPPORTED`). |

### 2.4. Project File Access & Headless Audio Render
- **Read-Only `.flp` Project Parsing (`EXPERIMENTAL`):**
  - `.flp` files use an undocumented binary event/chunk container format (`FLhd` + `FLdt` chunks).
  - External Python/Node inspection tools can extract tempo, track/channel names, plugin DLL/VST names, sample paths, and routing read-only to populate the `savedProject` tier (`State Tier 3`) alongside SHA-256 checksums.
  - **Hard Safety Rule:** **Binary `.flp` writes are `UNSUPPORTED` and strictly forbidden**, because undocumented FL 25/26 chunks risk irreversible project corruption.
- **Headless CLI Rendering (`FL64.exe /R`):**
  - Command syntax (`VERIFIED` in official CLI docs): `"C:\Program Files\...\FL64.exe" /R /Ewav "path\to\project.flp"`.
  - **Critical Operational Constraints:**
    1. Renders strictly from the **saved `.flp` on disk**, ignoring unsaved RAM edits in an open GUI session. Adapter MUST compare `liveObserved` state dirty status against `savedProject.sha256` and refuse or warn before rendering stale disk state!
    2. CLI switches `/R /Ewav` have **no command-line flag to force `"Split mixer tracks"` multi-stem export** (`UNSUPPORTED`). Only Master output rendering is guaranteed headlessly unless the `.flp`/template was manually saved with split-mixer preference enabled.
    3. `FL64.exe /R` must not execute concurrently with another exclusive ASIO hardware lock cleanly on all drivers — run isolated against throwaway/scratch WAV target copies and monitor exit codes + timeouts.

### 2.5. Producer Edition Plugin Constraints
Baseline workstation target is **Producer Edition**:
- **Permitted First-Party Stock Tools:** `FLEX`, `3x Osc`, `Sytrus`, `Edison`, `Slicex`, `Maximus`, `Fruity Parametric EQ 2`, `Fruity Limiter`, `Fruity Compressor`, `Fruity Multiband Compressor`, `Fruity Soft Clipper`, `Fruity Reeverb 2`, `Fruity Delay 3`, `Fruity Convolver`, `Fruity Send`, `Control Surface`, `Patcher`, `VFX *`.
- **Excluded / Demo-Locked Unless Proven Unlocked in `EXP-FL-01`:** `Gross Beat`, `Harmor`, `Newtone`, `DirectWave (Full)`, `Pitch Shifter`, `Vocodex`, `Sakura`, `Morphine`, `PoiZone`, `Sawer`, `Toxic Biohazard`, `Transient Processor`, `Transporter`.
- **Third-Party VST3 Plugins (`29` on host):** Fully compatible inside Producer Edition once manually inserted onto target slots (`FabFilter`, `iZotope`, `oeksound`, `Celemony`, `Antares`, `MasteringTheMix`, `WaveShell1-VST3`, etc.).

---

## 3. Required Manual Experiments Inside Installed FL Studio 2025

Before writing production FL Studio adapter code in Phase 10, execute these **7 reproducible manual experiments** on the Windows 11 workstation and record outputs into Obsidian `10_DAW_BRAIN/` evidence notes:

### `EXP-FL-01`: Installation Path, Binary Launch & Producer Edition Unlock Check
- **Goal:** Resolve why `FL Studio 2025\` has binaries only while `FL Studio 2026\` holds `Plugins/`, `Shared/`, and `Help/`, and verify the true active edition license.
- **Procedure:**
  1. Launch `C:\Program Files\Image-Line\FL Studio 2025\FL64.exe` cleanly. Observe whether it boots as `v25.1.6` or redirects/errors due to missing local resource folders. Record which binary (`FL Studio 2025` vs `2026`) is active.
  2. Open **Help -> About** inside the running FL Studio window and verify exact displayed version build + Edition string (confirm `"Producer Edition"` vs `"Signature"` vs `"All Plugins"`).
  3. Open **Options -> MIDI Settings** and open the script output console (**View -> Script output**), confirming embedded Python version (`sys.version`) prints without error.
- **Expected Pass Criteria:** Active binary launches reliably; `sys.version` matches installed Python runtime; true edition string recorded cleanly.

### `EXP-FL-02`: `loopMIDI` Virtual Loopback & Bidirectional SysEx Round-Trip Latency Benchmark
- **Goal:** Verify Windows 11 virtual MIDI loopback setup and measure live SysEx RTT & dropped-frame rate.
- **Procedure:**
  1. Install `loopMIDI` and create two ports: `XYP3RN_IN` (OS -> FL) and `XYP3RN_OUT` (FL -> OS).
  2. Place a test probe script `device_XYP3RNProbe.py` in `Documents\Image-Line\FL Studio\Settings\Hardware\XYP3RN_Probe\` implementing `OnSysEx` ping-pong echo + `transport.getSongPos()` + `transport.start()` / `stop()`.
  3. In FL Studio **Options -> MIDI Settings**, bind `XYP3RN_IN` Output/Input ports consistently to `XYP3RN_Probe`.
  4. From a Windows terminal MIDI script, send `100` numbered SysEx `PING` frames and timed `FPT_Play`/`FPT_Stop` transitions; record median and P99 RTT (`ms`) and drop count (`0 / 100` target).
- **Expected Pass Criteria:** `100/100` SysEx round-trips succeed with P99 RTT `< 60 ms` and zero lost frames.

### `EXP-FL-03`: Mixer Insert Sweep, EQ/Volume Clamping & `setRouteTo` Verification
- **Goal:** Verify safe batched serialization of all 126 mixer inserts (`Master` + `1..125`) and live `setRouteTo` / `setTrackVolume` precision.
- **Procedure:**
  1. Load `COLDINMYEYES.flp` (or `Project_1.flp`) in read-only test copy.
  2. Run probe calling `mixer.trackCount()`, `getTrackName(i)`, `getTrackVolume(i)`, `getTrackPan(i)`, and `getRouteSendActive(i, 0)` across all populated tracks and serialize via chunked SysEx.
  3. Test setting `mixer.setTrackVolume(4, 0.75)` -> verify readback (`getTrackVolume(4)`) matches within `<= 0.002` tolerance -> restore original value (`undo` / reset).
  4. Verify toggling `mixer.setRouteTo(4, 5, 1)` and back to `0` reflects immediately in `getRouteSendActive(4, 5)`.
- **Expected Pass Criteria:** Chunked mixer sweep completes under `150 ms`; volume & routing readbacks match intended values with zero stale read glitches.

### `EXP-FL-04`: Third-Party VST3 (`FabFilter`, `WaveShell`, `TRACE.vst3`) Enumeration & Parameter Readback Check
- **Goal:** Verify how FL Studio 2025's `plugins` module addresses multi-plugin wrappers (`WaveShell`) and third-party VST3 parameters.
- **Procedure:**
  1. Load `Fruity Parametric EQ 2`, `FabFilter Pro-Q 3`, `iZotope Ozone`, and `TRACE.vst3` onto Mixer Insert 1 slots `0..3` in a scratch project.
  2. Query `plugins.getPluginName(0, slot)` and `plugins.getParamCount(0, slot)` + first 32 parameter names/values via `plugins.getParamName` & `getParamValue`.
  3. Toggle slot 0 mute via `general.processRECEvent(mixer.getTrackPluginId(0, 0) + midi.REC_Plug_Mute, ...)` and read back state.
  4. Perform ONE safe normalized change (`setParamValue` + readback confirm + revert) on `Fruity Parametric EQ 2` Band 1 Freq and `FabFilter Pro-Q 3` param `0`.
- **Expected Pass Criteria:** Exact returned string names, param counts, latency (`ms`), and whether `TRACE.vst3` exposes telemetry parameters or private IPC are documented.

### `EXP-FL-05`: Headless CLI Master Bounce (`FL64.exe /R /Ewav`) Duration & ASIO Behavior Test
- **Goal:** Measure real wall-clock execution and exit behavior of headless `/R /Ewav` while FL Studio GUI is closed vs open.
- **Procedure:**
  1. Copy `Project_1.flp` to a temporary folder `%TEMP%\xyp3rn-fl-cli-test\test.flp`.
  2. With FL Studio GUI **closed**, run: `"C:\Program Files\...\FL64.exe" /R /Ewav "%TEMP%\xyp3rn-fl-cli-test\test.flp"`. Measure runtime and verify resulting WAV SHA-256 and `Audio Brain` decoding.
  3. Repeat while another `FL64.exe` GUI session is **open** on a different project to check single-instance / ASIO contention or silent failure exit codes.
- **Expected Pass Criteria:** Deterministic exit code, WAV creation confirmed when closed, and concurrent-GUI behavior documented cleanly so adapter guards against running `/R` over active locked sessions if contentious.

### `EXP-FL-06`: Read-Only `.flp` Binary Parser Verification on Real Workhorse Projects
- **Goal:** Verify whether read-only `.flp` chunk inspection accurately extracts BPM, track labels, and loaded VST3 plugin names from FL 2025/2026 `.flp` files without throwing on newer Image-Line event IDs.
- **Procedure:**
  1. Hash original `COLDINMYEYES.flp` & `Project_1.flp` (`Get-FileHash -Algorithm SHA256`), copy to temp directory, and run candidate read-only parser against the copies.
  2. Cross-check extracted tempo, track names, mixer routing, and plugin list against FL Studio GUI display (`VERIFIED` delta).
  3. Confirm post-parse file SHA-256 is byte-identical.
- **Expected Pass Criteria:** Zero uncaught parser crashes on FL 25/26 events; extracted metadata matches GUI >= 95% of core project fields cleanly.

### `EXP-FL-07`: `Plugin Brain` Edition Audit vs `ILPluginScanner64.exe` Database
- **Goal:** Check whether FL Studio's local plugin database cache (`Documents\Image-Line\FL Studio\Presets\Plugin database` / `New plugin archive`) exposes usable scanned VST3 metadata without touching running FL instances.
- **Procedure:**
  1. Inspect `Documents\Image-Line\FL Studio\Support\Logs\PluginManager v1.8.1.*.log` and `Presets\Plugin database\Effects\Installed\` `.nfo` / `.fst` files read-only.
  2. Document exact `.nfo` fields (`ps_file_name_0`, vendor, category, VST3 GUID) available natively from FL's own Plugin Manager output.
- **Expected Pass Criteria:** Read-only `.nfo` metadata format confirmed as authoritative local VST3 inventory source complementary to runtime `plugins.getPluginName()`.
