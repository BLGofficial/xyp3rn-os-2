# XYP3RN OS 3.0 — Data Architecture & Versioned File Schemas

**Status:** Phase 2 Architecture Freeze

---

## 1. Five Laws of Data Ownership

1. **Obsidian Vault = Canonical Content (`C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain`):**
   - Every piece of canonical knowledge, agent definition, workflow specification, skill, research brief, evidence, finding, contradiction, experiment, ADR decision, song, lyric, track, release, rights split, and governance policy lives as a human-readable Markdown (`.md`) or YAML (`.yaml`) file inside the external Obsidian Vault (with binary audio/image/PDF blobs content-addressed in `.vault/<sha256>`).
   - **Zero duplicated canonical storage:** No SQL database table holds canonical knowledge or creative truth.
2. **Minimal Local SQLite = Operational Runtime State (`.local-db/xyp3rn-os3.sqlite`):**
   - SQLite owns strictly operational state: `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, and disposable `index_state` / `index_meta`.
3. **Git + `.vault-revisions/` = Source History & Immutable Rollback:**
   - Every file mutation through `VaultEngine` archives an immutable content-addressed snapshot in `<vault>/.vault-revisions/<sha256[0..1]>/<sha256>.blob` with metadata (`.meta.json`: `previousSha256`, `actor`, `createdAt`) alongside Git version control.
4. **Search & Graph Indexes = Rebuildable Derived Data:**
   - `index_state` in SQLite and `gte-small` vector embeddings are 100% derived caches. Deleting `.local-db/xyp3rn-os3.sqlite`'s `index_state` loses zero user data and is rebuilt by `pnpm vault:os3 scan`.
5. **UI State = Presentation State Only (`UI-xyp3rn`):**
   - Camera pan/zoom, open/collapsed sector rings, and UI visual overrides in `localStorage` (`xyp3rn.constellation.status.v1`) are purely presentation state.

---

## 2. Versioned File Schemas (`v3`)

Every Markdown file managed by XYP3RN OS 3.0 begins with a YAML frontmatter block fenced by `---` that conforms to the **Base Entity Schema (`xyp3rn.entity/v3`)** plus its type-specific fields.

### 2.1. Base Entity (`xyp3rn.entity/v3`)
```yaml
---
schema: "xyp3rn.entity/v3"
id: "uuid-or-kebab-slug"
type: "entity_type"
title: "Human-Readable Title"
domain: "CORE | KNOWLEDGE | RESEARCH_INTELLIGENCE | RECORDS | TECH | GOVERNANCE"
sector: "01_CORE | 02_KNOWLEDGE_LAYER | 03_RESEARCH_INTELLIGENCE | 04_RESEARCH_MATERIAL | 05_XYP3RN_RECORDS | 06_GOVERNANCE"
status: "draft | pending_approval | approved | canonical | rejected | archived | live | in-development | not-started"
version: 1
source_sha256: "64-char-hex-sha256-of-body"
previous_sha256: null # or 64-char hex of parent revision
tags:
  - "xyp3rn"
created_at: "2026-11-16T00:00:00.000Z"
updated_at: "2026-11-16T00:00:00.000Z"
---
```

---

### 2.2. Agent (`xyp3rn.agent/v3`)
- **Path:** `01_CORE/02_Agents/<name>.md` (and `03_RESEARCH_INTELLIGENCE/06_Specialists/<name>.md` for Research Specialists)
```yaml
---
schema: "xyp3rn.agent/v3"
name: "x3lius-lyrics"
class: "Creative" # One of AGENT_CLASSES
domain: "RECORDS" # One of DOMAINS
description: "Writes section-by-section whole-song lyrics grounded in structure and Vocal DNA."
model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free" # or "none" for deterministic agents
capabilities:
  - "context.read"
  - "log.write"
  - "artifact.read"
  - "artifact.write"
tools:
  - "retrieve_context"
  - "retrieve_claims"
  - "read_artifact"
  - "write_artifact"
  - "log_message"
inputSchema:
  type: "object"
  required: ["request"]
  properties:
    request: { type: "string" }
    structureArtifactId: { type: ["string", "null"] }
outputSchema:
  type: "object"
  required: ["artifactId", "version"]
tags: ["xyp3rn", "agent", "domain/records"]
---
# System Instructions (Markdown body)
```

---

### 2.3. Workflow (`xyp3rn.workflow/v3`)
- **Path:** `01_CORE/03_Workflows/<name>.workflow.yaml` + wrapper `<name>.md`
```yaml
schema: "xyp3rn.workflow/v3"
name: "song-to-suno"
description: "Brief -> Songwriting structure -> Whole-song lyrics -> Genre/Style -> Suno Prompt Formula."
domain: "RECORDS"
requiredInput:
  - "request"
  - "sunoModel"
