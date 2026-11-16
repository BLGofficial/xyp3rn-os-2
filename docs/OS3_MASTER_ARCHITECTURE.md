# XYP3RN OS 3.0 — Master System Architecture (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze (Design Only — Pending Owner Approval)  
**Baseline:** [OS2_FORENSIC_AUDIT.md](audit/OS2_FORENSIC_AUDIT.md) · [SYSTEM_ARCHITECTURE.md](os3/architecture/SYSTEM_ARCHITECTURE.md)  
**Primary Interface:** `UI-xyp3rn` (`127.0.0.1:3000`)  
**Canonical Store:** Obsidian Vault (`OBSIDIAN_VAULT_PATH`, external Markdown/YAML + `.vault/` blobs)  
**Runtime Store:** Embedded WAL `node:sqlite` (`.local-db/xyp3rn-os3.sqlite`)

---

## 1. Architectural Mandate & Design Invariants

1. **Local-First & Zero Required Cloud DB:** All OS3 subsystems execute locally on Node.js >=22 + strict TypeScript (`erasableSyntaxOnly: true`, `exactOptionalPropertyTypes: true`). No Supabase or PostgreSQL server is required for OS3 + DAW Brain runtime execution.
2. **Single File Authority:** Every read, write, append, revision, and canonical promotion touching the Obsidian Vault passes through `VaultEngine`. Direct filesystem access by agents is prohibited.
3. **Obsidian Canonical Truth vs Disposable Indexes:** Canonical knowledge, agent definitions, workflows, documentation, production blueprints, and approved creative assets live strictly as human-readable Markdown/YAML in Obsidian. SQLite tables hold runtime operational telemetry and rebuildable structural indexes only.
4. **Universal Core / Vendor Adapter Separation:** `DAW Core` knows zero vendor specifics (`FL Studio`, `REAPER`); vendor implementations live solely behind `DawAdapter` capability contracts.
5. **Default Read-Only Mode & Human Governance:** All OS3 canonical mutations and high-impact DAW execution steps default to read-only observation/analysis until explicitly authorized and human-approved (`F35 D2`).

---

## 2. The 17 Frozen OS3 Subsystems

