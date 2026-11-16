# XYP3RN OS 3.0.0-rc.1 — Deployment & Operations Checklist

- [x] **Vault Path Configured:** `.env.local` defines `OBSIDIAN_VAULT_PATH`, `XYP_SQLITE_PATH`, `XYP_GATEWAY_PORT=8077` without hardcoded user paths in source code.
- [x] **Vault Initialized & Validated:** `pnpm.cmd vault:os3 provision`, `scan`, and `validate` succeed with `ok: true` and zero secret/schema violations.
- [x] **SQLite Runtime Ready:** `node:sqlite` initializes `.local-db/xyp3rn-os3.sqlite` with schema v2 (`integrityOk: true`) and zero canonical tables.
- [x] **Agent & Workflow Registries Clean:** `52` active agents pass `pnpm.cmd agents:validate` (`0` failures); `7` workflows pass compile checks (`0` failures).
- [x] **Localhost & Security Hardening Active:** `127.0.0.1` binding verified, path/symlink escape blocked, `SELF_APPROVAL_FORBIDDEN` active, secrets redacted/blocked.
- [x] **UI-xyp3rn Built & Verified:** `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test` (`92/92`), and `npm.cmd run build` (`9/9` routes) pass cleanly.
- [x] **Backup & Recovery Verified:** `.vault-revisions/`, SQLite online `backupDatabase()`, and local Git checkpoints tested; [RECOVERY_PLAN.md](../security/RECOVERY_PLAN.md) & [BACKUP_RESTORE_GUIDE.md](../operations/BACKUP_RESTORE_GUIDE.md) present.
- [x] **Local Startup Verified Without Postgres/Supabase:** `scripts/start-os3.ps1` / `pnpm.cmd start:os` launches cleanly with graceful gateway termination on exit.
- [ ] **External Deployment:** Explicitly deferred / prohibited by Release Candidate policy (local-first deployment only).
- [ ] **Final Operator Sign-Off:** Pending operator review of `UI-xyp3rn` & release candidate artifacts.
