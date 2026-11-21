# Phase 20 — X3LIUS Records + Music System Migration Architecture

## 1. Selective Migration Principles & Inspected OS2 Schemas

Phase 20 selectively migrates the X3LIUS Music System (`09_X3LIUS_MUSIC`) and XYP3RN Records (`06_RECORDS`) into OS 3.0 Vault-first storage without deleting or altering OS2 legacy sources (`supabase/migrations/20260925110000_records_ops.sql`, `20260925140000_vault_songs.sql`, `20260925150000_command_center.sql`, `20261011100000_core_immutability.sql`, `20261011110000_split_proposals.sql`).

### Preserved vs Retained Transactional Boundaries

| OS2 Postgres Mechanism | OS3 Guarantee & Storage Location | Disposition |
| --- | --- | --- |
| Write-once `ISRC` (ISO 3901) & `UPC` (GS1 mod-10) triggers + `draft`-only track registration | `Os3RecordsEngine` + `VaultEngine` (`expectedSha256` CAS, `reject-overwrite`, SQLite `index_state` global uniqueness) | Preserved in Vault + SQLite |
| `DEFERRABLE` 100.000% rights split sums + advisory lock (`xyp_queue_split_proposal`) | `validateRightsSharesMilli` + `SqliteRuntimeDb.acquireLock` / `releaseLock` / `transaction()` + `currentVersion` pinning | Preserved via SQLite locks + Vault CAS |
| F35 D2 no-self-approval + append-only creative/critique/retraction history | SQLite `pending_approvals` + distinct proposer/approver check + `APPR-*`/`CRET-*`/`PLRT-*`/`SLRT-*` notes (`status: superseded`) | Preserved in Vault + SQLite |
| OS2 Supabase command-center queue tables (`tasks`, `task_events`, storage RLS policies) | Retained upstream as read-only reference; OS3 local-first Vault entities do not depend on Supabase runtime | Retained read-only in OS2 |

## 2. Migrated Domains & Vault Storage Layout

- **Production Projects (`09_X3LIUS_MUSIC/PROJECTS/MPRJ-*.md`)**: Groups multi-song/album development work (`song_ids`, `release_ids`, `daw_project_paths`) distinct from final distribution releases.
- **Songs, Song Revisions & Song Links (`09_X3LIUS_MUSIC/SONGS/SONG-*.md`, `SLNK-*.md`, `SLRT-*.md`)**: Versioned revisions and typed links (`artifact_lineage`, `source`, `take`, `track`, `research_question`, `daw_session`, `daw_project`, `mix_version`, `master_version`) with non-destructive retractions.
- **Lyrics & Creative Approvals (`09_X3LIUS_MUSIC/LYRICS/LYR-*.md`, `09_X3LIUS_MUSIC/EVALUATION/APPR-*.md`)**: Immutable lyric versions with F22 mixed-script homoglyph checking (`mixedScriptWords`) and two-party approval pointers.
- **Takes, Critiques, Mix Versions & Master Versions (`09_X3LIUS_MUSIC/TAKES/TAKE-*.md`, `09_X3LIUS_MUSIC/EVALUATION/MIX-*.md`, `MSTR-*.md`)**: Audio SHA-256 checksums, loudness/true-peak validation (`<= 0.0` dBTP), and mandatory two-party approval gating for Master Versions.
- **Contributors, Aliases & Credits (`06_RECORDS/PEOPLE/PER-*.md`, `PALS-*.md`, `06_RECORDS/CREDITS/CRED-*.md`, `CRET-*.md`)**: Unified case-insensitive namespace (`display_name` + active `alias` collision check matching `xyp_person_name_free`), all 13 OS2 credit roles, and non-destructive retractions.
- **Releases, Albums, Tracks & Rights Splits (`06_RECORDS/RELEASES/REL-*.md`, `TRACKS/TRK-*.md`, `RIGHTS/SPLT-*.md`, `SPRP-*.md`)**: `single` | `ep` | `album` releases, `getAlbumContinuity()` contiguous `1..N` position checks, write-once GS1 UPC & ISO 3901 ISRC, exact thousandths (`milli`) `100.000%` split validation, and version-pinned split change proposals (`STALE_SPLIT_VERSION` / `CONCURRENT_SPLIT_MODIFICATION` guards).
- **Distribution, Artwork & Deliveries (`06_RECORDS/DISTRIBUTION/PLNK-*.md`, `PLRT-*.md`, `DLVR-*.md`, `ARTWORK/ARTW-*.md`)**: OS2 `xyp_platform_url_ok` regex host validation across 12 platforms, one live link per `(platform, target)` unless retracted, relative-path cover artwork version history, and append-only distributor delivery states.
- **Dynamic Catalog Readiness (`computeCatalogReadinessChecks`)**: Computes live blockers and warnings from current Vault and SQLite state on demand; never stores stale precomputed check flags.

## 3. DAW Brain <-> X3LIUS Catalog Integration

`DawMusicCatalogIntegrator` (`records/daw-catalog-integration.ts`) writes explicit `06_RECORDS/CATALOG_LINKS/DWLK-*.md` records (`authoritative_catalog_record: false`) linking:

- FL Studio / REAPER / simulated project files (`.flp` / `.rpp`) and `DawStateSnapshot` sessions
- `AudioBrainAnalysisReport` diagnostics (`reportId`, `overallVerdict`, audio SHA-256)
- `PluginChainGraph` / `PluginChainAnalysisReport` signal-chain IDs
- Canonical DAW production workflows (`wf-daw-*`)

to Songs, Music Projects, Albums, Releases, Mix Versions, and Master Versions.

### Hard Safety Invariants
1. **DAW Project Is Never Authoritative**: Passing `treatDawProjectAsAuthoritativeCatalog: true` throws `DawCatalogBoundaryError`. A `.flp`/`.rpp` project or live DAW session never replaces or auto-mutates `xyp3rn.song/v3`, `xyp3rn.release/v3`, `xyp3rn.track/v3`, or `xyp3rn.rights-split/v3`.
2. **Release / Master Promotion Guard**: `evaluatePromotionFromDaw()` and `computeCatalogReadinessChecks()` raise blockers if any linked DAW session reports unsaved live drift (`hasUnsavedLiveChanges: true` or `freshness: 'stale'`) or an `AudioBrainAnalysisReport` with verdict `CRITICAL`.

## 4. Migration CLI & Verification

- Dry-run Vault audit & migration report:
  ```powershell
  pnpm.cmd records:migrate --vault "C:\Users\blago\Desktop\XYP3RN-Suno-KB-v1.2-Brain" --dry-run --report-out "docs/os3/migration/RECORDS_MUSIC_PARITY_REPORT.md"
  ```
- Export migration + parity verification (`--export <json-path>`): idempotent across repeated runs, segregating items cleanly into `migrated`, `skipped_idempotent`, `rejected`, `conflicting`, and `incomplete`.
