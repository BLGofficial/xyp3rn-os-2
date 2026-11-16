---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0001"
decision_key: "OS3-D1"
type: "decision_record"
title: "Local-First and Obsidian-First Canonical Architecture"
domain: "CORE"
sector: "05_XYP3RN_RECORDS"
status: "approved"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision", "os3"]
---

# ADR-0001: Local-First and Obsidian-First Canonical Architecture

## Context
XYP3RN OS 2.0 stored canonical knowledge, creative artifacts, songs, releases, and research records inside a PostgreSQL/Supabase cluster (`supabase/migrations/`) while also maintaining partial Obsidian sync scripts (`knowledge/obsidian/`). Running two canonical stores created synchronization complexity and required a local Postgres cluster for daily artist operations.

## Decision
1. **Local-First Execution:** The entire XYP3RN OS 3.0 runtime executes locally on Node.js >=22 + TypeScript with zero cloud database or external infrastructure requirements.
2. **Obsidian-First Canonical Truth:** Markdown (`.md`) and YAML (`.yaml`) files inside the external Obsidian Vault (`C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain`, with binary blobs in `.vault/<sha256>`) are the **sole canonical source of truth** for knowledge, agents, workflows, research, creative records, catalog releases, and governance policies.
3. **No Duplicated Canonical Storage:** No SQL database table may hold canonical knowledge or creative records as a competing source of truth.

## Consequences
- Operator edits in Obsidian and agent outputs live in one unified, human-readable file tree.
- Legacy PostgreSQL (`core/db/`, `supabase/migrations/`) is preserved in parallel only until migration parity is signed off.
