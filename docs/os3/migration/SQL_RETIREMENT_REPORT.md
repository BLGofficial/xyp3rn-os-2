# XYP3RN OS 3.0 — Legacy SQL & Supabase Retirement Report

**Effective Phase:** Phase 13  
**Prerequisites Verified:** Full migration parity (`0` discrepancies across Research, X3LIUS Records, Agents, Workflows, Vault schemas, and UI-xyp3rn API surface) prior to retirement.

---

## 1. Retired Dependencies & Startup Changes

1. **Default OS Launcher (`package.json`):**
   - `"start:os"` now invokes `scripts/start-os3.ps1` (Local Obsidian Vault + SQLite + Gateway `127.0.0.1:8077` + `UI-xyp3rn` `127.0.0.1:3000`).
   - Legacy Docker/PostgreSQL stack launcher (`scripts/start-xyp3rn.ps1`) is moved exclusively to `"start:legacy-os2"` so OS 3.0 never attempts to boot Docker or PostgreSQL by default.
2. **Remote/Container Session Bootstrap (`scripts/session-start.sh`):**
   - Retired mandatory `./supabase/local/setup.sh`, `pnpm db:up`, and Postgres ingestion/embedding hooks from default startup; replaced with `pnpm -s vault:os3 scan`.
3. **Environment Template (`.env.example`):**
   - Commented out `XYP_DATABASE_URL` as `[RETIRED IN OS 3.0]`; new environments require zero PostgreSQL or Supabase credentials (`OBSIDIAN_VAULT_PATH`, `XYP_SQLITE_PATH`, `XYP_GATEWAY_PORT`).
4. **Operator UI (`UI-xyp3rn`):**
   - Verified via static source scan (`tests/os3-phase13-e2e/e2e-validation-and-failure.test.ts`) that `UI-xyp3rn/{app,components,lib}` contains **zero imports or references** to `postgres`, `@supabase/*`, `XYP_DATABASE_URL`, or legacy `apps/web/server/*-loaders.ts`.

---

## 2. Preserved Historical Assets (Non-Destructive Guarantee)

Per Phase 13 governance, legacy migration scripts and SQL history remain preserved on disk:
- **Migration History:** `supabase/migrations/` (56 timestamped `.sql` up/down migration files) and `supabase/seed/` (`fk-proof.ts`, `run-fk-proof.ts`).
- **Legacy DB Primitives & Loaders:** `core/db/`, `supabase/local/setup.sh`, `scripts/start-xyp3rn.ps1`, and `"start:legacy-os2"` script entry.

---

## 3. Zero-Postgres Startup Verification

- Verified cleanly in `tests/os3-phase13-e2e/e2e-validation-and-failure.test.ts` with `process.env.XYP_DATABASE_URL` and `process.env.SUPABASE_URL` deleted: Gateway (`:8077`), VaultEngine, Orchestrator, WorkflowEngine, ResearchEngine, RecordsEngine, and ContextEngine start and complete full workflows with exit status clean and zero SQL errors.

---

## 4. Legacy Rollback Procedure

If an environment must temporarily inspect legacy OS 2.0 Postgres data:
1. Ensure Docker Desktop is running (`xyp3rn-pg` container).
2. Restore `XYP_DATABASE_URL` in `.env.local` and run `pnpm.cmd db:up`.
3. Launch legacy OS 2.0 via `pnpm.cmd start:legacy-os2`.
4. Note: Any canonical changes made after OS 3.0 cutover live exclusively in the external Obsidian Vault (`OBSIDIAN_VAULT_PATH`); never overwrite OS 3.0 Vault files with stale OS 2.0 exports.
