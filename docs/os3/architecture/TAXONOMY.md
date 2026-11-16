# XYP3RN OS 3.0 — Domain & Vault Sector Taxonomy Specification

**Status:** Phase 2 Architecture Freeze
**Contract Owner:** `core/contracts/taxonomy.ts` + `core/vault-engine/path-guard.ts`

---

## 1. Separation of Functional Domains and Physical Vault Sectors

A foundational invariant of XYP3RN OS 3.0 is that **Functional Domains** (who owns business logic and agent authorization) and **Vault Sectors** (where files live inside the Obsidian Vault and how `UI-xyp3rn` lays out its 6-sector constellation ring) are **orthogonal dimensions**.

> [!CAUTION]
> **Non-Negotiable Rule:** Never conflate or silently merge `04_RESEARCH_MATERIAL` (Vault Sector 04) with `TECH` (Functional Domain 5).
> - `04_RESEARCH_MATERIAL` is the physical Vault sector holding raw ingested source documents, papers, articles, books, transcripts, datasets, media, and web clippings.
> - `TECH` (`XYP3RN Tech`) is the functional engineering domain owning Audio Tools (`TRACE`), Products, AI Systems, and R&D (`tech/`).

### 1.1. The Six Functional Domains (`Domain`)

Defined in `core/contracts/taxonomy.ts`:

| Domain ID | Code Directory | Label | Domain Color | Owns (Functional Responsibility) |
|---|---|---|---|---|
| `CORE` | `core/` | Core | `#22d3ee` | Orchestrator, JARVIS Core, Agent Registry, Tool Registry, Workflow Engine, Context Engine, Memory, SQLite Runtime, Observability. |
| `KNOWLEDGE` | `knowledge/` | Knowledge Layer | `#a78bfa` | Vault Engine, Promotion Gate, Source Registry, Vector Retrieval, Structural/Graph Index, Versioning & Provenance. |
| `RESEARCH_INTELLIGENCE` | `research-intelligence/` | Research Intelligence | `#f59e0b` | Research Orchestrator, 20 Specialists, Evidence Engine, Verbatim Quote Verifier, Contradiction Engine, Experiment Engine, Synthesis, Findings Library. |
| `RECORDS` | `records/` | XYP3RN Records | `#ef4444` | **X3LIUS Music System** (Songwriting, Lyrics, Vocal DNA, Composition, Arrangement, Genre/Style, Suno, Production, Mix/Master, Evaluation) + **Records Ops** (Songs, Releases, Tracks, Rights Splits, Credits, Platform Links, Deliveries, Tasks). |
| `TECH` | `tech/` | XYP3RN Tech | `#10b981` | TRACE Audio Analysis Service (`trace.analysis/v1` → `trace.report/v1`), Products, AI Systems, R&D Backlog (`rd_backlog`). |
| `GOVERNANCE` | `governance/` | Governance | `#94a3b8` | Legal, Rights-Conflict Checks, Tool Capability Matrix, Human Approval Queue (`pending_approvals`), Append-Only Audit Trail. |

---

### 1.2. The Six Physical Vault Sectors (`VaultSector`) + `ROOT_KB`

Defined in `core/vault-engine/path-guard.ts` and `UI-xyp3rn/lib/types.ts`:

