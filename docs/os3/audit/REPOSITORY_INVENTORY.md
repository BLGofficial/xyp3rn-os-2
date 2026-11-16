# XYP3RN OS 2.0 & UI-xyp3rn — Comprehensive Repository Inventory

**Audit Date:** 2026-11-16
**Audited Checkouts:**
- **Legacy OS 2.0 Repository (`xyp3rn-os-2`):** `C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS` (remote `https://github.com/BLGofficial/xyp3rn-os-2.git`, branch `feat/ops-surface-v2`; primary checkout also present at `C:\Users\blago\Desktop\oss2\xyp3rn-os-2` on `feat/p01-shell` and worktree `C:\Users\blago\Desktop\oss2\xyp3rn-os-2-aos04` on `claude/aos-04`)
- **Primary Operator Interface (`UI-xyp3rn`):** `C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn` (remote `https://github.com/BLGofficial/UI-xyp3rn.git`, branch `main`)
- **Canonical External Obsidian Vault:** `C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain` (20,189 indexed files across `01_CORE`..`06_GOVERNANCE` + `ROOT_KB`)

---

## PART 1 — `xyp3rn-os-2` (`officialFolderofXYP3RNOS`) Inventory

### 1.1. Core Architecture & Domain Taxonomy
- **`core/contracts/taxonomy.ts`**: Single source of truth for the 6 domains (`CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`), domain directory mappings, hex colors (`#22d3ee`, `#a78bfa`, `#f59e0b`, `#ef4444`, `#10b981`, `#94a3b8`), and the 8 agent classes (`Research`, `Knowledge`, `Planning`, `Creative`, `Critic`, `Revision`, `Execution`, `Governance`).
- **`core/repo.ts`**: Repository root path resolver.
- **`tests/aos-00/single-kernel.test.ts`**: Executable kernel ownership gate enforcing that 15 core functions/constants (`createAgentRegistry`, `createToolRegistry`, `CAPABILITIES`, `compileWorkflow`, `runWorkflow`, `dispatch`, `createLlmRunner`, `createLlmClient`, `ingestSource`, `runGate`, `admitFirstParty`, `createContextEngine`, `migrateUp`, `DOMAINS`, `AGENT_CLASSES`) exist in exactly one owning file, SQL migrations exist only in `supabase/migrations`, and `*.agent.md` files exist only in `agents/`.

