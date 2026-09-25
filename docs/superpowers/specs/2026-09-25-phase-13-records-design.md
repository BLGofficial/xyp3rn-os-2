# Phase 13 — XYP3RN Records: design

Status: approved in conversation, section by section (2026-09-25). This file is the written spec for review before the implementation plan.
Branch: `claude/phase-13`, cut from `claude/phase-12` (PR #10, not yet merged). It does not depend on `claude/lyrics-rules` (PR #11).

## 1. Intent

The build guide's Phase 13 (lines 638–660) adds the business-ops layer of XYP3RN Records: the catalog, rights splits and the release calendar.

- **Migration:** `releases`, `tracks` (FK releases), `rights_splits` (FK tracks, payee, percentage). Each track's percentages sum to 100, enforced by the database, so a direct INSERT cannot get past it.
- **Catalog agent:** registers a finished track (Phase 9–11 output), with ISRC/UPC present but nullable until assigned.
- **Rights agent:** validates splits and flags any unassigned percentage before a release can move to `scheduled`.
- **Release-calendar agent:** scheduling only; no marketing or PR logic.
- **Proof:** the split-sum constraint test and proof; a 5-bullet handoff for Phase 14.

Success means: every rule below is refused by the database on a direct write (not only by an agent), the end-to-end proof runs on a throwaway DB, and each change to a Records row leaves an audit row.

## 2. Decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Split totals and unknown shares | **Always exactly 100 at commit.** An unknown share is an explicit row with payee `UNASSIGNED`. A release cannot be scheduled while any of its tracks has one. Both rules are DB triggers. | ≤ 100 while drafting and = 100 only to schedule (the "100" guarantee would hold only at scheduling time) |
| D2 | A track's audio source | **Exactly one of:** a Suno take (`suno_takes`, Phase 9) or an external studio master (URI + SHA-256). Plus links to the creative artifacts behind it and, optionally, the master's mix report. | Suno take only; studio master only |
| D3 | Who schedules | **The agent proposes, the operator approves.** The Release-calendar agent sets a date and queues a `release_schedule` item; only the operator's approval moves the release to `scheduled`, re-checked at that moment. | The agent schedules directly |
| D4 | Agent classes | **Single-class agents, no hybrid** (the Phase 11 rule, F10). Catalog and Release-calendar are Execution; Rights is Governance (ARCHITECTURE F3: Governance reads rights data and flags, never writes it). | The guide's "Knowledge/Execution hybrid" Catalog agent |
| D5 | Models | **None.** All three agents are deterministic: registering, validating and scheduling create no content. | An LLM in any of them |

Assumptions the user did not correct:

- Splits are business facts entered by the operator (`service_role`, through a small CLI), not decided by an agent.
- Records ops capabilities are added explicitly to the capability matrix (Phase 12 handoff, next-phase need 2).

## 3. Data (migration `20260925110000_records`)

### 3.1 `releases`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `title` | text | not blank |
| `kind` | enum `release_kind` | `single`, `ep`, `album` |
| `upc` | text, nullable | 12 or 13 digits; unique when set |
| `status` | enum `release_status` | default `draft` |
| `release_date` | date, nullable | |
| `created_at`, `updated_at` | timestamptz | |

Status transitions, enforced by a `before update` trigger (the same pattern as `knowledge_candidates`):

- `draft → pending_schedule | cancelled`
- `pending_schedule → scheduled | draft | cancelled` (`draft` = the operator rejected the schedule)
- `scheduled → released | cancelled`
- `released` and `cancelled` are terminal.

### 3.2 `tracks`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `release_id` | uuid FK → releases | not null |
| `position` | int | ≥ 1; `unique (release_id, position)` |
| `title` | text | not blank |
| `isrc` | text, nullable | format `CC-XXX-YY-NNNNN` stored without dashes (12 chars, `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$`); unique when set |
| `duration_seconds` | numeric, nullable | > 0 |
| `suno_take_id` | uuid FK → suno_takes, nullable | |
| `master_uri` | text, nullable | |
| `master_sha256` | text, nullable | 64 lowercase hex |
| `artifact_ids` | uuid[] | default `{}`; every id must exist in `creative_artifacts` (trigger) |
| `mix_report_id` | uuid FK → creative_artifacts, nullable | its `schema_id` must be `x3lius.mix-report/v1` (trigger) |
| `created_at`, `updated_at` | timestamptz | |

Check: exactly one source — `(suno_take_id is not null) <> (master_uri is not null)`, and `master_sha256` is set exactly when `master_uri` is.

### 3.3 `rights_splits`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `track_id` | uuid FK → tracks | not null, `on delete cascade` |
| `payee` | text | not blank; the literal `UNASSIGNED` marks an unknown share |
| `role` | enum `split_role` | `writer`, `producer`, `performer`, `publisher`, `other` |
| `percentage` | numeric(5,2) | `> 0 and <= 100` |

- `unique (track_id, payee, role)`.
- **Always 100:** a deferred constraint trigger (`initially deferred`, fires once per touched track) checks at commit that each touched track that still has splits totals exactly `100.00`. Error code `23514`, message `rights_splits_sum_not_100: track <id> totals <n>`. A track with no split rows at all is allowed (nothing entered yet); the Rights agent flags it.
- **Locked after scheduling:** INSERT/UPDATE/DELETE on a track's splits is refused while its release is `pending_schedule`, `scheduled` or `released` (`splits_locked_after_schedule`).

### 3.4 Scheduling gate

A `before update` trigger on `releases`, on entering `pending_schedule` or `scheduled`, refuses (`release_not_schedulable: <reason>`) unless:

- `release_date` is set;
- the release has at least one track;
- every track has splits, and none has an `UNASSIGNED` row (the sum is already guaranteed by §3.3).

It runs again on `pending_schedule → scheduled`, so an approval is checked against the rows as they are at that moment.

### 3.5 Approval

- `approval_item_type` gains `release_schedule`; the `item_id` is the release id.
- `xyp_request_release_schedule(release_id)` (SECURITY DEFINER, EXECUTE for `xyp_calendar` only): moves `draft → pending_schedule` (the gate fires) and inserts one pending `approval_queue` row with `request = { release_id, title, release_date, tracks }`.
- The decision goes through the existing `xyp_decide_approval()` (Phase 6D; operator only), which seals it.
- `xyp_apply_release_decision(approval_id)` (SECURITY DEFINER, EXECUTE for `service_role` only) then applies a sealed `release_schedule` decision: approved → `pending_schedule → scheduled` (the gate re-checks); rejected → back to `draft`. It refuses a pending or already-applied item. `decideQueueItem` (Phase 12), which already branches on `item_type`, calls it after the decision.

### 3.6 `audit_log`

ARCHITECTURE.md already names `audit_log` ("Nothing may UPDATE or DELETE `audit_log`"), and the capability `audit.write` exists, but no migration created the table. This one does, general rather than Records-only:

- `id`, `at`, `actor` (`current_user`, the DB role), `table_name`, `row_id`, `op` (`insert` | `update` | `delete`), `old` jsonb, `new` jsonb.
- Filled by an `after insert or update or delete` trigger on `releases`, `tracks` and `rights_splits`.
- Append-only for every role, owner included (the `55000` trigger pattern of Phase 8/9).

### 3.7 `records_flags`

The Rights agent's output: `id`, `release_id` FK, `agent_run_id` FK, `report` jsonb, `created_at`. Append-only.

### 3.8 Roles and grants

| Role | May |
|---|---|
| `xyp_catalog` | INSERT/UPDATE `releases` (not `status`), INSERT/UPDATE `tracks`; SELECT `suno_takes`, `creative_artifacts` |
| `xyp_rights` | SELECT releases, tracks, splits; INSERT `records_flags` |
| `xyp_calendar` | SELECT releases, tracks, splits, flags; UPDATE `releases.release_date`; EXECUTE `xyp_request_release_schedule` |
| `service_role` (operator) | all of the above plus writing `rights_splits` |

Nobody except the operator writes `rights_splits`; no agent role can UPDATE `releases.status` directly (only through the SECURITY DEFINER functions). Proven by DB tests (42501).

## 4. Capabilities

Added to `core/tool-registry/capabilities.ts` and the table in `docs/AGENT_CLASSES.md` (the Phase 4C drift test keeps them equal):

| Capability | Classes | Permits |
|---|---|---|
| `records.read` | Execution, Governance, Planning | read releases, tracks, splits, flags |
| `catalog.write` | Execution | register releases and tracks |
| `schedule.propose` | Execution | set a release date and request scheduling |

The Rights agent flags with the existing `governance.flag`.

## 5. Agents

All three have `model: none`, domain RECORDS, and a tool per capability (`register_track`, `read_release`, `flag_release`, `propose_schedule`). Each run is an `agent_runs` row through the Orchestrator.

### 5.1 `records-catalog` (Execution)

- **Input:** `{ releaseId?, release?: { title, kind }, track: { title, position, source: { sunoTakeId } | { masterUri, masterSha256 }, artifactIds?, mixReportId?, durationSeconds? } }`. Exactly one of `releaseId` / `release`.
- **Does:** creates the release if asked, registers the track. ISRC/UPC stay null. Refuses a missing take, artifact or mix report, and a mix report of the wrong schema (the DB also refuses).
- **Output:** `{ release: { id, status }, track: { id, position }, next: "enter splits: pnpm records splits <trackId> <file>" }`.

### 5.2 `records-rights-splits` (Governance)

- **Input:** `{ releaseId }`.
- **Does:** per track: total, `UNASSIGNED` share, no splits at all, and the same payee listed twice under different roles (information only). Writes one `records_flags` row when anything blocks scheduling. Never edits splits.
- **Output:** `{ schedulable: boolean, tracks: [{ trackId, position, total, unassigned, problems: [string] }], flagId? }`.

### 5.3 `records-release-calendar` (Execution)

- **Input:** `{ releaseId, releaseDate }`.
- **Does:** runs the same validation the Rights agent uses (one shared pure function over rows it reads with `records.read`); if not schedulable, refuses with that report and points to `records-rights-splits` for the flag (it cannot flag: no `governance.flag`). Otherwise sets the date and calls `xyp_request_release_schedule`. The DB gate (§3.4) is the guarantee; this check only gives a readable refusal first.
- **Output:** `{ release: { id, status: "pending_schedule", releaseDate }, approvalId }`.

## 6. Operator path

- `pnpm records splits <trackId> <file.yaml>`: replaces a track's splits in one transaction (delete + insert), so the always-100 rule is checked once at commit. File: `splits: [{ payee, role, percentage }]`.
- `pnpm gate queue`: lists `release_schedule` items with their request.
- `pnpm gate decide <id> approve|reject "<approver>" "<reason>"`: records the decision, then schedules the release or returns it to `draft`.

## 7. Failure handling

Every DB refusal surfaces as a named error, never a partial write:

| Case | Error |
|---|---|
| Splits don't total 100 at commit | `rights_splits_sum_not_100` |
| Scheduling with UNASSIGNED / no splits / no tracks / no date | `release_not_schedulable: <reason>` |
| Changing splits after `pending_schedule` | `splits_locked_after_schedule` |
| Illegal status move | `release_status_transition` |
| Two sources, or none | check `tracks_one_source` |

## 8. Proof (`docs/proofs/PHASE-13-records.txt`)

DB tests on throwaway databases (`tests/phase-13/`):

1. **Split sum:** direct INSERTs totalling 99.99 and 100.01 are refused at commit; 60 committed alone is refused; an exact 100 split passes; a replace (delete + insert) in one transaction passes.
2. **Scheduling gate:** refused with UNASSIGNED, with no splits, with no tracks, with no date.
3. **Status transitions:** illegal moves refused; terminal states stay terminal.
4. **Locks:** splits refused after `pending_schedule`.
5. **Audit:** every write leaves an `audit_log` row; UPDATE/DELETE of `audit_log` refused for every role.
6. **Class boundaries:** `xyp_catalog` cannot write splits or status; `xyp_rights` cannot change a release; `xyp_calendar` cannot write `scheduled` directly (42501).
7. **End to end:** register a track from a Suno take and one from a master → enter splits with an UNASSIGNED share → Rights flags it → Calendar refuses → fix the splits → Calendar queues → operator approves → `scheduled`. Plus the reject path back to `draft`, and `xyp_apply_release_decision` refusing a pending or already-applied item.

Then a mutation pass (each DB rule removed in turn must fail a test), and `docs/handoffs/PHASE-13.md` with the 5 bullets for Phase 14.

## 9. Out of scope

- ISRC/UPC assignment (they are stored when known, never generated).
- Payee identities beyond a name (IPI/PRO numbers), royalties and statements.
- Marketing, PR and distribution submission.
- Per-row tenant RLS for a payee portal (SCHEMA.md note; no portal exists).
- The Governance rights-conflict agent (Phase 15, which reads these tables).
