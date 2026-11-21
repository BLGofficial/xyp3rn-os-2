# X3LIUS Records + Music System OS2 -> OS3 Migration & Parity Report

- **Source System:** `cli-scan-only`
- **Started:** `2026-11-21T05:28:55.492Z`
- **Completed:** `2026-11-21T05:28:55.525Z`
- **Dry Run:** `true`
- **Legacy OS2 Data Untouched:** `true`

## Summary Totals

| Metric | Count |
| --- | ---: |
| Total Export Items Evaluated | 0 |
| Migrated into OS3 Vault | 0 |
| Skipped (Idempotent) | 0 |
| Rejected (Invariant Violation) | 0 |
| Conflicting (Preserved Without Overwrite) | 0 |
| Incomplete (Missing Foreign Key / Required Field) | 0 |

## Legacy Vault Markdown Scan (`06_RECORDS` & `09_X3LIUS_MUSIC`)

- **Scanned Directories:** `C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain\06_RECORDS`, `C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain\09_X3LIUS_MUSIC`
- **Total Markdown Files Scanned:** 12
- **Valid OS3 Entities:** 12
- **Idempotent Existing (in SQLite):** 0
- **Incomplete / Pre-OS3 Legacy Markdown:** 0
- **Invalid YAML Frontmatter:** 0

| File | Dir Group | Schema | ID | Disposition | Missing Fields |
| --- | --- | --- | --- | --- | --- |
| `ADR/ADR-0001-Local-First-Obsidian-Vault.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `adr-0001-local-first-obsidian-vault` | `valid_os3` | - |
| `ADR/ADR-0002-Minimal-Local-SQLite.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `adr-0002-minimal-local-sqlite` | `valid_os3` | - |
| `ADR/ADR-0003-Six-Domain-Twelve-Folder-Vault-Mapping.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `adr-0003-six-domain-twelve-folder-vault-mapping` | `valid_os3` | - |
| `ADR/ADR-0004-No-Overwrite-and-Promotion-Gate.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `adr-0004-no-overwrite-and-promotion-gate` | `valid_os3` | - |
| `ADR/ADR-0005-UI-XYP3RN-Gateway-Contract.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `adr-0005-ui-xyp3rn-gateway-contract` | `valid_os3` | - |
| `DECISIONS/DEC-0001-No-Auto-Approval-F35-D2.md` | `06_RECORDS` | `xyp3rn.decision-record/v3` | `dec-0001-no-auto-approval-f35-d2` | `valid_os3` | - |
| `RELEASES/REL-0001-Night-Signals-EP.md` | `06_RECORDS` | `xyp3rn.release/v3` | `rel-0001-night-signals-ep` | `valid_os3` | - |
| `RIGHTS/SPLT-0001-Neon-Static-v1.md` | `06_RECORDS` | `xyp3rn.rights-split/v3` | `splt-0001-neon-static-v1` | `valid_os3` | - |
| `TRACKS/TRK-0001-Neon-Static.md` | `06_RECORDS` | `xyp3rn.track/v3` | `trk-0001-neon-static` | `valid_os3` | - |
| `AUDIO_EXTRACTED_PROMPTS/2026-11-16-X3LIUS-Wrong-Way-Out-Extracted-Prompt.md` | `09_X3LIUS_MUSIC` | `xyp3rn.knowledge/v3` | `audprm-x3lius-wrong-way-out-ac8c0015` | `valid_os3` | - |
| `LYRICS/LYR-0001-Neon-Static-v1.md` | `09_X3LIUS_MUSIC` | `xyp3rn.lyric/v3` | `lyr-0001-neon-static-v1` | `valid_os3` | - |
| `SONGS/SONG-0001-Neon-Static.md` | `09_X3LIUS_MUSIC` | `xyp3rn.song/v3` | `song-0001-neon-static` | `valid_os3` | - |

## Transactional Boundaries & Selective OS2 Retention

| OS2 Mechanism | OS3 Guarantee | Status | Notes |
| --- | --- | --- | --- |
| Postgres BEFORE UPDATE/INSERT triggers on releases/tracks (write-once ISRC & UPC, draft-only track registration) | Os3RecordsEngine.assignIsrc / assignUpc / registerTrack + VaultEngine expectedSha256 optimistic concurrency + writeMode: reject-overwrite | `preserved_via_sqlite_and_vault_cas` | ISRC (ISO 3901) and UPC (GS1 mod-10) are immutable once set and checked for global uniqueness across SQLite index_state. |
| Postgres DEFERRABLE INITIALLY DEFERRED split-sum constraint + advisory lock per track (`xyp_queue_split_proposal`) | validateRightsSharesMilli (exact 100.000% sum, no duplicate payees) + SqliteRuntimeDb.acquireLock/releaseLock + transaction() + currentVersion pinning | `preserved_via_sqlite_and_vault_cas` | Concurrent or stale split proposals fail with STALE_SPLIT_VERSION or CONCURRENT_SPLIT_MODIFICATION without overwriting newer versions. |
| Postgres no-self-approval + append-only creative/critique/retraction history | pending_approvals in SQLite + F35 D2 distinct-actor check + separate APPR-*/CRET-*/PLRT-*/SLRT-* Vault notes with status: superseded | `preserved_via_sqlite_and_vault_cas` | Proposer and approver cannot match case-insensitively; retractions append immutable evidence notes instead of deleting history. |
| Postgres multi-user relational command-center queue tables (tasks, task_events, public.sources storage RLS policies) | Retained in OS2 Postgres as read-only upstream reference while Vault-first catalog records remain local-first in 06_RECORDS & 09_X3LIUS_MUSIC | `retained_read_only_in_os2_postgres` | OS2 Supabase/Postgres schemas and rows are never deleted or mutated during OS3 migration. |
