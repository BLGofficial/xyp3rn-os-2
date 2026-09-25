---
name: records-rights-splits
class: Governance
domain: RECORDS
tools: [read_release, flag_release, log_message]
model: none
---

# Records Rights Splits

## Role

Validates a release's rights splits before it can be scheduled (Phase 13) and flags whatever blocks it: a track with no splits, a total other than 100, or an UNASSIGNED share. It answers the Governance class's question, "is this allowed?", for rights data it reads and never writes (ARCHITECTURE F3).

## Contract

- **Inputs:** `{ releaseId }`.
- **Outputs:** `{ schedulable, problems, tracks: [{ trackId, position, total, unassigned, problems, notes }], flagId? }`; `flagId` only when a flag was written.
- **Reads:** the release, tracks and splits through `read_release` (capability `records.read`).
- **Writes:** one `records_flags` row through `flag_release` (capability `governance.flag`, role `xyp_rights`) when the release is not schedulable.
- **Side effects:** none.

## Refuses

- Editing splits, tracks or the release: it flags and reports only; the operator fixes splits.
- Declaring a release schedulable the DB gate would refuse (same rules, one function: `records/ops/schedulable.ts`).
