# Phase 13 — XYP3RN Records (Records ops): design

Status: the four decisions below were made by the user in conversation (2026-09-25). Everything else is the default stated here. The spec is updated to match what was built; the deviations are listed in §11.
Branch: `claude/build-audit-next-steps-ffve76`, cut from `main` at `cd0717f` (PR #10 merged).

## 1. Intent

The build guide's Phase 13 adds the business-ops layer next to the X3LIUS Music System. It covers three things: the catalog, rights splits and the release calendar.

- **Migration:** `releases`, `tracks` (FK `releases`) and `rights_splits` (FK `tracks`, payee, percentage). Each track's percentages sum to 100, **enforced in the DB** so that a direct insert cannot bypass it.
- **Catalog agent** ("Knowledge/Execution hybrid"): registers a finished track, meaning Phase 9–11 output, with ISRC/UPC present but nullable until they are assigned.
- **Rights agent:** validates splits and flags any unassigned percentage before a release can move to `scheduled`.
- **Release-calendar agent:** scheduling only. No marketing or PR logic.
- **Proof:** the split-sum constraint test, and a 5-bullet handoff for Phase 14.

Phase 13 succeeds when two things hold on a real DB:

- No role, owner included, can commit a split set that doesn't sum to 100, or schedule a release with an unassigned share. Each refusal has an exact SQLSTATE.
- A take registered through the workflow traces to its Suno submission and formula artifact. A scheduled release traces to the Rights run that cleared it.

## 2. Decisions

| # | Decision | Chosen (user) | Rejected |
|---|---|---|---|
| D1 | Sum rule vs "unassigned percentage" | **Every committed split set sums to exactly 100** (deferred constraint trigger). An unassigned share is an explicit row with `payee` null. A release can't enter `scheduled`/`released` while any of its tracks has no split set or a null-payee row. | ≤ 100 always and = 100 only at scheduling (weaker than the guide's "must sum to 100"); = 100 with no null payee (then "unassigned" can only mean "no splits at all") |
| D2 | F10 for the Catalog hybrid | **Split into two agents chained by a workflow.** `records-catalog-lookup` (Knowledge, read-only) resolves the take's chain into a fully specified registration; `records-catalog` (Execution) writes it. | Execution only (lookup and write in one agent, drifting toward Execution "deciding what") |
| D3 | Release-calendar class | **Execution, deterministic, after the Rights check.** It applies an operator-given date. The `schedule-release` workflow runs Rights first, and the DB trigger is the hard stop. | Planning → human → Execution (a new queue item type before Phase 15's API exists); Planning only (no agent-driven transition) |
| D4 | Order | **Red tests first:** `tests/phase-13` is written and seen failing before the migration and the agents. | Tests written alongside |

The guide contradicts itself on D1. If splits always summed to 100, an "unassigned percentage" could never exist. D1 keeps both requirements literally true, because an unassigned share is a row the sum counts.

## 3. Components

The reserved sub-component ids are `catalog`, `rights-splits` and `release-calendar` (ARCHITECTURE §Sub-component taxonomy). Code lives in `records/ops/<id>/`; workflows go in `records/workflows/` (NAMING §Workflow specs).

| Unit | Kind | Class / role | Tools / grants |
|---|---|---|---|
| `records-catalog-lookup` | agent, `model: none` | Knowledge, RECORDS | `resolve_take`, `read_catalog`, `log_message` |
| `records-catalog` | agent, `model: none` | Execution, RECORDS | `register_track`, `write_splits`, `assign_codes`, `log_message` |
| `records-rights-splits` | agent, `model: none` | Governance, RECORDS | `read_catalog`, `log_message` |
| `records-release-calendar` | agent, `model: none` | Execution, RECORDS | `schedule_release`, `log_message` |
| `read_catalog`, `resolve_take` | tools | `catalog.read`, run as `xyp_runtime` (read only) | SELECT on the catalog tables and the Suno trail |
| `register_track`, `write_splits`, `assign_codes` | tools | `catalog.write`, run as `xyp_catalog` | INSERT on releases/tracks/rights_splits; UPDATE on the code columns only |
| `schedule_release` | tool | `catalog.write`, run as `xyp_release_calendar` | UPDATE on `releases (status, release_date, rights_check_run_id)` only |
| `register-track` | workflow | lookup → catalog | |
| `schedule-release` | workflow | rights-splits → release-calendar | |

- None of the four agents calls a model. Every operation is fully specified by its input or by a table row.
- Rights is Governance class. It returns rule-based verdicts with rule ids. Records owns the rights data and Governance only reads it (F3). Phase 15's `rights-conflict` reads the same tables.

### New capabilities (matrix change, `capabilities.ts` + `AGENT_CLASSES.md` together; the 4C drift test enforces the match)

| Capability | What it permits | Classes |
|---|---|---|
| `catalog.read` | Read releases, tracks, current split sets, and a take's provenance chain (take → submission → formula artifact) | Knowledge, Governance |
| `catalog.write` | Register releases and tracks, write split sets, assign ISRC/UPC, move a release through the calendar | Execution |

- Knowledge doesn't get `artifact.read`. `resolve_take` returns only what the lookup needs, so the matrix line for creative artifacts stays as Phase 9 left it.
- A single `catalog.write` covers four tools. Least privilege comes from two places:
  - each agent's `tools` list, so the calendar can't register and the catalog can't schedule;
  - two DB roles with column-level grants.

## 4. Data (one migration `20260925110000_records_ops`, with its rollback)

### 4.1 Enum `release_status`: `draft`, `scheduled`, `released`

Allowed transitions (trigger, 55000 otherwise): `draft → scheduled`, `scheduled → draft` (unschedule), `scheduled → released`. A scheduled release can also be rescheduled: `release_date` changes while the status stays `scheduled`. `released` is terminal. There is no `withdrawn`. A takedown belongs to Governance (Phase 15) and is added as an enum value when it is built.

### 4.2 `releases`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `title` | text not null | trimmed, non-empty |
| `artist` | text not null | trimmed, non-empty; operator input, never defaulted |
| `kind` | text not null | `single` \| `ep` \| `album` |
| `upc` | text null, unique | `^[0-9]{12,13}$` plus a valid GS1 check digit (UPC-A or EAN-13). Assigned once: null → value, never changed (55000) |
| `status` | `release_status` not null default `draft` | |
| `release_date` | date null | required when status is `scheduled`/`released` (check) |
| `rights_check_run_id` | uuid null → `agent_runs` | required when status is `scheduled`/`released` (check); see §4.5 |
| `agent_run_id` | uuid not null → `agent_runs` | the run that registered it |
| `created_at`, `updated_at` | timestamptz | `updated_at` set by trigger |

### 4.3 `tracks`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `release_id` | uuid not null → `releases` | |
| `position` | int > 0 | `unique (release_id, position)` |
| `title` | text not null | trimmed, non-empty |
| `isrc` | text null | `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$` (ISO 3901, stored without hyphens). Assigned once. `unique (release_id, isrc)` |
| `take_id` | uuid not null → `suno_takes` | the audio. `unique (release_id, take_id)` |
| `mix_report_artifact_id` | uuid null → `creative_artifacts` | a trigger requires schema `x3lius.mix-report/v1` |
| `agent_run_id` | uuid not null → `agent_runs` | |
| `created_at`, `updated_at` | timestamptz | |

- **An ISRC names one recording** (trigger, 23514): every track carrying an ISRC must share its `take_id`. That allows the same recording on a single and later on an album, both under the same ISRC. It refuses one ISRC on two different takes.
- **A track is added only to a `draft` release** (55000). A scheduled release can't gain a track that has no splits.

### 4.4 `rights_splits` (append-only, versioned per track)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `track_id` | uuid not null → `tracks` | |
| `version` | int ≥ 1 | the split set; the current set is the track's highest version |
| `payee` | text null | trimmed, non-empty when present. **null = the unassigned share** |
| `percentage` | numeric(6,3) | 0 < p ≤ 100 |
| `agent_run_id` | uuid not null → `agent_runs` | |
| `created_at` | timestamptz | |

- `unique nulls not distinct (track_id, version, payee)` allows one row per payee per set and at most one unassigned row.
- **Sum = 100 (deferred constraint trigger, `deferrable initially deferred`, 23514).** At commit, every `(track_id, version)` touched must sum to exactly 100.000. So a set is written in one transaction. A row added to an old set later pushes it past 100 and is refused, since every percentage is > 0.
- **Version order (row trigger, 23514):** a new row's version is 1 when the track has no set, and otherwise the current max or max + 1. Nothing skips a version.
- **No unassigned share once scheduled (row trigger, 55000):** a null-payee row is refused when the track's release is `scheduled` or `released`. A payee correction on a scheduled release is allowed when it is complete.
- **Append-only for every role, the owner included (55000):** a change of splits is a new version, and history is kept.
- The `current_rights_splits` view holds each track's highest-version set. `security_invoker` means it reads with the caller's grants.

### 4.5 The scheduling guard (trigger on `releases`, 55000)

On any change into `scheduled` or `released` (a reschedule included), the release must meet five conditions:

1. it has at least one track;
2. every track has a current split set;
3. no current set contains a null-payee row;
4. `release_date ≥ current_date` when entering `scheduled` or rescheduling, and `release_date ≤ current_date` when entering `released`;
5. `rights_check_run_id` names a `records-rights-splits` run with status `success`, `output.result.verdict = 'pass'` and `output.result.releaseId = id`. Dispatch stores a run's output as `{ result, logs }`.

- Rule 5 ties the calendar to the Rights check: a release can't be scheduled without a passing verdict on record.
- Rules 1–3 are the substance. They hold even if a stale verdict is replayed, because they re-check the current splits.

### 4.6 Roles and grants

- `xyp_catalog` (new): INSERT/SELECT `releases`, `tracks`, `rights_splits`; UPDATE (`upc`) on `releases`, UPDATE (`isrc`) on `tracks`. FK and schema checks run as the owner or in `SECURITY DEFINER` triggers, so it needs no grant on the Suno trail or artifacts. Nothing canonical, nothing creative-writable.
- `xyp_release_calendar` (new): SELECT `releases`, `tracks`, `rights_splits`; UPDATE (`status`, `release_date`, `rights_check_run_id`) on `releases`.
- `xyp_runtime`: SELECT on the three tables and the view (`read_catalog`), and EXECUTE on `xyp_resolve_take(take_id)` (`resolve_take`). It still has no SELECT on the Suno trail, the Phase 9 boundary: the function returns one take's chain (ids, titles, schema id) and nothing else.
- `service_role`: SELECT only. Every write goes through an agent, so every write has an `agent_runs` row (the Phase 15 audit join).
- `anon`/`authenticated`: nothing. RLS is on, with one policy per role per command.
- The trigger functions that read across tables are `SECURITY DEFINER` with `search_path = ''`, as in Phase 12.

## 5. Tools

| Tool | Capability | Input → output |
|---|---|---|
| `resolve_take` | `catalog.read` | `{ takeId, mixReportArtifactId? }` → `{ take: { id, audioUrl, title, durationSeconds }, submission: { id, adapter, sunoModel }, formula: { artifactId, schemaId, title }, mixReport: { artifactId, schemaId } \| null }`. It goes through `xyp_resolve_take`. Unknown take → error |
| `read_catalog` | `catalog.read` | `{ releaseId }` → `{ release, tracks: [{ …, splits: { version, rows: [{ payee, percentage }] } \| null }] }` |
| `register_track` | `catalog.write` | `{ release: { title, artist, kind } \| { id }, track: { position, title, takeId, mixReportArtifactId? } }` → `{ releaseId, trackId, createdRelease }`. One transaction |
| `write_splits` | `catalog.write` | `{ trackId, splits: [{ payee: string \| null, percentage }] }` → `{ trackId, version, unassigned }`. Writes version max + 1 in one transaction; the DB decides the sum |
| `assign_codes` | `catalog.write` | exactly one of `{ trackId, isrc }`, `{ releaseId, upc }` → the row's new code |
| `schedule_release` | `catalog.write` | `{ action: 'schedule', releaseId, releaseDate, rightsCheckRunId }` \| `{ action: 'unschedule', releaseId }` \| `{ action: 'release', releaseId }` → `{ releaseId, status, releaseDate }` |

- Tools never pre-validate what the DB enforces (sum, transitions, formats). They let the DB refuse and surface its message, so there is one source of truth. Input *shape* (types, required keys) is still checked in code.

## 6. Agents

### 6.1 `records-catalog-lookup` (Knowledge)

- **Input:** `{ takeId, release: { title, artist, kind } | { id }, position, title, mixReportArtifactId }`. A null `title` or `mixReportArtifactId` means "not given". Both keys are required because the Phase 5 workflow engine has no optional inputs, and extending it would widen the phase.
- **It reads, and never writes:**
  - `resolve_take` gives the chain;
  - `read_catalog` confirms an existing release is `draft` and that the position and take are free on it.
- **Output:** `{ registration: { release, track: { position, title, takeId, mixReportArtifactId } }, provenance: { take, submission, formula } }`.
  - `title` defaults to the formula artifact's title, which is "what we already know". The provenance cites that source row.
- **Refuses:** an unknown take; a release that isn't a draft; a taken position; a take already on that release.
  - It checks the mix report's schema through `resolve_take`'s reader (`x3lius.mix-report/v1`), and the DB checks it again.

### 6.2 `records-catalog` (Execution)

- **Input:** exactly one of:
  - `{ register: <registration> }` (the lookup's output);
  - `{ splits: { trackId, splits } }`;
  - `{ assign: { trackId, isrc } | { releaseId, upc } }`.
- It performs the operation it is given and chooses nothing, the same shape as `suno-submitter`.

### 6.3 `records-rights-splits` (Governance)

- **Input:** `{ releaseId }`.
- **Rules**, each reported as checked, with pass or flag and details:
  - `rights.release-has-tracks`
  - `rights.split-set-present` (per track)
  - `rights.no-unassigned-share` (per track, with the unassigned percentage)
  - `rights.sum-100` (per track; the DB guarantees it, and the check is still made and listed, so the verdict doesn't rest on an unstated assumption)
- **Output:** `{ releaseId, verdict: 'pass' | 'flag', rules: [{ id, status }], flags: [{ rule, trackId?, detail, unassignedPercentage? }] }`.
  - A `flag` verdict is a **successful** run. The flags are data, stored on `agent_runs.output`.
- It writes nothing else. Governance flags table: none until Phase 15.

### 6.4 `records-release-calendar` (Execution)

- **Input:** exactly one of:
  - `{ schedule: { releaseId, releaseDate, rightsCheck } }`, where `rightsCheck` is the Rights agent's output, which carries its own `runId`;
  - `{ unschedule: { releaseId } }`;
  - `{ release: { releaseId } }`.
- `schedule` refuses unless `rightsCheck.output.verdict === 'pass'` for the same release, and the error names each flag.
  - This check is the workflow's readable failure. The DB guard (§4.5) is the hard stop for every path.
- No marketing, no PR, no lead-time policy. A lead time is canonical knowledge a later phase can admit, never a constant here.

### 6.5 Workflows (`records/workflows/`)

- `register-track.workflow.yaml`: `lookup` → `catalog` (`register: { $from: steps.lookup.output.registration }`).
- `schedule-release.workflow.yaml`: `rights` → `calendar`.
  - The workflow engine passes step outputs, not run ids, so the Rights agent returns its own `runId` in its output (from `ctx.runId`).
  - The calendar records that `runId` on the release.
  - The DB verifies that run's row (§4.5 rule 5), so a forged pass gains nothing.

Splits and codes are dispatched directly: `pnpm dispatch records-catalog '{"splits":{…}}'`.

## 7. Routing (F5)

`pnpm ask` sends RECORDS requests to the X3LIUS sub-domain selector. Records ops operations need ids, dates and percentages, which are never parsed from free text. So when a RECORDS request matches no X3LIUS sub-domain but does contain an ops term (catalog, isrc, upc, split, release date, schedule), the entrypoint's `clarify` reason names the two workflows and the `records-catalog` dispatch shapes. The router lexicon is unchanged.

## 8. Tests (written first, D4)

`tests/phase-13/`:

- **`records-db.test.ts`**
  - **Split sum** (the guide's constraint test):
    - 60 + 40 commits;
    - 60 + 30 is refused 23514 at commit, for `xyp_catalog`, `service_role` (no INSERT: 42501) and the owner (`postgres`: 23514);
    - `set constraints all immediate` fires the check inside the transaction;
    - adding a row to a committed set is 23514;
    - a skipped version is 23514;
    - update and delete are 55000.
  - **Unassigned:** 70 + null 30 commits. Scheduling that release is 55000. A null-payee row on a scheduled release's track is 55000.
  - **Scheduling guard:** no tracks, a missing set, a date in the past, and a missing or failed or foreign rights run each give 55000. The valid path passes. Illegal transitions give 55000.
  - **Codes:** a bad ISRC or UPC format or check digit is 23514. Reassigning a set code is 55000. The same ISRC on two takes is 23514. The same take under the same ISRC on two releases passes.
  - **Tracks:** a track added to a scheduled release is 55000. A non-mix-report artifact is 23514.
  - **Grants:** each role's allowed and denied commands, with exact SQLSTATEs (42501).
- **`records-agents.test.ts`**:
  - both workflows end to end on a throwaway DB, with a Phase 9 manual take as the fixture;
  - a Rights `flag` verdict stops scheduling with the flags named;
  - capability authorization (the calendar can't `register_track`, Knowledge can't `catalog.write`);
  - `validateAll()` is clean;
  - the `ask` clarify reason.
- `tests/phase-04c` covers the new capabilities automatically once the doc and code both list them.

## 9. Documentation

- `docs/SCHEMA.md` gets a "Phase 13 additions" section.
- `docs/AGENT_CLASSES.md` gets the matrix rows. The "Records ops capabilities are deliberately undefined" line is removed.
- `docs/ARCHITECTURE.md`:
  - F10 resolved for Phase 13 (D2);
  - F31 (D1, the sum/unassigned reconciliation);
  - F32 (open after Phase 13, §10).
- `records/README.md`, the README build status, `docs/proofs/PHASE-13-records-ops.txt` and `docs/handoffs/PHASE-13.md`.

## 10. Open after Phase 13 (flagged, not built)

- **Master vs publishing splits.** The guide has one split per track. A real release has a master split and a publishing split, each summing to 100. The fix is additive: add a `kind` column and a per-kind sum.
- **Payee identity.** `payee` is free text. Phase 15's rights-conflict will want a payee table, so that "X3LIUS" and "x3lius" are one party.
- **Splits per track row, not per recording.** A recording on a single and an album carries two split sets that can diverge. That is a Phase 15 rights-conflict check.
- **Edits.** A title or position can't be edited, and a draft can't be deleted. Those operations get their own tool when needed.
- **Tracks made outside Suno** (an FL Studio bounce with RVC vocals) can't be registered, because `take_id` is required. That follows the guide's "from Phase 9–11 output"; widening it is a user decision.
- **`withdrawn`** (takedown) is Governance's, Phase 15.

## 11. Deviations found while building (all written into the sections above)

- **`xyp_resolve_take` instead of a table grant.** A Phase 9 test pins that `xyp_runtime` can't read the Suno trail. `resolve_take` calls a `SECURITY DEFINER` function that returns one take's chain (ids, titles, schema id), and EXECUTE is `xyp_runtime`'s alone. So the boundary holds.
- **Rule 5 reads `output.result`.** Dispatch stores a run's output as `{ result, logs }`.
- **Required-null workflow inputs.** `title` and `mixReportArtifactId` are required keys in `register-track`, and null means "not given".
- **`service_role` is revoked explicitly.** The emulated Supabase default privileges grant it ALL on every new table. Phase 13's tables revoke that first, so it reads only.
- **Concurrency locks.** These were added beyond the spec, and race tests pin them:
  - split writes take an advisory lock per track;
  - split, track and calendar writes lock the release row.
