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
**Front doors.** `pnpm ask` and Mercury's `POST /api/ask` share one path: `planRequest` → `runPlan` (`core/orchestrator/ask.ts`). The web path adds session auth, the same-origin check and the `runtime.execute` permission; approvals raised by runs go through `approval_queue` as usual. Voice sits at the edges and adds no runtime logic. Dictation is typed text from the external Wispr Flow app, submitted only by Send. Replies are spoken by a loopback-only Kokoro-FastAPI service. Mercury bridges to it through `/api/speech*` (`apps/web/lib/kokoro.ts`). Plan: `docs/voice/PLAN.md`.

### KNOWLEDGE — Knowledge Layer

**Purpose.** The system of record for what the OS knows.
**Owns.** `sources`, `modules`, `canonical_prompts`, `prompt_variants`, `tags`, `prompt_tags`, `relations`, `ingestion_runs`, `quality_reports`, `knowledge_versions`, and the embedding columns. It also owns the Source Registry, Prompt Library, Vector Retrieval, Knowledge Graph and Versioning + Provenance. Finally it owns the **Knowledge Promotion Gate**, the only code path in the OS allowed to INSERT/UPDATE canonical knowledge (F2).
**Never touches directly.** It accepts no canonical write from any agent or from any non-gate service. The only exception was the Phase 2 temporary bootstrap write (F1), revoked in 6D; first-party documents now enter through the gate's first-party admission path. It never writes research evidence or creative outputs. It never overwrites a canonical row in place: every change is a new `knowledge_versions` row.

### RESEARCH_INTELLIGENCE — Research Intelligence

**Purpose.** Establishes what is true and what works for AI music production. It gathers evidence, verifies sources, detects contradictions, runs experiments, and proposes knowledge candidates. Only the namespace is reserved in Phase 0; it is built in Phase 6.
**Owns.** `research_projects`, `research_questions`, `research_runs`, `research_findings`, `research_evidence`, `research_sources`, `experiments`, `experiment_runs` and `contradictions`. It may INSERT `knowledge_candidates`, but only with status `proposed`.
**Never touches directly.** It never touches `canonical_prompts`, `modules` or `knowledge_versions`, and it never moves a candidate beyond `proposed`, since only the gate does. Evidence and findings are INSERT-only for research roles, enforced by DB grants (Phase 6A). Every claim carries a model/version tag, so a newer-version finding never silently replaces an older-version rule.

### RECORDS — XYP3RN Records

**Purpose.** The label and artist system. It has two parts:

- The X3LIUS Music System: ten creative sub-domains (Phases 7–12). Built in Phase 7 as gate-written modules from `records/x3lius/music-system.manifest.yaml`, with one read-only stub agent per sub-domain. A promoted rule tagged with a sub-domain's slug lands in that module and is consumable on its scoped context path. Phase 8 replaced the Songwriting, Lyrics and Composition stubs with Creative agents of the same names. They write versioned, schema-validated artifacts to `creative_artifacts` from canonical rules and claims pulled at run time. Phase 9 did the same for Genre/Style and Suno (the Prompt-Formula), and added `suno-submitter` (Execution), which submits a formula artifact and records submissions, takes and stub scores in an append-only trail.
- Records ops: catalog, releases, rights splits and release calendar (Phase 13).

**Owns.** Creative artifacts (song structures, lyrics, Suno prompts, takes, critiques, revisions) plus `releases`, `tracks` and `rights_splits`.
**Never touches directly.** It never writes canonical knowledge. It reads style, vocal and mix rules through the Context Engine. A Vocal DNA change goes through the gate like any other canonical write. It never writes research tables and never hardcodes voice or style rules, which would make Research Intelligence updates have no effect. It never approves anything; that's Governance plus humans.

### TECH — XYP3RN Tech

**Purpose.** Products, Audio Tools (TRACE), AI Systems and R&D.
**Owns.** The versioned TRACE boundary contract, which is defined once and shared with Records' Mix/Master (Phases 11 and 14), plus `rd_backlog`.
**Never touches directly.** It never auto-implements backlog items, since a human decides what ships. It never writes canonical knowledge or research evidence, and never writes Records data.

### GOVERNANCE — Governance

**Purpose.** Decides whether something is authorized and compliant. That covers Legal, Rights conflict checks, Permissions/RBAC, Human Approval and Audit/Provenance.
**Owns.** RBAC role tables, the unified `approval_queue` (F8), legal/compliance flags, and `audit_log`, which is append-only at the grant level.
**Never touches directly.** It never mutates the object it is judging: no editing tracks, `rights_splits` or canonical rows. Nothing may UPDATE or DELETE `audit_log` (created in Phase 13, migration `20260925110000_records`). Governance agents flag and recommend. Only humans holding an RBAC role decide approval-queue items.

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

**F3. Rights has two owners (Records `rights_splits`, Governance "Rights").** DECIDED (Phase 13). Records owns the rights data; only the operator writes it (`service_role`, `pnpm records splits`). Governance reads it and flags: `records-rights-splits` (Phase 13) writes `records_flags`, and Phase 15's `rights-conflict` component reads both. Neither writes splits.

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

**F10. "Hybrid" agents vs a single-valued `class`.** RESOLVED for Phase 11 (user: the recommendation); Phase 13 still to decide. Phase 11 has "Creative+Execution" and Phase 13 has "Knowledge/Execution" agents, but `class` holds exactly one value. Recommendation: split each hybrid into two single-class agents chained by a Phase 5 workflow. The alternative is a multi-class field, which weakens class-level authorization.
- Phase 11 ships single-class agents and no hybrid:
  - `x3lius-arrangement` and `x3lius-production` are Creative, LLM-backed, on the shared creative program;
  - `x3lius-mix-master` is Creative and deterministic (`model: none`). It checks a TRACE analysis against the canonical rubric and writes a report artifact, with no LLM.
- The guide's Execution half (taking TRACE output from the real plugin) is Phase 14's TRACE integration. Phase 11 defines the contract it will implement (F24).

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

**F31. Rights splits always total exactly 100.** DECIDED (user, Phase 13). A deferred constraint trigger checks every touched track at COMMIT; an unknown share is an explicit `UNASSIGNED` row, and the scheduling gate refuses a release while any of its tracks has one. Rejected: ≤ 100 while drafting (the "100" guarantee would hold only at scheduling time).

**F32. A track's audio is a Suno take or a studio master.** DECIDED (user, Phase 13). Exactly one: `suno_take_id`, or `master_uri` + `master_sha256`. It links the creative artifacts behind it and, optionally, the master's mix report.

**F33. Scheduling: the agent proposes, the operator approves.** DECIDED (user, Phase 13). `records-release-calendar` queues a `release_schedule` request; only the operator's decision (`pnpm gate decide`) moves the release to `scheduled`, re-checked by the DB gate at that moment. Outside draft a release and its tracks are locked (only status, UPC and ISRC change), so nothing approved can change afterwards.
