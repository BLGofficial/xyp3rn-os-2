# XYP3RN OS 3.0 + DAW Brain — Canonical Obsidian Vault Foundation (Phase 03)

**Status:** Phase 03 Implementation Delivered  
**Implementation Root:** `core/vault-engine/`  
**Verified Schemas & Templates:** 32 `v3` schemas · 32 validated templates (covering all 22 requested document types + existing OS3 types)

---

## 1. Canonical 14-Folder Obsidian Vault Structure

Implemented in [path-guard.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/path-guard.ts) (`OS3_VAULT_DIRS`) and provisioned non-destructively by [vault-foundation.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-foundation.ts) (`REQUIRED_OS3_VAULT_SUBDIRS`):

| Sector Directory | Subdirectories | Purpose & Authority |
|---|---|---|
| `00_SYSTEM/` | `SCHEMAS/`, `TEMPLATES/` | System manifest (`SYSTEM_MANIFEST.md`), taxonomy (`TAXONOMY.md`), 32 schema contracts, 32 document templates |
| `01_CORE/` | `IDENTITY/`, `SYSTEM_PROMPTS/`, `AGENT_REGISTRY/`, `TOOL_REGISTRY/`, `DASHBOARDS/`, `TASKS/` | Core OS identity, JARVIS routing prompt, synced agent/tool indices, operational dashboards & tasks |
| `02_KNOWLEDGE/` | `CANONICAL/`, `SOURCES/`, `PROMPT_LIBRARY/`, `FRAMEWORKS/`, `GLOSSARY/` | Promotion-gated canonical rules, canonical prompts, prompt variants, ingested source material |
| `03_RESEARCH_INTELLIGENCE/` | `PROJECTS/`, `QUESTIONS/`, `EVIDENCE/`, `FINDINGS/`, `CONTRADICTIONS/`, `EXPERIMENTS/`, `RUNS/`, `SPECIALISTS/` | Evidence-grounded research workflows, verbatim quotes, contradiction ledgers, specialist rosters |
| `04_AGENTS/` | *(flat agent files)* | Validated `xyp3rn.agent/v3` Markdown/YAML agent definitions (synced from `agents/*.agent.md`) |
| `05_WORKFLOWS/` | `DEFINITIONS/` | Validated `xyp3rn.workflow/v3` documentation + canonical `.workflow.yaml` workflow definitions |
| `06_RECORDS/` | `DECISIONS/`, `ADR/`, `RELEASES/`, `TRACKS/`, `RIGHTS/`, `TASKS/` | Decision logs, Architecture Decision Records (ADR), release catalog, ISRC tracks, GS1 UPC, 100.000% splits |
| `07_TECH/` | `PRODUCTS/`, `AUDIO_TOOLS/`, `AI_SYSTEMS/`, `R_AND_D/`, `TRACE/` | Technical product engineering, TRACE audio tooling specs, R&D engineering backlog |
| `08_GOVERNANCE/` | `POLICIES/`, `STANDARDS/`, `ACCESS_CONTROL/`, `APPROVALS/`, `AUDIT_LOGS/` | Enforceable policies (`POL-0001`, `POL-0002`), access control, human approval ledgers, audit logs |
| `09_X3LIUS_MUSIC/` | `SONGS/`, `LYRICS/`, `VOCAL_DNA/`, `COMPOSITIONS/`, `ARRANGEMENTS/`, `GENRES_STYLES/`, `SUNO_PACKAGES/`, `TAKES/`, `EVALUATION/`, `AUDIO_EXTRACTED_PROMPTS/` | X3LIUS creative songwriting workspaces, immutable lyric versions, audio reverse-engineered prompt extractions |
| `10_DAW_BRAIN/` | `SESSIONS/`, `CAPABILITIES/`, `ADAPTERS/`, `PLUGINS/`, `PLUGIN_CHAINS/`, `AUDIO_ANALYSES/`, `DSP_CONCEPTS/`, `MIX_MASTER_REFS/`, `WORKFLOWS/` | DAW-agnostic production intelligence, FL Studio 2025 / REAPER adapter specs, Plugin Brain & Audio Brain specs |
| `11_INBOX/` | *(staging root)* | Default Obsidian new-note location (`newFileFolderPath: "11_INBOX"`) and operator draft staging |
| `12_ARCHIVE/` | `SUPERSEDED/`, `RETIRED/` | Explicit non-destructive destination for superseded and archived Vault records |
| `_attachments/` | *(binary media)* | Non-executable Vault attachments (`attachmentFolderPath: "_attachments"`) |

