# Phase 13 — Records ops: implementation plan

Spec: [2026-09-25-phase-13-records-ops-design.md](../specs/2026-09-25-phase-13-records-ops-design.md). Test-first (D4): each step's tests are committed failing before the code that turns them green.

## Order

1. **Red DB tests:** `tests/phase-13/records-db.test.ts` (spec §8). Fixture: agent run → formula artifact (`xyp_creative`) → manual submission and take (`xyp_execution`), inserted directly. Run it and see it fail: the relations don't exist.
2. **Migration** `supabase/migrations/20260925110000_records_ops.sql`, plus its rollback (spec §4). `pnpm db:up`, `pnpm db:down 1`, `pnpm db:up` round-trip. DB tests green.
3. **Red agent tests:** `tests/phase-13/records-agents.test.ts`. The workflows end to end, the Rights flag stop, authorization, `validateAll()`, and the `ask` clarify reason.
4. **Capabilities:** `catalog.read` and `catalog.write` in `core/tool-registry/capabilities.ts` and `docs/AGENT_CLASSES.md`. The 4C drift test stays green.
5. **Tools** `records/ops/tools.ts` (`resolve_take`, `read_catalog`, `register_track`, `write_splits`, `assign_codes`, `schedule_release`), registered in `core/runtime/tools.ts`.
6. **Agents:**
   - handlers in `records/ops/catalog/`, `records/ops/rights-splits/` and `records/ops/release-calendar/`;
   - the four `agents/records-*.agent.md` files;
   - registration in `core/runtime/handlers.ts`.
7. **Workflows:** `records/workflows/register-track.workflow.yaml` and `schedule-release.workflow.yaml`.
8. **Routing (spec §7):** ops terms in `records/x3lius/entrypoint.ts` → a clarify reason that names the workflows.
9. **Proof run** on a throwaway DB → `docs/proofs/PHASE-13-records-ops.txt`.
10. **Docs:** SCHEMA, AGENT_CLASSES, ARCHITECTURE (F10, F31, F32), `records/README.md`, README build status, `docs/handoffs/PHASE-13.md`.

## Gates before each push

`pnpm typecheck`, `pnpm test` (full suite), `pnpm agents:validate`, and a migration round-trip on the local DB.