optionalInput:
  - "songId"
steps:
  - id: "structure"
    agent: "x3lius-songwriting"
    dependsOn: []
    input:
      request: "$input.request"
  - id: "lyrics"
    agent: "x3lius-lyrics"
    dependsOn: ["structure"]
    input:
      request: "$input.request"
      structureArtifactId: "$steps.structure.output.artifactId"
output:
  lyricsArtifactId: "$steps.lyrics.output.artifactId"
```

---

### 2.4. Skill / Tool (`xyp3rn.skill/v3`)
- **Path:** `01_CORE/07_Tools/<name>.md`
```yaml
---
schema: "xyp3rn.skill/v3"
id: "vault-write-tool"
type: "skill"
name: "vault_write"
title: "vault.write"
domain: "CORE"
sector: "01_CORE"
capability: "vault.write"
allowed_classes: ["Execution"]
status: "live"
install_cmd: "xyp3rn> write <sector>/<cluster>/<file>.md \"<content>\""
tags: ["xyp3rn", "skill", "tool"]
---
# Tool Specification & No-Overwrite Guard Contract
```

---

### 2.5. Knowledge (`xyp3rn.knowledge/v3`)
- **Path:** `02_KNOWLEDGE_LAYER/{01_Concepts..05_Glossary}/<slug>.md` or `ROOT_KB/<slug>.md`
```yaml
---
schema: "xyp3rn.knowledge/v3"
id: "suno-v6-gravity-counter"
type: "knowledge"
title: "Suno v6 Gravity Counter Rule"
domain: "KNOWLEDGE"
sector: "02_KNOWLEDGE_LAYER"
status: "canonical"
version: 1
promoted_via: "gate" # "gate" | "first-party-ingest"
approval_id: "uuid-of-human-approval"
approved_by: "blago"
approved_at: "2026-11-16T03:00:00.000Z"
model_scope: "suno-v6" # or "model-agnostic" | "rvc" | "trace"
claims:
  - topic: "suno.genre-gravity-escape"
    value: { useMechanicsDescriptors: true, maxDominantGenres: 1 }
    model_scope: "suno-v6"
source_sha256: "64-char-hex"
previous_sha256: null
tags: ["xyp3rn", "canonical", "model/suno-v6"]
---
# Canonical Rule Body & Verbatim Citations
```

---

### 2.6. Source (`xyp3rn.source/v3`)
- **Path:** `04_RESEARCH_MATERIAL/{00_Inbox..07_Web_Clippings}/<slug>.md`
```yaml
---
schema: "xyp3rn.source/v3"
id: "uuid"
type: "source"
title: "Suno v6 Launch Fieldnotes"
domain: "KNOWLEDGE"
sector: "04_RESEARCH_MATERIAL"
origin: "first_party" # "first_party" | "official_docs" | "peer_reviewed" | "community"
uri: "https://..."
media_class: "document" # "document" | "lyric_sheet" | "audio" | "image" | "other"
blob_sha256: "64-char-hex-in-.vault"
byte_size: 48210
mime_type: "application/pdf"
retrieved_at: "2026-11-16T00:00:00.000Z"
tags: ["xyp3rn", "source"]
---
# Extracted Source Text / Transcript
```

---

### 2.7. Research Project (`xyp3rn.research-project/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/00_Briefs/<project-slug>.project.md`
```yaml
---
schema: "xyp3rn.research-project/v3"
id: "uuid"
slug: "suno-v6-drill-acoustics"
type: "research_project"
title: "Suno v6 UK Drill & 808 Glide Mechanics"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
status: "active" # "active" | "completed" | "archived"
tags: ["xyp3rn", "research-project"]
---
```

---

### 2.8. Research Question / Brief (`xyp3rn.research-question/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/00_Briefs/<date>-<slug>.md`
```yaml
---
schema: "xyp3rn.research-question/v3"
id: "uuid"
project_slug: "suno-v6-drill-acoustics"
type: "research_question"
title: "How to preserve 808 slide articulation in Suno v6 acoustic-guitar hybrids?"
intended_use: "Update X3LIUS house style recipe for UK drill releases"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
status: "open" # "open" | "running" | "answered"
allowed_urls:
  - "https://..."
specialists:
  - "suno-researcher"
  - "production-sound-design-researcher"
  - "genre-style-researcher"
linked_targets:
  - kind: "song"
    target: "05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/00_Songs/Neon Static.md"
