# XYP3RN OS 3.0 — Research Intelligence Migration Report (Phase 9)

## 1. Migrated Canonical Entities (Obsidian Vault + Minimal SQLite Runtime)

All 9 Research Intelligence entities are persisted in the canonical external Obsidian Vault via `VaultEngine`, while only ephemeral job execution state lives in SQLite (`jobs`):

| Entity | Vault Location | OS3 Schema | Runtime / Key Invariants |
|---|---|---|---|
| **Research Project** | `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-<slug>.md` | `xyp3rn.research-project/v3` | Idempotent creation by `slug` |
| **Research Question** | `03_RESEARCH_INTELLIGENCE/QUESTIONS/RQST-<id>.md` | `xyp3rn.research-question/v3` | Requires non-empty `question` & `intended_use` |
| **Research Run** | `03_RESEARCH_INTELLIGENCE/RUNS/RRUN-<id>.md` | `xyp3rn.entity/v3` | Tracked in SQLite `jobs` (`kind: 'research'`) + `selected_specialists` |
| **Source** | `02_KNOWLEDGE/SOURCES/SRC-<sha8>-<slug>.md` | `xyp3rn.source/v3` | SHA-256 deduplication + OS2 `classifySource()` reliability rubric (`0.3`..`0.9`) |
| **Evidence** | `03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-<id>.md` | `xyp3rn.evidence/v3` | Verifies `source_ref` exists, checks `verbatim_quote` verbatim against source text, separates `verbatim_quote` from `interpretation` & `uncertainty_note`, preserves `model_tag` |
| **Finding** | `03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-<id>.md` | `xyp3rn.finding/v3` | Uses `computeFindingConfidence()` (single-source cap `0.75`), requires >= 1 `evidence_ids`, `writeMode: 'reject-overwrite'` (never silently overwrites), runs contradiction check |
| **Contradiction** | `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/CNTR-<id>.md` | `xyp3rn.contradiction/v3` | Auto-created on conflicting `(claim_topic, model_scope)` values; blocks canonical promotion until resolved (`manual` or `experiment`) |
| **Experiment** | `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-<id>.md` | `xyp3rn.experiment/v3` | Defines `variant_a`, `variant_b`, `n_per_variant`, `scorer` |
| **Experiment Run** | `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/ERUN-<id>.md` | `xyp3rn.entity/v3` | Summarized via OS2 `summarizeExperiment()`; refuses stub-scored validation |

---

## 2. Analytical Capability Mapping (Strict Non-Invention Rule)

Per Phase 9 governance ("Only migrate agents that exist in the source repository or are explicitly approved"), **zero** unapproved `.agent.md` files were fabricated. The 21 existing `RESEARCH_INTELLIGENCE` agents (`agents/*.agent.md` -> `04_AGENTS/*.md`) cover the required analytical capabilities as follows:

| Requested Capability | Existing OS2 Agent / Deterministic Engine Used |
|---|---|
| **Researcher** | 20 Research Specialists (`suno-researcher`, `lyrics-rhyme-systems-researcher`, `ai-vocal-systems-researcher`, etc.) |
| **Evidence Engine** | `research-orchestrator` + deterministic `validateEvidence` & `Os3ResearchEngine.recordEvidence()` |
| **Contradiction Engine** | `research-orchestrator` + deterministic `Os3ResearchEngine.recordFinding()` / `resolveContradiction()` |
| **Fact Checker** | `evaluation-researcher` + verbatim source quote verification |
| **Historian** | `model-version-changelog-researcher` |
| **Methodologist** | `benchmark-scoring-methodology-researcher` + `summarizeExperiment` |
| **Hypothesis Generator** | `research-orchestrator` + `createQuestion()` / `designExperiment()` |
| **Devil's Advocate** | `negative-prompt-failure-mode-researcher` |
| **Science Advisor** | `benchmark-scoring-methodology-researcher` |
| **Technology Assessor** | `frontier-tool-scanner-researcher` & `mix-master-ai-tooling-researcher` |
| **Trend Forecaster** | `release-strategy-platform-algo-researcher` & `frontier-tool-scanner-researcher` |
