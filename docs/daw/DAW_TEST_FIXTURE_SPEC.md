# XYP3RN DAW Brain — Test Fixture & Verification Specification (Phase 09)

**Status:** Phase 09 Specification (Defines deterministic fixtures & verification criteria for Phase 10+ adapter builds; zero adapters built here)

---

## 1. Mock Transport & Wire-Protocol Fixtures

To verify 100% adapter correctness in CI without requiring live Windows GUIs or audio hardware:

### `FXT-MIDI-01`: Mock Virtual MIDI SysEx Transport (`MockMidiPortPair`)
- **Purpose:** Simulate bidirectional `loopMIDI` SysEx IPC between OS3 Node.js relay and mock/real `device_XYP3RNBrain.py` frame handler.
- **Required Behaviors:**
  1. 7-bit payload encoder/decoder asserting **zero bytes `>= 0x80`** between `0xF0` start and `0xF7` end markers (`assertStrict7BitSysEx()`).
  2. Multi-chunk fragmentation & reassembly (simulates >256 byte mixer/plugin dumps split across ordered SysEx chunks + CRC-16 check).
  3. Fault injection switches: configurable RTT delay (`10 ms`, `300 ms`), dropped ACK chunk (`retry once on read`), corrupted CRC rejection (`CRC_MISMATCH`), and sudden port disconnect (`offline` -> stale `cached` fallback).

### `FXT-RPR-01`: Mock REAPER OSC & ReaScript Bridge
- **Purpose:** Verify vendor-independent `DawAdapter` compatibility without `reaper.exe` installed.
- **Required Behaviors:**
  1. Stateful in-memory REAPER project tree supporting `InsertTrackAtIndex`, `DeleteTrack`, `TrackFX_AddByName`, `TrackFX_SetParamNormalized`, `CreateTrackSend`, and `Undo_DoUndo2`.
  2. Contrasts directly against FL Studio fixture in conformance suite: `daw.plugin.load_remove` & `daw.channel.create_delete` succeed with receipts on `FXT-RPR-01` while returning `501 DAW_CAPABILITY_UNSUPPORTED` on `FXT-FL-01`.

---

## 2. Project File Parsing Fixtures

### `FXT-RPP-01`: Deterministic REAPER `.rpp` Text Tree Fixture
- Minimal valid `.rpp` project (`tests/fixtures/daw/sample_mix.rpp`):
  - Header `<REAPER_PROJECT 0.1 "7.0"` + `TEMPO 140 4 4`.
  - At least 3 tracks: `Master`, `Vocal Bus` (`Track 1`), `808 Sub` (`Track 2`) with explicit `<AUXRECV` send routing, `<FXCHAIN>` carrying mock `VST3: FabFilter Pro-Q 3` + Base64 state chunk stub, and `<PARMENV` volume envelope points.
  - Expected parsed assertions: exact BPM `140`, track array count, directed send edges `Vocal -> Master`, `808 -> Master`, and unchanged input `.rpp` SHA-256 checksum post-parse.

### `FXT-FLP-01`: Read-Only `.flp` Binary Header & Event Stream Fixture
- Synthetic valid binary `.flp` container (`FLhd` chunk: format, channel count, PPQ `96` + `FLdt` chunk containing safe subset of FL project events: BPM, pattern name, mixer track name, plugin UTF-16 string).
- **Mandatory Negative Guard Tests:**
  1. Any call attempting `.flp` write/save/patch must throw `DAW_CAPABILITY_UNSUPPORTED` (`UNSUPPORTED`) BEFORE opening file write descriptors.
  2. Corrupt/truncated header bytes fail cleanly with `INVALID_PROJECT_FILE` rather than crashing or hanging.
  3. Parsing must preserve original SHA-256 identically.

---

## 3. Acoustic & `Audio Brain` Regression Fixtures

Deterministic synthetic 16-bit / 24-bit PCM `.wav` generators in test helper memory/temp dir (no copyrighted commercial audio files committed to Git):

