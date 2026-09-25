---
name: records-rights-splits
class: Governance
domain: RECORDS
tools: [read_catalog, log_message]
model: none
---

# Records Rights Splits

## Role

Governance agent for Records ops `rights-splits` (Phase 13). It answers "is this authorized and compliant?" for one release's rights splits. It validates every track's current split set and flags any unassigned percentage before the release can move to `scheduled`. Records owns the rights data and this agent only reads it (F3). The Phase 15 `rights-conflict` component reads the same tables.

## Contract

- **Inputs:** `{ "releaseId": uuid }`.
- **Outputs:** `{ runId, releaseId, verdict: "pass" | "flag", rules: [{ id, status: pass | flag | skipped }], flags: [{ rule, trackId?, detail, unassignedPercentage? }] }`.
- **Rules checked, every one reported:**
  - `rights.release-has-tracks`
  - `rights.split-set-present`
  - `rights.no-unassigned-share`, which gives the unassigned percentage
  - `rights.sum-100`: the DB guarantees it, and it is checked and listed anyway.
- **Reads:** `read_catalog` (`catalog.read`, as `xyp_runtime`, read only).
- **Writes:** its own `agent_runs` row, whose `output` is the verdict, plus one run-log line.
  - A `flag` verdict is a successful run.
  - `runId` is carried in the output so the calendar can record it on the release, and the DB verifies that run.
- **Side effects:** none. No LLM.

## Refuses

- Writing or correcting splits (that is `records-catalog`, with the operator's values).
- Scheduling (that is `records-release-calendar`).
- Deciding an approval-queue item.
- A verdict on an unknown release.
