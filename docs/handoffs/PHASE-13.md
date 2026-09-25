HANDOFF — Phase 13 built and proven (Records ops: catalog, rights splits, release calendar); no live data yet

- **Built:**
  - **Data** (migration `20260925110000_records_ops`, with rollback):
    - `releases` (draft → scheduled → released, scheduled → draft);
    - `tracks` (a Phase 9 `suno_takes` row on a release, plus an optional mix report);
    - `rights_splits` (append-only, versioned per track) and the `current_rights_splits` view.
    - **Every committed split set sums to exactly 100:** a deferred constraint trigger that binds every role, the owner included.
    - **An unassigned share is an explicit `payee` null row**, and it counts toward the sum (F31, user decision D1).
    - **The scheduling guard:** a release can't be scheduled or released without tracks, a current set on every track, no unassigned share, a valid date, and a passing `records-rights-splits` run for that release, which the DB verifies.
    - **Codes:** ISRC and UPC are nullable until assigned, format-checked (GS1 check digit for the UPC) and assigned once. An ISRC names one take.
    - **Concurrency:** split writes serialize per track, and split, track and calendar writes lock the release row. Race tests pin both orders.
    - **Roles:** `xyp_catalog` and `xyp_release_calendar` (column-level UPDATE only). `service_role` reads only.
  - **Agents** (all deterministic, `records/ops/`):
    - The Catalog hybrid is split (F10, D2): `records-catalog-lookup` (Knowledge: take → submission → formula chain, fully specified registration) → `records-catalog` (Execution: register, split sets, codes), chained in `records/workflows/register-track.workflow.yaml`.
    - `records-rights-splits` (Governance): four rules, each reported; a `flag` is a successful run whose flags are data.
    - `records-release-calendar` (Execution, D3): scheduling only, and only on a pass for the same release. It runs after Rights in `schedule-release.workflow.yaml`.
  - **Capabilities:** `catalog.read` (Knowledge, Governance) and `catalog.write` (Execution), in `capabilities.ts` and `AGENT_CLASSES.md` together.
  - **Routing:** `pnpm ask` answers a Records ops request with the ops commands (F5).
  - **Proof:** `docs/proofs/PHASE-13-records-ops.txt`.
    - 46 Phase 13 tests, written red first (D4).
    - The real CLIs on a throwaway DB, including direct-insert bypass attempts refused with 23514 / 55000.
    - 4/4 migration mutations caught.
    - Full suite 957/957 (893 before Phase 13), typecheck clean.
- **Key decisions (user):**
  - D1: sum = 100 plus a null-payee row for the unassigned share (F31).
  - D2: Catalog split into Knowledge + Execution (F10).
  - D3: the calendar is Execution, after Rights.
  - D4: red tests first.
- **Deviations from spec** (all written into the spec, §11):
  - `resolve_take` goes through a `SECURITY DEFINER` `xyp_resolve_take`, because a Phase 9 test pins that `xyp_runtime` can't read the Suno trail.
  - The guard reads the Rights verdict at `output.result`, since dispatch stores `{ result, logs }`.
  - `register-track` takes `title` / `mixReportArtifactId` as required keys where null means "not given", because the workflow engine has no optional inputs.
  - The concurrency locks were added beyond the spec.
- **Open flags (F32):**
  - Master vs publishing splits.
  - Payee identity: free text today.
  - Splits are per track row, not per recording.
  - No title/position edit and no `withdrawn` status.
  - Only Suno takes can be registered.
  - No lead-time policy.
  - **Pre-existing, not fixed here:** `service_role` holds full DML, TRUNCATE included, on `creative_artifacts`, `critiques` and the Suno trail (the emulated Supabase default privileges). SCHEMA.md says SELECT only. TRUNCATE skips the immutability triggers. It needs a follow-up migration; Phase 13's own tables already revoke it.
  - No live data: the X3LIUS catalog, payees, ISRC/UPC and dates are the operator's to enter.
- **Next phase needs (14):**
  1. TRACE integration implements `trace.analysis/v1` (`tech/trace/analysis.ts`) as the real API surface, defined once. When a render's analysis exists, a Records `tracks.mix_report_artifact_id` can point at its mix report.
  2. The R&D backlog agent (Planning, `plan.write`) writes `rd_backlog` proposals from `research_sources` tagged frontier/emerging. It needs its migration and role, and never auto-implements.
  3. Register Products / Audio Tools / AI Systems / R&D as TECH components in the Agent Registry. The router already sends TECH requests, but `ENTRYPOINTS.TECH` is unset.
  4. Phase 15's rights-conflict reads `rights_splits` / `current_rights_splits` through `catalog.read` (already granted to Governance). A payee table and master/publishing kinds are its first questions (F32).
  5. Take scoring still waits on a render's TRACE analysis (F30). Once Phase 14 lands, the `take_scores` stub rows and the catalog's mix report link both have a real source.
