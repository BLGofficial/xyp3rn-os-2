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
**Never touches directly.** It accepts no canonical write from any agent or from any non-gate service. The only exception is the Phase 2 temporary bootstrap write (F1), which 6D revokes. It never writes research evidence or creative outputs. It never overwrites a canonical row in place: every change is a new `knowledge_versions` row.

### RESEARCH_INTELLIGENCE — Research Intelligence

**Purpose.** Establishes what is true and what works for AI music production. It gathers evidence, verifies sources, detects contradictions, runs experiments, and proposes knowledge candidates. Only the namespace is reserved in Phase 0; it is built in Phase 6.
**Owns.** `research_projects`, `research_questions`, `research_runs`, `research_findings`, `research_evidence`, `research_sources`, `experiments`, `experiment_runs` and `contradictions`. It may INSERT `knowledge_candidates`, but only with status `proposed`.
**Never touches directly.** It never touches `canonical_prompts`, `modules` or `knowledge_versions`, and it never moves a candidate beyond `proposed`, since only the gate does. Evidence and findings are INSERT-only for research roles, enforced by DB grants (Phase 6A). Every claim carries a model/version tag, so a newer-version finding never silently replaces an older-version rule.

### RECORDS — XYP3RN Records

**Purpose.** The label and artist system. It has two parts:

- The X3LIUS Music System: ten creative sub-domains (Phases 7–12).
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
**Never touches directly.** It never mutates the object it is judging: no editing tracks, `rights_splits` or canonical rows. Nothing may UPDATE or DELETE `audit_log`. Governance agents flag and recommend. Only humans holding an RBAC role decide approval-queue items.

## System invariants

1. **One canonical writer.** Only the Knowledge Promotion Gate writes `canonical_prompts`/`modules`. The one exception is the Phase 2 bootstrap window (F1), which closes in 6D.
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

**F1. Phase 2 writes canonical before the gate exists.** RESOLVED (user: temporary bootstrap exception). Implemented in Phase 2 (`20260924090000_ingest_bootstrap_role.sql`). Phase 2 writes `canonical_prompts`/`modules` through a dedicated `xyp_ingest_bootstrap` DB role, and every such row is marked `promoted_via = 'bootstrap'`. Phase 6D then:

- revokes that role's canonical grants;
- fills in `knowledge_versions` rows for the bootstrap rows;
- sends future ingestion output through `knowledge_candidates`.

**F2. The gate's owning domain.** RESOLVED (user: Knowledge Layer). The gate lives in `knowledge/` next to Versioning + Provenance. Research Intelligence submits candidates and never holds a canonical write path. It is still built in Phase 6D as sequenced.

**F3. Rights has two owners (Records `rights_splits`, Governance "Rights").** PROPOSED. Records owns the rights data. Governance's `rights-conflict` component reads it and flags conflicts, but never writes it.

**F4. Evaluation appears three times: CORE Evaluation/Observability, X3LIUS Evaluation, and the Critic class.** PROPOSED. The split is:

- CORE `evaluation-observability`: did the system run correctly? (latency, errors, tokens)
- X3LIUS `evaluation`: is the output good? It owns the creative rubrics (canonical rows) and hosts the Critic/Revision agents.

**F5. The Phase 5 router's four targets name "X3LIUS Music System", not Records, and leave out CORE/KNOWLEDGE.** PROPOSED. Routing targets are `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH` and `GOVERNANCE`. `RECORDS` then routes on to either X3LIUS or Records ops; otherwise Phase 13 catalog and rights requests would have nowhere to go. CORE and KNOWLEDGE are infrastructure, not request destinations; "what do we know" questions go through the Context Engine.

**F6. Phase 16 says "Research Intelligence's 8 engines" but no phase lists them.** PROPOSED. Six components are reserved above. Five are built by 6A/6C, and `synthesis` is named only in the Phase 17 flow, so it is assigned to 6C. Validation and confidence assignment belong to the gate (Knowledge) under F2. The mismatch with "8" is harmless because the Graph View counts are live, but it is recorded here rather than padded.

**F7. The grant tests can't pass if everything runs as Supabase `service_role` or as the table owner.** RESOLVED (Phase 1). Owners and superusers ignore grants, and `service_role` gets broad default grants plus BYPASSRLS. The resolution:

- Tables are owned by the migration role (`postgres`), which is trusted by definition and never used by application code. The separate `xyp_owner` role proposed in Phase 0 was dropped: a non-login owner adds nothing when the owner never connects.
- Each component connects as its own least-privilege `xyp_*` role, created in the phase that introduces the component: `xyp_ingest_bootstrap` (2), `xyp_runtime` (4A), `xyp_research` (6A), `xyp_promotion` (6D), `xyp_governance` (15), `xyp_readonly` (16).
- `service_role` keeps full grants only until 6D revokes its canonical writes. `anon`/`authenticated` are revoked on every table from Phase 1 onward (`docs/SCHEMA.md`).

**F8. The human approval queue appears in three phases (6D table, 12 escalation, 15 API).** PROPOSED. There is one Governance-owned `approval_queue` table with an `item_type` column (`knowledge_candidate`, `critique_escalation`, …). The table is created in 6D, where it is first needed, and its API is built in 15.

**F9. `sources` (Knowledge) vs `research_sources` (Research Intelligence).** PROPOSED.

- `sources` are ingested documents that feed canonical knowledge.
- `research_sources` are the origins cited by evidence, e.g. changelogs, docs, observed generations.

A `research_sources` row may carry a nullable FK to `sources.id` when the cited document is already ingested. They are different tables with different writers, not duplicates.

**F10. "Hybrid" agents vs a single-valued `class`.** OPEN (decide in Phases 11 and 13). Phase 11 has "Creative+Execution" and Phase 13 has "Knowledge/Execution" agents, but `class` holds exactly one value. Recommendation: split each hybrid into two single-class agents chained by a Phase 5 workflow. The alternative is a multi-class field, which weakens class-level authorization.

**F11. Phase 16 says "Knowledge Layer's 6" satellites.** PROPOSED. Under F2 the gate is a seventh Knowledge component, and the counts are live.

**F12. `agent_runs` is built generic in Phase 4A and extended in 6A.** Accepted as the build guide states.

**F13. The 20-specialist roster: the source names 5 and the guide extrapolates the other 15.** OPEN (confirm before 6B).
