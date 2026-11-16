---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0002"
decision_key: "OS3-D2"
type: "decision_record"
title: "Minimal Local SQLite Runtime Store via node:sqlite"
domain: "CORE"
sector: "05_XYP3RN_RECORDS"
status: "approved"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision", "os3", "sqlite"]
---

# ADR-0002: Minimal Local SQLite Runtime Store via `node:sqlite`

## Context
While canonical knowledge and creative records belong in the Obsidian Vault, the local runtime requires transactional coordination for active agent runs, workflow jobs, cooperative locks, operator sessions, append-only runtime/audit events, pending human approvals, and a fast structural search cache over 20,189+ Vault files.

## Decision
1. Use Node.js 22's built-in `node:sqlite` (`DatabaseSync`) in `WAL` mode (`.local-db/xyp3rn-os3.sqlite`), avoiding external native C++ addon compilation (`better-sqlite3` / `node-gyp`) on Windows.
2. Restrict SQLite strictly to 7 operational tables (`agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`) plus 2 disposable index tables (`index_state`, `index_meta`).
3. Enforce append-then-seal and immutability invariants via SQLite triggers (`trg_agent_runs_seal`, `trg_agent_runs_no_delete`, `trg_jobs_seal`, `trg_jobs_no_delete`, `trg_runtime_events_no_update`, `trg_runtime_events_no_delete`, `trg_pending_approvals_seal`).

## Consequences
- Zero external database server process is required to boot XYP3RN OS 3.0.
- `index_state` can be dropped and rebuilt from the Obsidian Vault at any time without losing user data.
