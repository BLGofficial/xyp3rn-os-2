---
name: records-release-calendar
class: Execution
domain: RECORDS
tools: [schedule_release, log_message]
model: none
---

# Records Release Calendar

## Role

Execution agent for Records ops `release-calendar` (Phase 13). It handles scheduling only, with no marketing, PR or lead-time logic. It moves a release through the calendar (`draft → scheduled → released`, and `scheduled → draft`) on the operator's date. It runs after the Rights check in `records/workflows/schedule-release.workflow.yaml`. The DB scheduling guard is the hard stop on every path.

## Contract

- **Inputs:** exactly one of:
  - `{ "schedule": { "releaseId": uuid, "releaseDate": "YYYY-MM-DD", "rightsCheck": <records-rights-splits output> } }`
  - `{ "unschedule": { "releaseId": uuid } }`
  - `{ "release": { "releaseId": uuid } }` (on or after the release date).
- **Outputs:** `{ releaseId, status, releaseDate }`.
- **Writes:** `releases (status, release_date, rights_check_run_id)` via `schedule_release` (`catalog.write`, as `xyp_release_calendar`, those three columns only). Also its own `agent_runs` row.
- **Side effects:** none. No LLM.

## Refuses

- A rights check for another release, or a verdict other than `pass`. Every flag is named in the error.
- Anything the DB guard refuses:
  - no tracks;
  - a track with no split set, or with an unassigned share;
  - a date in the past, or a release before its date;
  - a rights run that isn't a passing `records-rights-splits` check of this release (a forged pass gains nothing);
  - any transition other than the three above.
- Choosing a date, or any marketing or promotion decision.
