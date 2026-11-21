# XYP3RN OS 3.0 + Universal DAW Brain

A local-first, Obsidian Vault-authoritative six-domain agent operating system (**CORE**, **KNOWLEDGE**, **RESEARCH_INTELLIGENCE**, **RECORDS / X3LIUS Music System**, **TECH**, **GOVERNANCE**) integrated with the **Universal DAW Brain** (`core/daw-brain/`), vendor-isolated **FL Studio 2025** & **Cockos REAPER** adapters (`core/daw-adapters/`), minimal local **SQLite runtime** (`node:sqlite`), `127.0.0.1:8077` **HTTP Gateway**, and the primary **Constellation Operator UI** (`UI-xyp3rn` on `127.0.0.1:3000`).

- **Current Status:** **Phase 25 — `RELEASE CANDIDATE`** (Phases 01 → 25 complete; `89/89` Postgres-free test files / `756/756` tests passing across `officialFolderofXYP3RNOS` and `UI-xyp3rn`).
- **Release Candidate Handover:** [docs/release/PHASE_25_RELEASE_CANDIDATE_HANDOVER.md](docs/release/PHASE_25_RELEASE_CANDIDATE_HANDOVER.md)
- **Phase 24 Acceptance Report:** [docs/acceptance/PHASE_24_ACCEPTANCE_REPORT.md](docs/acceptance/PHASE_24_ACCEPTANCE_REPORT.md)
- **OS2 Parity & DAW Verification Matrix:** [docs/acceptance/OS2_PARITY_AND_DAW_VERIFICATION_MATRIX.md](docs/acceptance/OS2_PARITY_AND_DAW_VERIFICATION_MATRIX.md)
- **Defect Register:** [docs/acceptance/PHASE_24_DEFECT_REGISTER.md](docs/acceptance/PHASE_24_DEFECT_REGISTER.md)
- **Developer & Operations Manual:** [docs/guides/OS3_DEVELOPER_AND_OPERATIONS_MANUAL.md](docs/guides/OS3_DEVELOPER_AND_OPERATIONS_MANUAL.md)
- **Extensibility & DAW Adapter SDK Guide:** [docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md](docs/guides/OS3_EXTENSIBILITY_AND_DAW_SDK_GUIDE.md)

---

## 1. OS 3.0 + DAW Brain Architecture & Phase 01 → 25 Build Status

