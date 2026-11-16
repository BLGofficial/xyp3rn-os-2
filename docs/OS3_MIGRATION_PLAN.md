# XYP3RN OS 3.0 + DAW Brain — Staged Migration & Implementation Plan (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Baseline:** [MIGRATION_PLAN.md](os3/architecture/MIGRATION_PLAN.md) · [OS2_TO_OS3_GAP_ANALYSIS.md](audit/OS2_TO_OS3_GAP_ANALYSIS.md)  
**Rule:** Work one phase at a time with explicit acceptance gates and zero deletion of legacy SQL before parity approval.

---

## 1. Master Migration & DAW Brain Roadmap

| Phase | Title | Primary Scope | Prerequisites & Rollback Point |
|---|---|---|---|
| **Phase 01** | **OS2 + UI + DAW Forensic Audit** *(DONE)* | Read-only baseline, dependency graph, FL Studio 2025 Producer boundaries, risk register. | Zero code edits (`docs/audit/*`). |
| **Phase 02** | **OS3 + DAW Brain Architecture Freeze** *(CURRENT)* | Complete module contracts, 5-tier session state, security/capability model, APIs, ADRs, sequence diagrams. | Await Owner Approval of ADR-0006..0011. |
| **Phase 03** | **Workspace Hygiene, OS3 Audio/TRACE Consolidation & DAW Core Skeleton** | 1) Split `test:os3`/`test:daw` from Postgres CI suites cleanly.<br>2) Add OS3 Event Bus (`core/runtime/event-bus.ts`) & SQLite DAW runtime schema migrations (`daw_sessions`, `daw_session_leases`, `daw_command_journal`, `daw_audio_analyses`).<br>3) Unify `Audio Brain` (`tech/trace` + `mix-rubric` + `audio-reverse-engineer`) on SQLite+Vault without Postgres.<br>4) Implement vendor-agnostic `DAW Core`, `DAW Adapter SDK`, `Capability Registry`, `Session Model`, and `Command Gateway` safety clamps + SDK conformance tests. | Rollback: reset feature branch or restore `.local-db` SQLite snapshot (`core/db/` & legacy `tech/trace/server.ts` stay untouched). |
| **Phase 04** | **Plugin Brain + Read-Only `.flp`/`.rpp` Parsers & REAPER Validation Adapter** | 1) Implement read-only VST3/VST2 scanner + FL 2025 Producer Edition filter + semantic parameter profiles.<br>2) Implement read-only `.flp` session topology parser + REAPER `.rpp`/OSC validation adapter proving zero FL-coupling in `DAW Core`.<br>3) Enforce binary `.flp` write prohibition + conformance suite across both mock FL & REAPER profiles. | Requires Owner approval of Phase 03 gate. Rollback: isolate `core/daw-brain/plugin-brain` & `adapters/reaper`. |
| **Phase 05** | **FL Studio 2025 Producer Edition Adapter (Live Loopback Bridge + Headless Render)** | 1) Build `device_XYP3RNBrain.py` controller script (`transport`, `mixer`, `plugins`, `REC_Plug_Mute`, SysEx CRC-16 frame protocol).<br>2) Build local Node/Python virtual MIDI loopback bridge (`loopMIDI`) + `FL64.exe /R /Ewav` master render runner.<br>3) Run live smoke verification against `FL Studio 2025 (25.1.6.4997)` once operator enables `loopMIDI`. | Requires `loopMIDI` driver installed by operator (`ADR-0008`). Rollback: remove hardware script folder; zero changes inside FL install dir. |
| **Phase 06** | **Production Intelligence, Evaluation Engine, DAW Agents & Workflows** | 1) Create approved DAW agent definitions in `04_AGENTS/` (`daw-session-observer`, `daw-audio-analyst`, `daw-mix-planner`, `daw-execution-operator`).<br>2) Implement `Production Intelligence`, `Evaluation Engine`, and 4 YAML workflows in `05_WORKFLOWS/DEFINITIONS/`.<br>3) Wire DAW tool capabilities strictly in `ToolRegistry` + `pending_approvals`. | Requires Owner approval of DAW agent roster (`ADR-0009`). |
| **Phase 07** | **Gateway `/api/daw/*` Routes & `UI-xyp3rn` Operator Surface Integration** | 1) Expose `/api/daw/*`, `/api/plugins/*`, `/api/audio-brain/*`, SSE `/api/events/stream` on `127.0.0.1:8077`.<br>2) Build DAW Brain Control, 5-tier Session Inspector, Plugin Compatibility Matrix & Live Audio Brain views inside `UI-xyp3rn` (`lib/daw-adapter.ts`) + offline seed fallback on `/chart`. | Preserves Constellation Map & existing routes (`ui` regression tests must pass 100%). |
| **Phase 08** | **Final End-to-End Parity, Security Adversarial Audit & Legacy CLI/SQL Cleanup Sign-Off** | Verify OS2->OS3 CLI/TRACE/Records equivalence + DAW fail-safe tests (host disconnect, clamp violation, unsafe fader spike, unsaved drift warning, rollback) before retiring redundant Postgres scripts. | Legacy SQL retained read-only until explicit final Owner approval. |

---

## 2. Guardrails Governing Every Migration Step

1. **Zero Simultaneous Dual-Stack Contamination:** New Phase 03+ modules under `core/daw-brain/`, `adapters/`, `records/os3-records-engine.ts`, and `core/gateway/` must have **zero imports** of `postgres`, `core/db/`, or `apps/web/server/`. Verified statically in tests.
2. **Legacy CLI Isolation Strategy (`Phase 03`):**
   - Preserve existing OS2 CLI scripts (`pnpm db:up`, `pnpm start:legacy-os2`, legacy `core/db/*`) intact.
   - Add dedicated `pnpm test:os3` and `pnpm test:daw` scripts so OS3 developers verify the entire Vault+SQLite+DAW system in `< 30s` with Postgres stopped, without altering `ci.yml` Postgres test coverage prematurely.
3. **Records Parity Gate (`Master Rule`):** Transactional Records code (`records/ops/`) & SQL migrations (`supabase/migrations/`) remain preserved on disk alongside `records/os3-records-engine.ts` through all DAW Brain phases until comprehensive Records + DAW production session parity is approved.
4. **No Fake Implementation for Missing REAPER Binary:** If REAPER remains uninstalled on the host during Phase 04, live host binary checks are explicitly marked `UNVERIFIED (host binary absent)` while `.rpp` parser, OSC codec, and `DawAdapter` conformance tests run 100% deterministically against curated test fixtures.