> **Legacy Compatibility Without Auto-Migration:** When an existing Vault already contains legacy directories such as `10_INBOX/`, `11_ARCHIVE/`, `02_KNOWLEDGE_LAYER/`, `04_RESEARCH_MATERIAL/`, `05_XYP3RN_RECORDS/`, or `06_GOVERNANCE/`, those folders remain readable and scannable in `VAULT_SECTORS` (`path-guard.ts`) and `DEFAULT_WRITABLE_SECTORS` (`vault-config.ts`). Zero files are automatically moved or overwritten.

---

## 2. Reconciliation With Six-Sector `UI-xyp3rn` Constellation Taxonomy

Defined programmatically in `UI_SECTOR_RECONCILIATION` ([path-guard.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/path-guard.ts)) and exported by `pnpm.cmd vault:os3 reconcile`:

| UI Sector (`LEGACY_UI_SECTORS`) | UI Display Name | Functional Domains | Mapped Vault Directories | Semantic Invariant |
|---|---|---|---|---|
| `01_CORE` | `CORE ENGINE` | `CORE`, `TECH` | `00_SYSTEM`, `01_CORE`, `04_AGENTS`, `05_WORKFLOWS`, `07_TECH`, `11_INBOX` | Runtime orchestration, agents, workflows, intake, and tech telemetry without absorbing raw research sources |
| `02_KNOWLEDGE_LAYER` | `KNOWLEDGE LAYER` | `KNOWLEDGE` | `02_KNOWLEDGE`, `02_KNOWLEDGE_LAYER`, `ROOT_KB` | Promotion-gated canonical knowledge (`CANONICAL/`, `PROMPT_LIBRARY/`, `FRAMEWORKS/`, `GLOSSARY/`) |
| `03_RESEARCH_INTELLIGENCE` | `RESEARCH INTELLIGENCE` | `RESEARCH_INTELLIGENCE` | `03_RESEARCH_INTELLIGENCE` | Projects, questions, verbatim evidence, findings, contradictions, experiments, specialists |
| `04_RESEARCH_MATERIAL` | `RESEARCH MATERIAL` | `KNOWLEDGE`, `RESEARCH_INTELLIGENCE` | `04_RESEARCH_MATERIAL`, `02_KNOWLEDGE/SOURCES` | Raw ingested source library; **never merged with `07_TECH/` or `10_DAW_BRAIN/`** |
| `05_XYP3RN_RECORDS` | `XYP3RN RECORDS` | `RECORDS` | `06_RECORDS`, `05_XYP3RN_RECORDS`, `09_X3LIUS_MUSIC`, `10_DAW_BRAIN`, `_attachments` | Records catalog operations, X3LIUS creative catalog, and DAW Brain production intelligence |
| `06_GOVERNANCE` | `GOVERNANCE` | `GOVERNANCE` | `08_GOVERNANCE`, `06_GOVERNANCE`, `12_ARCHIVE` | Governance policies, human approvals, access control, audit logs, archived/superseded history |

---

## 3. Document Types, Schemas (`v3`) & Templates

All 32 recognized `v3` schemas are defined in [vault-schemas.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-schemas.ts) (`RECOGNIZED_OS3_SCHEMAS`), documented in `00_SYSTEM/SCHEMAS/<name>.schema.md`, and templated in `00_SYSTEM/TEMPLATES/<name>.template.md`:

