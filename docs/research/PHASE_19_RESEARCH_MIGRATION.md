# Phase 19 — OS 3.0 Research Intelligence Migration

Canonical migration, validation, workflow orchestration, DAW Brain research integration, and non-destructive OS 2 -> OS 3 parity reporting built on top of `research-intelligence/os3-research-engine.ts` and `core/vault-engine/`.

---

## 1. Preserved Concepts & Validated Vault Representation

All existing OS2 Research Intelligence concepts and live Vault artifacts were inspected first and preserved cleanly without duplication or schema regression across the 32 recognized OS3 Vault schemas:

| Concept | OS3 Vault Location | Schema (`v3`) | Key Invariants Enforced (`os3-schemas.ts`) |
| :--- | :--- | :--- | :--- |
| **Research Project** | `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-<slug>.md` | `xyp3rn.research-project/v3` | Stable ID (`rprj-*`), kebab slug, idempotent creation, provenance |
| **Question & Brief Links** | `03_RESEARCH_INTELLIGENCE/QUESTIONS/RQST-<id>-*.md` | `xyp3rn.research-question/v3` | Non-empty question & `intended_use`, `parent_question_id`, active targets & retracted link log |
| **Research Run** | `03_RESEARCH_INTELLIGENCE/RUNS/RRUN-<id>.md` | `xyp3rn.entity/v3` | `type: research_run`, `question_ref`, `job_id`, scored `selected_specialists` |
| **Source** | `02_KNOWLEDGE/SOURCES/SRC-<sha8>-*.md` | `xyp3rn.source/v3` | URI normalization, SHA-256 deduplication, OS2 `RELIABILITY_RUBRIC`, `evidence_tier` |
| **Evidence** | `03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-<id>-*.md` | `xyp3rn.evidence/v3` | Verbatim quote check against `source_ref` body, `interpretation` vs `verbatim_quote`, `uncertainty_note`, `confidence_inputs` |
| **Finding** | `03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-<id>-*.md` | `xyp3rn.finding/v3` | `computeFindingConfidence()` (single-source cap `0.75`), `reject-overwrite`, `verification_status`, Tier-1 `owner_decision` |
| **Contradiction** | `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/CNTR-<id>-*.md` | `xyp3rn.contradiction/v3` | Auto-triggered on conflicting `(claim_topic, overlap(model_scope))`; blocks promotion until `resolved` (`manual` or `experiment`) |
| **Experiment & Run** | `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-*` / `ERUN-*` | `xyp3rn.experiment/v3` + `xyp3rn.entity/v3` | Controlled A/B variants, explicit scorer (`STUB_SCORER` cannot validate), trial bounds `1..N` |
| **Research Brief** | `03_RESEARCH_INTELLIGENCE/BRIEFS/BRF-*.md` | `xyp3rn.entity/v3` | `type: research_brief`, verbatim citations distinct from synthesis, uncertainty limits, open conflict warnings |

---

## 2. Ten Canonical Research Workflows (`xyp3rn.workflow/v3`)

Defined in `research-intelligence/workflows/research-workflows.ts` and executed via `Os3WorkflowEngine` strictly using existing migrated `04_AGENTS/` specialists (no unapproved agents invented):

1. `research-initiation` (`research-orchestrator`)
2. `research-question-decomposition` (`research-orchestrator`)
3. `research-source-collection` (`frontier-tool-scanner-researcher`)
4. `research-evidence-extraction` (`suno-researcher`)
5. `research-finding-creation` (`research-orchestrator`)
6. `research-contradiction-detection` (`negative-prompt-failure-mode-researcher`)
7. `research-verification` (`evaluation-researcher`)
8. `research-synthesis` (`extractive-summarizer`)
9. `research-brief-generation` (`research-orchestrator`)
10. `research-human-review-promotion` (`evaluation-researcher` -> `vault-curator` -> human `approvalGate` -> `VaultEngine.promote()`)

---

## 3. DAW Brain Integration (`daw-research-integration.ts`)

Enables research workflows to ingest and organize all six DAW engineering categories into `02_KNOWLEDGE/SOURCES/`, `03_RESEARCH_INTELLIGENCE/` (including staged candidate notes under `03_RESEARCH_INTELLIGENCE/DAW_REFERENCES/`), and human-approved canonical `10_DAW_BRAIN/` folders via `promoteStagedDawReference()` (`VaultEngine.promote()`):
- `daw_documentation` -> staged `CAP-RES-*` -> canonical `10_DAW_BRAIN/CAPABILITIES/` (`xyp3rn.daw-capability/v3`)
- `plugin_documentation` -> staged `PLG-RES-*` -> canonical `10_DAW_BRAIN/PLUGINS/` (`xyp3rn.daw-plugin/v3`, `host_installed_verified` forbidden from `official_vendor_doc` alone)
- `dsp_research` -> staged `DSP-RES-*` -> canonical `10_DAW_BRAIN/DSP_CONCEPTS/` (`xyp3rn.dsp-concept/v3`)
- `audio_engineering_reference` -> staged `MIX-RES-*` -> canonical `10_DAW_BRAIN/MIX_MASTER_REFS/` (`xyp3rn.mix-reference/v3`)
- `production_technique` -> staged `PWF-RES-*` -> canonical `10_DAW_BRAIN/WORKFLOWS/` (`xyp3rn.production-workflow/v3`)
- `daw_compatibility_finding` -> staged `CAP-RES-*` -> canonical `10_DAW_BRAIN/CAPABILITIES/` + host-scoped contradiction detection (`fl-studio-2025-producer`, `reaper-7`)

---

## 4. Safe, Idempotent OS2 Migration & Parity CLI

`research-intelligence/migration/os2-migrator.ts` and `scripts/migrate-os2-research.ts` (`pnpm run research:migrate`):
- Deterministically maps OS2 Postgres export records (`projects`, `questions`, `runs`, `sources`, `evidence`, `findings`, `contradictions`, `experiments`, `experimentRuns`, `researchLinks`, `findingDecisions`) to OS3 Vault documents.
- Supports read-only scanning of legacy Markdown folders (`03_RESEARCH_INTELLIGENCE/00_Briefs/`, `01_Analyses/`) without modifying or deleting source files (`legacyDataUntouched: true` verified by pre/post SHA-256 checksums).
- Explicitly reports **migrated**, **skippedIdempotent**, **rejected** (secrets, quote mismatches, invalid bounds, missing evidence), **conflicting** (content divergences & claim contradictions), and **incomplete** (pre-AOS-04 omissions, open runs, stub experiments, legacy unstructured notes) records.
- Verifies schema + reference parity via `verifyResearchMigrationParity()` and formats `formatResearchMigrationReportMarkdown()`.