| # | Subsystem | Target Module Boundary | Primary Responsibility |
|---|---|---|---|
| 1 | **Runtime** | `core/runtime/` | Process bootstrap, env loading (`.env.local`), graceful shutdown, lock/job crash recovery (`recoverStaleLocks`, `recoverStaleRunningJobs`), service lifecycle coordination. |
| 2 | **Vault Engine** | `core/vault-engine/` | Sole canonical filesystem boundary: `path-guard` traversal/junction checks, `writeFileAtomic`, No-Overwrite Guard (`Note (2).md`), SHA-256 Compare-and-Swap (`expectedSha256`), `.vault-revisions/`, and incremental Vault scanner. |
| 3 | **Knowledge Engine** | `knowledge/`, `core/context-engine/structural-index.ts`, `semantic-index.ts` | Parses Obsidian Markdown (`YAML` frontmatter + `[[wikilinks]]`), maintains derived `index_state` + optional 384-dim `gte-small` embeddings, runs deterministic ingestion/normalization (`first_party` vs `research`), and rebuilds indexes cleanly from disk. |
| 4 | **Context Engine** | `core/context-engine/os3-context-engine.ts` | Assembles provenance-tagged, token-budgeted context bundles across `knowledge`, `vault`, `agents`, and `daw-knowledge` scopes using hybrid structural + graph + semantic scoring and LRU generation caching. |
| 5 | **Agent Registry** | `core/agent-registry/os3-agent-registry.ts` | Discovers, validates (`xyp3rn.agent/v3`), and hot-swaps atomic snapshots of `.md`/`.agent.md` definitions from Vault `04_AGENTS/` (52 migrated + approved DAW Brain agents), enforcing single `class`, `domain`, `capabilities`, `tools`, `inputSchema`, `outputSchema`. |
| 6 | **Tool Registry** | `core/tool-registry/capabilities.ts`, `os3-tool-registry.ts` | Maintains registered execution tools, maps every tool 1:1 to a `Capability`, validates inputs/outputs via JSON Schema, enforces deny-by-default `authorize(agentClass, toolName)`, timeouts, retries, and tool audit logs. |
| 7 | **Workflow Engine** | `core/workflow-engine/os3-workflow-engine.ts`, `spec.ts` | Compiles `*.workflow.yaml` from `05_WORKFLOWS/DEFINITIONS/`, checks agent existence, rejects cycles/prototype pollution, resolves `$input` / `$steps.<id>.output` bindings, executes DAG steps, records `spec_sha256`. |
| 8 | **Task Orchestrator** | `core/orchestrator/os3-orchestrator.ts` | Executes single-agent dispatches and queued/scheduled multi-step tasks (`jobs`), acquires `locks` TTL leases, isolates failures cleanly, records per-step `agent_runs`, and supports bounded execution cancellation. |
| 9 | **JARVIS Core** | `core/gateway/os3-jarvis-core.ts`, `jarvis-runtime.ts`, `jarvis-inspector.ts` | Single front door for UI, HTTP, CLI, and voice directives. Performs intent classification, `@path`/`@agent` context resolution, gated Whole-OS/Vault inspection (`readAccepted`), and non-mutating change proposal staging (`askBeforeChange`). |
| 10 | **Research Intelligence** | `research-intelligence/os3-research-engine.ts` | Coordinates research programs over operator-approved sources, verifies verbatim evidence quotes (`quote` in `source_text`), tracks contradictions without overwriting prior findings, scores A/B experiments, and writes candidate findings into `03_RESEARCH_INTELLIGENCE/`. |
| 11 | **Records (+ Parity Layer)** | `records/os3-records-engine.ts`, legacy `records/ops/` fallback | Manages X3LIUS creative domains + catalog (`GS1 UPC`, `ISO 3901 ISRC` write-once, `100.000%` rights splits, release state machine) + `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/`. Transitional SQL parity hooks remain frozen until full CLI/transaction parity sign-off. |
| 12 | **Promotion Gate** | `core/vault-engine/promotion-gate.ts` | The **sole writer** to canonical Vault prefixes (`CANONICAL_PATH_PREFIXES`). Validates evidence/provenance/confidence, blocks agent self-approval (`AGENT_OR_SYSTEM_ACTOR_RE`), enforces human `approved` row in SQLite `pending_approvals`, and seals decision triggers. |
| 13 | **Runtime Store** | `core/sqlite/` | WAL-mode `node:sqlite` storing strictly runtime operational tables (`schema_meta`, `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, derived `index_state`/`index_meta`, plus frozen Phase 02 DAW runtime state/audit tables). |
| 14 | **Event Bus** | `core/runtime/event-bus.ts` (New Unifying Contract) | In-process typed synchronous/async Pub-Sub bus unifying Vault mutations, Agent/Workflow lifecycle, Approval transitions, and DAW State/Safety events, piping durable audit events to Runtime Store & UI SSE/poll streams. |
| 15 | **Audit Engine** | `core/vault-engine/audit.ts`, `core/runtime/logger.ts`, SQLite triggers | Enforces immutable append-only `runtime_events`, redacts secrets (`redactSecrets`), validates `.vault-revisions/` SHA-256 history chains, and flags unauthorized write or unsafe DAW parameter attempts. |
| 16 | **API** | `core/gateway/server.ts` (`127.0.0.1:8077`) | Loopback-only HTTP/JSON/SSE boundary with Host/Origin/Referer allowlisting (`Same-Origin & Host Allowlist`), PNA headers, optional Bearer/`X-XYP-Token` auth, 256 KB body caps, routing OS3 + DAW Brain endpoints cleanly. |
| 17 | **UI Adapter** | `UI-xyp3rn/lib/{os3-adapter,gateway,daw-adapter}.ts` + `core/gateway/ui-queries.ts` | Translates runtime/Vault/DAW state into strictly typed view DTOs (`/api/overview`, `/api/vault/graph`, `/api/records`, `/api/daw/*`) while shielding React/Canvas/WebGL UI from SQLite/filesystem details and providing deterministic seed offline fallbacks. |

---

## 3. Layered Dependency Topology & Import Rules

Dependencies flow strictly downward. Cross-layer shortcuts and upward imports are prohibited:

1. **Presentation:** `UI-xyp3rn` (`Next.js 14` `:3000`) -> talks ONLY to **API** (`127.0.0.1:8077`).
2. **Gateway:** `core/gateway/` (`API` + `UI Queries`) -> delegates to `JARVIS Core`, `DAW Core`, `VaultEngine`, `Runtime Store`.
3. **Orchestration:** `JARVIS Core`, `Task Orchestrator`, `Workflow Engine`.
4. **Intelligence & Domain Engines:** `Context Engine`, `Research Intelligence`, `Records`, `DAW Brain` (`DAW Core`, `Plugin Brain`, `Audio Brain`, `Production Intelligence`, `DAW Evaluation`).
5. **Governance & Safety Gate:** `Tool Registry`, `Agent Registry`, `Promotion Gate`, `DAW Command Gateway`, `DAW Capability Registry`, `Audit Engine`.
6. **Storage & Platform Primitives:** `Vault Engine`, `Knowledge Engine`, `Runtime Store` (`core/sqlite`), `Event Bus`, `DAW Adapter SDK` -> vendor adapters (`FL Studio 2025`, `REAPER`) sit in isolated adapter packages injected into `DAW Core`, never imported directly by `DAW Core` or `UI-xyp3rn`.
7. **Zero-Dependency Kernel:** `core/contracts/` (taxonomy, error codes, capability enums).

---

## 4. Integration of TRACE & Legacy `core/db` Retirement Boundary

- **Rule Reconciliation:** Existing legacy `core/db/` + `supabase/migrations/` remain untouched for transitional transactional parity checks and rollback safety (`apps/web/` stays frozen on Next 15 for reference only).
- **TRACE Unification (`core/daw-brain/audio-brain/`):** `tech/trace/` schemas (`trace.analysis/v1`, `trace.report/v1`) and mix rubric evaluation (`records/x3lius/mix-master/`) remain the canonical DSP analysis contracts, while PostgreSQL persistence inside `tech/trace/server.ts` is marked for replacement by OS3 Audio Brain (SQLite + VaultEngine).
