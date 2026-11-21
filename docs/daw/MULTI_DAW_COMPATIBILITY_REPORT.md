# XYP3RN Multi-DAW Compatibility Report (Phase 17)

**Scope:** Architecture portability & contract conformance across `FakeDawAdapter`, `FlStudio2025Adapter`, and `ReaperAdapter` without modifying universal core interfaces (`core/daw-brain/`).

---

## 1. Capability Comparison Matrix

| Capability | FakeDawAdapter | FL Studio 2025 (`read_only` / `controlled_safe_v1`) | REAPER (`controlled_safe_v1`) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `daw.health.probe` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Process/transport RTT probing across all adapters |
| `daw.session.inspect` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Live RAM observation strictly separated from `.flp`/`.rpp` disk saves |
| `daw.transport.read` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Play/pause/record/loop/BPM/position |
| `daw.mixer.read` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Tracks, gains, pans, mute, solo, peak telemetry |
| `daw.routing.read` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Send edges + pre/post/sidechain flags |
| `daw.plugin.inventory_live` | `SUPPORTED` | `READ_ONLY` | `READ_ONLY` | Loaded plugins on channels/tracks |
| `daw.plugin.param_read` | `SUPPORTED` | `READ_ONLY` (`daw.plugin.params_read` alias noted) | `READ_ONLY` | Parameter names, normalized floats, formatted display text |
| `daw.transport.control` | `SUPPORTED` (rollback) | `UNSUPPORTED` / `SUPPORTED` (opt-in, rollback) | `SUPPORTED` (rollback) | Command Gateway bounded transport control |
| `daw.mixer.fader_pan_mute` | `SUPPORTED` (rollback) | `UNSUPPORTED` / `SUPPORTED` (opt-in, rollback) | `SUPPORTED` (rollback) | Clamped `[-60, +3.0 dB]` step & `<= 0 dBFS` Master safety gate |
| `daw.plugin.bypass` | `SUPPORTED` (rollback) | `UNSUPPORTED` / `SUPPORTED` (opt-in, rollback) | `SUPPORTED` (rollback) | Slot bypass toggle with readback & exact rollback |
| `daw.plugin.param_write` | `SUPPORTED` (rollback) | `UNSUPPORTED` | `SUPPORTED` (rollback, opt-in policy) | TrackFX / wrapper normalized parameter writes |
| `daw.mixer.routing_write` | `SUPPORTED` (rollback) | `UNSUPPORTED` | `SUPPORTED` (rollback, opt-in policy) | Send creation/toggle (`CreateTrackSend` on REAPER) |
| `daw.track.create_delete` | Undeclared | **`UNSUPPORTED`** (fixed 126 inserts) | **`SUPPORTED`** (`rollback: false`) | Fundamental architectural divergence cleanly handled |
| `daw.plugin.load_remove` | `UNSUPPORTED` | **`UNSUPPORTED`** (missing FL MIDI API) | **`SUPPORTED`** (`rollback: false`) | `TrackFX_AddByName` on REAPER vs manual instruction on FL |
| `daw.project.save` | Undeclared | **`UNSUPPORTED`** (no silent save / `.flp` banned) | **`SUPPORTED`** (`Main_SaveProject`, `rollback: false`) | Honest stronger-approval warning on non-rollback save |
| `daw.render.master` | Optional fixture | Headless CLI `/R` (disk `.flp` only) | `reaper.exe -renderproject` (`rollback: false`) | Offline audio bounce passed to Audio Brain |
| Timeline (`markers`, `regions`, `automationLanes`, `audioClips`, `midiClips`) | Mixed `unavailable`/`unknown` | **`unsupported`** (absent in FL MIDI Python) | **`available`** (ReaScript + `.rpp`) | `DawAvailability<T>` preserves truth without faking arrays |
| `daw.audio.pcm_tap` | Undeclared | **`UNSUPPORTED`** | **`UNSUPPORTED`** | Both use offline render + Audio Brain DSP instead |

---

## 2. Key Semantic & State Synchronization Differences

1. **Unity Headroom Calibration Discovery:**
   - FL Studio maps `0.0 dBFS` unity to normalized `0.8` (`TackDefaultVolume`).
   - REAPER maps `0.0 dBFS` unity to linear `D_VOL = 1.0`.
   - **Validation Outcome:** Running REAPER through `DawCommandGateway` caught a hardcoded `0.8` unity ceiling assumption inside `command-policy.ts`. Updated `command-policy.ts` cleanly to check explicit dB safety (`<= 0 dBFS`) and host-observed unity normalization rather than forcing FL's `0.8` curve on REAPER, without changing any universal core contract or interface.
2. **Plug-in Parameter Coupled Curves (`deltaDb` vs `volumeNormalized`):**
   - Adjusting `deltaDb` in REAPER (`D_VOL`) and FL Studio updates linear normalized volume as a mathematical consequence, whereas fixed fixtures may update scalar `volumeDb` independently. `DawDryRunEngine.verifyPostcondition()` checks modified target parameters cleanly across both curves.
3. **Track / Mixer Object Models:**
   - FL Studio decouples Channel Rack instruments (`0..C`), Fixed 126 Mixer Inserts (`Master` + `1..125`), and Playlist tracks (`1..N`).
   - REAPER unifies tracks (`Master -1`, dynamic `0..N-1`), media items, envelopes, FX chains, and sends into one `MediaTrack` hierarchy.
   - `DawStateSnapshot` (`tracks`, `channels`, `mixerChannels`, `buses`, `routing`) accommodates both naturally without distorting either model.
4. **State Synchronization Transport:**
   - FL Studio uses chunked 7-bit WinMM SysEx + CRC-16 + `OnRefresh(HW_Dirty_*)` bitmask pushes.
   - REAPER uses `127.0.0.1` loopback HTTP JSON-RPC + `GetProjectStateChangeCount()` monotonic dirty counter pushes.

---

## 3. Shared Regression Verification

All 3 adapters (`FakeDawAdapter`, `FlStudio2025Adapter`, and `ReaperAdapter`) pass the identical shared contract conformance harness (`tests/os3-phase17-reaper-multi-daw/reaper-and-multi-daw.test.ts`):
- `validateAdapterContract(adapter)` clean pass.
- Default `connected_read_only` boot + lease enforcement (`DAW_LEASE_REQUIRED`).
- Host version gating (`DAW_UNSUPPORTED_HOST_VERSION` on too-old hosts, `degraded_read_only` blocking mutations on untested future hosts).
- Offline disconnect degradation to `stale` + `cached` and clean recovery to `observed`.
- Identical Command Gateway safety clamps (`+5.0 dB` jump -> `DAW_SAFETY_VIOLATION`, Master `> 0 dBFS` -> `DAW_SAFETY_VIOLATION`), drift detection (`DAW_TARGET_DRIFT`), dry-run diff, human approval enforcement, postcondition readback, duplicate protection, and `beforeState` rollback.
- Cross-DAW delegation through `Os3JarvisCore` (`DawBrainDelegate`) and `DawSessionIntelligence`.
