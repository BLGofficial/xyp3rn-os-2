# XYP3RN DAW Brain — Capability Model & Host Compatibility Matrix (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Security Rule:** Default session permission = **`observe`** (strictly read-only). Unsupported host capabilities return structured `DAW_CAPABILITY_UNSUPPORTED`, never simulated silently.

---

## 1. Seven-Tier Security Permission Model

Every DAW tool, agent, and UI/API command maps explicitly to one permission level in `DawCapabilityRegistry`:

| Permission Tier | Scope Description | Allowed Agents / Actors | Default Active? | Approval / Safety Requirement |
|---|---|---|---|---|
| **1. `observe`** | Read live transport, tracks, mixer routing, loaded plugin names/params, and session health. | All DAW/Research/Knowledge agents + UI | **YES (Default)** | Read-only; zero project or DSP mutation. |
| **2. `analyze`** | Run DSP/TRACE spectral/LUFS checks, `.flp`/`.rpp` read-only parsing, Plugin Brain capability matching. | `daw-audio-analyst`, `daw-plugin-advisor`, `daw-session-observer` | **YES** (Safe compute) | Read-only analysis over observed/audio artifacts. |
| **3. `propose`** | Emit `proposedModifications` (`DawCommand[]`), mix deltas, arrangement suggestions, Obsidian notes. | `daw-mix-planner`, `x3lius-*`, `Planning`/`Creative` | No host mutation | Queued as draft artifacts / structured proposals; zero host effect. |
| **4. `prepare`** | Validate targets against live slot IDs, apply range/headroom safety clamps, snapshot `beforeState`, stage `PreparedDawPatch`. | `daw-mix-planner`, `daw-execution-operator` | Explicit session flag | Must prove target IDs exist and patch passes safety invariants. |
| **5. `execute`** | Transmit `PreparedDawPatch` over DAW adapter (mixer fader/pan/mute, plugin parameter, transport, headless render). | `daw-execution-operator` ONLY (never Planning/Creative) | **NO (Opt-in Lease)** | Requires active time-bounded `execute` lease + prior `approve` (policy or per-patch) + `beforeState` capture. |
| **6. `approve`** | Authorize execution of prepared DAW mutations or promotion of session insights to canonical Vault. | **Human Operator ONLY (`[]` for all Agents)** | Human-only | Stored immutably in SQLite `pending_approvals`. |
| **7. `rollback`** | Restore `beforeState` values (`paramValues`, `mixerFader`, `mute`) from an `appliedModifications` receipt. | `daw-execution-operator` + Human Operator | Emergency / Operator | Only allowed where adapter declares capability `rollback: 'supported'`. Fails explicitly if host mutated destructively out-of-band without reversible receipt. |

---

## 2. Universal DAW Adapter Capability Matrix

Adapters declare support level per capability using exact states:
- `SUPPORTED` — Deterministic programmatic execution & verification available.
- `TEMPLATE_SCOPED` — Supported only when pre-configured project template / loaded plugin slots exist.
- `READ_ONLY` — Inspection available; programmatic writes disabled.
- `UNSUPPORTED` — Not exposed cleanly by official vendor API; adapter **must return `DAW_CAPABILITY_UNSUPPORTED`**.

