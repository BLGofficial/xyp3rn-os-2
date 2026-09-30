# Jarvis Build Sequence: current-state map and gap list (Prompt 01, inspection)

> The operator's *XYP3RN Artist OS — Jarvis Build Sequence* (2026-09-28; 18 prompts, a global build contract) against the repository at `main` `c5597f4` (after AOS-04 Plan C1). This is Prompt 01's inspection deliverable: the current-state map, what each prompt already has, and the gaps. It changes no code. The earlier baseline for the AOS plan is [AOS-00-baseline.md](AOS-00-baseline.md); this map updates it for the Jarvis sequence.

## 1. The contract's inputs, in this repository

- **The Phase 0 documents it names do not exist.** `docs/phase-0/handoff/phase-1-agent-context.md`, `docs/phase-0/PHASE-0-RELEASE.md`, `phase-1-readiness.md`, `implementation-order.md` and `phase-1-risks.md` are not in the tree and never were (`git log --all -- docs/phase-0` is empty).
- **What holds those decisions here** (read in this order, the contract's "adapt paths" clause):
  1. `docs/ARCHITECTURE.md`: the Phase 0 contract (six domains, invariants, sub-component ids) and the flagged decisions F1–F47;
  2. `README.md`;
  3. `docs/artist-os/PLAN.md`: the operator's AOS plan, verbatim;
  4. `docs/artist-os/AOS-00-baseline.md`: its current-state map, gap list, implementation order, and decisions D1–D4;
  5. `docs/handoffs/*`: per-phase readiness and open risks;
  6. `docs/NAMING.md` and `docs/SCHEMA.md`: naming and data contracts.
- **Gate** "no duplicate bootstrap or parallel registry": pinned by `tests/aos-00/single-kernel.test.ts` (one agent registry, tool registry, capability matrix, workflow engine, dispatch, LLM runner, ingestion, gate, Context Engine, migration runner, taxonomy).

## 2. Contract lines that disagree with frozen decisions

The contract's first rule makes the repository's decisions authoritative and forbids silently changing frozen contracts, so these stand as they are. Each is raised again at the prompt that depends on it.

| Contract line | This repository | Raised at |
|---|---|---|
| UUID v7 entity ids | **UUID v4** everywhere: D1 (operator, 2026-09-25) kept v4 and superseded the plan's v7 line. Ordering comes from `created_at`. | — (decided) |
| Registry codes such as `prm_*`, `skl_*` | **None exist.** Agents are kebab-case names (`agents/<name>.agent.md`), tools snake_case, modules and canonical prompts slugs, records UUIDs (NAMING.md). Adding codes would be a second naming scheme. | Prompt 04 (persona), if wanted |
| draft → review → approved → production → deprecated → archived | **No shared lifecycle** (baseline C5): per-table lifecycles (artifact versions draft/approved/rejected through `approval_queue`, candidates, releases, runs). | Prompts 04 and 14 (persona and workflow versions) |
| Semantic versions for executable IP | Workflows are identified by **name + spec sha256** (every run records it); agents by file; canonical knowledge by integer `knowledge_versions`. | Prompt 14 |
| Monotonic integers for source/asset snapshots | Holds: artifact `version`, `song_revisions.revision`, `knowledge_versions.version`; bytes are content-addressed (sha256). | — |
| UTC ISO 8601 timestamps | Holds: `timestamptz` storage; the UI renders Sofia time with its offset (display only, F44). | — |
| No Claude API dependency (Prompt 08) | `core/llm/providers.ts` still ships an `anthropic` provider (and `@anthropic-ai/sdk`); **no agent uses it** (30 agents on the OpenRouter free route, 21 deterministic). AgentRouter is not configured. | Prompt 08 |

## 3. Current-state map (Artist OS architecture → owners)

| Area | Owner in this repository | State |
|---|---|---|
| **OS kernel** | `core/`: orchestrator (keyword router, dispatch, scope selection), agent registry, tool registry + capability matrix, workflow engine (YAML specs, runs pinned to spec sha256), Context Engine (knowledge + Vault corpora), memory, LLM runner | built (Phases 3–5, AOS-01) |
| **Knowledge layer** | `knowledge/`: ingestion (normalizers, quality), source registry + Vault store (content-addressed `.vault/`), vector retrieval (gte-small, 384-d), Promotion Gate (every canonical change to the owner, D2), vault export/import, **knowledge-graph** (file index + graph views, Plan C1) | built |
| **Research intelligence** | `research-intelligence/`: orchestrator, 20 specialists (one shared program, R4), evidence with verbatim quotes, synthesis, contradictions, experiments, the Findings Library | built (Phase 6, AOS-04 A); **never run live** (no `OPENROUTER_API_KEY`) |
| **Music domain** | `records/`: X3LIUS Music System (10 sub-domains, creative artifacts, lyric editor, Suno package, studio editor, vocal DNA, mix/master, evaluation/critic), Vault songs and links, ops (catalog, rights/splits, release calendar, tasks) | built (Phases 7–13, AOS-01–03) |
| **Connectors** | none external. `tech/trace` is a local HTTP service (TRACE plugin contract). | **gap** (Prompts 11, 16) |
| **Studio voice** | none (no speech-to-text, no TTS) | **gap** (Prompt 02) |
| **Evaluation / observability** | the Critic (`records/x3lius/evaluation`), `agent_runs` / `workflow_runs` (every run logged), the system pulse, `/system` (index coverage, diagnostics) | partial (improvement loop = AOS-07) |
| **UI** | `apps/web` (Next.js 14.2, React 18, Tailwind 3.4, local Postgres; runs on 127.0.0.1 behind `XYP_WEB_TOKEN`) | built through Plan C1 |

**Routes:**
- `/` (Command: metrics, Graph list, inspector rail);
- `/studio` (recipes, tags, packages);
- `/research` (runs, library);
- `/vault` (files, lineages);
- `/songs`, `/releases`, `/tasks`, `/people`, `/ingest`;
- `/search`, `/node`, `/system`, `/index/files/[id]`;
- `/api/time`.

**Registries:** 6 domains · 51 agents · 37 tools · 23 capabilities · 6 workflow files (15 steps) · 35 modules · 31 canonical prompts (dev DB).

**Data stores:**
- Postgres: 62 tables, 26 views, one role per component (least privilege, RLS; `service_role` read-only);
- `.vault/` (bytes);
- `.local-models/` (embedding weights);
- secrets only in the environment.

**Tests:** 108 files / 1431 tests (vitest, throwaway databases), `agents:validate`, the migration round trip, and `web:smoke` (Chromium against `next start`).

## 4. The eighteen prompts against what exists

| Prompt | Existing work | State |
|---|---|---|
| 01 Baseline, shell, Mercury sphere | AOS-00 baseline; Plan B shell (tokens, fonts, clock, metrics, pulse, activity, drawer, 390 px); Plan C1 graph data; **Prompt 01: the sphere, the command input, the eight areas** | **built** (F48; open items F49) |
| 02 Voice loop (Whisper/Kokoro) | none (= AOS-05) | **not built** |
| 03 Sphere as provenance and navigation | C1: stored-only nodes and edges with provenance, inspector, search, domain/kind/lens filters, retractions, inherited targets | **partial**: no sphere, no answer-driven focus, filters lack status/language/project/date; no Social Stats nodes (Prompt 11) |
| 04 X3LIUS persona and command routing | keyword domain router (`pnpm ask`), specialist scope selection; **F50:** Ask on the command input with four tiers (skill, lookup, deep, front door), `/ask/[id]`, Claude Code skills | **partial**: no persona config, no intent classes beyond the four tiers |
| 05 Vault capture, ingestion, learning | AOS-01 Vault (original bytes, text extraction incl. PDF, duplicates by sha256, tags, language, provenance), drafts + owner approval, AOS-03 take ratings | **mostly built**: audio transcripts need Prompt 02; improvement proposals = AOS-07 |
| 06 Studio song and Suno package | AOS-03 (recipes, tag sets, package composer, handoff, audio import, ratings, trace to exact versions) | **built**: improvement-proposal step pending |
| 07 Live-chain preflight harness | `web:smoke` (e2e on a throwaway DB), unit gates | **gap**: nothing checks the *running* OS with PASS/FAIL/WARN |
| 08 Model gateway | `core/llm` (anthropic, groq, openrouter; frontmatter model refs; retries on 429/5xx) | **partial**: no AgentRouter, no allowlist/switching UI; Anthropic present (§2) |
| 09 Research mode | AOS-04 Plan A (briefs, specialists, verbatim quotes, synthesis, library, gate) | **built** (not live); templates/comparisons, time range and source policy partial |
| 10 Catalog, credits, rights, releases | AOS-02 (people/credits, splits, ISRC/UPC, artwork, deliveries, platform links, checks, tasks) | **mostly built**: no catalog CSV import/export |
| 11 Connectors and analytics | none (= AOS-06); Analytics shown as not built | **not built** |
| 12 Command/reminder/condition routing | none | **not built** |
| 13 Notification policy | Command alert cards (catalog checks) | **not built** |
| 14 Workflow execution, approvals, receipts | engine + runs pinned to spec sha256; approval queue; submission gate (AOS-03) | **partial**: no pause/resume/idempotency keys/receipts model |
| 15 Scheduled routines, briefings | none | **not built** |
| 16 Telegram companion (optional) | none | **not built** |
| 17 Staging / demo mode | throwaway test DBs, `[FIXTURE]`/`[FAKE]` labels | **not built** as a mode |
| 18 Security, recovery, readiness | least-privilege roles, RLS, session auth, sandboxed raw routes, rollbacks refusing owner data | **not built** as an audit; no backup/restore test (= AOS-08) |

## 5. Prompt 01 gaps

> **Closed by Prompt 01** (plan [JARVIS-01-plan.md](JARVIS-01-plan.md), decisions F48, open items F49, proof `docs/proofs/JARVIS-01.txt`): the sphere (1), the command input (2), the eight areas (3), the sphere's own loading, empty, error and populated states (4), and the same bars for it as for the shell (5). The list below is the gap as it stood before.

1. **The sphere** is not built. Its data is (C1: `graph_nodes`/`graph_edges`, 752 entities on the dev DB). Decided: in-house SVG (S2), extractive answers (S4).
2. **Bottom command input:** not built.
3. **Navigation**, against the prompt's eight areas:
   - Command Center, Studio, Research and Creative Vault exist;
   - Songs & Releases exist as two items;
   - **Workflow Builder** has no page (workflows are YAML files; runs are recorded);
   - **Analytics** is listed as not built;
   - **System Admin** is `/system` (index coverage only).
4. **Graph states:** empty and populated are handled (the list); loading is server-rendered today, and the sphere's client load needs its own state.
5. **Honest metrics, Live System Pulse, recent activity, keyboard navigation, reduced motion:** built (Plan B). The sphere must meet the same bars.