| Category / Requested Document Type | Schema ID | Template File | Document-Specific Required Fields & Invariants |
|---|---|---|---|
| Base Entity | `xyp3rn.entity/v3` | `entity.template.md` | `title`, `domain` |
| **Agent** | `xyp3rn.agent/v3` | `agent.template.md` | `name`, `class`, `domain`, `model`, `capabilities`, `tools` |
| **Tool** | `xyp3rn.tool/v3` | `tool.template.md` | `name`, `title`, `domain`, `capability`, `allowed_classes` + strict `provenance` |
| Skill | `xyp3rn.skill/v3` | `skill.template.md` | `name`, `domain`, `capability` |
| **Workflow** | `xyp3rn.workflow/v3` | `workflow.template.md` | `name`, `domain`, `steps` |
| **Knowledge article** | `xyp3rn.knowledge/v3` | `knowledge.template.md` | `title`, `domain`, `status` |
| **Canonical prompt** | `xyp3rn.canonical-prompt/v3` | `canonical-prompt.template.md` | `title`, `domain`, `prompt_text`, `model_scope`, `promoted_via` + strict `provenance` |
| **Prompt variant** | `xyp3rn.prompt-variant/v3` | `prompt-variant.template.md` | `title`, `domain`, `parent_prompt_id`, `variant_label`, `model_scope`, `prompt_text` + strict `provenance` |
| Source | `xyp3rn.source/v3` | `source.template.md` | `title`, `domain`, `origin` |
| **Research project** | `xyp3rn.research-project/v3` | `research-project.template.md` | `slug`, `title`, `domain` |
| Research question | `xyp3rn.research-question/v3` | `research-question.template.md` | `project_slug`, `title`, `domain` |
| **Evidence** | `xyp3rn.evidence/v3` | `evidence.template.md` | `title`, `source_ref`, `verbatim_quote`, `confidence` (`0 <= confidence <= 1`) |
| **Research finding** | `xyp3rn.finding/v3` | `finding.template.md` | `title`, `confidence` (`0 <= confidence <= 1`), `evidence_ids` |
| Contradiction | `xyp3rn.contradiction/v3` | `contradiction.template.md` | `title`, `claim_topic` |
| Experiment | `xyp3rn.experiment/v3` | `experiment.template.md` | `title`, `trial_count` |
| **Architecture decision** | `xyp3rn.decision-record/v3` | `decision-record.template.md` | `decision_key`, `title`, `decided_by` |
| **Song** | `xyp3rn.song/v3` | `song.template.md` | `title`, `artist`, `language` |
| Lyric | `xyp3rn.lyric/v3` | `lyric.template.md` | `lineage_id`, `title`, `language` |
| Track | `xyp3rn.track/v3` | `track.template.md` | `title`, `position` |
| **Release** | `xyp3rn.release/v3` | `release.template.md` | `title`, `artist`, `kind` |
| Rights split | `xyp3rn.rights-split/v3` | `rights-split.template.md` | `title`, `total_percentage` (`=== 100`), `has_unassigned_share` (`false` when non-draft), `shares` |
| **Production session** | `xyp3rn.production-session/v3` | `production-session.template.md` | `title`, `daw_host`, `daw_edition`, `project_path`, `state_tier` (`liveObserved` \| `cached` \| `savedProject` \| `proposedModifications` \| `appliedModifications`) + strict `provenance` |
| **DAW capability** | `xyp3rn.daw-capability/v3` | `daw-capability.template.md` | `title`, `capability_id`, `permission_tier` (`observe..rollback`), `host_support` (`SUPPORTED` \| `TEMPLATE_SCOPED` \| `READ_ONLY` \| `UNSUPPORTED`) + strict `provenance` |
| **DAW adapter** | `xyp3rn.daw-adapter/v3` | `daw-adapter.template.md` | `title`, `adapter_id`, `host_name`, `transport_protocol`, `supported_capabilities` + strict `provenance` |
| **Plugin** | `xyp3rn.daw-plugin/v3` | `daw-plugin.template.md` | `title`, `plugin_format`, `vendor`, `category`, `edition_requirement` + strict `provenance` |
| **Plugin chain** | `xyp3rn.daw-plugin-chain/v3` | `daw-plugin-chain.template.md` | `title`, `stage`, `plugins` (non-empty array) + strict `provenance` |
| **Audio analysis** | `xyp3rn.audio-analysis/v3` | `audio-analysis.template.md` | `title`, `analysis_schema`, `source_sha256`, `integrated_lufs` (`[-120, 3]`), `true_peak_dbtp` (`[-120, 24]`) + strict `provenance` |
| **DSP concept** | `xyp3rn.dsp-concept/v3` | `dsp-concept.template.md` | `title`, `domain`, `category`, `acoustic_principle` + strict `provenance` |
| **Mix/mastering reference** | `xyp3rn.mix-reference/v3` | `mix-reference.template.md` | `title`, `stage` (`mix` \| `master`), `target_lufs_min <= target_lufs_max`, `max_true_peak_dbtp <= 0` + strict `provenance` |
| **Production workflow** | `xyp3rn.production-workflow/v3` | `production-workflow.template.md` | `title`, `target_daw`, `stage`, `workflow_steps` (non-empty array) + strict `provenance` |
| **Governance policy** | `xyp3rn.policy/v3` | `policy.template.md` | `title`, `domain`, `enforcement` |
| Approval record | `xyp3rn.approval/v3` | `approval.template.md` | `title`, `item_type`, `item_id`, `proposer` |

---

## 4. Standard Frontmatter Metadata & Validation Rules

Enforced in [schema-validator.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/schema-validator.ts) (`validateEntityContent`, `assertValidEntityContent`):