| Phase | Milestone | Primary Modules & Documentation | Status |
| :---: | :--- | :--- | :---: |
| **01–02** | **Forensic Audit & Architecture Freeze** | [docs/OS3_MASTER_ARCHITECTURE.md](docs/OS3_MASTER_ARCHITECTURE.md), [docs/DAW_BRAIN_ARCHITECTURE.md](docs/DAW_BRAIN_ARCHITECTURE.md), [docs/OS3_MODULE_CONTRACTS.md](docs/OS3_MODULE_CONTRACTS.md), [docs/OS3_API_CONTRACTS.md](docs/OS3_API_CONTRACTS.md) | `[x]` |
| **03–04** | **14-Sector Obsidian Vault Foundation & Production VaultEngine** | `core/vault-engine/` (atomic writes, No-Overwrite Guard, expected-SHA256 CAS, `.vault-revisions/` snapshots & restore, 9-step `VaultPromotionGate` enforcing `F35-D2` human-only approval) · [docs/VAULT_FOUNDATION.md](docs/VAULT_FOUNDATION.md), [docs/VAULT_ENGINE.md](docs/VAULT_ENGINE.md) | `[x]` |
| **05** | **Minimal Local SQLite Runtime (`node:sqlite`)** | `core/sqlite/`, `core/runtime/` (`schemaVersion: 3`, 0 canonical tables in SQLite, nested savepoints, TTL locks, online `VACUUM INTO` backup & auto-quarantine recovery, singleton instance lock, degraded-Vault resilience) · [docs/SQLITE_RUNTIME_STORE.md](docs/SQLITE_RUNTIME_STORE.md) | `[x]` |
| **06** | **Knowledge Engine & Hybrid Context Engine** | `core/knowledge-engine/`, `core/context-engine/` (12-domain Knowledge Graph, FTS5 structural + deterministic semantic index, epistemological classification, generation-invalidated LRU cache, DAW session context assembler) · [docs/KNOWLEDGE_AND_CONTEXT_ENGINE.md](docs/KNOWLEDGE_AND_CONTEXT_ENGINE.md) | `[x]` |
| **07** | **Agent & Tool Registry Migration** | `core/agent-registry/`, `core/tool-registry/` (**52** core `xyp3rn.agent/v3` agents + **12** DAW specialists, **39** core tools + **8** DAW tools, 8 single-class capability matrix, atomic hot-reload) · [docs/AGENT_AND_TOOL_REGISTRY.md](docs/AGENT_AND_TOOL_REGISTRY.md) | `[x]` |
| **08** | **JARVIS Core, DAG Orchestrator, Workflow Engine & Model Gateway** | `core/gateway/os3-jarvis-core.ts`, `core/orchestrator/os3-orchestrator.ts`, `core/workflow-engine/os3-workflow-engine.ts`, `core/llm/os3-model-gateway.ts` (**27** canonical `xyp3rn.workflow/v3` workflows: 7 core + 10 Research + 10 DAW) · [docs/JARVIS_AND_WORKFLOW_ENGINE.md](docs/JARVIS_AND_WORKFLOW_ENGINE.md) | `[x]` |
| **09–10** | **Universal DAW Brain Foundation** | `core/daw-brain/` (vendor-independent `DawCore`, `DawAdapter` SDK, 7-state `DawSessionModel`, `DawVersionManager`, `FakeDawAdapter`) · [docs/daw/DAW_BRAIN_FOUNDATION.md](docs/daw/DAW_BRAIN_FOUNDATION.md) | `[x]` |
| **11** | **FL Studio 2025 Producer Edition Adapter** | `core/daw-adapters/fl-studio-2025/` (7-bit chunked WinMM SysEx + CRC-16 protocol, `device_XYP3RNBrain.py`, read-only `FLhd`/`FLdt` `.flp` inspector verified on 8 real `.flp` files, 155-plugin scanner with Producer Edition exclusion tagging) · [docs/daw/FL_STUDIO_2025_ADAPTER_REPORT.md](docs/daw/FL_STUDIO_2025_ADAPTER_REPORT.md) | `[x]` |
| **12** | **DAW Session Intelligence** | `core/daw-brain/session-intelligence/` (track role classification, signal-flow routing graph, orphan/dead-end bus detection, headroom/clipping risk, live-vs-saved drift, X3LIUS catalog linking) · [docs/daw/DAW_SESSION_INTELLIGENCE.md](docs/daw/DAW_SESSION_INTELLIGENCE.md) | `[x]` |
| **13** | **Plugin Brain** | `core/daw-brain/plugin-brain/` (strict separation of Vault plugin docs vs verified host installation, semantic parameter normalization, 9 workflow recipes, chain ordering/redundancy/edition diagnostics) · [docs/daw/PLUGIN_BRAIN.md](docs/daw/PLUGIN_BRAIN.md) | `[x]` |
| **14** | **Audio Brain (DSP, MIR & Evaluation Fixtures)** | `core/daw-brain/audio-brain/` (read-only PCM16/Float32 WAV decoder with pre/post SHA-256 verification, BS.1770 LUFS, 4x true-peak dBTP, crest factor, FFT spectral bands, stereo correlation, probabilistic MIR tempo/key/chroma/sections, 29-metric `trace.analysis/v1` rubric) · [docs/daw/AUDIO_BRAIN.md](docs/daw/AUDIO_BRAIN.md) | `[x]` |
| **15** | **XYP3RN DAW Agent Team** | `core/daw-brain/agents/` (**12** consolidated single-class specialists: `daw-operator`, `daw-session-analyst`, `daw-routing-specialist`, `daw-mixing-engineer`, `daw-mastering-engineer`, `daw-vocal-engineer`, `daw-plugin-specialist`, `daw-dsp-engineer`, `daw-audio-quality-analyst`, `daw-workflow-planner`, `daw-music-theory-analyst`, `daw-compatibility-analyst`; `analyze`-by-default) · [docs/daw/DAW_AGENT_TEAM.md](docs/daw/DAW_AGENT_TEAM.md) | `[x]` |
| **16** | **DAW Command Gateway + Safe Execution** | `core/daw-brain/daw-command-gateway.ts`, `command-policy.ts`, `dry-run-engine.ts` (11-stage lifecycle, 5 command classes, default-deny allowlist, `[-60, +3.0 dB]` step & `<= 0 dBFS` Master safety clamps, human session leases, `F35-D2` approval, postcondition readback, single-shot rollback) · [docs/daw/DAW_COMMAND_GATEWAY.md](docs/daw/DAW_COMMAND_GATEWAY.md) | `[x]` |
| **17** | **REAPER Adapter + Multi-DAW Validation** | `core/daw-adapters/reaper/` (`ReaperAdapter`, `127.0.0.1` JSON-RPC `HttpReaperBridgeTransport`, `xyp3rn_reaper_bridge.lua`, read-only `.rpp` parser, cross-DAW contract conformance suite across `FakeDawAdapter`, `FlStudio2025Adapter`, `ReaperAdapter`) · [docs/daw/MULTI_DAW_COMPATIBILITY_REPORT.md](docs/daw/MULTI_DAW_COMPATIBILITY_REPORT.md) | `[x]` |
| **18** | **DAW Brain Evaluation Engine + Production Workflows** | `core/daw-brain/evaluation/`, `core/daw-brain/workflows/` (11 evaluation categories / `22/22` benchmark cases at `100.0%` accuracy vs baseline thresholds; 10 canonical DAW workflows) · [docs/daw/DAW_BRAIN_BENCHMARK_BASELINE.md](docs/daw/DAW_BRAIN_BENCHMARK_BASELINE.md) | `[x]` |
| **19** | **Research Intelligence Migration** | `research-intelligence/` (`Os3ResearchEngine`, 10 Research workflows, 6-category DAW Brain research integration, idempotent OS2 export migrator & read-only legacy Markdown scanner) · [docs/research/PHASE_19_RESEARCH_MIGRATION.md](docs/research/PHASE_19_RESEARCH_MIGRATION.md) | `[x]` |
| **20** | **X3LIUS Records + Music System Migration** | `records/` (`Os3RecordsEngine`, 17 music/catalog domains, GS1 UPC, ISO 3901 write-once ISRC, `100.000%` milli-percent rights splits, version-pinned split proposals, `DawMusicCatalogIntegrator` enforcing `authoritative_catalog_record: false`) · [docs/records/PHASE_20_RECORDS_MUSIC_MIGRATION.md](docs/records/PHASE_20_RECORDS_MUSIC_MIGRATION.md) | `[x]` |
| **21–22** | **Complete `UI-xyp3rn` + OS3 & DAW Brain Integration** | `core/gateway/{server,daw-gateway,ui-queries}.ts` + `UI-xyp3rn` (preserves Constellation Galaxy geometry/tokens while exposing all 17 OS3 domains & 12 DAW Brain interface areas at `/map`, `/dashboards`, `/chart`, `/jarvis`, `/daw`) · [docs/ui/PHASE_22_UI_OS3_INTEGRATION.md](docs/ui/PHASE_22_UI_OS3_INTEGRATION.md) | `[x]` |
| **23** | **OS3 + DAW Brain Governance & Security Hardening** | 17 security domains audited & hardened (`127.0.0.1` binding, CORS allowlist, timing-safe Bearer auth, `F35-D2`, Windows ADS/device/symlink escape blocks, prototype-pollution JSON sanitizer, single-use approval replay lock, secret & audio buffer log redaction) · [docs/security/PHASE_23_SECURITY_ASSESSMENT.md](docs/security/PHASE_23_SECURITY_ASSESSMENT.md) | `[x]` |
| **24–25** | **Complete Acceptance Testing & Release Candidate** | All 17 test layers, OS3 & DAW E2E scenarios, all 10 failure modes, startup preflight & singleton lock, backup/restore, and complete operational documentation · [docs/release/PHASE_25_RELEASE_CANDIDATE_HANDOVER.md](docs/release/PHASE_25_RELEASE_CANDIDATE_HANDOVER.md) | `[x]` |

