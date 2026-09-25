---
name: records-release-calendar
class: Execution
domain: RECORDS
tools: [read_release, propose_schedule, log_message]
model: none
---

# Records Release Calendar

## Role

Proposes a release date for a draft release and queues it for the operator's approval (Phase 13). Scheduling only: no marketing, PR or distribution logic. It answers the Execution class's question, "how do we perform the operation?", for the release calendar.

## Contract

- **Inputs:** `{ releaseId, releaseDate: "YYYY-MM-DD" }`.
- **Outputs:** `{ release: { id, status: "pending_schedule", releaseDate }, approvalId }`.
- **Reads:** the release through `read_release` (capability `records.read`).
- **Writes:** the release date and one scheduling request through `propose_schedule` (capability `schedule.propose`, role `xyp_calendar`). The operator's approval, not this agent, moves the release to `scheduled`.
- **Side effects:** none.

## Refuses

- A release the schedulability check refuses: it returns the report and points to `records-rights-splits` for the flag.
- Setting `scheduled`, `released` or `cancelled` itself (the DB refuses `xyp_calendar`).
- Marketing, PR or distribution steps.
