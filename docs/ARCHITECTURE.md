# XYP3RN Agentic OS — Architecture

Status: Phase 0 contract. Changes to this file are contract changes — see [Flagged decisions](#flagged-decisions) for anything not yet settled.

The domain ids, directories and colors below are defined once in code at `core/contracts/taxonomy.ts`. If this doc and that file disagree, the code wins and this doc is the bug.

## Domain tree

```
CORE
  Orchestrator, Agent Registry, Workflow Engine, Tool Registry,
  Context Engine, Memory, Evaluation/Observability
KNOWLEDGE LAYER
  Canonical Knowledge, Source Registry, Prompt Library, Vector Retrieval,
  Relations/Knowledge Graph, Versioning + Provenance,
  Knowledge Promotion Gate                      <- placed here by F2
RESEARCH INTELLIGENCE                           <- namespace reserved; built Phase 6
XYP3RN RECORDS
  X3LIUS MUSIC SYSTEM
    Songwriting, Lyrics, Vocal DNA, Composition, Arrangement, Genre/Style,
    Suno, Production, Mix/Master, Evaluation
  Records ops (catalog, rights splits, release calendar)  <- Phase 13
XYP3RN TECH
  Products, Audio Tools, AI Systems, R&D
GOVERNANCE
  Legal, Rights, Permissions, Human Approval, Audit/Provenance
```

## Repo map

| Domain id | Directory | Label | Color |
|---|---|---|---|
| `CORE` | `core/` | Core | `#22d3ee` |
| `KNOWLEDGE` | `knowledge/` | Knowledge Layer | `#a78bfa` |
| `RESEARCH_INTELLIGENCE` | `research-intelligence/` | Research Intelligence | `#f59e0b` |
| `RECORDS` | `records/` | XYP3RN Records | `#ef4444` |
| `TECH` | `tech/` | XYP3RN Tech | `#10b981` |
| `GOVERNANCE` | `governance/` | Governance | `#94a3b8` |

Shared, non-domain directories: `docs/` (contracts, handoffs), `agents/` (`*.agent.md` definitions, the `{{AGENTS_DIR}}`), `supabase/` (migrations and rollbacks, Phase 1+), `tests/` (cross-phase proofs). `apps/web/` is added in Phase 16.

## Domains

### CORE — Core

**Purpose.** The runtime that turns `.agent.md` files into executed, logged work. It includes the Orchestrator (request routing and dispatch), Agent Registry, Tool Registry with authorization, Workflow Engine, Context Engine, Memory, and Evaluation/Observability.
**Owns.** `agent_runs`, the in-memory agent and tool registries, workflow specs, and run telemetry (latency, tokens, error rates).
**Never touches directly.** Canonical knowledge tables, which it reads only through the Context Engine and never writes. Also research tables, Records data, and domain business logic. Core decides *how* work runs, never *what* the content is.
**Boundary with Knowledge.** The Context Engine (Core) ranks, bundles and caches context for agents. It calls Knowledge's Vector Retrieval and Knowledge Graph for the raw similarity and graph queries. Retrieval primitives live in `knowledge/`; ranking, the reasons attached to each result, and caching live in `core/`.

### KNOWLEDGE — Knowledge Layer

**Purpose.** The system of record for what the OS knows.
**Owns.** `sources`, `modules`, `canonical_prompts`, `prompt_variants`, `tags`, `prompt_tags`, `relations`, `ingestion_runs`, `quality_reports`, `knowledge_versions`, and the embedding columns. It also owns the Source Registry, Prompt Library, Vector Retrieval, Knowledge Graph and Versioning + Provenance. Finally it owns the **Knowledge Promotion Gate**, the only code path in the OS allowed to INSERT/UPDATE canonical knowledge (F2).
It also owns the Creative Vault's files and bytes (AOS-01, F36). The main pieces:
- `vault-curator` (Execution) and `knowledge/source-registry/vault-store.ts`;
- `source_texts`, `source_tags` and `vault_embeddings`;
- the `knowledge_sources` view;
- `knowledge/vault-io`, for export and import.

A Vault file is the owner's material, not knowledge. It becomes canonical only through `pnpm ingest` and the gate.
**Never touches directly.** It accepts no canonical write from any agent or from any non-gate service. The only exception was the Phase 2 temporary bootstrap write (F1), revoked in 6D; first-party documents now enter through the gate's first-party admission path. It never writes research evidence or creative outputs. It never overwrites a canonical row in place: every change is a new `knowledge_versions` row.

### RESEARCH_INTELLIGENCE — Research Intelligence

**Purpose.** Establishes what is true and what works for AI music production. It gathers evidence, verifies sources, detects contradictions, runs experiments, and proposes knowledge candidates. Only the namespace is reserved in Phase 0; it is built in Phase 6.
**Owns.** `research_projects`, `research_questions`, `research_runs`, `research_findings`, `research_evidence`, `research_sources`, `experiments`, `experiment_runs` and `contradictions`. It may INSERT `knowledge_candidates`, but only with status `proposed`.
**Never touches directly.** It never touches `canonical_prompts`, `modules` or `knowledge_versions`, and it never moves a candidate beyond `proposed`, since only the gate does. Evidence and findings are INSERT-only for research roles, enforced by DB grants (Phase 6A). Every claim carries a model/version tag, so a newer-version finding never silently replaces an older-version rule.

### RECORDS — XYP3RN Records

**Purpose.** The label and artist system. It has two parts:

- The X3LIUS Music System: ten creative sub-domains (Phases 7–12). Built in Phase 7 as gate-written modules from `records/x3lius/music-system.manifest.yaml`, with one read-only stub agent per sub-domain. A promoted rule tagged with a sub-domain's slug lands in that module and is consumable on its scoped context path. Phase 8 replaced the Songwriting, Lyrics and Composition stubs with Creative agents of the same names. They write versioned, schema-validated artifacts to `creative_artifacts` from canonical rules and claims pulled at run time. Phase 9 did the same for Genre/Style and Suno (the Prompt-Formula), and added `suno-submitter` (Execution), which submits a formula artifact and records submissions, takes and stub scores in an append-only trail.
- Records ops: catalog, releases, rights splits and release calendar (Phase 13, `records/ops/`). Four deterministic agents:
  - `records-catalog-lookup` (Knowledge) → `records-catalog` (Execution), in `records/workflows/register-track.workflow.yaml`. F10: the guide's Knowledge/Execution hybrid, split. They register a Phase 9 take as a track.
  - `records-catalog` also writes split sets and assigns ISRC/UPC.
  - `records-rights-splits` (Governance) → `records-release-calendar` (Execution), in `schedule-release.workflow.yaml`.
  - The split sum, the unassigned share and the scheduling guard are DB rules (F31).
- Songs and the owner's lyrics (AOS-01, `records/vault/`, F36):
  - `records-songs` (Execution) writes song revisions and typed song links;
  - `x3lius-lyric-editor` (Creative, deterministic) turns Vault lyric sheets and owner edits into `x3lius.lyrics/v2` versions, each a draft until the owner decides.

**Owns.** Creative artifacts (song structures, lyrics, Suno prompts, takes, critiques, revisions) plus `releases`, `tracks`, `rights_splits`, `songs`, `song_revisions` and `song_links`.
**Never touches directly.** It never writes canonical knowledge. It reads style, vocal and mix rules through the Context Engine. A Vocal DNA change goes through the gate like any other canonical write. It never writes research tables and never hardcodes voice or style rules, which would make Research Intelligence updates have no effect. It never approves anything; that's Governance plus humans.

### TECH — XYP3RN Tech

**Purpose.** Products, Audio Tools (TRACE), AI Systems and R&D.
**Owns.** The versioned TRACE boundary contract, which is defined once and shared with Records' Mix/Master (Phases 11 and 14), plus `rd_backlog`.
**Built (Phase 14).** Four components come from `tech/tech.manifest.yaml`, admitted through the gate as modules under `xyp3rn-tech` (F33):
- `tech-products` and `tech-ai-systems`: stubs.
- `tech-audio-tools`: the TRACE intake (Execution).
- `tech-r-and-d`: the R&D backlog (Planning, LLM).

The TRACE service (`tech/trace/server.ts`, `pnpm trace:serve`) takes `trace.analysis/v1` in and answers with `trace.report/v1`. `pnpm ask` routes TECH requests through `tech/entrypoint.ts`.
**Never touches directly.** It never auto-implements backlog items, since a human decides what ships. It never writes canonical knowledge or research evidence, and never writes Records data.

### GOVERNANCE — Governance

**Purpose.** Decides whether something is authorized and compliant. That covers Legal, Rights conflict checks, Permissions/RBAC, Human Approval and Audit/Provenance.
**Owns.** RBAC role tables, the unified `approval_queue` (F8), legal/compliance flags, and `audit_log`, which is append-only at the grant level.
**Never touches directly.** It never mutates the object it is judging: no editing tracks, `rights_splits` or canonical rows. Nothing may UPDATE or DELETE `audit_log`. Governance agents flag and recommend. Only humans holding an RBAC role decide approval-queue items.

## System invariants

1. **One canonical writer.** Only the Knowledge Promotion Gate writes `canonical_prompts`/`modules`. The one exception was the Phase 2 bootstrap window (F1), closed in 6D. The gate's own role can only append, and a canonical row can't commit without its `knowledge_versions` row.
2. **Enforced by grants, not convention.** Every "never writes" above becomes a Postgres grant that a test proves (Phases 4A, 6A, 6D, 15). Application checks are a second layer, never the only one.
3. **History is permanent.** Canonical changes append `knowledge_versions` rows. Evidence, findings and audit rows are append-only.
4. **Every run is logged.** Every agent execution writes exactly one `agent_runs` row, and it never stays `pending`.
5. **Rules come from data, not code.** Creative agents get voice, style and rubric rules from the Context Engine. A hardcoded fallback voice counts as a bug.
6. **Every result traces back to a row.** Context items, scores and UI numbers each carry the table/row/query they came from. No magic numbers, no fabricated figures.
7. **Deny by default.** An unregistered tool, an unknown class or domain, or an unmatched capability is rejected loudly, never allowed by omission.

## Sub-component taxonomy (reserved names)

These are reserved ids, not built code. Each one is registered in the phase that builds it. The Graph View (Phase 16) counts registered components live, so this list does not fix the counts.

| Domain | Sub-components (kebab-case ids) | Registered in |
|---|---|---|
| CORE | `orchestrator`, `agent-registry`, `tool-registry`, `workflow-engine`, `context-engine`, `memory`, `evaluation-observability` | 3–5 |
| KNOWLEDGE | `canonical-knowledge`, `source-registry`, `prompt-library`, `vector-retrieval`, `knowledge-graph`, `versioning-provenance`, `promotion-gate` | 1–3, 6D |
| RESEARCH_INTELLIGENCE | `research-orchestrator`, `evidence-engine`, `source-verification`, `contradiction-engine`, `synthesis`, `experiment-engine` + N specialists | 6A–6C |
| RECORDS | X3LIUS: `songwriting`, `lyrics`, `vocal-dna`, `composition`, `arrangement`, `genre-style`, `suno`, `production`, `mix-master`, `evaluation`. Ops: `catalog`, `rights-splits`, `release-calendar` | 7, 13 |
| TECH | `products`, `audio-tools`, `ai-systems`, `r-and-d` | 14 |
| GOVERNANCE | `legal`, `rights-conflict`, `permissions-rbac`, `human-approval`, `audit-provenance` | 15 |

## Flagged decisions

Phase 0 was told to stop and flag inconsistencies in the domain tree rather than resolve them silently. Each flag carries a status:

- **RESOLVED**: the user chose.
- **PROPOSED**: my recommendation, which stands unless overridden.
- **OPEN**: must be decided at the phase named.

**F1. Phase 2 writes canonical before the gate exists.** RESOLVED (user: temporary bootstrap exception). CLOSED in 6D (`20260924150000_promotion_gate.sql`).

Phase 2 wrote `canonical_prompts`/`modules` through a dedicated `xyp_ingest_bootstrap` DB role, and every such row is marked `promoted_via = 'bootstrap'`. Phase 6D then:

- revoked that role's canonical and graph grants; it keeps only `sources` and `ingestion_runs`;
- backfilled a `knowledge_versions` row (`approval.mode = 'bootstrap'`) for every bootstrap row;
- routed future ingestion through the gate. On the user's 6D decision this is a **first-party admission path** (`admitFirstParty`), not `knowledge_candidates`:
  - Operator-authored documents are the authority; there is no third-party claim to verify.
  - Anything with `origin ≠ first_party` is refused and must enter as research evidence.
  - Each admitted row is `promoted_via = 'gate'`, carries its `knowledge_versions` row (`approval.mode = 'first-party-ingest'`), and is tied to a `promotion_runs` record.

**F2. The gate's owning domain.** RESOLVED (user: Knowledge Layer). The gate lives in `knowledge/` next to Versioning + Provenance. Research Intelligence submits candidates and never holds a canonical write path. It is still built in Phase 6D as sequenced.

**F3. Rights has two owners (Records `rights_splits`, Governance "Rights").** PROPOSED. Records owns the rights data. Governance's `rights-conflict` component reads it and flags conflicts, but never writes it.

**F4. Evaluation appears three times: CORE Evaluation/Observability, X3LIUS Evaluation, and the Critic class.** PROPOSED. The split is:

- CORE `evaluation-observability`: did the system run correctly? (latency, errors, tokens)
- X3LIUS `evaluation`: is the output good? It owns the creative rubrics (canonical rows) and hosts the Critic/Revision agents.

**F5. The Phase 5 router's four targets name "X3LIUS Music System", not Records, and leave out CORE/KNOWLEDGE.** RESOLVED (Phase 5, as proposed; `core/orchestrator/router.ts`). Routing targets are `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH` and `GOVERNANCE`. `RECORDS` then routes on to either X3LIUS or Records ops; otherwise Phase 13 catalog and rights requests would have nowhere to go. CORE and KNOWLEDGE are infrastructure, not request destinations; "what do we know" questions go through the Context Engine.

**F6. Phase 16 says "Research Intelligence's 8 engines" but no phase lists them.** PROPOSED. Six components are reserved above. Five are built by 6A/6C, and `synthesis` is named only in the Phase 17 flow, so it is assigned to 6C. Validation and confidence assignment belong to the gate (Knowledge) under F2. The mismatch with "8" is harmless because the Graph View counts are live, but it is recorded here rather than padded.

**F7. The grant tests can't pass if everything runs as Supabase `service_role` or as the table owner.** RESOLVED (Phase 1). Owners and superusers ignore grants, and `service_role` gets broad default grants plus BYPASSRLS. The resolution:

- Tables are owned by the migration role (`postgres`), which is trusted by definition and never used by application code. The separate `xyp_owner` role proposed in Phase 0 was dropped: a non-login owner adds nothing when the owner never connects.
- Each component connects as its own least-privilege `xyp_*` role, created in the phase that introduces the component: `xyp_ingest_bootstrap` (2), `xyp_embedder` (3), `xyp_runtime` (3 read path; 4A adds `agent_runs`), `xyp_research` (6A), `xyp_promotion` (6D), `xyp_governance` (15), `xyp_readonly` (16).
- `service_role` lost INSERT/UPDATE/DELETE/TRUNCATE on `canonical_prompts`, `modules` and `knowledge_versions` in 6D; it remains the operator key and is the only role that can decide approvals (`xyp_decide_approval`). `anon`/`authenticated` are revoked on every table from Phase 1 onward (`docs/SCHEMA.md`).

**F8. The human approval queue appears in three phases (6D table, 12 escalation, 15 API).** PROPOSED, table built in 6D. There is one Governance-owned `approval_queue` table with an `item_type` column (`knowledge_candidate`, `critique_escalation`, …). The table is created in 6D, where it is first needed, and its API is built in 15. Until then the operator decides with `pnpm gate decide` (user decision), which calls `xyp_decide_approval` as `service_role`. The approver name is free text until Phase 15/16 add authentication. Since Phase 12 the evaluation loop writes `critique_escalation` rows through `xyp_escalate_critique` (F29).

**F9. `sources` (Knowledge) vs `research_sources` (Research Intelligence).** PROPOSED.

- `sources` are ingested documents that feed canonical knowledge.
- `research_sources` are the origins cited by evidence, e.g. changelogs, docs, observed generations.

A `research_sources` row may carry a nullable FK to `sources.id` when the cited document is already ingested. They are different tables with different writers, not duplicates.

**F10. "Hybrid" agents vs a single-valued `class`.** RESOLVED for Phases 11 and 13 (user: the recommendation both times). Phase 11 has "Creative+Execution" and Phase 13 has "Knowledge/Execution" agents, but `class` holds exactly one value. Recommendation: split each hybrid into two single-class agents chained by a Phase 5 workflow. The alternative is a multi-class field, which weakens class-level authorization.
- Phase 11 ships single-class agents and no hybrid:
  - `x3lius-arrangement` and `x3lius-production` are Creative, LLM-backed, on the shared creative program;
  - `x3lius-mix-master` is Creative and deterministic (`model: none`). It checks a TRACE analysis against the canonical rubric and writes a report artifact, with no LLM.
- The guide's Execution half (taking TRACE output from the real plugin) is Phase 14's TRACE integration. Phase 11 defines the contract it will implement (F24).
- Phase 13 splits the Catalog agent in two:
  - `records-catalog-lookup` (Knowledge) resolves a take's chain (take → Suno submission → formula artifact) and the target release. It answers with a fully specified registration and its provenance, and writes nothing.
  - `records-catalog` (Execution) performs it.
  - `register-track.workflow.yaml` chains them.
  - The new capabilities `catalog.read` (Knowledge, Governance) and `catalog.write` (Execution) keep class-level authorization intact.

**F11. Phase 16 says "Knowledge Layer's 6" satellites.** PROPOSED. Under F2 the gate is a seventh Knowledge component, and the counts are live.

**F12. `agent_runs` is built generic in Phase 4A and extended in 6A.** Accepted as the build guide states.

**F13. The 20-specialist roster: the source names 5 and the guide extrapolates the other 15.** RESOLVED (user, 6B: the guide's 20 as-is).

**F14. The auto-approve threshold.** DECIDED in 6D (the guide requires the value and its reasoning in the same commit, and no silent change later).
- Rule: auto-approve only when finding confidence ≥ **0.8**, AND the latest controlled experiment is validated with the candidate variant beating control, AND every cited source was retrieved within **180 days**. Anything short of that goes to the human `approval_queue`.
- Why 0.8: finding confidence is mean(evidence confidence × source reliability) × min(1, 0.5 + 0.25k).
  - A single source is capped at 0.75 of its own support, so no single page, doc or studio session can auto-approve.
  - Two independent sources need a mean support ≥ 0.8, e.g. two official changelogs (0.9) at confidence ≥ 0.89.
  - Community (0.4) and unknown-host (0.3) evidence can never reach it.
- Why 180 days: AI music models ship major versions every few months, so older evidence gets a human look.
- Consequence today: nothing auto-approves before Phase 12, because trials are stub-scored until the Critic exists.
- Phase 12: trials are scored by the Critic (passed / checked, F28); the auto-approve path can now fire.
- Changing either number is a new flagged decision, never a silent edit (`knowledge/promotion-gate/decide.ts`).
- **SUPERSEDED by F35 D2 (Artist OS):** nothing auto-approves. A candidate that meets every condition goes to the owner, and its reason says that every automatic condition holds. The thresholds remain as reasons, and the gate has no auto path left (`decide()` returns only blocked, rejected or human).

**F15. Two X3LIUS sub-domains had no building phase.** RESOLVED (user approved the first option).
- Phase 7 lists ten sub-domains. Phases 8–12 build Songwriting and Lyrics (8), Suno (9), Vocal DNA (10), Production, Arrangement and Mix/Master (11), and Evaluation (12). No phase named Composition or Genre/Style.
- Resolution: **Composition is built in Phase 8**, alongside songwriting (chords and melody belong with structure and toplines). **Genre/Style is built in Phase 9**, alongside Suno style prompts.
- Recorded as `built_in: '8'` / `'9'` in `records/x3lius/music-system.manifest.yaml`. Re-admitting it through the gate appended v2 of both modules; v1 is kept as history.

**F16. Global retrieval returned superseded versions.** RESOLVED (user go, before Phase 8; migration `20260924170000_global_current_versions.sql`).
- The Phase 3 global path (`xyp_match_knowledge`) searched every embedded version, so a v1 and its v2 could both rank.
- It now applies the same current-version filter as the Phase 7 scoped path, scanning canonical prompts exactly. Sources keep their HNSW branch.
- Proof: `tests/phase-07/propagation.test.ts` ("F16: …"), which was red before the migration.

**F17. LLM provider.** DECIDED (user, Phase 8): provider-agnostic.
- `core/llm/` has two paths:
  - native Anthropic Messages through the official SDK;
  - OpenAI-compatible chat completions for Groq and OpenRouter.
- An agent names its provider in frontmatter `model` (`<provider>:<model>`, or a bare `claude-*`). Keys are per provider (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`) and are read at call time.
- Replies are validated against the caller's schema whatever the provider claims.
- The Anthropic base URL is pinned, not read from `ANTHROPIC_BASE_URL` (hosted dev containers set that variable for their own tooling).
- Live-verified on OpenRouter with `nvidia/nemotron-3-ultra-550b-a55b:free` (Phase 8 addendum), which is now the creative agents' model (user decision). Anthropic and Groq are still verified against fakes only.
- The schema is stated in the prompt as well as in `response_format`, because some routes drop the latter.
- Model calls retry transient provider errors twice with backoff: 408/429/5xx, and a 200 whose `finish_reason` is `error` (the upstream abandoned the generation; seen live). A completion changes no external state; Execution agents stay retry-free (Phase 4D).
- The LLM step timeout is 30 min (user decision): whole-song lyrics make about ten calls of 30–110s each. OpenRouter's upstream idle timeout (120s) still ends a stalled call.

**F18. Canonical knowledge is too sparse for a distinct X3LIUS voice.** OPEN (flagged by Phase 8, as the guide requires).
- The creative sub-domains and Vocal DNA hold 0 rules. The model's whole voice context is the guide's one claim, `x3lius.voice-reference` (4 descriptors).
- Every artifact is written with `knowledge.sparse = true` and a long `ungroundedChoices` list. No fallback voice exists in code, and a test enforces that.
- It closes only through data: rules tagged with a sub-domain slug, promoted by the gate (Research Intelligence, or an operator-cited first-party source).

**F19. Suno access.** DECIDED (user, Phase 9): pluggable adapters.
- Suno has no official public API (a developer API has been in partner-only exploration since 2026-07).
- The adapters:
  - `manual`: the prompt is recorded and the operator registers takes. It works now, with no ToS exposure.
  - `sunoapi`: the sunoapi.org reseller, an unofficial resale of Suno access, unverified until `SUNO_API_KEY` exists.
- Browser automation was rejected (captcha, fragility, ToS).
- The caller names the adapter; the Execution agent never chooses.
- When Suno ships an official API, it becomes a third adapter.

**F20. Suno rules are version-scoped.** DECIDED (Phase 9, recorded here because it constrains Phases 10–12).
- A canonical rule or claim tagged `suno-<version>` applies only to prompts for that version; anything else applies to all.
- Platform limits (`suno.limit.<field>-chars`) are canonical claims, never constants in code.

**F21. Lyrics follow the song structure: the whole song, one model call per section.** DECIDED (user, after the Phase 9 live runs).
- Lyrics written from the brief alone gave Suno one verse and no hook.
- `x3lius-lyrics` now reads the song-structure artifact and writes one `x3lius.lyrics/v2` artifact covering every section: each written or listed as instrumental.
- It makes one model call per structure section, in order (`x3lius.lyrics-section-llm/v2`). Each call sees the structure (with its selected hook) and the lyrics written so far.
- Code sets each section's id and kind from the structure, so coverage and order hold by construction. It records the structure version followed, and tags each call's trace with its section.
- One whole-song reply was tried first and dropped. On the free Nemotron route only 1 of 5 attempts returned a complete reply:
  - the provider abandoned one at 137s;
  - one hit the 16k output cap at 357s;
  - with reasoning off, 3 tries all hit the 120s upstream idle timeout.
- Short replies are what that route handles reliably. A failed section call stops the run, and nothing is written.
- A bare brief with no structure is still one call.
- `x3lius.lyrics/v1` artifacts stay readable (the formula renders both) and revisable.
- Whether the hook actually appears in the chorus is not code-checked (fuzzy); it is the Phase 12 Critic's.
- Section tags are code's (user decision, after the model wrote ids as tags live: `[v1]`, `[pre1]`). Verses are numbered in song order and every other kind gets its name (`sectionLabels`). This is a rendering convention in code until a canonical Suno rule says otherwise.
- The sung bars hold words only. Production and performance notes go in each section's `directions`, stored on the artifact and never sent to Suno. The model wrote an outro's stage directions as sung lines live. This is asked for in the prompt, not code-checked.

**F22. Mixed-script words: refused in text Suno receives, a warning elsewhere.** DECIDED (user, after the Phase 9 live runs).
- A word mixing Latin and Cyrillic letters (seen live: "Пeak", "phonк", "Лieux") is a homoglyph corruption. Every creative artifact body is checked before it is written.
- A hit in text Suno receives verbatim refuses the run, and nothing is written. That text is:
  - lyric bars and section labels;
  - the formula's title, style, excluded styles and lyrics. The rendered lyrics are checked too, so an older artifact can't pass a hit on.
- A hit anywhere else (device notes, genre/style fields, songwriting text) is written as a warning in `creative_artifacts.warnings` and logged. That way a typo in metadata doesn't cost a 4-minute run.
- Per-section repair (user decision, after "горниotope"-style hits in 4 of 4 long live outputs):
  - Whole-song lyrics check each section's lines as soon as its call returns (labels are code's).
  - On a hit, that one section is asked for once more, with the words named. Still mixed means the run fails, naming the section.
  - Every creative prompt also asks for one alphabet per word.
- Switching script between words is untouched: which languages a line uses is canonical knowledge.

**F23. Vocal DNA is one canonical row with many readers.** DECIDED (user, Phase 10).
- The X3LIUS vocal signature is operator-authored first-party data in `records/x3lius/vocal-dna.yaml` (`xyp-vocal-dna/v1`).
  - It holds tone, register, delivery and ad-libs as lists of descriptors, plus the RVC/Applio model and the settings actually used.
  - It is admitted through the gate's first-party path into the manifest's `x3lius-vocal-dna` module, never redeclared. A change is a re-ingest and becomes a new version in `knowledge_versions`.
- Its claims are the interface. `x3lius.vocal.{tone,register,delivery,adlibs}` are model-agnostic; `x3lius.vocal.rvc` is scoped `rvc`.
- Readers:
  - Every creative agent gets the attributes (the Suno formula included), through the claims and the row's module.
  - The RVC step (`x3lius-rvc-post`) and the Vocal DNA agent read through one reader (`records/x3lius/vocal-dna/read.ts`). It requires exactly one row with all five claims.
  - Nobody keeps a copy, so a new version reaches every reader at once.
- Tool scoping, which extends F20:
  - A creative agent admits only model-agnostic knowledge by default.
  - The Suno formula admits model-agnostic knowledge plus its own `suno-<v>`.
  - So knowledge scoped to one tool (Suno versions, the RVC settings) reaches only the agents that target it.
- The ingestion writer lets a document place its prompts in a module another document owns, using that module's current version.
- No value is defaulted: an RVC setting the file doesn't state is listed as `unset`, and the local tool's defaults apply.

**F24. The TRACE contract and the mix/master rubric.** DECIDED (user, Phase 11).
- **`trace.analysis/v1`** is the one TRACE boundary contract. It lives in `tech/trace/analysis.ts` (TECH owns it). Mix/Master reads it now and Phase 14 implements it. It is never edited in place; a change is `trace.analysis/v2`.
  - It covers one render at the `mix` or `master` stage. The shape was defined from the guide's list (user: no TRACE export exists yet):
    - loudness per BS.1770/R128 (integrated, short-term max, momentary max, range, true peak);
    - tonal balance over seven fixed bands (dB relative to the full band);
    - stereo correlation and width, for the full band and per band;
    - crest factor.
  - Strict validation: shape, then ranges. It flattens into 29 metric ids (e.g. `loudness.integrated-lufs`, `stereo.sub.width-pct`).
- **The rubric is canonical claims, never constants in code.**
  - Each claim is `x3lius.<stage>.<metric>` = `{ min?, max? }`, scoped `trace`, so it never reaches a lyrics, Suno or production prompt.
  - Operator values come from `records/x3lius/mix-rubric.yaml` (`xyp-mix-rubric/v1`, user decision), admitted through the gate's first-party path as one versioned row in `x3lius-mix-master`. Admission refuses `REQUIRED` placeholders.
  - Research candidates can bound a metric too, one claim each on their own slug. A metric stated by two current rows is refused as two sources of truth.
- **The report.** Each check names its claim ref and version, so the Phase 12 Critic can trace a mix note to the rule in force. A metric no claim bounds is `unset`, never defaulted (the F23 pattern).
- **Phase 14 implemented it** (user decision, F33 D1).
  - `trace.report/v1` (`tech/trace/report.ts`) is the answer TRACE receives. The check type lives there, and Mix/Master's type and the mix report artifact's check schema import it, so a check is defined once (a grep test fails on a second definition).
  - JSON Schema files for the plugin are generated from the TS contract (`tech/trace/schemas/`, `pnpm trace:schemas`), with a drift test. They carry shape; ranges are enforced by the service and described per field.

**F25. How the Critic finds a violation.** DECIDED (user, Phase 12).
- **Hybrid.** Code checks every structured claim it has a check for; the model judges only the prose rules. Today's code checks are the Suno `suno.limit.<field>-chars` claims (measured from the text, never from the stored `limits`) and a mix report's own checks.
- **Code verifies every model-found violation.** The rule must be one the model was given (and not a code-checked one), the path must be a field of the artifact (JSON Pointer), and the quote must appear there word for word. Anything else is kept as `unverified` with its reason and never counts.
- Rejected: code only (prose rules such as "the hook lands in the chorus" would go unchecked); model only (unreliable on counts and bounds, not repeatable).
- The rules are the producing sub-domain's, found by the artifact's **schema id** (a revised version is written by `x3lius-revision`), pulled with the artifact's brief, current versions only. A rule the gate changes reaches older output too.

**F26. A mix report is studio work.** DECIDED (user, Phase 12). The Critic critiques it (each raise/lower check is a violation tied to its claim ref and version), and the loop escalates it to the human queue at once. Revision never rewrites a report of measurements: the fix is a change in the session and a new render. Rejected: revising the production artifact's effect chains (they don't map onto measured metrics); critique only (a stored critique nobody is asked to act on).

**F27. Loop guard: at most 3 revisions, plus a stall rule.** DECIDED (user, Phase 12).
- `MAX_REVISIONS = 3` (`records/x3lius/evaluation/loop.ts`). Each round is two model calls, and a call took minutes on the free route in the Phase 9 live runs, so 3 rounds plus the final Critic pass is at most 7 calls. Three targeted edit rounds that fail to clear the violations are unlikely to be cleared by a fourth.
- **Stall:** a revision that doesn't reduce the violation count escalates at once.
- After each Critic pass the first matching rule wins: Critic run failed → `error` (no queue item: a system fault); nothing checked → `no_rules`; no violations → `converged`; mix report → `studio_work`; 3 revisions made → `iteration_cap`; no progress → `stall`; otherwise revise. A refused or failed revision escalates as `revision_failed`.
- Changing the number is a new flagged decision, never a silent edit (as F14).

**F28. A critique becomes a trial score as rules passed / rules checked.** DECIDED (user, Phase 12). One Critic pass per trial (no revision); the score is the share of applicable rules with no violation, to 4 decimals. No `artifactId` in the trial output, a failed Critic run, or zero rules checked gives score null with the reason, never a number. Rejected: pass/fail (1 and 9 violations score the same); code-weighted (a weight nobody could justify).

**F29. The loop is a code controller over the Orchestrator.** DECIDED (user, Phase 12). `evaluate()` dispatches the Critic and Revision like any agent (authorized, logged in `agent_runs`). It owns no capability; its role `xyp_evaluation_loop` may only call `xyp_escalate_critique`, which writes the `critique_escalation` row (the Promotion Gate's pattern: a service, not an agent, queues for a human). Rejected: a `repeat` construct in the workflow engine (it breaks Phase 5's tested no-cycles rule); the Critic calling Revision directly (it bypasses the dispatch point).

**F30. Open after Phase 12.**
- **Escalation decisions are only recorded.** `pnpm gate decide` approves (accept the latest version as it is) or rejects (don't use it); nothing acts on the decision until the Phase 15 API and Phase 16 UI.
- **Revision makes no structural edits** (adding or removing a section). A violation that needs one persists, the stall rule fires, and a human takes it.
- **Take scoring waits on TRACE.** A Suno take is audio; the Critic reads structured artifacts. New `take_scores` stubs carry `stub:needs-trace-analysis` until Phase 14's `trace.analysis/v1` of a render exists.
- **No live-model run yet** of the Critic or Revision (no model key); both are proven on the FAKE model with scripted replies.

**F31. Splits sum to 100, and "unassigned" is a row.** DECIDED (user, Phase 13).
- The guide asks for two things that can't both hold literally:
  - per-track percentages "must sum to 100", enforced in the DB;
  - the Rights agent "flags any unassigned percentage" before scheduling.
- Resolution:
  - Every committed split set sums to exactly 100 (a deferred constraint trigger, every role, the owner included).
  - An unassigned share is an explicit `payee` null row that the sum counts.
  - A release can't enter `scheduled`/`released` while any track has no set or an unassigned share, and an unassigned row is refused once it is scheduled.
- Rejected:
  - ≤ 100 always and = 100 only at scheduling (then "must sum to 100" holds only for scheduled releases);
  - = 100 with no null payee ("unassigned" could then only mean "no splits at all").
- The Rights check is Governance class (F3: Records owns the data, Governance reads it). A `flag` verdict is a successful run whose flags are data, and the calendar (Execution) schedules only on a `pass` for the same release (D3).
- The release records the Rights run that cleared it, and the DB verifies that run. So the calendar can't be bypassed by a forged verdict or a direct UPDATE.

**F32. Open after Phase 13.**
- **Master vs publishing.** The guide has one split per track. A real release has a master split and a publishing split, each summing to 100. The fix is additive: a `kind` column and a per-kind sum.
- **Payee identity.** `payee` is free text, so "X3LIUS" and "x3lius" are two payees. Phase 15's rights-conflict will want a payee table.
- **Splits per track row, not per recording.** One take on a single and an album carries two split sets that can diverge. That is a Phase 15 rights-conflict check.
- **No edits or takedowns.** There is no title/position edit, no draft delete, and no `withdrawn` status (a Governance takedown, Phase 15).
- **Only Suno takes register.** `take_id` is required, as in the guide's "from Phase 9–11 output". A track made outside Suno (an FL Studio bounce with RVC vocals) can't be registered until that is widened (a user decision).
- **Lead time is not policy.** Any date ≥ today schedules. A DSP lead time is canonical knowledge a later phase can admit, never a constant.
- ~~**`service_role` holds full DML on earlier-phase tables.**~~ RESOLVED in AOS-00 (G20, migration `20260925130000_service_role_read_only`). The hole was wider than listed here: 28 relations. `service_role` is now read-only on every relation and by default.

**F33. XYP3RN Tech (Phase 14).** DECIDED (user, Phase 14).
- **The guide's premises that don't hold:**
  - `research_sources` has no tags, so "tagged frontier/emerging" doesn't exist. The Frontier Scanner's output is `research_evidence` with `specialist = 'frontier-tool-scanner-researcher'`, and the Phase 6 schema is unchanged.
  - That specialist has never run (the 20 specialists need an Anthropic key and have no LLM program), so the backlog is proven on fixtures and the FAKE model.
  - Products / Audio Tools / AI Systems / R&D are TECH sub-components (the reserved ids), not domains. Registering them as domains would break the six-domain taxonomy.
- **D1, the TRACE API is a local HTTP service.**
  - `POST /v1/trace/analyses` validates, records, checks and links, then answers with `trace.report/v1`. `GET /v1/trace/analyses/:id` and `/v1/trace/health` complete it.
  - It binds 127.0.0.1 by default and requires a bearer token (`XYP_TRACE_TOKEN`, at least 16 characters, compared in constant time).
  - Rejected: a CLI file drop (no plugin could call it); the contract alone (nothing runs end to end).
- **D2, the components are a manifest plus agents (Phase 7's pattern).**
  - `tech/tech.manifest.yaml` is admitted through the gate, with one agent per component named after its module.
  - The stub handler is shared (`core/agents/manifest-stub.ts`), and X3LIUS is rebound to it unchanged.
  - Rejected: agents only (no scoped context path); a code constant (not in the registry).
- **D3, the backlog is an LLM whose proposals code verifies** (the F25 pattern).
  - A proposal must cite evidence it was given, fit the schema and not repeat a title. Anything else is kept as `unverified` with its reason.
  - Rejected: deterministic, one item per source (a triage list, not feature ideas).
- **D4, humans decide in `approval_queue`** (`rd_backlog_item`, F8's one queue).
  - The DB queues every item by trigger, and `pnpm gate decide` records the decision.
  - The status is the queue row's (the view `rd_backlog_items`), never copied.
  - Nothing acts on an approval: "shipped" stays outside the OS until someone decides otherwise.
  - Rejected: an operator status column (a second decision path).

**F34. Open after Phase 14.**
- **Take scoring from TRACE.** An analysis can name its Suno take, but turning a mix report into a take score is a scoring decision (the F28 analogue) not taken here. The `take_scores` stubs stay.
- **The R&D model call hasn't run live.** There is no model key in this container, and no real Frontier Scanner output anywhere, because the specialists need their runner.
- **The TRACE plugin itself** (VST3/AU) is a separate codebase. Its side of the contract is the generated JSON Schema files.
- **The service is local-only.** Exposing it beyond localhost (TLS, rotating tokens, per-plugin identities) is a deployment decision.
- **Approved backlog items.** Nothing reads an approval as a trigger to build anything, and a "shipped" state would be a new decision.

**F35. The Artist OS sequence (AOS-00 → AOS-08).** DECIDED (operator, 2026-09-25).
- The operator's plan (`docs/artist-os/PLAN.md`) is now the build sequence. It extends this OS; it does not replace it. The baseline and the no-parallel-kernel gate (`tests/aos-00`) are in `docs/artist-os/AOS-00-baseline.md`.
- **D1:** ids stay UUID v4 (`gen_random_uuid()`) on every table. The plan's "UUID v7" line is superseded.
- **D2:** F14 auto-approval is turned off, so every canonical change goes to the owner's `approval_queue`. This supersedes F14's rule; its thresholds remain only as reasons shown to the human.
- **D3:** the old build guide's Phases 15–17 are absorbed:
  - RBAC, the approval API and the audit log go into AOS-07/08;
  - the UI is built from AOS-01 on as the Command Center in `apps/web`;
  - the radial Graph View is dropped unless the operator asks for it;
  - end-to-end validation becomes each AOS gate.
- **D4:** Creative Vault bytes live in a local content-addressed store (`.vault/<sha256>`, referenced from `sources`) behind one storage interface. Supabase Storage is a second adapter at deployment.

**F36. Creative Vault + songs (AOS-01).** DECIDED (operator, 2026-09-25; design `docs/artist-os/AOS-01-design.md`).
- **A1:** songs link to existing work through a typed `song_links` table: one FK per target kind, exactly one set, append-only with retractions.
- **A2:** the owner's writes go through deterministic agents: `vault-curator` and `records-songs` (Execution, `vault.write`), and `x3lius-lyric-editor` (Creative, `artifact.write` + `vault.read`). Approval is the owner's decision (`xyp_decide_artifact`, `service_role`); no agent approves.
- **A3:** one Context Engine, two corpora.
  - `knowledge`, the default, is unchanged; a test pins every agent-facing bundle as identical, generation included.
  - `vault` (`retrieve(q, { corpus: 'vault' })`) ranks knowledge hits and `vault_embeddings` hits together.
- **A4:** `apps/web` (Next.js 14) runs on 127.0.0.1 behind `XYP_WEB_TOKEN`. Its server modules are loaded natively through `lib/os.ts` (no OS module is bundled or re-implemented). Reads run as `xyp_web`, read only.
- **Built beyond the design:**
  - the owner can edit lyrics as a lyric sheet in the UI and with `pnpm vault edit` (each edit is a new draft version);
  - `pnpm context --vault` gives search from the CLI.

**F37. Open after AOS-01.**
- **Releases past draft can't be restored.** A restore recreates draft releases only, because `xyp_releases_guard` registers a release as a draft. The export refuses a linked scheduled or released release. Release history belongs in AOS-08.
- **An import doesn't remap ids.** A tag whose slug already exists in the target under another id is refused. A promoted knowledge source imports as a Vault-only file: its ingestion runs are not exported, so it is not knowledge in the target.
- **Two known concurrency gaps (one owner, not guarded):**
  - two first adds of the same lyric sheet at once can each import it;
  - the export orders re-links by `created_at` (transaction start).
- **Instrumental sections.** v2 lyrics can't hold directions on an instrumental section. They are reported as warnings, and the sheet keeps them.
- **The UI's session** is one shared token (single owner, no RBAC); AOS-07/08 bring owner identity. An unauthenticated GET gets a 401 with a relative refresh to `/login`, because Next rewrites absolute redirects to `localhost` and the cookie belongs to a host.
- **`pnpm embed` is manual.** New material is searchable only after it runs; `/ingest` shows the backlog.


**F38. Command Center + catalog (AOS-02).** DECIDED (operator, 2026-09-25; design `docs/artist-os/AOS-02-design.md`).
- **B1:** people (name + aliases, one case-insensitive namespace) and credits by role on a song or a track. Append-only, with retractions.
- **B2:** tasks are their own table, with status events (`open`, `done`, `cancelled`). Readiness is computed (`catalog_checks`), never stored, and shown as alerts; a task is never an approval item (F8).
- **B3:** platform links from a fixed list, on a release or a track. The URL must be https on the platform's host; one live link per platform per target; history kept.
- **B4:** a track's recording is a Suno take or a Vault audio file, exactly one. Closes that F32 item.
- **Writes:** `records-catalog` gains the metadata operations (`catalog.write`, Execution); `records-tasks` is new (`task.write`, Execution). The UI calls them through dispatch and the Records workflows, as in A2.
- **Song status** stays the owner's to set. The release stage is derived from the song's tracks; a mismatch is a check (`status_behind`, `status_ahead`), never an automatic change.

**F39. Open after AOS-02.**
- **Payee identity** (F32): split payees are free text, not people. The next step is an optional `person_id` on split rows.
- **Master vs publishing splits** (F32): one split set per track.
- **Past-draft releases can't be exported** (F37): the gate's own final state is refused; release history is AOS-08.
- **No distributor or platform connectors:** deliveries and links are recorded by hand; connectors and analytics are AOS-06.
- **No edits in place:** a person's name, a task's title or due date. A wrong name is a new alias; a wrong task is cancelled and re-added.
- **Tasks have no assignee:** one owner until AOS-07/08 bring identities.
- **The UI keeps typed values after a write.** A successful form redirects to the same page, and React keeps uncontrolled inputs, so a second click re-submits. The DB refuses duplicate people, credits and links (23505); a duplicate task or delivery event would be written. Resetting forms on success is not in AOS-02's scope.
- **The song workspace registers Vault audio only.** A song's linked Suno takes are registered from `/releases`.

**F40. Studio mode and Suno-ready workflows (AOS-03).** DECIDED (operator, 2026-09-25; design `docs/artist-os/AOS-03-design.md`).
- **S1:** style recipes (`x3lius.style-recipe/v1`) and meta-tag sets (`x3lius.meta-tag-set/v1`) are creative-artifact lineages, written by `x3lius-studio-editor` (Creative, deterministic) and approved by the owner like lyrics (`xyp_decide_artifact`). A recipe is reused across songs by building packages from it. Rejected: their own tables; canonical knowledge.
- **S2 (settles baseline C3 and F21's "until a canonical rule says otherwise"):** the code labels are the default tag set's first version (`defaultTagSet()`). Every package names a tag-set version. The owner's cues render as tags after the section label. Tags are still never the model's. Rejected: code labels with an optional cue layer; deferring tag sets.
- **S3:** the Suno handoff is a prompt package (`x3lius.suno-package/v1`, built by `x3lius-suno-package` in `build-suno-package`, exported as `xyp-suno-package/v1` and copy-paste text) recorded as the `manual` submission. The result is a Vault audio file registered as the attempt's take (`suno_takes.source_id`). Rejected: a plain linked file; the sunoapi reseller as the main path.
- **S4:** a submission is refused unless every version its package names is approved and a successful workflow run built it. This is enforced by the DB (`xyp_suno_package_ready`, the submission gate) and asked by the submitter before any adapter call. Rejected: warn only; a workflow-engine approval step.
- **Defaults:**
  - only `x3lius-suno-package` writes a package, and a package is never revised;
  - the Phase 9 formula stays a proposer (`recipeFrom` seeds a draft recipe from it) and can no longer be submitted;
  - the owner rates a take 1–5 with keep/change notes (`take_ratings`, `feedback.write`), apart from the Critic's `take_scores`;
  - workflow specs take `input.optional` (an absent one binds as null), used by `register-track`.
- **The gate** (PLAN §5 Phase 3): `generation_attempts` names each attempt's exact lyric, recipe and tag set versions, and the workflow's name and spec sha256. `generation_takes` names each take's Vault file and sha256. Both survive a Vault export.

**F41. Open after AOS-03.**
- **Instrumental sections can't be tagged:** v2 lyrics list them by id only, so the renderer skips them, as the formula did.
- **Model-proposed recipes and tag sets:** only the owner's editor writes them (`recipeFrom` copies a formula as a draft). Proposals with evaluation are AOS-07.
- **No live run of `recipeFrom` or of a package under a canonical limit.** The formula needs an LLM key. No `suno.limit.*` claim is admitted, so limits are proven by a unit test over claim items and by the wiring (`retrieve_claims`).
- **Engine approval steps, resume and pause** (G11's rest): AOS-08. S4 puts approval on the submission.
- **Reseller takes stay URLs:** `sunoapi` takes are not downloaded into the Vault.
- **Same recording, two paths:** a Vault bounce registered directly and the same file as a take count as two recordings for the ISRC rule.
- **`suno_submissions.formula_artifact_id`** holds a package since AOS-03. The rename is deferred (every Phase 9/13 reader uses the name).
- **A take's audio isn't linked to its song:** the take is the song's through its package. The song's Files list doesn't show it; the Studio section does.
- **Forms keep typed values after a write** (F39): the take upload form keeps the chosen file. A second submit of the same file to the same attempt is refused ("already a take").

**F42. Research mode (AOS-04).** DECIDED (operator, 2026-09-26; design `docs/artist-os/AOS-04-design.md`, plan A `docs/artist-os/AOS-04-plan.md`).
- **R1:** the 20 specialists run on the OpenRouter free route, `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` (frontmatter, swappable per agent).
- **R2:** research links are brief-level and typed: a song through `song_links` (A1), a lineage root, a workflow (name + spec sha256) or an ARCHITECTURE decision through `research_links`. Findings inherit targets through run → brief.
- **R3:** two approval tiers. The owner accepts or rejects a finding into the Findings Library (`xyp_decide_finding`; not canonical). Only an accepted finding can be promoted: candidate → Promotion Gate → the owner's approval (D2).
- **R4:** one shared grounded-evidence program for all 20. Passages are the brief's URLs first, then retrieved canonical rows that trace to an ingested source, within 24 000 chars. One model call; every claim quotes a passage verbatim, and the DB checks the quote before the write. No sources, no model call. Deterministic synthesis by (topic, value, model tag).
- **R5 on Next 14.2 (no upgrade):** the server action awaits `openResearch`, then starts `executeResearch` without awaiting it; the run seals itself on every path. A run a stopped server left running is sealed `abandoned` by the sweep, at boot (`instrumentation.ts`) and before every new brief.
- **One decision per finding**, final, as for an artifact version (`approval_queue_item_key`); a better finding comes from a new run.
- **The gate** (PLAN §5 Phase 4): a canonical row promoted from research chains back through its candidate, finding and evidence to the verbatim quote and the page text it was checked against; nothing reaches a canonical table without the owner's approval. Shown by `tests/aos-04/brief-to-canonical.test.ts`, the CLIs and the browser (`docs/proofs/AOS-04-research.txt`).

**F43. Open after AOS-04.**
- **Owner signals as passages** (a recipe's tested notes, a take's keep/change ratings): AOS-07.
- **Model-proposed URLs or web search:** needs a search provider; not configured. The brief's URLs are the only external sources.
- **A server stopped mid-run** leaves the run `running` until its deadline (up to `n × 30 min`).
- **Findings are insert-only:** a better finding comes from a new run.
- **Decision keys** cover ARCHITECTURE `F<n>` entries only, not the baseline's C/D or the phases' A/S/R tables.
- **Intra-run disagreements** are shown side by side, not recorded as `contradictions` rows (the engine checks candidates and canonical rows only).
- **Legacy sources without text can't back a new quote:** `research_sources` dedups by content across runs, so a page registered before AOS-04 (text null) keeps null, and a quote from it is refused.
- **Ingested-source quotes depend on the canonical body:** a quote citing an ingested document is checked against the canonical rows quoting that source. Restoring such evidence into a database without those rows would be refused by the same check (read from the trigger; no test exercises it).
- **A gate-promoted row has no source,** so a later specialist sees it as context, not a citable passage; its provenance is the candidate → finding → evidence chain.
- **No live specialist run in the proof environment:** no `OPENROUTER_API_KEY` there. The live path is proven up to the model call (a real page fetched and kept); the model's part is proven with the FAKE MODEL.
- **Plans B and C** (the Mercury shell; the graph, file index and sphere, design §§12–21) are not built.
