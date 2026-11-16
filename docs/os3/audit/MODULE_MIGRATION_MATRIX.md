# XYP3RN OS 3.0 — Module Migration Classification Matrix

**Classification Key:**
- **PRESERVE**: Keep 100% untouched in design, geometry, and behavior.
- **REUSE**: Keep module as-is and wire directly into OS 3.0 runtime.
- **REFACTOR**: Keep domain logic and contracts; rebind storage/persistence from PostgreSQL to Vault Engine + Local SQLite.
- **REPLACE**: Supersede legacy PostgreSQL-only or duplicate infrastructure with approved OS 3.0 architecture.
- **DEPRECATE**: Freeze and schedule for removal once OS 3.0 parity gate is signed off.
- **NEW**: Net-new OS 3.0 module required by the Master Engineering Context.

---

## 1. `UI-xyp3rn` Modules (`C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn`)

| Module / Path | Classification | Rationale & OS 3.0 Migration Action |
|---|---|---|
| `components/ConstellationCanvas.tsx` | **PRESERVE** | Preserves exact ring/strip/focus SVG geometry, imperative motion-value transforms, pan/zoom gestures, and 60fps rendering. |
| `components/SectorTree.tsx` | **PRESERVE** | Preserves overview dots, focus 34px icon discs, satellite dots, keyboard navigation, and collapsed stubs. |
| `components/BrainCore.tsx` | **PRESERVE** | Preserves 350-particle sphere, dual engine cores (`CLAUDE CODE CLI`, `GEMINI API`), drift/twinkle layers. |
| `components/ChromeShell.tsx` | **PRESERVE** | Preserves collapsible left sector rail, `LogoMark`, operator button, and top `MAP / DASHBOARDS / CHART` pill. |
| `components/JobPanel.tsx` | **PRESERVE** | Preserves 14-section frosted job inspector, autonomy ladder, `buildsOn` navigation, and status overrides. |
| `components/SkillViewer.tsx` | **PRESERVE** | Preserves `SKILL.MD` modal sheet, Markdown renderer, copy buttons, and `.md` download. |
| `components/SearchBar.tsx` | **PRESERVE** | Preserves BM25 search + camera fly-to behavior. |
| `components/SectorCycler.tsx` | **PRESERVE** | Preserves bottom-center sector switcher and strip unroll trigger. |
| `components/JarvisVisualizer.tsx` | **PRESERVE** | Preserves 4 harmonic rings and 24 radial frequency bars. |
| `components/X3liusPlayer.tsx` | **PRESERVE** | Preserves 24-band `/api/music/pulse` spectrum relay, transport controls, `COMPOSE`, and `IMPORT RENDER`. |
| `components/JarvisDock.tsx` | **REUSE** | Already dispatches to `127.0.0.1:8077/api/jarvis` via `dispatchJarvis()` with local fallback. |
| `components/JarvisView.tsx` | **REFACTOR** | Keep UI 100% intact; probe `fetchGatewayHealth()` on mount so live `127.0.0.1:8077` status shows immediately. |
| `components/EmptyState.tsx` | **REFACTOR** | Keep fallback component, while evolving `/dashboards` and `/chart` (`app/dashboards/page.tsx`, `app/chart/page.tsx`) to display live Vault/SQLite metrics when desired. |
| `lib/layout.ts` & `lib/camera.ts` | **PRESERVE** | Pure, deterministic layout and camera math pinned by snapshot tests (`layout.test.ts.snap`). |
| `lib/tokens.ts` | **PRESERVE** | Canonical visual tokens (`TOKENS`, `SECTOR_COLORS`, `LAYOUT`, `MOTION`). |
| `lib/jarvis.ts` & `lib/gateway.ts` | **REFACTOR** | Extend with typed OS 3.0 Gateway endpoints (`/api/health`, `/api/vault/note`, `/api/vault/search`, `/api/approvals`, `/api/approvals/decide`) while keeping deterministic offline fallback. |
| `lib/storage.ts`, `lib/url.ts`, `lib/search.ts`, `lib/markdown.ts`, `lib/vault.ts`, `lib/voice.ts`, `lib/prng.ts` | **PRESERVE** | Pure, 100% unit-tested client utilities. |
| `data/map.ts` | **PRESERVE** | Keep as deterministic layout seed and offline fallback; synchronize its 60 written notes into the canonical Obsidian Vault. |

---

## 2. `xyp3rn-os-2` Modules (`C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS`)

