---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0004"
decision_key: "OS3-D4"
type: "decision_record"
title: "Vault Engine Single File Authority and Human-Gated Promotion"
domain: "KNOWLEDGE"
sector: "05_XYP3RN_RECORDS"
status: "approved"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision", "os3", "security"]
---

# ADR-0004: Vault Engine Single File Authority and Human-Gated Promotion

## Context
Direct filesystem access by agents risks silent data overwrites, path traversal, or unreviewed modifications to canonical knowledge and governance policies.

## Decision
1. **Single File Authority (`VaultEngine`):** All file reads, writes, appends, and promotions inside the Obsidian Vault must go through `core/vault-engine/engine.ts`.
2. **No Silent Overwrites:** `VaultEngine.writeNote()` defaults to `no-overwrite` mode (`Note (2).md`) and supports `compare-and-swap` (`expectedSha256`) with conflict logging (`vault.write.conflict`).
3. **Immutable Revisions:** Every write archives a content-addressed copy in `<vault>/.vault-revisions/<sha256[0..1]>/<sha256>.blob`.
4. **Promotion Gate (`F35 D2`):** Direct writes to canonical paths (`02_KNOWLEDGE_LAYER/`, `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/`, `06_GOVERNANCE/00_Policies/`, `canonical/`, `ROOT_KB`) are blocked for all agents. Only `VaultEngine.promoteToCanonical()` with a human-decided `approved` record in `pending_approvals` can write canonical notes.

## Consequences
- User data is protected against silent overwrites and unauthorized canonical tampering, with a complete SHA-256 revision trail and SQLite audit log.
