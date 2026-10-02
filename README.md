# XYP3RN Agentic OS 2

A six-domain agent operating system: CORE, KNOWLEDGE, RESEARCH_INTELLIGENCE, RECORDS (X3LIUS Music System), TECH, GOVERNANCE. It is built phase by phase following `XYP3RN_Agentic_OS_Build_Sequence.pdf` (Phase 0 → 17).

- Architecture and invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Agent classes and the capability matrix: [docs/AGENT_CLASSES.md](docs/AGENT_CLASSES.md)
- Naming: [docs/NAMING.md](docs/NAMING.md)
- Agent file template: [agents/_template.agent.md](agents/_template.agent.md)
- Phase handoffs: [docs/handoffs/](docs/handoffs/)
- Approved logo: [docs/BRAND.md](docs/BRAND.md)
- Latest engineering audit and next steps: [2026-10-02](docs/PROJECT-AUDIT-2026-10-02.md)

## Develop

Requires Node 22+ and pnpm.

```sh
# Cloud sessions: scripts/session-start.sh (SessionStart hook in .claude/settings.json) runs the
# setup below automatically — DB, migrations, guide + X3LIUS manifest ingest, embeddings.
pnpm install
pnpm db:setup    # local Postgres 16 + pgvector + emulated Supabase roles (Debian/Ubuntu; idempotent)
pnpm db:up       # apply migrations
pnpm ingest --file XYP3RN_Agentic_OS_Build_Sequence.pdf --origin first_party   # Phase 2 ingestion
pnpm embed       # Phase 3: gte-small embeddings (model downloads to .local-models/ on first use)
pnpm context "your question"   # ranked, traceable context bundle
pnpm agents:validate            # Agent Registry: validate agents/*.agent.md
pnpm dispatch health-check '{"ping":"xyp"}'   # run an agent end to end, print its agent_runs row
pnpm route "your request"       # domain routing decision with evidence
pnpm ask "your request"         # front door: route → plan → run the domain entrypoint (research, X3LIUS sub-domains)
pnpm ingest --file records/x3lius/music-system.manifest.yaml --origin first_party   # Phase 7: X3LIUS module + 10 sub-domains via the gate
pnpm research <cmd> '<json>'    # 6C engines by hand: observation, cite, finding, candidate, eligibility, resolve, experiment:*
pnpm research ask '{"projectSlug":"...","question":"...","intendedUse":"...","urls":["https://..."],"songId"?:"<uuid>"}'   # AOS-04: a brief, run live (OPENROUTER_API_KEY)
pnpm research decide <findingId> accept|reject "<reason>"   # AOS-04: the Findings Library (never canonical)
pnpm research promote '{"findingId":"...","proposed_kind":"canonical_prompt","target_slug":"...","title":"...","body":"...","domain":"RECORDS"}'   # AOS-04: an accepted finding → the gate → pnpm gate decide
pnpm index scan [--full]   # AOS-04 C1: index this checkout and check the Vault's bytes; pnpm index status for the last scan
pnpm dispatch x3lius-lyrics '{"request":"..."}'   # Phase 8 Creative agent (also x3lius-songwriting, x3lius-composition); needs the key for its model's provider
pnpm workflow records/x3lius/song-to-suno.workflow.yaml '{"request":"...","sunoModel":"v5"}'   # Phase 9: brief → Suno-ready prompt artifact
pnpm dispatch x3lius-studio-editor '{"recipeFrom":{"artifactId":"<formula id>"}}'       # Phase 9 formula → a draft style recipe (AOS-03: a formula is no longer submitted)
pnpm gate run <candidateId>     # 6D Promotion Gate: the nine-step state machine, the only canonical writer
pnpm gate queue                 # pending human approvals with the gate's reasons
pnpm gate decide <approvalId> approve|reject "<approver>" "<reason>"   # operator decision, then re-run the gate
pnpm workflow core/workflows/retrieve-and-summarize.workflow.yaml '{"query":"..."}'
pnpm workflow records/workflows/register-track.workflow.yaml '{"takeId":"<uuid>","release":{"title":"...","artist":"X3LIUS","kind":"single"},"position":1,"title":null,"mixReportArtifactId":null}'   # Phase 13: catalog a Suno take
pnpm dispatch records-catalog '{"splits":{"trackId":"<uuid>","splits":[{"payee":"X3LIUS","percentage":70},{"payee":null,"percentage":30}]}}'   # Phase 13: split set (null = unassigned); must sum to 100
pnpm dispatch records-catalog '{"assign":{"trackId":"<uuid>","isrc":"QZAB12600001"}}'   # Phase 13: ISRC / UPC, once
XYP_TRACE_TOKEN=<16+ chars> pnpm trace:serve   # Phase 14: TRACE service on 127.0.0.1:8787 — POST /v1/trace/analyses (trace.analysis/v1 → trace.report/v1)
pnpm trace:schemas               # Phase 14: regenerate tech/trace/schemas/*.schema.json from the contract
pnpm dispatch tech-r-and-d '{"request":"..."}'   # Phase 14: R&D backlog proposals from Frontier Scanner evidence, each queued for pnpm gate decide
pnpm ingest --file tech/tech.manifest.yaml --origin first_party   # Phase 14: TECH components via the gate
pnpm dispatch records-catalog '{"credit":{"person":"X3LIUS","role":"writer","songId":"<uuid>"}}'   # AOS-02: people, credits, links, artwork, deliveries
pnpm dispatch records-tasks '{"create":{"title":"...","releaseId":"<uuid>","dueDate":"YYYY-MM-DD"}}'   # AOS-02: the owner's tasks
pnpm workflow records/workflows/schedule-release.workflow.yaml '{"releaseId":"<uuid>","releaseDate":"YYYY-MM-DD"}'   # Phase 13: Rights check, then schedule
pnpm dispatch x3lius-studio-editor '{"recipe":{"name":"...","style":"...","excludeStyles":["..."]}}'   # AOS-03: a style recipe (also recipeFrom, tagSet, defaultTagSet)
pnpm workflow records/workflows/build-suno-package.workflow.yaml '{"songId":"<uuid>","lyricsArtifactId":"<uuid>","styleRecipeArtifactId":"<uuid>","tagSetArtifactId":"<uuid>","title":"...","sunoModel":"v5"}'   # AOS-03: the Suno package
pnpm studio export <packageId> [--text]   # AOS-03: xyp-suno-package/v1, or the copy-paste blocks for Suno's form
pnpm dispatch suno-submitter '{"submit":{"packageId":"<uuid>","adapter":"manual"}}'   # AOS-03: hand off (every version approved); then {"capture":{...}} and {"rate":{...}}
pnpm test        # vitest: phase proofs + unit tests (DB tests use throwaway databases)
pnpm typecheck   # tsc --noEmit
```

