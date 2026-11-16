---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0003"
decision_key: "OS3-D3"
type: "decision_record"
title: "Orthogonal Separation of Functional Domains and Physical Vault Sectors"
domain: "CORE"
sector: "05_XYP3RN_RECORDS"
status: "approved"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision", "os3", "taxonomy"]
---

# ADR-0003: Orthogonal Separation of Functional Domains and Physical Vault Sectors

## Context
`xyp3rn-os-2` defines 6 functional domains (`CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`), whereas `UI-xyp3rn` and `MAIN-XYP3RN-OS-Vault` organize the Obsidian Vault into 6 physical sectors (`01_CORE`, `02_KNOWLEDGE_LAYER`, `03_RESEARCH_INTELLIGENCE`, `04_RESEARCH_MATERIAL`, `05_XYP3RN_RECORDS`, `06_GOVERNANCE`), plus 19,632 root-level Suno KB notes (`ROOT_KB`).

## Decision
1. Preserve all 6 OS 2.0 functional domains (`core/contracts/taxonomy.ts`) for agent ownership, routing, and tool authorization.
2. Keep the 6 physical Vault sectors (`01_CORE`..`06_GOVERNANCE` + `ROOT_KB`) as the filesystem and `UI-xyp3rn` constellation layout taxonomy.
3. **Never merge `04_RESEARCH_MATERIAL` with `TECH`:** `04_RESEARCH_MATERIAL` holds raw source documents, papers, transcripts, and media under `KNOWLEDGE`/`RESEARCH_INTELLIGENCE`, while `TECH` owns TRACE audio tools, products, AI systems, and R&D (`tech/`).

## Consequences
- Both `tests/phase-00/contracts.test.ts` (`xyp3rn-os-2`) and `lib/__tests__/data.test.ts` (`UI-xyp3rn`) remain 100% satisfied without taxonomy drift.