- **Stable ID (`id`):** Required non-empty kebab/dot/underscore string matching `/^[a-z0-9][a-z0-9._-]{2,127}$/i`, unique across the Vault.
- **Type & Classification (`type`, `title`, `domain`, `sector`):** `domain` must belong to `DOMAINS` (`CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`); `sector` must belong to `VAULT_SECTORS` (+ `ROOT_KB` compatibility).
- **Lifecycle Status (`status`):** Checked against `VALID_ENTITY_STATUSES`.
- **Versioning (`version`):** Positive integer (`>= 1`).
- **Timestamps (`created_at`, `updated_at`):** Valid ISO-8601 parseable timestamps (mandatory on all `STRICT_PROVENANCE_SCHEMAS` and generated by `writeNoteWithFrontmatter`).
- **Provenance (`provenance`):** Mandatory non-empty string or object on all 12 `STRICT_PROVENANCE_SCHEMAS`.
- **Tags (`tags`):** Must be an array of strings when present.
- **Secret Hygiene:** Blocks API key patterns (`sk-or-v1-...`, `sk-ant-...`, `gsk_...`, `AIza...`, PEM private keys).
- **Canonical Path Protection (`CANONICAL_PATH_PREFIXES` in `path-guard.ts`):** Canonical knowledge, system prompts, agent registry, research findings, ADRs, policies, releases/splits, and DAW canonical capabilities/adapters/mix references (`10_DAW_BRAIN/{CAPABILITIES,ADAPTERS,MIX_MASTER_REFS}/`) cannot be mutated directly without the Promotion Gate.

---

## 5. Safety, Non-Destructive Provisioning, Archive & Supersession Rules

### 5.1 Zero Silent Overwrites & Zero Automatic Legacy Migration
- `writeNoteWithFrontmatter()` and `.workflow.yaml` copying inside [vault-foundation.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-foundation.ts) strictly return `'unchanged'` whenever the destination file already exists (`exists(absPath)`).
- Legacy notes (e.g., `10_INBOX/`, `11_ARCHIVE/`) are preserved untouched and remain scannable/validatable in place.
- `VaultEngine.writeNote()` defaults to `writeMode: 'no-overwrite'`; updates require `compare-and-swap` (`expectedSha256`) and automatically create content-addressed backup revisions in `.vault-revisions/`.

### 5.2 Explicit Archive & Supersession (`vault-archive.ts`)
Implemented in [vault-archive.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-archive.ts) and enforced in `schema-validator.ts`:
- `status: "archived"` requires non-empty `archive_reason` and valid ISO `archived_at` (with explicit legacy exemption solely for pre-existing `id: arch-0001-archive-index`).
- `status: "superseded"` requires non-empty `superseded_by` (target entity ID or Vault path) and valid ISO `superseded_at`.
- `archiveVaultNote(vault, req)` copies a non-canonical note to `12_ARCHIVE/{SUPERSEDED|RETIRED}/<date>-<filename>` with a unique archive ID (`arch-...`), `archived_from`, and `previous_sha256` without overwriting existing files.
- `supersedeVaultNote(vault, req)` archives an immutable backup into `12_ARCHIVE/SUPERSEDED/` first, then CAS-updates the prior note (`expectedSha256`) to `status: "superseded"`.
- Canonical documents throw `CANONICAL_WRITE_FORBIDDEN` on direct archive/supersede calls so Promotion Gate approval cannot be bypassed.

---

## 6. Validation CLI Scripts & Test Verification

Defined in `package.json` and [cli.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/cli.ts):

- `pnpm.cmd vault:os3 provision` — Creates missing OS3 Vault folders/templates/schemas/examples non-destructively, validates the Vault, and updates SQLite index.
- `pnpm.cmd vault:validate` (or `pnpm.cmd vault:os3 validate`) — Runs `validateOs3Vault()`, checking all 14 sector subtrees, 32 templates, YAML syntax, unique IDs, recognized schemas, full metadata/domain invariants, secret hygiene, and `.obsidian/*.json`.
- `pnpm.cmd vault:validate-templates` (or `pnpm.cmd vault:os3 validate-templates`) — Runs `validateAllTemplates()`, verifying every file in `00_SYSTEM/TEMPLATES/` and checking that all 32 template specs exist and satisfy `validateEntityContent(..., { requireSchema: true })`.
- `pnpm.cmd vault:os3 reconcile` — Outputs the JSON `UI_SECTOR_RECONCILIATION` contract mapping.
- `pnpm.cmd vitest run tests/os3-phase3-vault/vault-foundation.test.ts` — Verifies 14-folder provisioning, 32-template validation, 6-sector UI reconciliation, document-specific schema invariants, no-silent-overwrite safety, legacy preservation, and explicit archive/supersession flows.
