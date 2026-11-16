# XYP3RN OS 3.0 — X3LIUS Music System & Records Migration & Reconciliation Report (Phase 10)

## 1. Domain & Entity Mapping (Obsidian Vault Canonical + SQLite Ephemeral State)

| Functional Sub-Domain | Vault Directory | OS3 Schema / Entity Types |
|---|---|---|
| **Songwriting & Songs** | `09_X3LIUS_MUSIC/SONGS/` | `xyp3rn.song/v3` (`Song`), `xyp3rn.entity/v3` (`Song Revision`) |
| **Lyrics** | `09_X3LIUS_MUSIC/LYRICS/` | `xyp3rn.lyric/v3` (`Lyric Version`, immutable v1..vN) |
| **Vocal DNA** | `09_X3LIUS_MUSIC/VOCAL_DNA/` | `xyp3rn.entity/v3` (`Creative Artifact`) |
| **Composition** | `09_X3LIUS_MUSIC/COMPOSITIONS/` | `xyp3rn.entity/v3` (`Creative Artifact`) |
| **Arrangement** | `09_X3LIUS_MUSIC/ARRANGEMENTS/` | `xyp3rn.entity/v3` (`Creative Artifact`) |
| **Genre and Style** | `09_X3LIUS_MUSIC/GENRES_STYLES/` | `xyp3rn.entity/v3` (`Creative Artifact`) |
| **Suno** | `09_X3LIUS_MUSIC/SUNO_PACKAGES/` | `xyp3rn.entity/v3` (`Generation Attempt`, Suno Package) |
| **Production** | `09_X3LIUS_MUSIC/TAKES/` | `xyp3rn.entity/v3` (`Production Session`, `Take`) |
| **Mix & Master / Evaluation** | `09_X3LIUS_MUSIC/EVALUATION/` | `xyp3rn.entity/v3` (`Critique`, `Revision`), `xyp3rn.approval/v3` (Creative Approval) |
| **Catalog (Tracks & ISRC)** | `06_RECORDS/TRACKS/` | `xyp3rn.track/v3` (`Track`), `xyp3rn.entity/v3` (`ISRC Assignment`) |
| **Rights Splits** | `06_RECORDS/RIGHTS/` | `xyp3rn.rights-split/v3` (`Rights Split Set`, append-only v1..vN) |
| **Release Calendar (UPC & History)** | `06_RECORDS/RELEASES/` | `xyp3rn.release/v3` (`Release` + `release_history[]`), `xyp3rn.entity/v3` (`UPC Assignment`) |

---

## 2. Preserved OS2 Business Constraints (Verified Parity)

1. **Song Identity & Revisions:** Permanent `song.id`; revisions create immutable `SREV-*` records and advance the `revision` pointer with compare-and-swap optimistic concurrency.
2. **Immutable Lyric Revisions & Homoglyph Guard (`F22`):** Lyric versions (`LYR-<lineage>-v<n>.md`) use `writeMode: 'reject-overwrite'` and reject mixed Latin+Cyrillic words (`mixedScriptWords()`).
3. **Creative Approvals:** Queued via SQLite `pending_approvals` (`item_type: 'artifact_version'`), disallow self-approval, and write immutable approval pointers (`APPR-*.md`).
4. **AI Provenance:** Every Suno `Take` links immutably to its `Generation Attempt` (`generation_attempt_id`, `suno_model`, `package_sha256`, `style_prompt`, `prompt_text`).
5. **Rights Split Arithmetic & Unassigned Share Rule (`F31`):** Exact integer thousandths (`milli(pct)`), enforcing `sum === 100_000` (100.000%). Unassigned share (`payee: null`) is allowed only in draft sets and blocks release scheduling.
6. **ISRC & UPC Write-Once + Format/Check-Digit + Uniqueness:**
   - ISRC validates ISO 3901 (`^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$`), refuses reassignment, and prevents duplicates across tracks.
   - UPC validates GS1 mod-10 check digit (`isValidGs1Code`), refuses reassignment, and prevents duplicates across releases.
7. **Tracks on Drafts Only & Release Calendar Guard:** Adding tracks to non-draft releases is blocked; `draft <-> scheduled -> released` requires passing `records-rights-splits` run + live split re-verification + valid release date + preserved `release_history[]`.

---

## 3. Storage & Retirement Strategy

- **Vault (`06_RECORDS/`, `09_X3LIUS_MUSIC/`)** is canonical for all 14 creative and business entity types.
- **SQLite (`agent_runs`, `pending_approvals`, `index_state`)** holds only ephemeral execution state and the approval queue.
- **SQL-backed OS2 Records Modules (`records/ops/tools.ts`):** Preserved in parallel without retirement until parity suite (`tests/os3-phase10-records/records-music-migration.test.ts`) demonstrates 100% invariant parity (`reconcileLegacyExports().ok === true`).
