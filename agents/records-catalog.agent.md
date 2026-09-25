---
name: records-catalog
class: Execution
domain: RECORDS
tools: [register_track, write_splits, assign_codes, add_person, add_alias, write_credit, retract_credit, write_platform_link, retract_platform_link, set_artwork, record_delivery, log_message]
model: none
---

# Records Catalog

## Role

Execution agent for Records ops `catalog` and `rights-splits` data (Phase 13). It is the write half of the Catalog agent (F10: split and chained after `records-catalog-lookup`). It answers "how do we perform the operation?". It registers a finished recording as a track, writes a track's split set, or assigns an ISRC/UPC. Since AOS-02 it also records catalog metadata: people and their aliases, credits, platform links, artwork and delivery status. It performs exactly the operation it is given, and creates and chooses nothing.

## Contract

- **Inputs:** exactly one of:
  - `{ "register": <registration> }`: the lookup's `registration`.
  - `{ "splits": { "trackId": uuid, "splits": [{ "payee": string | null, "percentage": number }] } }`. `payee: null` is the explicit unassigned share.
  - `{ "assign": { "trackId": uuid, "isrc": string } | { "releaseId": uuid, "upc": string } }`.
  - AOS-02 (B1, B3):
    - `{ "person": { "name" } }` and `{ "alias": { "personId", "alias" } }`;
    - `{ "credit": { "personId" | "person": name-or-alias, "role", "songId" | "trackId", "note"? } }` and `{ "uncredit": { "creditId", "reason" } }`;
    - `{ "link": { "platform", "url", "releaseId" | "trackId" } }` and `{ "unlink": { "linkId", "reason" } }`;
    - `{ "artwork": { "releaseId", "sourceId" } }`;
    - `{ "delivery": { "releaseId", "distributor", "status", "note"? } }`.
- **Outputs:**
  - register: `{ releaseId, trackId, createdRelease }`
  - splits: `{ trackId, version, rows, unassigned }`
  - assign: the code set.
- **Writes** (`catalog.write`, as `xyp_catalog`):
  - `releases` (new drafts) and `tracks`;
  - `rights_splits`, as the track's next version, the whole set in one transaction;
  - the `upc`/`isrc` columns, once;
  - `people`, `person_aliases`, `credits`, `credit_retractions`, `platform_links`, `platform_link_retractions`, `release_artwork` and `release_deliveries` (append-only).
- **Side effects:** none outside the catalog. No LLM.

## Refuses

- An input naming zero operations or more than one.
- Anything the DB refuses, reported with the DB's reason:
  - a split set that doesn't sum to exactly 100;
  - an unassigned share on a scheduled release;
  - a track on a non-draft release;
  - a malformed or reassigned code;
  - one ISRC on two recordings;
  - a name or alias another person already has;
  - a second live credit for the same person, role and target, or a second live link for the same platform and target;
  - a URL that isn't https on the platform's own host;
  - artwork that isn't a Vault image.
- A credit for an unknown name: the person is added first, never created implicitly.
- Deciding what to register, how to split or which code to assign: every value is an input.
- Updating or deleting a split row: a change of splits is a new version, and history is kept.