tags: ["xyp3rn", "research-brief"]
---
```

---

### 2.9. Evidence (`xyp3rn.evidence/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/01_Analyses/<run-id>-evidence.md`
```yaml
---
schema: "xyp3rn.evidence/v3"
id: "uuid"
research_run_id: "uuid"
specialist: "suno-researcher"
type: "evidence"
title: "Evidence on 808 glide retention"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
source_ref: "04_RESEARCH_MATERIAL/02_Articles/suno-v6-guide.md"
source_sha256: "64-char-hex"
verbatim_quote: "Exact substring verified word-for-word against source text."
claim_topic: "suno.808-glide-descriptor"
claim_value: "portamento 808 sub-bass"
model_tag: "suno-v6"
confidence: 0.85
confidence_inputs:
  source_reliability: 0.9
  directness: 0.95
tags: ["xyp3rn", "evidence", "model/suno-v6"]
---
```

---

### 2.10. Finding (`xyp3rn.finding/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/05_Syntheses/<finding-id>.md`
```yaml
---
schema: "xyp3rn.finding/v3"
id: "uuid"
research_run_id: "uuid"
type: "finding"
title: "Explicit portamento descriptors prevent 808 flattening in Suno v6"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
claim_topic: "suno.808-glide-descriptor"
claim_value: "portamento 808 sub-bass"
model_tag: "suno-v6"
confidence: 0.88
evidence_ids:
  - "evidence-uuid-1"
  - "evidence-uuid-2"
owner_decision: "pending" # "pending" | "accepted" | "rejected"
canonical_status: "none" # "none" | "candidate" | "promoted" | "rejected"
tags: ["xyp3rn", "finding", "model/suno-v6"]
---
```

---

### 2.11. Contradiction (`xyp3rn.contradiction/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/04_Hypotheses/contradiction-<id>.md`
```yaml
---
schema: "xyp3rn.contradiction/v3"
id: "uuid"
type: "contradiction"
title: "Conflict on suno.808-glide-descriptor (suno-v6)"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
claim_topic: "suno.808-glide-descriptor"
model_scope: "suno-v6"
finding_ref: "03_RESEARCH_INTELLIGENCE/05_Syntheses/finding-1.md"
conflicting_target_ref: "02_KNOWLEDGE_LAYER/04_Atomic_Notes/existing-rule.md"
status: "open" # "open" | "resolved" | "dismissed"
resolution: null
resolved_at: null
tags: ["xyp3rn", "contradiction"]
---
```

---

### 2.12. Experiment (`xyp3rn.experiment/v3`)
- **Path:** `03_RESEARCH_INTELLIGENCE/04_Hypotheses/experiment-<id>.md`
```yaml
---
schema: "xyp3rn.experiment/v3"
id: "uuid"
candidate_id: "uuid"
type: "experiment"
title: "A/B Trial: Portamento 808 vs Standard 808 Tag in Suno v6"
domain: "RESEARCH_INTELLIGENCE"
sector: "03_RESEARCH_INTELLIGENCE"
status: "validated" # "designed" | "running" | "validated" | "inconclusive"
control_score: 0.65
candidate_score: 0.90
trial_count: 6
scorer: "x3lius-evaluation"
tags: ["xyp3rn", "experiment"]
---
```

---

### 2.13. Decision Record / ADR (`xyp3rn.decision-record/v3`)
- **Path:** `05_XYP3RN_RECORDS/02_Decisions_ADR/ADR-<nnnn>-<slug>.md`
```yaml
---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0001"
decision_key: "F35"
type: "decision_record"
title: "Local-First and Obsidian-First Canonical Architecture"
domain: "CORE"
sector: "05_XYP3RN_RECORDS"
status: "approved" # "proposed" | "approved" | "superseded"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision"]
---
```

---

### 2.14. Song (`xyp3rn.song/v3`)
- **Path:** `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/00_Songs/<slug>.md`
```yaml
---
schema: "xyp3rn.song/v3"
id: "uuid"
type: "song"
title: "Neon Static"
artist: "X3LIUS"
language: "en"
genre: "UK Drill / Dark Synthwave"
bpm: 128
status: "in_studio" # "idea" | "writing" | "in_studio" | "mastered" | "released" | "archived"
revision: 2
links:
  lyrics_ref: "05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/01_Lyrics/Neon-Static_1.md"
  suno_package_ref: "05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/07_Suno_Prompts/Neon-Static.md"
  audio_ref: "05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/06_Audio/neon-static-master.mp3"