Schema and access model: [docs/SCHEMA.md](docs/SCHEMA.md).

## Artist OS (current sequence)

The operator's Artist OS plan ([docs/artist-os/PLAN.md](docs/artist-os/PLAN.md)) extends this OS into the Command Center, Studio and Research modes over one Creative Vault. Its phases are numbered AOS-00 → AOS-08.

- [x] AOS-00: Baseline. The current-state map, gap list, dependency map, implementation order and an executable no-parallel-kernel gate ([baseline](docs/artist-os/AOS-00-baseline.md), [handoff](docs/handoffs/AOS-00.md)). Its four decisions were taken (F35).
- [x] AOS-01: Creative Vault + song schema ([design](docs/artist-os/AOS-01-design.md), [proof](docs/proofs/AOS-01-vault.txt), [handoff](docs/handoffs/AOS-01.md)):
  - songs with revisions and typed links;
  - Vault files (bytes in `.vault/`, text, tags);
  - lyric sheets → lyric versions, which the owner approves;
  - vault search next to knowledge;
  - byte-identical export and import;
  - the first UI (`pnpm web:build && XYP_WEB_TOKEN=… pnpm web`, on 127.0.0.1:3100).
- [x] AOS-02: Command Center + catalog ([design](docs/artist-os/AOS-02-design.md), [proof](docs/proofs/AOS-02-command-center.txt), [handoff](docs/handoffs/AOS-02.md)):
  - people with aliases, and credits by role on songs and tracks;
  - tasks with status history, and readiness checks computed from the data (`catalog_checks`);
  - platform links (fixed list, host-checked), artwork from the Vault, delivery status;
  - tracks from your own Vault audio as well as Suno takes;
  - the dashboard at `/`, and the `/releases`, `/people` and `/tasks` screens; the song page is the song's workspace.
- [x] AOS-03: Studio mode and Suno-ready workflows ([design](docs/artist-os/AOS-03-design.md), [proof](docs/proofs/AOS-03-studio.txt), [handoff](docs/handoffs/AOS-03.md)):
  - style recipes and meta-tag sets as versioned lineages the owner approves; the code labels are the default tag set's first version;
  - the Suno prompt package: a lyric version rendered with a tag set, a recipe's style and exclusions, built in `build-suno-package` and exported as JSON or copy-paste text;
  - the handoff is refused until every version the package names is approved (a DB gate); Suno's audio comes back as a Vault take, which the owner rates;
  - every generation attempt traced to its exact lyric, style, tags, workflow sha256 and audio sha256 (`generation_attempts`);
  - the `/studio` screens, the package page, and a Studio section on the song page.
- [x] AOS-04 (Plan A): Research mode ([design](docs/artist-os/AOS-04-design.md), [plan](docs/artist-os/AOS-04-plan.md), [proof](docs/proofs/AOS-04-research.txt), [handoff](docs/handoffs/AOS-04.md)):
  - a research brief: question, intended use, the only URLs the specialists may read, an optional owner pick of specialists, and typed links to songs, lineages, workflows and decisions;
  - the 20 specialists run one grounded-evidence program on the OpenRouter free route; every claim quotes its passage verbatim, checked by the DB against the kept page text;
  - synthesis into findings; the owner accepts findings into the Findings Library, and promotes accepted ones to canonical through the Promotion Gate;
  - `/research` (briefs, preview, new brief), the run workbench, `/research/library`, and Research sections on songs, recipes and tag sets; runs execute in the background of `next start`.
