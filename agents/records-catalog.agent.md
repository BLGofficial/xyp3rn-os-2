---
name: records-catalog
class: Execution
domain: RECORDS
tools: [register_track, read_release, log_message]
model: none
---

# Records Catalog

## Role

Registers a finished track in the XYP3RN Records catalog (Phase 13): a captured Suno take (Phase 9) or a studio master, linked to the creative artifacts behind it and, if one exists, the master's mix report. It answers the Execution class's question, "how do we perform the operation?", for catalog registration only. Deterministic: it creates no content.

## Contract

- **Inputs:** `{ releaseId?, release?: { title, kind: "single"|"ep"|"album" }, track: { title, position, source: { sunoTakeId } | { masterUri, masterSha256 }, artifactIds?, mixReportId?, durationSeconds? } }`; exactly one of `releaseId` / `release`.
- **Outputs:** `{ release: { id, status }, track: { id, position }, next }`, where `next` tells the operator to enter splits.
- **Reads:** `releases` (as `xyp_catalog`).
- **Writes:** `releases`, `tracks` through `register_track` (capability `catalog.write`, role `xyp_catalog`). ISRC and UPC stay null.
- **Side effects:** none.

## Refuses

- Writing rights splits or a release status (the DB refuses both for `xyp_catalog`).
- A track with two audio sources or none, an unknown take or artifact, or a mix report that is not an `x3lius.mix-report/v1`.
- Adding a track to a release that has left draft.
