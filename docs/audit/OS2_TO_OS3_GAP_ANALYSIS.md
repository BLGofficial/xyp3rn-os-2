# OS2-to-OS3 & DAW Brain Gap Analysis

**Audit Date:** 2026-11-16  
**Scope:** Reconciles the current verified state of `officialFolderofXYP3RNOS` + `UI-xyp3rn` + Obsidian Vault against all requirements in the Master Engineering Context.

---

## 1. Executive Summary

OS3 Phases 1–14 already converted core kernel paths (`VaultEngine`, `core/sqlite`, `core/gateway`, `Os3RecordsEngine`, `Os3ResearchEngine`, and `UI-xyp3rn`). However, **five major architectural gaps** remain between the current repositories and a clean, production-grade **XYP3RN OS 3.0 + DAW Brain** system (`VERIFIED`).

---

## 2. Subsystem Gap Matrix

| Domain | Current Verified State | Target Master Engineering State | Gap / Action Required |
|---|---|---|---|
| **Workspace & Repo Hygiene** | IDE metadata points to stale `E:\FileHistory` backup; `xyp3rn-os-2` & `xyp3rn-os-2-aos04` dirty worktrees; Desktop root `.git` wraps Vault; loose files in root (`0.26.0`, prototypes). | Single unambiguous OS3 checkout (`officialFolderofXYP3RNOS`), clean worktrees, Vault isolated from Desktop `.git`, clean root scripts. | **Gap:** High confusion risk. Pin workspace to `officialFolderofXYP3RNOS` + `UI-xyp3rn`, prune stale worktree metadata, isolate legacy root files. |
| **OS2 -> OS3 Dual-Stack Split** | 96 files (CLIs, `tech/trace/server.ts`, legacy `knowledge/promotion-gate`, `knowledge/obsidian/watcher`, `records/ops/*-tools.ts`, `apps/web/server/*`) still import `core/db` / `postgres`. | Clean OS3 single authority: `VaultEngine` + `node:sqlite`, preserving legacy transactional Records only until parity CLI/tool deprecation is approved. | **Gap:** Running legacy CLIs (`pnpm ask`, `gate`, `trace:serve`, `vault`, `evaluate`) fails without Postgres `:5432`. Needs explicit OS3 CLI routing + TRACE SQLite migration. |
| **CI & Test Separation** | `.github/workflows/ci.yml` spins up Postgres 16 `:5432` and runs `vitest run` across ALL `**/*.test.ts`; bare `pnpm.cmd test` fails locally when Postgres is off. | Clear separation: deterministic `test:os3` & `test:daw` scripts running 100% Postgres-free alongside optional `test:legacy-sql`. | **Gap:** Unqualified `pnpm test` fails locally without Postgres (`VERIFIED` in `KNOWN_LIMITATIONS.md`). |
| **DAW Brain Core** | **0% implemented.** No `daw-brain` package/module, capability contract, session model, command validator, or audit gate exists. | DAW-independent `core/daw-brain/` orchestrating intents, capability checks, state snapshots, undoable patches, and approval gates across adapters. | **Gap:** Net-new subsystem required from architecture design upward. |
| **Plugin Brain** | **0% implemented.** Host holds 29 VST3s + FL 2025 native plugins, but no scanner, edition-compatibility table, or parameter semantic map exists. | `Plugin Brain` subsystem indexing installed VST3/VST2/CLAP + FL 2025 Producer Edition stock plugins, parameter normalization maps, and chain presets in Vault. | **Gap:** Net-new subsystem required; must cross-check Producer Edition boundaries so agents never emit unavailable plugins. |
| **Audio Brain & TRACE Bridge** | Two disconnected pieces exist: `UI-xyp3rn` + `gateway/audio-reverse-engineer.ts` (DSP extraction to Suno prompts) AND Postgres-bound `tech/trace/` (`trace.analysis/v1` + `mix-rubric.yaml`). | Unified OS3 `Audio Brain` built on `trace.analysis/v1` + DSP reverse-engineer + Vault rubrics, feeding actionable mix/gain/EQ moves into DAW Brain without Postgres. | **Gap:** Rebind `tech/trace/` off Postgres into SQLite + VaultEngine and unify telemetry schemas with `audio-reverse-engineer.ts`. |
| **FL Studio 2025 Adapter** | Only LLM output shape (`PRODUCTION_SCHEMA.flStudio`) exists; zero MIDI script, `loopMIDI` IPC, `.flp` reader, or `/R` render runner. | Capability-bounded FL Studio 2025 adapter: SysEx/MIDI bridge + `FL64.exe /R` bounce verifier + read-only `.flp` parser + standard template contract. | **Gap:** Net-new subsystem; prerequisite virtual MIDI loopback (`loopMIDI`) absent on host (`VERIFIED`). |
| **REAPER Validation Adapter** | **0% implemented**, and `reaper.exe` / `reaper.ini` is **not installed** on host (`UNVERIFIED`). | Cross-DAW contract validation via REAPER adapter (`ReaScript` / OSC / `.rpp` text parser) proving DAW Brain core is non-FL-coupled. | **Gap:** Net-new subsystem; needs interface contract + deterministic `.rpp`/OSC mocks locally until REAPER binary is installed. |
| **`UI-xyp3rn` Integration** | Clean OS3 shell (`Map`, `Dashboards`, `Chart`, `Jarvis` + 3D orb + Audio extractor). `/chart` lacks offline seed fallback; no DAW Brain UI surface; Next 14 vs `apps/web` Next 15 split. | Preserve Constellation UI; add DAW Brain Control / Plugin Catalog / Audio Analysis telemetry panel on `UI-xyp3rn` over `127.0.0.1:8077`. | **Gap:** Needs Gateway `/api/daw/*` contracts + UI panel + `/chart` offline fallback + `localhost` vs `127.0.0.1` consistency cleanup. |
| **Master Documentation Suite** | Rich `docs/os3/*` docs exist, **but none** of the 11 required `docs/OS3_*` / `docs/DAW_BRAIN_*` files exist cleanly yet. | Complete maintained set of 11 master OS3 + DAW Brain specs matching repository conventions. | **Gap:** Needs unified documentation mapping in Phase 01/02 without duplicating contradictory sources of truth. |