- [x] AOS-04 Plan B: the Mercury shell ([plan](docs/artist-os/AOS-04-plan-B.md), [proof](docs/proofs/AOS-04-mercury.txt)): graphite/mercury tokens across the whole app, locally hosted fonts, the three-column shell with a drawer below 1280 px, the metric strip with its definitions, the system pulse and recent activity, the Sofia clock synced to the server, and Research recomposed per §17.
- [x] AOS-04 Plan C1: the graph and file index ([plan](docs/artist-os/AOS-04-plan-C1.md), [proof](docs/proofs/AOS-04-graph-index.txt)): a scanned index of this checkout and the Vault (`pnpm index scan | status`, a boot scan, Rescan on /system), agents, workflows, decisions, imports and links as source-backed entities and edges, the live records beside them, search everything, a Graph list with domain filters and the Creative lens, an inspector whose every connection says why it exists, and a safe viewer for repository files.
- [x] Jarvis Prompt 01: the Mercury sphere and the eight areas ([map](docs/artist-os/JARVIS-00-map.md), [plan](docs/artist-os/JARVIS-01-plan.md), [proof](docs/proofs/JARVIS-01.txt), [handoff](docs/handoffs/JARVIS-01.md)): the graph sphere on Command over a bounded, authenticated overview (groups name their query and members; nothing moves on its own; keyboard, reduced motion, loading/empty/error states), a command input that searches the whole index, and the eight areas (Songs & Releases with tabs; Workflow Builder, Analytics and System Admin as honest pages).
- [ ] Jarvis Prompt 03: answers that focus their sources, clusters, richer filters (supersedes the rest of AOS-04 Plan C2).

## Build status (Agentic OS build guide)

- [x] Phase 0: Foundation / Contracts
- [x] Phase 1: Supabase canonical data model
- [x] Phase 2: Knowledge ingestion + normalization
- [x] Phase 3: Retrieval / context engine
- [x] Phase 4: Agent runtime + registry (4A–4E)
- [x] Phase 5: Workflow / orchestration engine
- [x] Phase 6: AI Music Research Intelligence (6A–6D; the 20 specialists run since AOS-04)
- [x] Phase 7: X3LIUS Music Intelligence (module + ten sub-domains, scoped context path)
- [x] Phase 8: Songwriting + Lyrics agents, plus Composition (F15). Live verse produced with Nemotron via OpenRouter ([handoff](docs/handoffs/PHASE-08.md))
- [x] Phase 9: Suno Generation System, plus Genre/Style (F15). Live brief-to-Suno-prompt produced with Nemotron via OpenRouter: whole-song lyrics against the structure, hook in every chorus; no Suno take yet ([handoff](docs/handoffs/PHASE-09.md))
- [~] Phase 10: Vocal / Artist DNA. Built and proven on a fixture; waiting on the operator's real Vocal DNA values ([handoff](docs/handoffs/PHASE-10.md))
- [~] Phase 11: Production / Mix / Master. Built and proven; the operator's mix rubric is admitted and embedded (PR #9). Waiting on a real render's `trace.analysis/v1` for the first live mix check ([handoff](docs/handoffs/PHASE-11.md))
- [~] Phase 12: Critic + Revision System. Built and proven on the FAKE model (both loop proofs, 6C scoring through the Critic); Critic run live once (converged, 1 rule, 0 violations); Revision not yet live, since no lyrics rules are admitted to trigger it ([handoff](docs/handoffs/PHASE-12.md))
- [x] Phase 13: XYP3RN Records (Records ops).
  - `releases`, `tracks` and `rights_splits`. Each split set sums to exactly 100 at commit for every role; an unassigned share is an explicit null-payee row, and it blocks scheduling (F31).
  - Catalog lookup (Knowledge) → catalog (Execution) (F10), Rights (Governance) and the release calendar (Execution).
  - Proven on a throwaway DB with the real CLIs ([handoff](docs/handoffs/PHASE-13.md)).
- [x] Phase 14: XYP3RN Tech.
  - The TRACE service (`trace.analysis/v1` in, `trace.report/v1` out, one definition of a check, JSON Schemas for the plugin).
  - The TECH components via a gate-admitted manifest.
  - The R&D backlog agent, whose verified proposals are each queued for a human.
  - Proven with the live service on a throwaway DB. The R&D model call has not run live, for lack of a key ([handoff](docs/handoffs/PHASE-14.md)).
- [ ] Phase 15: Legal / Governance
- [ ] Phase 16: UI / Observability / Graph View / Command Center (16A–16D)
- [ ] Phase 17: End-to-End Validation
