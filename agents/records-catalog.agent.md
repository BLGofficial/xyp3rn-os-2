---
name: records-catalog
class: Execution
domain: RECORDS
tools: [register_track, write_splits, assign_codes, log_message]
model: none
---

# Records Catalog

## Role

Execution agent for Records ops `catalog` and `rights-splits` data (Phase 13). It is the write half of the Catalog agent (F10: split and chained after `records-catalog-lookup`). It answers "how do we perform the operation?": it registers a finished take as a track, writes a track's split set, or assigns an ISRC/UPC. It performs exactly the operation it is given, and creates and chooses nothing.

## Contract

- **Inputs:** exactly one of:
  - `{ "register": <registration> }`: the lookup's `registration`.
  - `{ "splits": { "trackId": uuid, "splits": [{ "payee": string | null, "percentage": number }] } }`. `payee: null` is the explicit unassigned share.
  - `{ "assign": { "trackId": uuid, "isrc": string } | { "releaseId": uuid, "upc": string } }`.
- **Outputs:**
  - register: `{ releaseId, trackId, createdRelease }`
  - splits: `{ trackId, version, rows, unassigned }`
  - assign: the code set.
- **Writes** (`catalog.write`, as `xyp_catalog`):
  - `releases` (new drafts) and `tracks`;
  - `rights_splits`, as the track's next version, the whole set in one transaction;
  - the `upc`/`isrc` columns, once.
- **Side effects:** none outside the catalog. No LLM.

## Refuses

- An input naming zero operations or more than one.
- Anything the DB refuses, reported with the DB's reason:
  - a split set that doesn't sum to exactly 100;
  - an unassigned share on a scheduled release;
  - a track on a non-draft release;
  - a malformed or reassigned code;
  - one ISRC on two takes.
- Deciding what to register, how to split or which code to assign: every value is an input.
- Updating or deleting a split row: a change of splits is a new version, and history is kept.