| Capability ID | Description | Required Permission | FL Studio 2025 (Producer Ed.) | REAPER (Validation Target) | Notes & Host Boundaries |
|---|---|---|---|---|---|
| `daw.health.probe` | Detect DAW alive / adapter ready | `observe` | `SUPPORTED` (SysEx ping via `loopMIDI`) | `SUPPORTED` (OSC / ReaScript ping) | Reports `degraded` if `loopMIDI` missing (`FL Studio`). |
| `daw.transport.read` | Read BPM, play/stop/rec, song pos | `observe` | `SUPPORTED` (`transport`, `general`) | `SUPPORTED` (OSC / `GetPlayState`) | Polled into `liveObserved`. |
| `daw.transport.control` | Play, stop, jump bar, tempo (bounded) | `execute` | `SUPPORTED` (`transport` API) | `SUPPORTED` (`CSurf_OnPlay/Stop`) | Tempo change capped inside safety bounds (`20–300 BPM`). |
| `daw.mixer.read` | List tracks, volume, pan, mute, solo, sends | `observe` | `SUPPORTED` (`mixer` API) | `SUPPORTED` (`GetTrack*` API / `.rpp`) | Maps FL `Insert 0..125` to canonical `BusNode`. |
| `daw.mixer.fader_pan_mute` | Adjust gain/pan/mute/solo & send levels | `execute` | `SUPPORTED` (`mixer` API) | `SUPPORTED` (`SetMediaTrackInfo_Value`) | Clamped `<= +3.0 dB` boost per patch; ceiling guard `0 dBFS`. |
| `daw.mixer.routing_write` | Rewire bus send links (`setRouteTo`) | `execute` | `TEMPLATE_SCOPED` (`mixer.setRouteTo`) | `SUPPORTED` (`CreateTrackSend`) | Requires user approval (`routing` mutation). |
| `daw.channel.create_delete` | Add or delete instruments/tracks dynamically | `execute` | **`UNSUPPORTED`** | `SUPPORTED` (`InsertTrackAtIndex`) | **FL 2025 MIDI API lacks track/channel creation; returns manual guidance.** |
| `daw.plugin.inventory_live` | Read loaded plugin names, slot index, bypass | `observe` | `SUPPORTED` (`plugins.getPluginName`) | `SUPPORTED` (`TrackFX_GetFXName`) | Verified per channel / mixer slot. |
| `daw.plugin.load_remove` | Insert VST3/native plugin onto slot or delete | `execute` | **`UNSUPPORTED`** | `SUPPORTED` (`TrackFX_AddByName`) | **FL 2025 cannot instantiate plugins via MIDI Scripting; NO GUI macros.** |
| `daw.plugin.bypass` | Toggle/set active slot mute/bypass | `execute` | `SUPPORTED` (`REC_Plug_Mute`) | `SUPPORTED` (`TrackFX_SetEnabled`) | Reversible via `beforeState`. |
| `daw.plugin.param_read` | Read normalized param `[0..1]` & label | `observe` | `SUPPORTED` (`plugins.getParamValue/getName`) | `SUPPORTED` (`TrackFX_GetParamNormalized`) | Semantic mapping handled by `Plugin Brain`. |
| `daw.plugin.param_write` | Set normalized plugin param `[0..1]` | `execute` | `SUPPORTED` (`plugins.setParamValue`) | `SUPPORTED` (`TrackFX_SetParamNormalized`) | Max step delta clamped; before/after verified via readback. |
| `daw.project.parse_file` | Parse saved project structure on disk | `observe` | `READ_ONLY` (External `.flp` inspector) | `SUPPORTED` (`.rpp` text tree parser) | Binary `.flp` writes are **strictly forbidden** (`UNSUPPORTED`). |
| `daw.project.save` | Save project to disk | `execute` | **`UNSUPPORTED`** *(SysEx UI hint only; no safe silent path API)* | `SUPPORTED` (`Main_SaveProject`) | Keeps `liveObserved` vs `savedProject` cleanly distinguished. |
| `daw.render.master` | Export master audio bounce for Audio Brain | `execute` | `SUPPORTED` (`FL64.exe /R /Ewav` against saved `.flp`) | `SUPPORTED` (`reaper -renderproject`) | Targets saved `.flp`/`.rpp`, outputs WAV to scratch/Vault pipeline. |
| `daw.render.stems` | Export split per-track stems programmatically | `execute` | `TEMPLATE_SCOPED` *(Requires pre-saved FL split-mixer flag)* | `SUPPORTED` (Render matrix / ReaScript) | Returns manual instructions if template isn't split-configured. |
| `daw.midi.trigger_note` | Send preview note/velocity trigger | `execute` | `SUPPORTED` (`channels.midiNoteOn`) | `SUPPORTED` (`StuffMIDIMessage`) | Bounded preview duration (`<= 4s`). |
| `daw.action.rollback` | Revert applied fader/param/bypass patch | `rollback` | `SUPPORTED` *(for API-mutated params/faders)* | `SUPPORTED` (`Undo_DoUndo2` / snapshot restore) | Uses `beforeState` map stored on receipt. |

---

## 3. Workstation Plugin Edition Guardrail (FL Studio 2025 Producer Edition)

`Plugin Brain` encodes static tier flags (`producer` | `signature` | `all-plugins` | `third-party-vst3`):
- **Permitted Stock Native Plugins (Producer Baseline):** `FLEX`, `3x Osc`, `Sytrus` *(wait: note Sytrus IS included in Producer Edition!)*, `Edison`, `Slicex`, `Maximus`, `Fruity Parametric EQ 2`, `Fruity Limiter`, `Fruity Reverb 2`, `Fruity Delay 3`, `Fruity Convolver`, `Vocoder`,Stock Sampler/Audio Clips.
- **Blocked/Warned Stock Plugins on Producer Edition:** `Gross Beat`, `Harmor`, `Newtone`, `DirectWave (Full)`, `Pitch Shifter`, `Vocodex`, `Sakura`, `Morphine`, `PoiZone` -> marked `REQUIRES_HIGHER_EDITION_OR_TRIAL` unless live host probe confirms unlock.
- **Verified Local Third-Party VST3 Candidates (`C:\Program Files\Common Files\VST3`):** `29` installed items (e.g., `FabFilter`, `iZotope`, `oeksound`, `Celemony`, `Antares`, `MasteringTheMix`, `ARCHON.vst3`, `Black Salt Audio`, `Cradle`, `Nuro Audio`) indexed with file path, vendor folder, and scan timestamp for safe recommendation once license/active state is confirmed by host inspection.
