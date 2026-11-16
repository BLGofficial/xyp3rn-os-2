# XYP3RN OS 3.0 + DAW Brain — Architecture Decision Records (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Scope:** Preserves existing [ADR-0001 through ADR-0005](os3/architecture/adr/ADR-0001-local-and-obsidian-first.md) and freezes **ADR-0006 through ADR-0011** covering OS3 completion & DAW Brain architecture.

---

## Preserved Baseline Decisions (`VERIFIED` in `docs/os3/architecture/adr/`)

- **ADR-0001 (`OS3-D1`):** Local-first Node.js execution + Obsidian Vault as canonical store (no duplicate SQL canonical store).
- **ADR-0002 (`OS3-D2`):** Minimal local WAL-mode `node:sqlite` (`core/sqlite`) for transient runtime state + rebuildable derived index.
- **ADR-0003 (`OS3-D3`):** Strict decoupling between functional domains (`CORE`..`GOVERNANCE`) and physical Vault sectors (`01_CORE`..`06_GOVERNANCE`, `09_X3LIUS_MUSIC`, etc.).
- **ADR-0004 (`OS3-D4`):** `VaultEngine` as sole file authority + human-gated `PromotionGate` (`F35 D2`).
- **ADR-0005 (`OS3-D5`):** `UI-xyp3rn` preservation on `127.0.0.1:8077` local HTTP Gateway with deterministic offline fallbacks.

---

## ADR-0006 (`DAW-D1`): Strict Separation of Vendor-Agnostic DAW Core & Adapters

- **Status:** Proposed (Phase 02 Freeze — Pending Owner Approval)
- **Context:** FL Studio 2025 uses a sandboxed Python MIDI API with SysEx feedback and binary `.flp` saves, whereas REAPER uses `.rpp` text files, ReaScript, and OSC/HTTP extensions. Coupling `DAW Core` to FL Studio concepts (`Channel Rack`, `Pattern`, `Mixer Insert 1..125`) would make multi-DAW portability impossible.
- **Decision:**
  1. `core/daw-brain/` exposes purely DAW-neutral entities (`ProjectSnapshot`, `TrackNode`, `BusRoute`, `PluginSlot`, `CanonicalParamTarget`, `DawCommand`).
  2. Vendor code resides solely in `adapters/fl-studio/` and `adapters/reaper/`, implementing `DawAdapter`.
  3. Every adapter must publish an explicit `DawAdapterCapabilityManifest`. Any capability marked `unsupported` must return `DAW_CAPABILITY_UNSUPPORTED` rather than simulating success or invoking fragile UI keystroke macros.
- **Consequences:** Cross-DAW workflows (including Audio Brain diagnostics and Mix Evaluation) remain 100% portable. Workflows requiring dynamic plugin loading automatically pause and instruct the human operator on hosts like FL Studio 2025 where `plugin.instantiate` is `unsupported`.

---

## ADR-0007 (`DAW-D2`): Five-Tier DAW Session State Model

- **Status:** Proposed (Phase 02 Freeze — Pending Owner Approval)
- **Context:** In live DAW work, what exists in RAM (unsaved fader tweaks inside FL Studio) frequently differs from the `.flp` saved on disk, AI-proposed patches, or cached snapshots. Conflating them causes silent overwrite bugs and false undo states.
- **Decision:** Every DAW session managed by `DAW Core` tracks five separate structures:
  1. `liveObserved`: Read-only snapshot polled from running host memory.
  2. `cached`: Latest TTL-stamped `liveObserved` snapshot stored in SQLite for offline inspection.
  3. `savedProject`: Read-only hash-verified representation parsed from `.flp` / `.rpp` on disk.
  4. `proposedModifications`: Reviewed/unapplied patch plans (`DawCommand[]`) queued for validation/approval.
  5. `appliedModifications`: Append-only execution receipts from `DAW Command Gateway`, explicitly marked `savedToProjectFile: false` until `savedProject` hash updates cleanly.
- **Consequences:** Operators always know whether an AI mix adjustment exists only in volatile DAW RAM or is saved safely on disk.

---

## ADR-0008 (`DAW-D3`): FL Studio 2025 Scoped Bridge via Loopback MIDI + SysEx + Offline Inspection

- **Status:** Proposed (Phase 02 Freeze — **Requires Owner Approval for External `loopMIDI` Prerequisite**)
- **Context:** Forensic inspection (`FL_STUDIO_INTEGRATION_FEASIBILITY.md`) verified that FL Studio 2025's embedded Python MIDI controller runtime blocks `socket`, `http`, `subprocess`, and arbitrary filesystem writes, and lacks plugin insert/delete APIs.
- **Decision:**
  1. **Live Control Path:** An embedded FL Python MIDI script (`device_XYP3RNBrain.py` installed into FL Hardware Scripts) communicates with an external local Node/Python bridge service over a **Windows Virtual MIDI loopback port (`loopMIDI`)** using versioned, checksummed 7-bit SysEx messages.
  2. **Project File Path:** `.flp` project inspection runs **strictly read-only** via an external offline reader; binary `.flp` rewriting by scripts is forbidden.
  3. **Render Verification Path:** Headless master audio bounces use official `FL64.exe /R /Ewav` CLI against saved `.flp` checkpoints. Multi-stem exports rely on user-configured export templates or manual render drop folders rather than keystroke macros.
  4. **Edition Boundary:** All FL templates and Plugin Brain suggestions filter out non-Producer Image-Line plugins (`Harmor`, `Gross Beat`, `Newtone`, `Vocodex`, `DirectWave Full`) unless verified unlocked by runtime plugin probe.