tags: ["xyp3rn", "x3lius", "song"]
---
```

---

### 2.15. Lyric (`xyp3rn.lyric/v3`)
- **Path:** `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/01_Lyrics/<slug>_<version>.md`
```yaml
---
schema: "xyp3rn.lyric/v3"
id: "artifact-uuid"
lineage_id: "lineage-uuid"
version: 1
type: "lyric"
title: "Neon Static"
author: "X3LIUS"
domain: "RECORDS"
sector: "05_XYP3RN_RECORDS"
language: "en"
genre: "UK Drill"
status: "approved" # "draft" | "approved" | "canonical"
mixed_script_checked: true
vocal_dna_ref: "[[05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/02_Vocal_DNA/vocal-dna.yaml]]"
source_sha256: "64-char-hex"
tags: ["xyp3rn", "x3lius", "lyrics"]
---
# Neon Static

## [VERSE 1]
...
```

---

### 2.16. Track (`xyp3rn.track/v3`)
- **Path:** `05_XYP3RN_RECORDS/05_Releases/tracks/<slug>.md`
```yaml
---
schema: "xyp3rn.track/v3"
id: "uuid"
type: "track"
title: "Neon Static"
release_ref: "[[05_XYP3RN_RECORDS/05_Releases/Night-Signals-EP.md]]"
position: 1
isrc: "QZAB12600001" # ISO 3901 without hyphens; immutable once set
recording_kind: "vault_audio" # "suno_take" | "vault_audio"
audio_ref: "05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/06_Audio/neon-static-master.mp3"
audio_sha256: "64-char-hex"
duration_seconds: 194
mix_report_ref: null
tags: ["xyp3rn", "records", "track"]
---
```

---

### 2.17. Release (`xyp3rn.release/v3`)
- **Path:** `05_XYP3RN_RECORDS/05_Releases/<slug>.md`
```yaml
---
schema: "xyp3rn.release/v3"
id: "uuid"
type: "release"
title: "Night Signals EP"
artist: "X3LIUS"
kind: "ep" # "single" | "ep" | "album"
upc: "012345678905" # GS1 check-digit validated; immutable once set
status: "draft" # "draft" | "scheduled" | "released"
release_date: "2026-12-01"
rights_check_run_id: "agent-run-uuid"
artwork_ref: null
tracks:
  - "[[05_XYP3RN_RECORDS/05_Releases/tracks/Neon-Static.md]]"
tags: ["xyp3rn", "records", "release"]
---
```

---

### 2.18. Rights Split (`xyp3rn.rights-split/v3`)
- **Path:** `05_XYP3RN_RECORDS/05_Releases/splits/<track-slug>-v<version>.md`
```yaml
---
schema: "xyp3rn.rights-split/v3"
id: "uuid"
track_ref: "[[05_XYP3RN_RECORDS/05_Releases/tracks/Neon-Static.md]]"
version: 1
type: "rights_split"
title: "Rights Splits: Neon Static (v1)"
domain: "RECORDS"
sector: "05_XYP3RN_RECORDS"
status: "approved"
approval_id: "approval-uuid"
total_percentage: 100.000 # Invariant F31: must equal exactly 100.000
has_unassigned_share: false # Blocks release scheduling if true
shares:
  - payee: "X3LIUS"
    role: "master_and_publishing"
    percentage: 100.000
tags: ["xyp3rn", "records", "rights-split"]
---
```

---

### 2.19. Policy (`xyp3rn.policy/v3`)
- **Path:** `06_GOVERNANCE/{00_Policies,01_Standards,02_Access_Control}/<slug>.md`
```yaml
---
schema: "xyp3rn.policy/v3"
id: "localhost-binding-policy"
type: "policy"
title: "Localhost Binding Policy"
domain: "GOVERNANCE"
sector: "06_GOVERNANCE"
status: "canonical"
enforcement: "mandatory"
enforced_by:
  - "core/gateway/server.ts"
  - "core/vault-engine/path-guard.ts"
tags: ["xyp3rn", "governance", "policy", "canonical"]
---
```

---

### 2.20. Approval (`xyp3rn.approval/v3`)
- **Operational Storage:** SQLite `pending_approvals` table + canonical audit note in `06_GOVERNANCE/05_Audit_Logs/approval-<id>.md`
```yaml
---
schema: "xyp3rn.approval/v3"
id: "approval-uuid"
type: "approval"
item_type: "vault_promotion" # "knowledge_candidate" | "split_proposal" | "artifact_version" | "critique_escalation" | "rd_backlog_item" | "vault_promotion"
item_id: "candidate-id"
domain: "GOVERNANCE"
sector: "06_GOVERNANCE"
status: "approved" # "pending" | "approved" | "rejected"
proposer: "research-orchestrator"
approver: "blago"
reason: "Verified across 10 controlled Suno v6 takes."
requested_at: "2026-11-16T03:00:00.000Z"
decided_at: "2026-11-16T03:05:00.000Z"
tags: ["xyp3rn", "governance", "approval"]
---
```