---

## 3. Legacy Records Capabilities Parity Check

- **Current Status (`VERIFIED`):** `records/os3-records-engine.ts` (1,336 lines) and `tests/os3-phase10-records/records-music-migration.test.ts` implement X3LIUS 13 domains, GS1 UPC check digits, ISO 3901 ISRC write-once checks, and 100.000% rights splits in OS3 Vault + SQLite. Meanwhile, legacy Postgres modules in `records/ops/` and `supabase/migrations/` remain intact on disk (`apps/web/` + `records/*-tools.ts`).
- **Gap Rule Compliance:** Legacy SQL structures and migration scripts **must remain preserved** until full Records + DAW session/stem tracking parity is also signed off under OS3 Phases (`Rule 10` & Frozen Decision #17).

---

## 4. Prioritized Next-Phase Recommendations (`PROPOSED`)

1. **Normalize Workspace & Docs Naming:** Confirm canonical paths (`officialFolderofXYP3RNOS`, `UI-xyp3rn`, `docs/os3/` vs `docs/` master index) and test script separation (`test:os3`) before writing code.
2. **Design DAW Brain Core Contracts First (DAW-Agnostic):** Define capability tokens (`daw.read`, `daw.transport`, `daw.mixer.write`, `daw.plugin.param`, `daw.render`), bounded state snapshots, dry-run validation, and human-approval gates reusing `core/tool-registry/capabilities.ts`.
3. **Unify Audio Brain on OS3 (`VaultEngine + SQLite`):** Bridge `tech/trace/analysis.ts` (`trace.analysis/v1`), `records/x3lius/mix-master/`, and `audio-reverse-engineer.ts` natively without Postgres.
4. **Build FL Studio 2025 Adapter Behind Explicit Capability Checks + Virtual MIDI Bridge** + **REAPER `.rpp`/OSC Adapter** as the architectural portability test.