| Vault Sector ID | UI-xyp3rn Label | UI Sector Color | Subfolders (Clusters) | Owning Functional Domain(s) |
|---|---|---|---|---|
| `01_CORE` | `CORE ENGINE` | `#38BDF8` | `00_Identity`, `01_System_Prompts`, `02_Agents`, `03_Workflows`, `04_Templates`, `05_Dashboards`, `06_Tasks`, `07_Tools` | `CORE` ( Tech & Domain agents in `02_Agents/` carry their own frontmatter `domain`). |
| `02_KNOWLEDGE_LAYER` | `KNOWLEDGE LAYER` | `#8B7CF6` | `00_MOCs`, `01_Concepts`, `02_Frameworks`, `03_Playbooks`, `04_Atomic_Notes`, `05_Glossary`, `Prompt_Knowledge` | `KNOWLEDGE` (Promotion Gate is the sole writer; `tech.manifest.yaml` and `mix-rubric.yaml` live in `02_Frameworks/` with `domain: TECH` / `RECORDS`). |
| `03_RESEARCH_INTELLIGENCE` | `RESEARCH INTELLIGENCE` | `#EC6A9C` | `00_Briefs`, `01_Analyses`, `02_Competitive_Intel`, `03_Trend_Signals`, `04_Hypotheses`, `05_Syntheses`, `06_Specialists` | `RESEARCH_INTELLIGENCE` (plus `TECH` R&D analyses in `01_Analyses/` with `domain: TECH`). |
| `04_RESEARCH_MATERIAL` | `RESEARCH MATERIAL` | `#E8C53A` | `00_Inbox`, `01_Papers`, `02_Articles`, `03_Books`, `04_Transcripts`, `05_Datasets`, `06_Media`, `07_Web_Clippings` | `KNOWLEDGE` (Source Registry) & `RESEARCH_INTELLIGENCE` (fetched research sources). **Never merged with `TECH`.** |
| `05_XYP3RN_RECORDS` | `XYP3RN RECORDS` | `#3ECFB2` | `00_Daily_Notes`, `01_Session_Logs`, `02_Decisions_ADR`, `03_Projects`, `04_Meetings`, `05_Releases`, `06_X3LIUS_MUSIC_SYSTEM/{00_Songs..07_Suno_Prompts}`, `99_Archive` | `RECORDS` (`02_Decisions_ADR` may carry `domain: CORE | GOVERNANCE`). |
| `06_GOVERNANCE` | `GOVERNANCE` | `#E5484D` | `00_Policies`, `01_Standards`, `02_Access_Control`, `03_Risk_Register`, `04_Compliance`, `05_Audit_Logs`, `06_Changelog` | `GOVERNANCE` |
| `ROOT_KB` *(Legacy Root Corpus)* | Indexed under `KNOWLEDGE` | `#8B7CF6` | Root-level `BEST-*`, `PROMPT-*`, `TAG-*`, `TECH-*`, `VOC-*`, `WF-*`, `GEN-*`, `FAIL-*`, `_COMMUNITY_*` notes in `XYP3RN-Suno-KB-v1.2-Brain` | `KNOWLEDGE` (19,632 canonical read-only Suno v5/v6 knowledge notes). |

---

## 2. Entity Types, Canonical Paths & File Ownership

