# XYP3RN OS 3.0.0-rc.1 — Known Limitations & Open Constraints

1. **Legacy OS 2.0 PostgreSQL Test Suites Require Stopped/Running Postgres Separation:**
   - Executing unqualified root `pnpm.cmd test` runs legacy OS 2.0 Postgres integration suites alongside OS 3.0 suites. When local Postgres (`xyp3rn-pg` / `XYP_DATABASE_URL`) is offline, suites such as `tests/aos-04/brief-to-canonical.test.ts` and `tests/phase-06d/cite-ingested.test.ts` skip, and un-guarded Postgres connection suites time out waiting on the retired Postgres socket. Run the verified OS 3.0 suite directly when operating without Postgres (`npx.cmd vitest run tests/os3-* tests/aos-00/single-kernel.test.ts`).
2. **Legacy `apps/web/` Surface Retained in Repository:**
   - `apps/web/` (former OS 2.0 Postgres-backed UI loaders) remains on disk for reference/rollback compatibility and still depends on `postgres` types; `UI-xyp3rn` is the sole supported OS 3.0 operator interface.
3. **Root `package.json` Lint Scope:**
   - Root `officialFolderofXYP3RNOS/package.json` enforces strict TypeScript compilation (`pnpm.cmd typecheck`, `tsc --noEmit`) without a separate ESLint configuration; full ESLint verification (`next lint --max-warnings 0`) is enforced on `UI-xyp3rn`.
4. **Windows Unprivileged Symlink Creation vs. Junctions:**
   - Non-elevated Windows hosts without Developer Mode forbid POSIX-style `dir` symlinks (`EPERM`), while directory junctions work unprivileged. `resolveVaultPath()` blocks both symbolic links and NTFS junctions escaping `vaultRoot`.
5. **External Model Execution Requires Operator Credentials:**
   - Out-of-the-box deterministic workflows and Vault/Records/Research engines operate 100% locally without API keys; invoking external LLM-backed `openrouter:*` / `anthropic:*` / `groq:*` models requires supplying the corresponding key in `.env.local` (or runtime environment).
6. **Gateway Bearer Auth Opt-In (`XYP_GATEWAY_TOKEN`):**
   - Localhost origin allowlist (`127.0.0.1` / `localhost` Host, Origin, Referer) is always active; bearer header enforcement is enabled automatically when `XYP_GATEWAY_TOKEN` is set.
