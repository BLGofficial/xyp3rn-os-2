HANDOFF — Phase 13 reused from claude/phase-13 and integrity corrections verified in throwaway databases

- **Built:**
  - **Corrective migration `20260925115000_records_integrity`:** parent tuple updates serialize split mutations against each other and scheduling, including repeatable-read snapshots. Source-parent ids cannot change. Service-role default privileges are revoked before explicit grants. Private single-use transaction authorization prevents direct status updates from bypassing approval. Release decision and application share one transaction in `decideQueueItem`; failed applications leave the queue pending. Locked ISRC/UPC can be assigned once, and UNASSIGNED has one reserved spelling.
  - **Current verification (2026-09-25):** 60/60 Phase 13 and Records ops tests pass, including the seven previously uncommitted review regressions and six concurrency/migration tests. Typecheck passes. Corrective migration is idempotent and its rollback preserves catalog data. The prior full-suite count below is branch evidence, not a claim that this integrated checkout's entire suite was rerun here.
  - **Migration `20260925110000_records`:** `releases`, `tracks` (FK releases), `rights_splits` (FK tracks), `release_schedule_requests`, `records_flags`, and the general append-only `audit_log` (ARCHITECTURE names it; no earlier migration had created it).
    - **Split sum:** a deferred constraint trigger makes every touched track total exactly 100.00 at COMMIT (`rights_splits_sum_not_100`); an unknown share is an explicit `UNASSIGNED` row (F31). A direct INSERT cannot bypass it.
    - **Scheduling gate:** a release enters `pending_schedule` / `scheduled` only with a date, at least one track, splits on every track and no `UNASSIGNED` share (`release_not_schedulable`). Status path enforced (`release_status_transition`).
    - **Locks outside draft:** a release changes only status and UPC; its tracks only ISRC; splits nothing (`release_locked`, `track_locked`, `splits_locked_after_schedule`).
    - **Approval:** `xyp_request_release_schedule` queues a `release_schedule` item; `xyp_apply_release_decision` applies the operator's sealed decision once (approve → `scheduled`, re-checked; reject → `draft`).
  - **Agents** (all `model: none`, domain RECORDS, single class):
    - `records-catalog` (Execution): registers a Suno take or a studio master (F32), links its artifacts and mix report; ISRC/UPC null.
    - `records-rights-splits` (Governance): the schedulability report; flags a blocked release (`records_flags`). Never writes splits (F3).
    - `records-release-calendar` (Execution): refuses a blocked release with the report, otherwise proposes the date and queues it (F33).
  - **Tools / capabilities:** `register_track` (`catalog.write`), `read_release` (`records.read`), `flag_release` (`governance.flag`), `propose_schedule` (`schedule.propose`); each runs as its own DB role (`xyp_catalog`, `xyp_runtime`, `xyp_rights`, `xyp_calendar`).
  - **Operator path:** `pnpm records splits <trackId> <file.yaml>` (replace a track's splits in one transaction); `pnpm gate queue` / `pnpm gate decide` now handle `release_schedule`.
  - **Proof:** `docs/proofs/PHASE-13-records.txt`. 33 Phase 13 tests plus the end-to-end run (catalog → UNASSIGNED flagged → Calendar refuses → fix → queued → approved → scheduled, every write audited with its role). Mutation pass 10/10. Full suite 967/967, tsc clean.
- **Key decisions (user):** F31 always 100 with explicit UNASSIGNED; F32 Suno take or studio master; F33 agent proposes, operator approves. F3 (rights ownership) is now DECIDED.
- **Deviations from spec:**
  - `releases.integrity_version` is an internal serialization counter. Its updates remain audited; business-event assertions filter those internal-only events. `xyp_meta.records_schedule_authorizations` is inaccessible to application roles and consumed during the guarded transition.
  - `release_schedule_requests` (new): `approval_queue` is unique per item, so the release id could not be re-queued after a rejection.
  - Locks outside draft (new): without them a track or date could change after approval.
  - The audit table is `audit_log` (ARCHITECTURE's name), general rather than Records-only.
  - The Rights agent judges rights only: a draft with no date yet is not flagged for it (found by the end-to-end proof); the Calendar and the DB gate still require the date.
  - The Rights agent is `records-rights-splits`, matching the ARCHITECTURE ops slug.
- **Open flags:**
  - Integrated migration rollback review is complete: Phase 1 up/re-up/down/re-down/up returns an identical schema. The missing `take_scores` error was traced to the new Phase 14 rollback and corrected there; Phase 12 needed no change.
  - Current validation used separate disposable databases. No claim is made here that the corrective migration was applied to the user's development database.
  - ISRC and UPC assignment is manual (stored when known, never generated).
  - `released` is reachable only by a direct operator update: nothing marks a release released on its date yet.
  - No payee identity beyond a name (IPI/PRO numbers), no royalties or statements.
  - `approval_item_type` keeps `release_schedule` after a rollback (Postgres can't drop an enum value).
- **Next phase needs (14):**
  1. TRACE intake (`trace.analysis/v1` as a real API surface) should attach a studio master's mix report to `tracks.mix_report_id`.
  2. Take scoring via a TRACE analysis closes the Phase 9 stub (`take_scores`).
  3. The R&D backlog agent is Planning and holds `records.read` if it needs catalog context; it must not gain `catalog.write`.
  4. Register Products / Audio Tools / AI Systems / R&D as TECH domains in the Agent Registry, as Records ops were registered here (agents + capabilities, never implicit).
  5. Phase 15's rights-conflict agent reads `rights_splits`, `records_flags` and `audit_log`; it never writes splits.