| Entity Type (`type` in Frontmatter) | Schema ID | Owning Functional Domain | Target Vault Sector & Subfolder | Canonical (Gate-Only Write)? |
|---|---|---|---|---|
| `identity` / `system_prompt` | `xyp3rn.policy/v3` | `CORE` | `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/` | **Yes** |
| `agent` | `xyp3rn.agent/v3` | Declared in frontmatter (`CORE`..`GOVERNANCE`) | `01_CORE/02_Agents/<name>.md` (+ `03_RESEARCH_INTELLIGENCE/06_Specialists/<name>.md`) | Synced from `agents/*.agent.md` |
| `workflow` | `xyp3rn.workflow/v3` | Declared in frontmatter (`CORE`, `RECORDS`, `TECH`) | `01_CORE/03_Workflows/<name>.workflow.yaml` + `<name>.md` | Synced from repo `*.workflow.yaml` |
| `skill` / `tool` | `xyp3rn.skill/v3` | `CORE` | `01_CORE/07_Tools/<name>.md` | **Yes** |
| `task` | `xyp3rn.entity/v3` | `CORE` / `RECORDS` | `01_CORE/06_Tasks/<slug>.md` | No (`records-tasks` Execution agent) |
| `knowledge` | `xyp3rn.knowledge/v3` | `KNOWLEDGE` | `02_KNOWLEDGE_LAYER/{01_Concepts,02_Frameworks,03_Playbooks,04_Atomic_Notes,05_Glossary}/` & `ROOT_KB` | **Yes (`PromotionGate` only)** |
| `source` | `xyp3rn.source/v3` | `KNOWLEDGE` / `RESEARCH_INTELLIGENCE` | `04_RESEARCH_MATERIAL/{00_Inbox..07_Web_Clippings}/` + `.vault/<sha256>` | No (`vault-curator` / `fetch_source`; immutable once ingested) |
| `research_project` | `xyp3rn.research-project/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/00_Briefs/<project-slug>.project.md` | No (`research-orchestrator`) |
| `research_question` (Brief) | `xyp3rn.research-question/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/00_Briefs/<date>-<slug>.md` | No (`research-orchestrator`) |
| `evidence` | `xyp3rn.evidence/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/01_Analyses/<run-id>-evidence.md` | No (Append-only, verbatim quote checked) |
| `finding` | `xyp3rn.finding/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/05_Syntheses/<finding-id>.md` | No (Owner accepts into Findings Library; promotes via Gate) |
| `contradiction` | `xyp3rn.contradiction/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/04_Hypotheses/contradiction-<id>.md` | No (System-detected; resolved by `xyp_verifier` / human) |
| `experiment` | `xyp3rn.experiment/v3` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE/04_Hypotheses/experiment-<id>.md` | No |
| `decision_record` (ADR) | `xyp3rn.decision-record/v3` | `CORE` / `GOVERNANCE` | `05_XYP3RN_RECORDS/02_Decisions_ADR/ADR-<nnnn>-<slug>.md` | **Yes** |
| `song` | `xyp3rn.song/v3` | `RECORDS` | `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/00_Songs/<slug>.md` | No (`records-songs`, revisioned) |
| `lyric` | `xyp3rn.lyric/v3` | `RECORDS` | Drafts: `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/01_Lyrics/<slug>-v<n>.md`; Approved: `0444` read-only | Approved versions are read-only (`0444`) |
| `track` | `xyp3rn.track/v3` | `RECORDS` | `05_XYP3RN_RECORDS/05_Releases/tracks/<slug>.md` + audio in `06_Audio/` | No (`records-catalog`, ISRC once-only) |
| `release` | `xyp3rn.release/v3` | `RECORDS` | `05_XYP3RN_RECORDS/05_Releases/<slug>.md` | No (`records-catalog` / `records-release-calendar`) |
| `rights_split` | `xyp3rn.rights-split/v3` | `RECORDS` (audited by `GOVERNANCE`) | `05_XYP3RN_RECORDS/05_Releases/splits/<track-slug>-v<n>.md` | Append-only; requires human approval via `propose-split` |
| `policy` | `xyp3rn.policy/v3` | `GOVERNANCE` | `06_GOVERNANCE/{00_Policies,01_Standards,02_Access_Control}/<slug>.md` | **Yes** |
| `approval` | `xyp3rn.approval/v3` | `GOVERNANCE` | Operational row in SQLite `pending_approvals` + audit note in `06_GOVERNANCE/05_Audit_Logs/` | Decided by human operator only |

---

## 3. Tagging & Relationship Taxonomy

### 3.1. Tag Namespaces
- `xyp3rn` — root OS marker tag on all OS-managed notes.
- `domain/<core|knowledge|research|records|tech|governance>` — functional domain tag.
- `status/<draft|pending_approval|approved|canonical|rejected|archived>` — lifecycle tag.
- `model/<suno-v5|suno-v5.5|suno-v6|suno-v6-wild|rvc|trace|model-agnostic>` — tool/model scope tag (`F20`, `F23`, `F24`).
- `community/<Cluster_Name>` & `graphify/<concept|EXTRACTED>` — preserved tags across the 19,632 `ROOT_KB` Suno knowledge notes.

### 3.2. Typed Relationships (Wikilinks & Frontmatter Edges)
Every relationship between entities is expressed in Markdown via `[[target|alias]]` wikilinks and/or typed frontmatter arrays (`links`), indexed into SQLite `index_state.wikilinks_json`:
- `builds_on` — upstream dependency job/note (`Job.buildsOn`).
- `breaks_into` — downstream sub-skill or satellite note (`Job.breaksInto`).
- `cites_source` — `evidence` / `finding` → `source` (`04_RESEARCH_MATERIAL/`).
- `contradicts` — `finding` / `candidate` ↔ `knowledge` (same `claim_topic` and overlapping `model_scope` with differing value).
- `promoted_from` — `knowledge` (`02_KNOWLEDGE_LAYER/`) → `finding` (`03_RESEARCH_INTELLIGENCE/05_Syntheses/`) + `approval_id`.
- `revision_of` — version `v(n)` → parent version `v(n-1)` (`previous_sha256`).
- `belongs_to_song` — `lyric`, `suno_package`, `take`, `track`, or `research_question` → `song` (`00_Songs/<slug>.md`).
- `part_of_release` — `track` & `rights_split` → `release` (`05_Releases/<slug>.md`).
