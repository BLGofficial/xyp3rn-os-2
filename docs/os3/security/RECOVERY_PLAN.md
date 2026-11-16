# XYP3RN OS 3.0 — Disaster Recovery & Rollback Plan

This runbook covers local recovery procedures for the canonical Obsidian Vault (`OBSIDIAN_VAULT_PATH`), `.vault-revisions/` version store, local SQLite runtime database (`.local-db/xyp3rn-os3.sqlite`), and Git checkpoints.

---

## 1. Recovery Principles (Vault-First Invariant)

1. **Canonical Truth Lives in the Obsidian Vault:** `.md` and `.yaml` files inside `OBSIDIAN_VAULT_PATH` are the authoritative system state. SQLite holds transient operational state (jobs, agent runs, locks, pending approvals, index cache, event log) and can be rebuilt or restored independently.
2. **Non-Destructive Rollback:** Never delete `.vault-revisions/` or `.local-db/` backups before confirming integrity checks pass.

---

## 2. Recovery Scenarios & Procedures

### Scenario A: Corrupted or Accidental Edit to a Vault Note
- **Automatic Protection:** Every `VaultEngine` write, update, append, restore, or external Obsidian edit archives prior content in `<vaultRoot>/.vault-revisions/`.
- **Procedure:**
  1. Inspect note revision history via `vault.history(vaultPath)` (or inspect `.vault-revisions/history/<hash>.json`).
  2. Restore a verified prior SHA-256 revision on non-canonical paths via `vault.restore({ vaultPath, targetSha256, actor: 'human-operator', reason })`.
  3. For canonical paths, inspect the archived content in `.vault-revisions/`, re-queue through `queueApproval()`, obtain a human approval decision, and promote via `vault.promoteToCanonical()`.

### Scenario B: Stale Runtime Locks After Unclean Process Crash
- **Symptom:** Operations fail with `LOCK_BUSY` after process crash or power loss.
- **Procedure:**
  1. On gateway/runtime restart, run lock recovery (`db.recoverStaleLocks()`) and stale job recovery (`db.recoverStaleRunningJobs()`), which release expired TTL locks and mark interrupted `running` jobs for inspection without overwriting Vault files.

### Scenario C: SQLite Runtime Corruption or Index Drift
- **Procedure (Index Drift Only):**
  1. Run full Vault rescan: `pnpm.cmd vault:os3 scan` (or `vault.scanVault({ full: true })`) to reconcile `index_state` and `wikilinks` with on-disk Obsidian Vault Markdown files.
  2. Validate Vault health: `pnpm.cmd vault:os3 validate` (verifies schemas, IDs, broken links, and zero secret leaks).
- **Procedure (Corrupted `.local-db/xyp3rn-os3.sqlite`):**
  1. Verify online backup file integrity (`db.checkIntegrity()`).
  2. Stop running gateway daemon (`127.0.0.1:8077`).
  3. Move corrupted DB aside (`xyp3rn-os3.sqlite.corrupt`), copy verified SQLite backup from `backupDatabase()`, and run `vault.scanVault({ full: true })`.
  4. Re-apply `applySqliteMigrations()` automatically via `openRuntimeDb()`.

### Scenario D: Multi-File Vault Rollback via Snapshot or Git Checkpoint
- **Vault Snapshot Manifests:** Periodic manifests in `<vaultRoot>/.vault-revisions/snapshots/<snapshotId>.json` record `(vaultPath, sha256, byteSize, sector)` across all indexed files.
- **Git Checkpoint Rollback:**
  1. Inspect clean/dirty status using `inspectGitRepository(vaultRoot)` (`core/runtime/git-integration.ts`).
  2. Review recent commits (`git log -n 10 --oneline`) created via `createGitCheckpoint(vaultRoot, message)`.
  3. Restore targeted files (`git checkout <commit-hash> -- <path>`) rather than blind hard resets, then run `pnpm.cmd vault:os3 validate` and `vault.scanVault({ full: true })`.

### Scenario E: Suspected Secret Exposure in Vault or Gateway Logs
- **Procedure:**
  1. **Immediately rotate** the compromised credential at the external provider (OpenRouter, Anthropic, Groq, Google AI).
  2. Locate and purge the offending file/revision from the Vault and `.vault-revisions/` / Git history (`git filter-repo` if committed locally).
  3. Verify `GET /api/vault/note` returns zero `SECRET_DETECTED` errors and `pnpm.cmd vault:os3 validate` reports `0` secret issues.
