# XYP3RN OS 3.0 — Backup & Restore Operations Guide

## 1. What Needs to Be Backed Up
1. **Primary Authoritative Asset (`OBSIDIAN_VAULT_PATH`):**
   Contains all canonical documents, `.md` / `.yaml` entities, schemas, agents, workflows, Research briefs, X3LIUS songs/lyrics/rights splits/releases, and `<VaultRoot>/.vault-revisions/` version history + snapshots.
2. **Operational Runtime DB (`XYP_SQLITE_PATH`, default `.local-db/xyp3rn-os3.sqlite`):**
   Contains active approval queues, `agent_runs`, `jobs`, `runtime_events` audit log, `sessions`, `locks`, and the rebuildable `index_state` cache.

---

## 2. Backup Procedures

### A. Vault Snapshot & Local Git Checkpoint
- **Create Vault Manifest Snapshot:** Call `vault.snapshot('daily-checkpoint', 'operator')` — writes SHA-256 manifest JSON to `<VaultRoot>/.vault-revisions/snapshots/<snapshotId>.json`.
- **Create Git Commit Checkpoint:** Run `createGitCheckpoint(vaultRoot, 'checkpoint message')` or standard `git add -A && git commit -m "vault checkpoint"` inside `OBSIDIAN_VAULT_PATH`.

### B. SQLite Online Backup (No Gateway Downtime Required)
- Call `db.backupDatabase('<backup-dir>/xyp3rn-os3-backup.sqlite')` in `core/sqlite/client.ts`.
- Automatically executes SQLite `VACUUM INTO` / online backup and verifies `PRAGMA integrity_check === 'ok'` on the resulting backup file (`integrityOk: true`).

---

## 3. Restore Procedures

### A. Restore a Single Vault Note to Previous Revision
```ts
const history = await vault.history('03_RESEARCH_INTELLIGENCE/00_Briefs/note.md');
await vault.restore({
  vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/note.md',
  targetSha256: history[0]!.sha256,
  actor: 'human-operator',
  reason: 'Rollback accidental edit',
});
```
*(Canonical paths in `02_KNOWLEDGE_LAYER/`, `01_CORE/00_Identity/`, `06_GOVERNANCE/00_Policies/` cannot be overwritten directly — inspect the archived revision and promote cleanly through human approval via `VaultPromotionGate`.)*

### B. Rebuild Lost or Corrupted SQLite Database from Obsidian Vault
1. Stop running gateway (`127.0.0.1:8077`).
2. Move corrupted `.local-db/xyp3rn-os3.sqlite` aside (or copy a verified `backupDatabase()` artifact into place).
3. Run:
   ```powershell
   pnpm.cmd vault:os3 scan
   pnpm.cmd vault:os3 validate
   ```
   SQLite schema migrations apply automatically on startup and `index_state` + `wikilinks` rebuild deterministically from the Vault files on disk.