---

## 2. Quick Start (OS 3.0 Local-First Mode — Zero Postgres Required)

Requires **Node.js `>= 22`** (uses built-in `node:sqlite`) and **pnpm** (`pnpm.cmd` on Windows PowerShell).

```powershell
# 1. Install dependencies
pnpm.cmd install

# 2. Provision, scan, and validate the canonical Obsidian Vault (configured via OBSIDIAN_VAULT_PATH in .env.local)
pnpm.cmd vault:os3 provision
pnpm.cmd vault:os3 scan
pnpm.cmd vault:os3 validate

# 3. Run typecheck and the complete Postgres-free OS3 + DAW Brain test suite (37 test files / 167 tests)
pnpm.cmd typecheck
pnpm.cmd test:os3

# 4. Run the DAW Brain focused test suite (10 test directories)
pnpm.cmd test:daw

# 5. Launch the complete local stack (Vault scan + OS3 Gateway on http://127.0.0.1:8077 + UI-xyp3rn on http://127.0.0.1:3000)
pnpm.cmd start:os3
```

---

## 3. Legacy OS 2.0 Reference Commands & Historical Build Sequence

> **Note:** Legacy OS 2.0 PostgreSQL migrations (`supabase/migrations/`, 56 `.sql` files) and `core/db/` remain preserved on disk (`pnpm.cmd start:legacy-os2`) until explicit Owner sign-off for destructive SQL retirement.