### 1.2. Orchestrator & JARVIS Core (`core/orchestrator/`, `core/src/`)
- **`core/orchestrator/router.ts`**: Deterministic keyword/evidence router targeting `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, and `GOVERNANCE`.
- **`core/orchestrator/orchestrate.ts`**: Request planner (`planRequest`, `planDirect`, `ENTRYPOINTS`). Produces `run`, `hold`, or `clarify` plans.
- **`core/orchestrator/dispatch.ts`**: Single agent execution entry point. Validates agent existence, checks tool capabilities via `ToolRegistry.authorize()`, validates input/output against JSON schemas, logs one `agent_runs` row per invocation, and seals the row upon completion.
- **`core/orchestrator/ask.ts`**, **`ask-cli.ts`**, **`cli.ts`**, **`route-cli.ts`**, **`lookup.ts`**, **`keyword-match.ts`**, **`scope-select.ts`**: Front-door request execution and CLI bindings.
- **`core/src/jarvis/JarvisOrchestrator.ts`** & **`core/src/cli/jarvis-entry.ts`**: `JarvisCore.interceptAndExecute()` unifying `ask`, `dispatch`, `workflow`, `canonical-write`, `propose-split`, and `apply-split` with the `PENDING_HUMAN_APPROVAL` invariant (`F35 D2`).
- **`core/src/playbooks/monday-review.ts`**: Automated weekly audit sweep across Obsidian inbox, rights splits, TRACE analyses, and pending approvals.

### 1.3. Agent Registry (`core/agent-registry/`, `agents/`)
- **`core/agent-registry/parse-agent-file.ts`**: Parses `agents/*.agent.md` YAML frontmatter (`name`, `class`, `domain`, `model`, `capabilities`, `tools`, `inputSchema`, `outputSchema`) and Markdown system instructions.
- **`core/agent-registry/registry.ts`** & **`cli.ts`**: `loadAgents()` and `createAgentRegistry()` with in-memory snapshot caching and `validateAll()`.
- **`agents/*.agent.md`**: **52 validated agent definitions** (plus `_template.agent.md`), spanning:
  - **20 Research Specialists:** `ai-vocal-systems-researcher`, `artist-identity-researcher`, `benchmark-scoring-methodology-researcher`, `brand-persona-consistency-researcher`, `composition-arrangement-researcher`, `evaluation-researcher`, `frontier-tool-scanner-researcher`, `genre-style-researcher`, `lyrics-rhyme-systems-researcher`, `market-monetization-researcher`, `mix-master-engineering-researcher`, `music-psychology-listener-retention-researcher`, `platform-tos-policy-researcher`, `production-sound-design-researcher`, `prompt-engineering-researcher`, `release-strategy-platform-algo-researcher`, `rights-licensing-researcher`, `songwriting-structure-researcher`, `suno-researcher`, `udio-alt-platform-researcher`, `voice-cloning-researcher`.
  - **14 X3LIUS Creative/Studio/Evaluation Agents:** `x3lius-arrangement`, `x3lius-composition`, `x3lius-evaluation`, `x3lius-genre-style`, `x3lius-lyric-editor`, `x3lius-lyrics`, `x3lius-mix-master`, `x3lius-production`, `x3lius-revision`, `x3lius-rvc-post`, `x3lius-songwriting`, `x3lius-studio-editor`, `x3lius-suno-package`, `x3lius-suno`, `x3lius-vocal-dna`.
  - **18 Core/Knowledge/Records/Tech/Governance Agents:** `context-retriever`, `extractive-summarizer`, `health-check`, `obsidian-sync`, `records-catalog-lookup`, `records-catalog`, `records-release-calendar`, `records-rights-splits`, `records-songs`, `records-tasks`, `research-orchestrator`, `suno-submitter`, `tech-ai-systems`, `tech-audio-tools`, `tech-products`, `tech-r-and-d`, `vault-curator`.

### 1.4. Tool Registry (`core/tool-registry/`)
- **`core/tool-registry/capabilities.ts`**: Defines 23 capabilities (`context.read`, `log.write`, `web.read`, `research.write`, `research.read`, `candidate.propose`, `plan.write`, `artifact.write`, `artifact.read`, `critique.write`, `critique.read`, `catalog.read`, `catalog.write`, `trace.write`, `vault.write`, `vault.read`, `task.write`, `feedback.write`, `external.execute`, `governance.flag`, `canonical.write`, `approval.decide`, `audit.write`) and maps each to allowed `AgentClass[]`. `canonical.write`, `approval.decide`, and `audit.write` are granted to **no** agent class (`[]`).
- **`core/tool-registry/registry.ts`**: `defineTool()` and `createToolRegistry()` implementing deny-by-default authorization (`authorize(agentClass, toolName)`).
- **`core/tool-registry/tools/`**: `log-message.ts`, `read-artifact.ts`, `retrieve-claims.ts`, `retrieve-context.ts`, `write-artifact.ts`.

### 1.5. Context Engine & Memory (`core/context-engine/`, `core/memory/`)
- **`core/context-engine/context-engine.ts`**: Retrieves ranked, traceable context bundles over two corpora (`knowledge` default, and `vault` via `vault-corpus.ts`) with module scoping (`scope: { modules }`) and claim lookup (`readClaims`).
- **`core/context-engine/rank.ts`** & **`lru-cache.ts`**: Deterministic hybrid scoring and generation-invalidated LRU cache.
- **`core/memory/memory.ts`**: Scoped workflow run memory and `$input` / `$steps.<id>.output` binding resolution.

### 1.6. Workflow Engine (`core/workflow-engine/`)
- **`core/workflow-engine/spec.ts`**: Validates YAML workflow definitions (`name`, `description`, `requiredInput`, `optionalInput`, `steps`, `output`), detects cycles, and computes topological execution order (`topoOrder`).
- **`core/workflow-engine/engine.ts`** & **`cli.ts`**: `loadWorkflow()`, `compileWorkflow()`, and `runWorkflow()`. Records `spec_sha256` per run.
- **7 YAML Workflows:**
  1. `core/workflows/retrieve-and-summarize.workflow.yaml`
  2. `records/workflows/build-suno-package.workflow.yaml`
  3. `records/workflows/register-track.workflow.yaml`
  4. `records/workflows/schedule-release.workflow.yaml`
  5. `records/x3lius/song-to-suno.workflow.yaml`
  6. `records/x3lius/write-lyrics.workflow.yaml`
  7. `tech/workflows/trace-intake.workflow.yaml`

### 1.7. Model Gateway (`core/llm/`)
- **`core/llm/providers.ts`**: Provider-agnostic LLM client supporting Anthropic Messages (`@anthropic-ai/sdk`), OpenRouter, and Groq (OpenAI-compatible HTTP), plus `claude-cli.ts` headless CLI transport.
- **`core/llm/runner.ts`** & **`json-schema.ts`**: Structured output validation against caller JSON schemas and bounded transient error retries (408/429/5xx).

### 1.8. Knowledge Layer, Promotion Gate & Obsidian Sync (`knowledge/`)
- **`knowledge/ingestion/`**: `ingest.ts`, `extract-pdf.ts` (`unpdf`), `write-normalized.ts`, `vault.ts`, `vault-curator.ts`, and 4 first-party normalizers (`build-sequence.ts`, `module-manifest.ts`, `mix-rubric.ts`, `vocal-dna.ts`).
- **`knowledge/vector-retrieval/`**: `embedder.ts` (local HuggingFace `Supabase/gte-small` 384-dim ONNX model cached in `.local-models/`), `pipeline.ts`, `compose.ts`.
- **`knowledge/promotion-gate/`**: `gate.ts`, `decide.ts`, `cli.ts`. Nine-step state machine (`runGate`, `admitFirstParty`). Auto-approval is disabled (`F35 D2`); every canonical promotion queues in `approval_queue` for human approval.
- **`knowledge/obsidian/`**:
  - `parser.ts` & `types.ts`: YAML frontmatter + `[[wikilink]]` extractor + SHA-256 hashing.
  - `watcher.ts` & `core/obsidian/watcher-cli.ts`: Chokidar file watcher over `inbox/`, `research/`, `creative/`, staging edits as `pending_approval` in `obsidian_findings`.
  - `exporter.ts` & `exporter-cli.ts`: Exports owner-approved lyric versions to `canonical/lyrics/<slug>_<v>.md` as `0444` read-only notes with `source_sha256`.
  - `plan.ts`, `sync.ts`, `notes.ts`, `tools.ts`, `agent.ts`: Bidirectional Obsidian sync planner (`F54`).
- **`knowledge/source-registry/`**: `acquire.ts`, `vault-store.ts` (local content-addressed `.vault/<sha256[0..1]>/<sha256>` store), `vault-tools.ts`.
- **`knowledge/vault-io/`**: `export.ts`, `import.ts`, `spec.ts` (`xyp-vault-export/v1` deterministic bundle).
- **`knowledge/knowledge-graph/`**: `scan.ts`, `projection.ts`, `overview.ts`, `components.ts`, `declared.ts`, `refs.ts`, `scope.ts`, `search.ts`, `status.ts`, `cli.ts`.

### 1.9. Research Intelligence (`research-intelligence/`)
- **`research-intelligence/agents/research-orchestrator.ts`**, **`orchestrator/select.ts`**, **`specialists/program.ts`**, **`specialists/table.ts`**: Runs the 20 specialist research programs over operator-approved URLs (`brief.ts`), enforcing verbatim quote verification (`sources/fetch.ts`, `sources/verify.ts`, `evidence/engine.ts`).
- **`research-intelligence/contradictions/engine.ts`**, **`experiments/engine.ts`**, **`synthesis/findings.ts`**, **`synthesis/synthesize.ts`**, **`library.ts`**: Contradiction detection, controlled A/B trial scoring, synthesis into findings, and Findings Library management.

### 1.10. Records & X3LIUS Music System (`records/`)
- **`records/x3lius/`**:
  - `music-system.manifest.yaml`, `vocal-dna.yaml`, `mix-rubric.yaml`, `music-system.ts`, `entrypoint.ts`.
  - `creative/`: `artifacts.ts`, `lyrics.ts`, `production.ts`, `program.ts`, `schemas.ts`, `script-check.ts` (mixed Latin/Cyrillic homoglyph guard `F22`).
  - `suno/`: `formula.ts`, `package.ts`, `package-export.ts`, `submitter.ts`, `adapters.ts` (`manual` and `sunoapi`), `score-hook.ts`.
  - `studio/`: `editor.ts`, `tags.ts`, `cli.ts` (style recipes and versioned meta-tag sets).
  - `vocal-dna/`: `agent.ts`, `read.ts`, `rvc-post.ts`.
  - `mix-master/agent.ts`: Deterministic rubric checker over `trace.analysis/v1`.
  - `evaluation/`: `critic.ts`, `revision.ts`, `loop.ts` (`MAX_REVISIONS = 3` + stall guard `F27`), `verify.ts`, `scorer.ts`, `checks.ts`, `edits.ts`, `pointer.ts`.
- **`records/ops/`**: `catalog/lookup.ts`, `catalog/catalog.ts`, `rights-splits/check.ts` (`F31` sum-to-100 rule), `release-calendar/calendar.ts`, `tasks/tasks.ts`, `metadata-tools.ts`.
- **`records/vault/`**: `songs-agent.ts`, `lyric-editor.ts`, `lyric-sheet.ts`, `import.ts`, `cli.ts`.

### 1.11. Tech & Governance (`tech/`, `governance/`)
- **`tech/trace/`**: `analysis.ts` (`trace.analysis/v1`), `report.ts` (`trace.report/v1`), `intake.ts`, `server.ts` (`127.0.0.1:8787` HTTP service behind `XYP_TRACE_TOKEN`), `schemas.ts`.
- **`tech/r-and-d/`**: `backlog.ts`, `tools.ts` (LLM-backed R&D proposals grounded in Frontier Scanner evidence).
- **`governance/approvals.ts`**: Operator approval decision helper (`decideApproval` via `xyp_decide_approval`).

### 1.12. Legacy Web App (`apps/web/`) & Galaxy Python Daemon (`galaxy/`)
- **`apps/web/`**: Next.js 15.5.27 Artist OS Command Center (`127.0.0.1:3100`) with 26 page routes (`/`, `/songs`, `/releases`, `/people`, `/tasks`, `/studio`, `/research`, `/vault`, `/approvals`, `/hud`, `/ops`, `/os`, `/system`, `/workflows`, `/analytics`, `/agents`, etc.) and 24 API routes.
- **`galaxy/`**: Python auxiliary daemon (`server.py`, `jarvis_brain.py`, `phone.py`, `google.py`, `desk_mcp.py`, `scheduler.py`).

### 1.13. Database Schema & Migrations (`supabase/migrations/`)
- **27 SQL migrations** (`20260924080000_canonical_base.sql` through `20261011110000_split_proposals.sql`) defining 46 tables, 19 views, and 14 least-privilege Postgres roles (`xyp_runtime`, `xyp_embedder`, `xyp_research`, `xyp_verifier`, `xyp_promotion`, `xyp_creative`, `xyp_execution`, `xyp_critic`, `xyp_evaluation_loop`, `xyp_catalog`, `xyp_release_calendar`, `xyp_trace_intake`, `xyp_planner`, `xyp_vault`, `xyp_tasks`, `xyp_indexer`, `xyp_obsidian_watch`, `xyp_web`).

---

## PART 2 — `UI-xyp3rn` Inventory (`C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn`)

### 2.1. Routes (`app/`)
| Route | File Path | Status | Behaviour |
|---|---|---|---|
| `/` | `app/page.tsx` | Live | Redirects (`redirect('/map')`) to `/map`. |
| `/map` | `app/map/page.tsx` | Live | Wraps `<MapScreen />` in `<Suspense>` (Views 1–5 + `JarvisDock` + `JarvisView` overlay). |
| `/jarvis` | `app/jarvis/page.tsx` | Live | Dedicated full-screen `<JarvisView />` route; closing navigates back to `/map`. |
| `/dashboards` | `app/dashboards/page.tsx` | Stub | Renders `<EmptyState view="dashboards" />` (`// STUB: the source material never shows this screen.`). |
| `/chart` | `app/chart/page.tsx` | Stub | Renders `<EmptyState view="chart" />` (`// STUB: the source material never shows this screen.`). |
| `/icon.svg` | `app/icon.svg` | Live | Vector hexagon brand icon. |

### 2.2. Components (`components/`)
- **`ConstellationCanvas.tsx`**: Views 1–3 full-viewport SVG canvas. Manages a single `<motion.g ref={cameraRef}>` camera group, 6 sector spoke lines, `<BrainCore />`, 6 `<SectorTree variant="overview" />` groups arranged on a ring (or unrolled horizontal strip when cycling), and `<SectorTree variant="focus" />` with 3 concentric orbit arcs (`170`, `350`, `530` px). Imperatively updates SVG `transform` attributes in `apply()` from Framer Motion values (`rot`, `unroll`, `slide`, `focusT`, `panX`, `panY`, `zoom`) to avoid React re-renders during animation.
- **`SectorTree.tsx`**: Memoized sector renderer for both `'overview'` (dots + counter-scaled 22px hub) and `'focus'` (34px icon discs, wrapped 2-line titles, `breaksInto` satellite dots, `START HERE` badge, and cluster count tips). Supports keyboard navigation (`Tab`, `Enter`, `Space`) and collapsed branch stubs (`collapseTree`).
- **`BrainCore.tsx`**: Central `XYP3RN.CORE` sphere with 350 deterministic PRNG particles (`mulberry32`), hair-thin links to 2 engine cores (`CLAUDE CODE CLI` and `GEMINI API`), 3 counter-drifting layers, and 2 twinkle groups.
- **`JobPanel.tsx`**: View 4 frosted 14-section slide-over dialog (`role="dialog"`, `aria-modal="true"`). Renders autonomy eyebrow, title + `START HERE`, sector/cluster path tree (`pathTree`), summary, `SKILL.MD` download bar (disabled for stubs), `breaksInto` chips, interactive `buildsOn` navigation chips, `replaces` callout, 3-level autonomy ladder (`human-led`, `human-assisted`, `fully-autonomous`), human role, build notes, skill card with terminal install command, 3-way status segmented control (`not-started`, `in-development`, `live`), and help toggle.
- **`SkillViewer.tsx`**: View 5 `SKILL.MD` modal sheet. Parses frontmatter, headings, lists, code blocks, and inline code via `lib/markdown.ts`, and provides `COPY INSTALL COMMAND`, `COPY SKILL.MD`, and `.md` file `DOWNLOAD`.
- **`ChromeShell.tsx`**: App shell providing `ChromeContext` (`active`, `setActive`, `jarvisOpen`, `setJarvisOpen`), collapsible left sector rail (56px collapsed / 208px expanded on desktop; bottom bar on mobile), `LogoMark`, operator initials button (`BK`) toggling `jarvisOpen`, disabled settings stub icon, and top-center `MAP / DASHBOARDS / CHART` navigation pill.
- **`SearchBar.tsx`**: Top-left home button + search input running BM25 `searchJobs(departments, query, 1)` with live hint and camera fly-to on `Enter`.
- **`SectorCycler.tsx`**: Bottom-center `‹ 01_CORE ›` sector switcher with tagline.
- **`JarvisDock.tsx`**: Floating bottom-right operator dock with voice mic toggle (`startVoiceCapture`), engine toggle (`CLAUDE CLI` / `GEMINI API`), command input (`xyp3rn>`), expandable `<X3liusPlayer />`, latest reply status card with `OPEN NODE →`, and `CONSOLE` launcher.
- **`JarvisView.tsx`**: Full-screen operator console with `<JarvisVisualizer />`, engine switcher, TTS toggle (`speakJarvisReply`), `<X3liusPlayer />`, 6 quick directive chips, and persisted session exchange log (`05_XYP3RN_RECORDS / 01_Session_Logs`) with clickable `@context` job chips.
- **`JarvisVisualizer.tsx`**: SVG harmonic voice orb with 4 concentric rings and 24 radial frequency bars (`buildVisualizerBars`, `buildVisualizerRings`).
- **`X3liusPlayer.tsx`**: X3LIUS Music System deck with 24-band spectrum (`fetchTrackPulse`), play/pause/prev/next transport, track selector (`uk-drill`, `neon-static`, `glass-orbit`), `COMPOSE` trigger, `SONG HUB` navigation, and `.wav/.mp3/.flac` `IMPORT RENDER` file picker.
- **`EmptyState.tsx`**: Centered frosted card for `/dashboards` and `/chart` with link back to `/map`.

### 2.3. Pure Libraries & Engines (`lib/`, `data/`)
- **`lib/layout.ts`**: Deterministic polar tree layout engine (`planBranches`, `layoutSector`, `layoutFocusArc`, `collapseTree`, `layoutTree`, `ringPosition`) using seeded rejection sampling (`96` attempts) to prevent node collisions.
- **`lib/camera.ts`**: Pure camera math (`fitScale`, `clampPan`, `zoomAt`).
- **`lib/tokens.ts`**: `TOKENS` (`#20232E` bg, `#EFEBE2` ink, `#8B8F9C` inkDim, `#F59B5C` accent), `SECTOR_COLORS` for `01_CORE`..`06_GOVERNANCE`, `LAYOUT` constants (`gatewayPort: 8077`, `mcpConnectorTotal: 21`), and `MOTION` timings.
- **`lib/gateway.ts`** & **`lib/jarvis.ts`**: Command parser (`parseJarvisCommand`), path safety guard (`isSafeVaultPath`), no-overwrite copy resolver (`resolveSafeCopyPath`), `@context` resolver (`extractContextRefs`, `resolveContextRefs`), `127.0.0.1:8077` gateway client (`dispatchJarvis`, `fetchTrackPulse`, `fetchGatewayHealth`, `fetchVaultNote`, `searchLiveVault`, `fetchPendingApprovals`, `decideGatewayApproval`) with deterministic `local-vault` fallback, and `localStorage` session logger (`xyp3rn.jarvis.session.v1`).
- **`lib/storage.ts`**: `localStorage` job status overrides (`xyp3rn.constellation.status.v1`).
- **`lib/search.ts`**, **`lib/markdown.ts`**, **`lib/vault.ts`**, **`lib/url.ts`**, **`lib/labels.ts`**, **`lib/icons.ts`**, **`lib/prng.ts`**, **`lib/useDialogFocus.ts`**, **`lib/voice.ts`**.
- **`data/map.ts`**: Static seed containing `ui` copy strings, `x3liusTracks` (3 tracks), `brain` config, and `departments` (6 sectors, 46 clusters, 137 jobs: 60 written notes + 77 stubs).

### 2.4. Existing Tests Verified
- **`UI-xyp3rn`**: 6 test suites (`lib/__tests__/data.test.ts`, `helpers.test.ts`, `jarvis.test.ts`, `layout.test.ts`, `components/__tests__/views.test.tsx`, `jarvis.test.tsx`) — **85/85 tests passing**.
- **`xyp3rn-os-2`**: 130+ phase/AOS test suites + 5 OS 3.0 test suites (`tests/os3-phase1..4`, `tests/aos-00/single-kernel.test.ts`) — **all verified tests passing**.