- **Consequences:** 100% compliant with official FL Studio APIs with zero brittle UI scripting or `.flp` corruption hazards. Requires operator confirmation to install/configure `loopMIDI` before live FL Studio testing.

---

## ADR-0009 (`DAW-D4`): Default Read-Only Permission Tier & 7-Level DAW Capability Gate

- **Status:** Proposed (Phase 02 Freeze — Pending Owner Approval)
- **Context:** Unrestricted write access to live audio gains, limiters, or plugin controls risks destructive project edits and dangerous playback volume spikes (`Rule 9`).
- **Decision:**
  1. All DAW integrations boot in default **`observe`** (strict read-only) mode.
  2. Every DAW action classifies under 7 progressive capability permissions: `observe`, `analyze`, `propose`, `prepare`, `execute`, `approve`, `rollback`.
  3. Mutating live parameters requires: (a) active operator session lease allowing `execute`, (b) pre-execution snapshot capture + bounded delta clamp (`maxGainStepDb <= 3.0`, `maxCeilingDbtp <= 0.0`), (c) human confirmation or prior approved policy rule in SQLite `pending_approvals`.
- **Consequences:** Autonomous agents can continuously inspect, analyze audio, and prepare safe patches (`observe` / `analyze` / `propose` / `prepare`), while live mutating actuation remains tightly gated by operator safety controls.

---

## ADR-0010 (`OS3-D6`): Unification of `tech/trace` Audio Analysis into OS3 Audio Brain (Zero Postgres)

- **Status:** Proposed (Phase 02 Freeze — Pending Owner Approval)
- **Context:** Today `tech/trace/server.ts` (`:8787`) persists `trace.analysis/v1` rows to PostgreSQL (`core/db`), whereas `core/gateway/audio-reverse-engineer.ts` and `records/os3-records-engine.ts` already use OS3 SQLite + Obsidian Vault.
- **Decision:**
  1. Preserve `trace.analysis/v1` and `trace.report/v1` JSON Schemas verbatim (`tech/trace/schemas.ts`).
  2. Implement `Audio Brain` (`core/daw-brain/audio-brain/`) on OS3 `VaultEngine + SqliteRuntimeDb`, unifying TRACE loudness/tonal/stereo evaluation (`x3lius-mix-master` + `mix-rubric.yaml`) with acoustic DSP extraction (`audio-reverse-engineer.ts`), ingesting both local WAV bounces and future TRACE VST3 HTTP posts on `127.0.0.1`.
  3. Leave legacy `tech/trace/server.ts` Postgres path intact strictly for rollback compatibility until OS3 Audio Brain passes parity tests.
- **Consequences:** Eliminates the last audio/DSP dependency on PostgreSQL in the OS3 critical path while preserving full C++ VST3/AU contract compatibility.

---

## ADR-0011 (`OS3-D7`): Workspace Isolation, CI Test Partitioning & Transactional Records Retention

- **Status:** Proposed (Phase 02 Freeze — **Pending Owner Approval**)
- **Context:** Forensic audit revealed: (1) session workspace path points to a stale `E:\FileHistory` folder instead of `officialFolderofXYP3RNOS`, (2) Desktop root `.git` wraps the Obsidian Vault, (3) root `pnpm test` fails locally without Postgres `:5432`, and (4) `legacy records/ops/` modules remain alongside `records/os3-records-engine.ts`.
- **Decision:**
  1. Canonical development checkout is pinned strictly to `C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS` + `C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn`. Sibling dirty worktrees (`xyp3rn-os-2`, `xyp3rn-os-2-aos04`) and `E:\FileHistory` must never receive implementation edits.
  2. Preserve legacy `core/db/`, `supabase/migrations/`, and transactional Records scripts until full OS3 + DAW workflow equivalence is validated end-to-end.
  3. Separate Postgres-free test scripts (`test:os3`, `test:daw`) cleanly from `test:legacy-sql` in Phase 03 rather than leaving `pnpm test` failing locally.
- **Consequences:** Zero risk of editing backup snapshots or prematurely deleting legacy transactional safeguards before parity sign-off.

---

## Summary of Decisions Requiring Explicit Owner Approval Before Phase 03+

| Decision ID | Decision Summary | Impact if Deferred / Rejected |
|---|---|---|
| **ADR-0006** | Lock `DawCore` strict vendor isolation (`UNSUPPORTED` errors instead of GUI macros). | Without strict refusal of GUI macros, FL Studio missing features might drift into brittle keyboard hacks violating Rule 9. |
| **ADR-0007** | Lock 5-tier DAW Session State data separation + disallow external `.flp` binary mutation. | Conflating live vs saved state leads to lost edits; external `.flp` writing risks corrupting projects. |
| **ADR-0008** | Approve virtual MIDI loopback (`loopMIDI`) + `device_XYP3RNBrain.py` SysEx bridge for FL Studio 2025 Producer Edition. | Live bidirectional FL Studio control cannot run without `loopMIDI` (offline render/inspect fallback only). |
| **ADR-0009** | Approve default-`observe` read-only security posture, audio headroom clamps, and human approval gate for DAW mutations. | Determines friction vs autonomy balance when agents apply mix tweaks live. |
| **ADR-0010** | Approve consolidating Audio Brain / TRACE intake onto OS3 SQLite + Vault without Postgres `:5432`. | Leaving TRACE coupled to Postgres blocks unified offline OS3 DAW workflows. |
| **ADR-0011** | Approve partitioning `test:os3`/`test:daw` away from legacy Postgres CI tests while retaining `core/db` rollback layer. | Keeps CI/local verification unambiguous before full SQL retirement. |