- Legacy architecture and invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Agent classes and the capability matrix: [docs/AGENT_CLASSES.md](docs/AGENT_CLASSES.md)
- Naming: [docs/NAMING.md](docs/NAMING.md)
- Agent file template: [agents/_template.agent.md](agents/_template.agent.md)
- Phase handoffs: [docs/handoffs/](docs/handoffs/)
- Approved logo: [docs/BRAND.md](docs/BRAND.md)
- Schema and access model: [docs/SCHEMA.md](docs/SCHEMA.md)

### Legacy OS 2.0 CLI Commands (Require Local PostgreSQL `:5432`)

```sh
pnpm install
pnpm db:setup    # local Postgres 16 + pgvector + emulated Supabase roles (Debian/Ubuntu; idempotent)
pnpm db:up       # apply migrations
pnpm ingest --file XYP3RN_Agentic_OS_Build_Sequence.pdf --origin first_party
pnpm embed       # gte-small embeddings (model downloads to .local-models/ on first use)
pnpm context "your question"
pnpm agents:validate
pnpm dispatch health-check '{"ping":"xyp"}'
pnpm route "your request"
pnpm ask "your request"
pnpm research <cmd> '<json>'
pnpm gate run <candidateId>
pnpm gate queue
pnpm gate decide <approvalId> approve|reject "<approver>" "<reason>"
XYP_TRACE_TOKEN=<16+ chars> pnpm trace:serve
pnpm trace:schemas
pnpm test        # full monorepo vitest including legacy Postgres throwaway-DB suites
pnpm typecheck   # tsc --noEmit
```

### Historical Artist OS Sequence (AOS-00 → AOS-04)

- [x] AOS-00: Baseline ([baseline](docs/artist-os/AOS-00-baseline.md), [handoff](docs/handoffs/AOS-00.md)).
- [x] AOS-01: Creative Vault + song schema ([design](docs/artist-os/AOS-01-design.md), [proof](docs/proofs/AOS-01-vault.txt), [handoff](docs/handoffs/AOS-01.md)).
- [x] AOS-02: Command Center + catalog ([design](docs/artist-os/AOS-02-design.md), [proof](docs/proofs/AOS-02-command-center.txt), [handoff](docs/handoffs/AOS-02.md)).
- [x] AOS-03: Studio mode and Suno-ready workflows ([design](docs/artist-os/AOS-03-design.md), [proof](docs/proofs/AOS-03-studio.txt), [handoff](docs/handoffs/AOS-03.md)).
- [x] AOS-04 (Plan A, Plan B Mercury shell, Plan C1 Graph & File Index): Research mode ([design](docs/artist-os/AOS-04-design.md), [plan](docs/artist-os/AOS-04-plan.md), [handoff](docs/handoffs/AOS-04.md)).
- [x] Jarvis Prompt 01 & Jarvis Core ([map](docs/artist-os/JARVIS-00-map.md), [roadmap](docs/JARVIS-ROADMAP.md)).