| Module / Path | Classification | Rationale & OS 3.0 Migration Action |
|---|---|---|
| `core/contracts/taxonomy.ts` | **PRESERVE** | Single source of truth for the 6 domains and 8 agent classes. |
| `agents/*.agent.md` (52 files) | **REUSE** | Already Markdown with YAML frontmatter; synchronize into `01_CORE/02_Agents/` and `03_RESEARCH_INTELLIGENCE/06_Specialists/` in the Obsidian Vault. |
| `core/agent-registry/` (`parse-agent-file.ts`, `registry.ts`) | **REUSE** | Parses and validates Markdown/YAML agent definitions into an in-memory registry. |
| `core/tool-registry/` (`capabilities.ts`, `registry.ts`) | **REUSE** | Deny-by-default capability matrix and tool authorization check (`authorize()`). |
| `core/workflow-engine/` (`spec.ts`, `engine.ts`) & `**/*.workflow.yaml` | **REFACTOR** | Reuse YAML spec parser, cycle detector, and topological runner; record `jobs` and step `agent_runs` in Local SQLite instead of PostgreSQL `workflow_runs`. |
| `core/orchestrator/` (`router.ts`, `orchestrate.ts`, `dispatch.ts`, `ask.ts`) | **REFACTOR** | Reuse routing and schema-validated dispatch logic; write execution telemetry to Local SQLite `agent_runs` and route file operations through `VaultEngine`. |
| `core/src/jarvis/JarvisOrchestrator.ts` & `playbooks/monday-review.ts` | **REFACTOR** | Reuse `JarvisCore` front door and human-approval enforcement (`PENDING_HUMAN_APPROVAL`); rebind from PostgreSQL to `VaultEngine` + `SqliteRuntimeDb`. |
| `core/context-engine/` (`context-engine.ts`, `rank.ts`, `lru-cache.ts`) | **REFACTOR** | Reuse ranking and LRU caching; read structural/vector index over the Obsidian Vault instead of PostgreSQL `canonical_prompts`/`sources` tables. |
| `core/llm/` (`providers.ts`, `runner.ts`, `json-schema.ts`, `claude-cli.ts`) | **REUSE** | Provider-agnostic model gateway (Anthropic, OpenRouter, Groq, Claude CLI) with JSON Schema enforcement. |
| `knowledge/obsidian/` (`parser.ts`, `watcher.ts`, `exporter.ts`) | **REFACTOR** | Consolidate into `VaultEngine` (`core/vault-engine/`): keep `parseObsidianNote()`, chokidar watcher, and `0444` read-only canonical export. |
| `knowledge/promotion-gate/` (`gate.ts`, `decide.ts`) | **REFACTOR** | Preserve 9-step gate rules and `F35 D2` (no auto-approve); commit promoted knowledge as versioned Markdown/YAML notes in the Obsidian Vault via `VaultEngine.promoteToCanonical()` and track approvals in SQLite `pending_approvals`. |
| `knowledge/vector-retrieval/` (`embedder.ts`, `pipeline.ts`) | **REUSE** | Reuse local `Supabase/gte-small` ONNX embedder (`.local-models/`) for optional local semantic index over Vault notes. |
| `knowledge/source-registry/vault-store.ts` | **REUSE** | Reuse content-addressed `.vault/<sha256>` binary store for audio/image/PDF blobs referenced by Vault notes. |
| `research-intelligence/` (all sub-engines & 20 specialists) | **REFACTOR** | Preserve verbatim quote verification, contradiction detection, and specialist synthesis; store briefs, evidence, and findings as Markdown/YAML in `03_RESEARCH_INTELLIGENCE/` via `VaultEngine`. |
| `records/x3lius/` (creative, suno, studio, vocal-dna, mix-master, evaluation) | **REFACTOR** | Preserve domain rules (`F20`–`F29`, mixed-script guard `F22`, Critic/Revision loop `F27`); persist songs, lyrics, recipes, and Suno packages as versioned notes in `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/`. |
| `records/ops/` (catalog, rights-splits, release-calendar, tasks) | **REFACTOR** | Preserve `F31` sum-to-100 split rule and GS1/ISRC checks; persist releases, tracks, splits, and tasks in the Obsidian Vault (`05_XYP3RN_RECORDS/` & `01_CORE/06_Tasks/`). |
| `tech/trace/` (`analysis.ts`, `report.ts`, `server.ts`) & `tech/r-and-d/` | **REUSE** | Keep local `127.0.0.1:8787` TRACE HTTP service and `trace.analysis/v1` -> `trace.report/v1` contract; store reports and R&D proposals via `VaultEngine` + SQLite `pending_approvals`. |
| `core/db/` (`client.ts`, `migrate.ts`) & `supabase/migrations/*.sql` | **DEPRECATE** | Preserve untouched during transition until migration parity is demonstrated, then retire in favor of `VaultEngine` + `core/sqlite/`. |
| `apps/web/` (legacy Artist OS UI on `:3100`) & `New folder/` | **DEPRECATE** | `UI-xyp3rn` is the approved primary operator interface; legacy `apps/web/` and untracked `New folder/` are frozen for reference only. |
| `core/sqlite/` (`schema.ts`, `client.ts`) | **NEW** | Minimal local SQLite runtime database (`node:sqlite`) owning `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, and `index_state`. |
| `core/vault-engine/` (`path-guard.ts`, `revision.ts`, `engine.ts`, `bootstrap.ts`, `cli.ts`) | **NEW** | Single controlled file authority over the external Obsidian Vault with atomic writes, No-Overwrite Guard, CAS conflict detection, `.vault-revisions/`, and Promotion Gate. |
| `core/gateway/` (`jarvis-runtime.ts`, `server.ts`, `cli.ts`) | **NEW** | Local `127.0.0.1:8077` HTTP Gateway connecting `UI-xyp3rn` to `JarvisCore`, `VaultEngine`, and `SqliteRuntimeDb`. |