| Fixture ID | Acoustic Signal Profile | Expected `Audio Brain` Verdict |
| :--- | :--- | :--- |
| **`FXT-AUD-CLIP`** | 1 kHz sine/noise burst hitting `+0.5 dBFS` clipped peaks + excessive crest compression | Flags `TRUE_PEAK_EXCEEDED` (`> -1.0 dBTP`), recommends gain trim `-1.5 dB` to `-2.5 dB`. |
| **`FXT-AUD-MUD`** | Multi-tone harmonic test signal with heavy `+8 dB` hump at `250–350 Hz` & narrow sub correlation | Flags low-mid masking delta (`200–500 Hz`), recommends dynamic attenuation / subtractive EQ proposal. |
| **`FXT-AUD-PASS`** | Balanced reference sweep (`-9.5 LUFS` integrated, `-1.2 dBTP` ceiling, `8.5 dB` crest, `+0.85` correlation) | Passes canonical X3LIUS mix/master rubric thresholds cleanly. |

---

## 4. Safety, Governance & Capability Conformance Fixtures

Every Phase 10 DAW adapter MUST pass this shared **Adapter Conformance Suite** (`runAdapterConformanceSuite(adapter)`):

1. **Read-Only Boot Invariant:** Newly connected session permits `observe` / `analyze` queries (`execute`, `prepare`, `rollback` return `DAW_PERMISSION_DENIED` until valid `daw_session_leases` grant).
2. **Gain & Parameter Clamp Safety Gate:**
   - Normalized param value `< 0.0` or `> 1.0` -> rejected (`DAW_SAFETY_VIOLATION`) without calling transport.
   - Mixer gain delta `> +3.0 dB` or master gain push past `0.0 dBFS` -> rejected cleanly before approval queue!
3. **Target Slot Drift Guard:** Modify target track/param out-of-band on mock host between `prepare()` and `execute()` -> `execute()` MUST abort with `409 DAW_TARGET_DRIFT` and leave `daw_command_journal` free of false success receipts!
4. **Human Approval & No-Retry Mutation Policy:**
   - Omitting `approvalId`, providing a `pending`/`rejected` ID, or providing agent self-approval -> blocked (`403 DAW_PERMISSION_DENIED`).
   - Timed-out `execute` command -> fails closed with **zero blind retries**; transitions state to reconciliation check.
5. **Rollback Fidelity:** `execute()` -> readback verify `afterState` -> `rollback()` restores `beforeState` bit-for-bit on mock host (when `rollbackSupported: true`).
6. **Live vs. Saved Epistemic Isolation:** Modifying live mock host state without disk save sets `hasUnsavedLiveChanges: true` and blocks unacknowledged CLI headless render against stale `savedProject`.
7. **Producer Edition Guardrail Check (`FXT-EDT-01`):** Attempting to plan or execute using `Harmor`, `Gross Beat`, `Newtone`, or `Vocodex` against `Producer Edition` baseline flags `REQUIRES_HIGHER_EDITION_OR_TRIAL` / `PLUGIN_EDITION_EXCLUDED` cleanly instead of outputting invalid workflow plans.

---

## 5. Manual Workstation Acceptance Matrix Link

| Spec Target | Automated Fixture Readiness | Manual Live-Host Gate |
| :--- | :--- | :--- |
| FL Studio 2025 Bridge (`device_XYP3RNBrain.py`) | Validated via `FXT-MIDI-01` + Conformance Suite | `EXP-FL-01`, `EXP-FL-02`, `EXP-FL-03`, `EXP-FL-04` |
| FL Studio Render & `.flp` Inspector | Validated via `FXT-FLP-01` + `FXT-AUD-*` | `EXP-FL-05`, `EXP-FL-06`, `EXP-FL-07` |
| REAPER Portability Adapter | Validated via `FXT-RPR-01` + `FXT-RPP-01` + Conformance Suite | `EXP-RPR-01`, `EXP-RPR-02`, `EXP-RPR-03`, `EXP-RPR-04` (after REAPER install) |
