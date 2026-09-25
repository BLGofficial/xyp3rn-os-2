# AOS-01 — Creative Vault + song schema: design

Status: the four decisions below were made by the operator in conversation (2026-09-25). Everything else is the default stated here, open to review before implementation starts.
Source: [PLAN.md](PLAN.md) §5 Phase 1; gaps G1–G7 of [AOS-00-baseline.md](AOS-00-baseline.md). Branch `claude/build-audit-next-steps-ffve76`, cut from `main` at `6549e5b`.

## 1. Intent

The plan's AOS-01:

- **Work:** implement core records, file ingestion, metadata, versioning, provenance, access rules and search.
- **Deliverables:** a Vault browser, an ingestion status view, a song catalog, and lyrics and assets linked to their songs.
- **Gate:**
  - files can be ingested, searched, versioned and traced to their source;
  - existing records can be exported and re-imported without losing links.

This phase closes these gaps:

| Gap | What it adds |
|---|---|
| G1 | songs |
| G2 | file bytes |
| G3 | ingestion |
| G4 | search |
| G5 | export and re-import |
| G6 | draft/approved lyric versions, and lyric versions the owner writes |
| G7 | the first UI, owner-only |

It inherits the AOS-00 decisions:

- **D1:** UUID v4.
- **D2:** nothing auto-approves.
- **D3:** the UI is built here.
- **D4:** a local content-addressed store behind one interface.

## 2. Decisions

| # | Decision | Chosen (operator) | Rejected |
|---|---|---|---|
| A1 | How songs link to existing work | **Typed link table.** `song_links` has one FK column per target kind, exactly one set per row. It is append-only, and existing work can be attached later. | `song_id` on each table (immutable tables can't be backfilled); the `relations` graph (mixes catalog links into gate-written knowledge; ids are text) |
| A2 | How the owner's actions are written | **Through agents.** The CLI/UI dispatches small deterministic agents, so every change has an `agent_runs` row carrying the owner's input. Approving stays a human decision recorded in `approval_queue`. | An owner DB role (a second write path with its own audit); everything via the approval queue (the owner approving their own edits) |
| A3 | Search scope | **One engine, two corpora.** The Context Engine gains `corpus`: `knowledge` (the default, unchanged) is what agents ground on; `vault` also covers lyrics and other creative artifacts, research findings and files. | Merging into agent context (drafts would act as rules); a separate keyword search (two search paths) |
| A4 | UI access | **Local, single owner.** Next.js 14 in `apps/web` on 127.0.0.1 behind a token. It reads server-side through a read-only role and writes by dispatching agents. | Supabase Auth now (needs a live project first); no UI yet (drops the plan's Vault browser deliverable) |

Defaults the operator did not override:

- Red tests first.
- The export format `xyp-vault-export/v1` (§8).
- Ingestion scope: text, Markdown and PDF, plus lyric sheets and stored audio and images, with no transcription (AOS-05 adds that).
- Lyric approval recorded in `approval_queue`.
- Next.js 14 + React 18 + Tailwind (the operator's stack).

## 3. Components and owners (the AOS-00 gate: extend, never duplicate)

| Unit | Kind | Owner (domain) | Class / role |
|---|---|---|---|
| `VaultStore` + local adapter | module | `knowledge/source-registry` (KNOWLEDGE) | none (called by one tool) |
| `songs`, `song_revisions`, `song_links` | tables | RECORDS | written as `xyp_vault` |
| `sources` storage columns, `source_texts`, `source_tags` | columns / tables | KNOWLEDGE | written as `xyp_vault` |
| `vault_embeddings`, `xyp_match_vault` | table / function | `knowledge/vector-retrieval` (KNOWLEDGE) | written as `xyp_embedder`; read as `xyp_runtime`, `xyp_web` |
| `vault-curator` | agent, `model: none` | KNOWLEDGE | Execution: adds files and tags them |
| `records-songs` | agent, `model: none` | RECORDS | Execution: creates and revises songs; links and unlinks |
| `x3lius-lyric-editor` | agent, `model: none` | RECORDS | Creative: writes the owner's lyric versions and imports lyric sheets |
| `importLyricSheet`, `addToVault` | services (code controllers over `dispatch`, like the Phase 12 loop) | `records/vault`, `knowledge/ingestion` | none of their own: they only dispatch agents |
| `xyp_decide_artifact` | SQL function | GOVERNANCE (the one approval queue, F8) | EXECUTE held by `service_role` only |
| Context Engine `corpus` | option | `core/context-engine` | none |
| Export / import | module + CLI (`pnpm vault export|import`) | `knowledge/vault-io` | a restore operation, run as the migration role (§8) |
| `apps/web` | Next.js app | new (reserved since Phase 0) | reads as `xyp_web`, writes via `dispatch` |

**Capabilities** (the matrix changes in `capabilities.ts` and `AGENT_CLASSES.md` together):

| Capability | What it permits | Classes |
|---|---|---|
| `vault.write` | Register Vault files, tag them, create/revise songs, link/unlink song targets (AOS-01) | Execution |
| `vault.read` | Read a Vault file's metadata and extracted text (AOS-01) | Knowledge, Creative, Execution |

## 4. Data (one migration `20260925140000_vault_songs`, with its rollback)

### 4.1 Songs (RECORDS), versioned like everything else

- **`songs`** (`id`, `agent_run_id`, `created_at`) is the stable identity.
- **`song_revisions`** is append-only, one row per change:
  - columns: `song_id`, `revision`, `title`, `artist`, `language`, `genre`, `status`, `notes`, `agent_run_id`, `created_at`;
  - `revision` is 1 for a song's first row and max + 1 after that (trigger, 23514);
  - `unique (song_id, revision)`.
- **`song_status`** is `idea` | `writing` | `producing` | `releasing` | `released` | `archived`. AOS-02 adds transition rules. Here any value may follow any other.
- A song with no revision can't be committed (deferred check, 23514).
- **`current_songs`** is a view of each song's latest revision.

### 4.2 `song_links` (A1)

- **Columns:** `id`, `song_id`, `role` (free text, e.g. `lyrics`, `reference`, `stem`, `artwork`), and one FK per target kind:
  - `artifact_lineage_id` → `creative_artifacts` (the lineage root: `id = lineage_id`, trigger, 23514);
  - `source_id` → `sources`;
  - `take_id` → `suno_takes`;
  - `track_id` → `tracks`;
  - `research_question_id` → `research_questions`;
  - and `agent_run_id`, `created_at`.
- **Rules:**
  - `check (num_nonnulls(artifact_lineage_id, source_id, take_id, track_id, research_question_id) = 1)`;
  - one live link per song and target (a partial unique index over the current links).
- **History is kept:**
  - `song_link_retractions` (`song_link_id` pk, `reason`, `agent_run_id`, `created_at`) marks a link unlinked;
  - `current_song_links` shows the unretracted ones;
  - both tables are append-only (55000).
- A new target kind is a new FK column, never a text id.

### 4.3 Vault files (KNOWLEDGE): `sources`, extended rather than a parallel item table

- **New columns on `sources`:**
  - `storage` (`local-vault` | null): the bytes are in the `VaultStore`, keyed by the existing `checksum_sha256`;
  - `media_class` (`document` | `lyric_sheet` | `audio` | `image` | `other` | null);
  - `language` (ISO 639-1 or `mixed` | null).
  - Existing rows keep null: they are knowledge documents with paths, as before.
- **`source_texts`** (`source_id` pk, `text`, `extractor`, `created_at`) holds the text extracted from a document or lyric sheet. It is for search and parsing and is immutable.
- **`source_tags`** (`source_id`, `tag_id`) reuses the existing `tags` table. It is append-only.
- A file is never modified. A changed file has different bytes, so it is a new source row, and the old one stays.

### 4.4 Approval of creative versions (G6, F8, D2)

- **`approval_item_type`** gains `artifact_version`.
- **`xyp_decide_artifact(artifact_id, decision, approver, reason)`** is `SECURITY DEFINER` with EXECUTE held by `service_role` only:
  - it inserts an already-decided `approval_queue` row;
  - an owner-initiated decision needs no pending phase;
  - it refuses a second decision on the same version.
- **Proposed versions.** An agent-proposed version (Studio, AOS-03) will later get a pending row through its own path. Both paths land in the same table.
- **`artifact_approvals`** (a view) lists each version with its status:
  - `draft` (no row), `pending`, `approved` or `rejected`;
  - `approved_version`: the lineage's highest approved version.
- A new version never moves the approved pointer until it is approved itself. That is the plan's "never silently replace approved lyrics", held by the data.

### 4.5 Search index (A3)

- **`vault_embeddings`** holds one row per embedded entity and model:
  - columns: `entity_kind` (`artifact` | `source` | `research_finding`), `entity_id`, `embedding vector(384)`, `model`, `input_sha256`, `created_at`;
  - primary key: `entity_kind, entity_id, model`.
- **Why a separate table:** `creative_artifacts` is immutable, so it can't carry embedding columns that get filled in later.
- **Writes:** `xyp_embedder` inserts and updates, only when the input hash changes.
- **Reads:** `xyp_match_vault(query_embedding, limit)` returns `entity_kind`, `entity_id` and similarity. EXECUTE is held by `xyp_runtime` and `xyp_web`.

### 4.6 Roles

- **`xyp_vault`** (new):
  - INSERT/SELECT on the song tables, `song_links`, retractions, `source_texts` and `source_tags`;
  - INSERT on `sources` with the new columns;
  - SELECT on `creative_artifacts`, `suno_takes`, `tracks` and `research_questions`, for the FK and root checks, which otherwise run in `SECURITY DEFINER` triggers.
- **`xyp_web`** (new): SELECT only, on the Vault, song, artifact, research, release and run tables it renders, plus EXECUTE `xyp_match_vault`. It is never used to write.
- **`service_role`** stays read-only (G20), plus EXECUTE on both decide functions.

## 5. Storage (D4): `knowledge/source-registry/vault-store.ts`

```ts
type VaultStore = { put(bytes): Promise<{ sha256, size }>; get(sha256): Promise<Uint8Array>; has(sha256): Promise<boolean> };
```

- **Local adapter.** `createLocalVaultStore(dir)` writes `dir/<first 2 hex>/<sha256>`:
  - the write goes to a temp file, then an atomic rename;
  - existing content is a no-op, because bytes are content-addressed;
  - every `get` re-hashes and refuses a mismatch as corruption.
- **Location.** `XYP_VAULT_DIR`, defaulting to `.vault/` (gitignored).
- **Supabase Storage** is a second adapter at deployment, behind the same type.

## 6. Ingestion (G3): `pnpm vault add <file> [--song <id>] [--as <class>] [--title …] [--language …] [--tags a,b]`

`addToVault` (`knowledge/ingestion/vault.ts`) runs these steps:

1. **Hash.** It reads the file and computes its sha256. The media class comes from `--as`, else from the extension and MIME type.
2. **Register.** It dispatches `vault-curator` with `{ add: { path, sha256, mediaClass, title, language, tags } }`. The tool `register_vault_file` (`vault.write`):
   - re-reads and verifies the hash;
   - `put`s the bytes;
   - inserts the `sources` row (kind `file`, `storage local-vault`);
   - extracts text for `document` / `lyric_sheet` (txt and md directly; PDF with the existing `unpdf`) into `source_texts`;
   - tags the file.
   - The same bytes return the existing row (idempotent).
3. **Link.** With `--song`, it dispatches `records-songs` with `{ link: { songId, sourceId, role } }`.
4. **Lyric sheet.** For a `lyric_sheet`, `importLyricSheet` dispatches `x3lius-lyric-editor` with `{ import: { sourceId } }`, and links the new lineage when a song is given.
   - The editor parses section tags (`[Verse 1]`, `[Chorus]`, …, mapped to the existing section kinds), else stanzas separated by blank lines.
   - It writes a `x3lius.lyrics/v2` v1 artifact: bars are the lines; `language` is from `--language`, else `und`; `rhymeTag` is `''`; `ungroundedChoices: ['owner-authored']`; `sources` cites the Vault file.

No step turns a Vault file into canonical knowledge. That remains the gate's first-party path (`pnpm ingest`), unchanged.

**As built (steps 2–5): where the build differs from the text above, and why.**

- **Provenance goes in `contextRefs`, not `sources`.** The v2 schema's `sources` holds upstream artifacts only (role `structure`), so the Vault file an import was read from is recorded as `contextRefs: [{ kind: 'vault-file', sourceId, sha256, title }]`. An owner edit records `[{ kind: 'owner-edit' }]`. Both carry `knowledge: { authored: 'owner' }` and `sources: []`.
- **Instrumental sections.** In v2, `instrumental` lists section ids outside `sections`, and the Suno renderer skips them. A tagged section with no sung line is instrumental. The directions under it can't be kept in v2, so they are returned as warnings and stored in the artifact's `warnings`; the sheet (the Vault file) keeps them.
- **A section tag with a note** (`[Verse 2: whispered]`) is a section plus a direction.
- **Promotion.** `sources.checksum_sha256` is unique, so bytes `pnpm ingest` already registered can't get a second row. `register_vault_file` sets the Vault columns on that row instead: status `promoted`, and the knowledge title and uri are kept.
  - The migration grants `xyp_vault` UPDATE on those four columns only.
  - `xyp_sources_vault_guard` then freezes a Vault file: only the knowledge index's embedding columns may still change (55000 otherwise).
- **Tags** get a slug from the label. A label with no Latin letter or digit (Cyrillic) gets `t-<12 hex of its sha256>`, with the label kept as written.
- **Text.** Text files must be valid UTF-8, or they are refused rather than stored garbled; a BOM is stripped. A lyric sheet must yield text.
- **Import once.** `addAndImport` (`pnpm vault add`) returns the earlier import of the same sheet instead of writing a second lineage. It does not guard two concurrent first adds, because the Vault has one owner.
- **Owner edits** are the whole sheet as text (`{ edit: { parentId, text, language? } }`), parsed like an import. The parent's rhyme tags and devices are not carried: the owner's text doesn't have them.
- **Flags for later steps:**
  - **Step 6 must fix this before merge.** `embedPending` (knowledge) embeds every `sources` row, so after this step `pnpm embed` would put Vault-only files into the knowledge corpus. Step 6 limits the knowledge index to knowledge sources: rows with a successful `ingestion_runs` row, or `storage is null`.
  - **Step 8:** `register_vault_file` reads any path the OS process can read. That is fine for the local CLI, but the web UI must write an upload to a temp file itself and never take a path from the browser.
  - **Existing behaviour:** a dispatch timeout marks the run as an error but doesn't cancel the tool, so a slow add can still commit its row. Re-adding returns `existing`.

**The ingestion status view** comes from rows, not a new table. It shows:

- recent `vault-curator` and `x3lius-lyric-editor` runs;
- `ingestion_runs` (knowledge);
- per-kind counts of unembedded Vault rows.

## 7. Search (G4, A3)

- **The new option.** `retrieve(query, { corpus: 'vault' })`:
  - runs the existing knowledge search (canonical + sources) and `xyp_match_vault`;
  - merges both by similarity;
  - returns items with a `kind` (`canonical`, `source`, `file`, `artifact`, `research_finding`), a display text, and the item's link targets (song, lineage, version).
- **The default is unchanged.** `corpus: 'knowledge'` is what every agent and existing test uses, so drafts never ground an agent. A test pins that the knowledge bundle is identical before and after Vault rows exist.
- **Embedding inputs.** `pnpm embed` also fills `vault_embeddings`:
  - an artifact: its brief plus its rendered text (the lyrics' lines, and style fields for other schemas);
  - a Vault file: its title plus extracted text (the first 4k characters, recorded as truncated when cut);
  - a research finding: its claim.
- **One model** (gte-small) and one embedder.

## 8. Export / re-import (G5): `xyp-vault-export/v1`

- **`pnpm vault export <dir>`** writes:
  - **`manifest.json`:** the format, `created_at`, the source DB's migration head, counts per record type, and the sha256 of `records.ndjson`;
  - **`records.ndjson`:** one `{ type, row }` per line, in dependency order;
  - **`blobs/<sha256>`:** every stored file.

  **Records exported:** the Vault's rows and the closure of their links: every song with its revisions, links and retractions; every Vault file with its text and tags; every lineage it links, with all versions and their approval rows; the linked takes with their submission and formula artifact; the linked tracks with their release and splits; the linked research questions with their project; and every `agent_runs` / `workflow_runs` row these reference.
- **`pnpm vault import <dir>`** runs as the migration role: import is a restore, and AOS-08 formalises backup and restore.
  1. It verifies the manifest, the records hash and every blob hash, then `put`s the blobs.
  2. In one transaction it inserts every record with its original id, in order:
     - an identical row that already exists is skipped;
     - a row that differs refuses the whole import, listing each conflict;
     - the existing triggers still apply, so immutability, derived versions, link roots and split sums hold.
- **The gate test:**
  1. Export DB A, then import into a fresh DB B.
  2. Every link resolves in B.
  3. Re-exporting B gives a byte-identical `records.ndjson` and identical blobs.
  4. Re-importing into B changes nothing.

## 9. UI (G7, A4): `apps/web`

- **Stack and access:**
  - a pnpm workspace package on Next.js 14 (App Router), React 18 and Tailwind;
  - served on 127.0.0.1 (`pnpm web`);
  - the first visit asks for `XYP_WEB_TOKEN` (≥ 16 characters) and sets an HMAC session cookie; middleware refuses every other route without it.
- **Reads** are server components querying as `xyp_web`. **Writes** are server actions that call `dispatch` (A2) and `xyp_decide_artifact` (approve / reject).
- **Screens (AOS-01):**
  - **`/vault`:** the browser, with filters by kind, song, tag and language, and search over the `vault` corpus;
  - **`/vault/files/[id]`:** a file's metadata, provenance (the agent run that added it, its checksum, the original name), text, tags and linked songs; audio and images are served from the store;
  - **`/vault/lineages/[id]`:** a lineage's versions, a diff between versions, approval state, and approve / reject;
  - **`/ingest`:** upload (drag and drop → `addToVault`), recent runs with status, and the embedding backlog;
  - **`/songs`:** the catalog;
  - **`/songs/[id]`:** revisions, linked lyrics with the approved version marked, files, takes, tracks and research; plus create, revise, link and unlink.
- **Design direction:** the operator's modern brutalism: mono type, hard rules, high contrast, the RECORDS red accent from `taxonomy.ts`. Every figure shows its source and time.
- **Spike: done (2026-09-25).** Server code imports OS modules at run time, outside the webpack bundle: `apps/web/lib/os.ts` calls `import(/* webpackIgnore: true */ file://…)`. Node 22 then runs them natively (`.ts` type stripping, `import.meta.dirname`, the repo's `node_modules`), so the app never re-implements or bundles an OS module.
  - **Proven:** under `next build` + `next start`, a server component read `agent_runs` and dispatched `health-check`, which succeeded and wrote its run.
  - **The fallback OS API is not needed.**
  - **One snag:** Next 14's build type check needs TypeScript 5's JS API, but the repo pins TypeScript 7 (the native port). The web package pins `typescript@5.9` for itself, and the root keeps TS 7 for `pnpm typecheck`.

## 10. Tests (written first)

`tests/aos-01/`:

- **`vault-db.test.ts`:**
  - revisions are append-only and gap-free, and a song without a revision is refused;
  - a link has exactly one target and points at a lineage root; retraction and re-linking work; duplicate live links are refused;
  - `sources` storage columns and `source_texts` behave as specified;
  - `xyp_decide_artifact` (only `service_role`, one decision per version) and `artifact_approvals` (the approved pointer doesn't move);
  - the grants of each new role, with exact SQLSTATEs.
- **`vault-store.test.ts`:** put and get, idempotent put, atomic write, corruption detected on read.
- **`vault-ingest.test.ts`:**
  - txt, md and PDF (the build guide) with extracted text; audio and image stored without text;
  - re-adding is idempotent;
  - a lyric sheet with tags, and one without, becomes a v2 lineage citing its file;
  - a song link, and runs recorded for each step.
- **`vault-search.test.ts`:**
  - the `vault` corpus finds a lyric line, a file's text and a finding;
  - the `knowledge` corpus bundle is unchanged by Vault rows.
- **`vault-export.test.ts`:**
  - the A → B round trip is byte-identical, links resolve, and re-import is a no-op;
  - a conflicting row refuses the import;
  - a corrupt blob or a tampered records file is refused.
- **`web`:**
  - unit tests of the session check and the data loaders;
  - a Playwright smoke test in the proof: log in, upload a lyric sheet, see the lineage, approve it, find it in search.
- **`tests/aos-00`:** the single-kernel gate still passes, so no second registry, engine or store appears.

## 11. Out of scope (flagged)

- **Song status transitions, tasks, credits and platform links:** AOS-02.
- **Style recipes, meta-tag sets and generation sessions:** AOS-03 (with F21).
- **Transcribing audio:** AOS-05.
- **Research linking beyond `research_question_id`:** AOS-04.
- **Multi-user access and RBAC:** AOS-07/08. The UI is local and single-owner here.
- **Deleting a Vault file:** nothing is deleted. A retraction removes a file from a song, and the file stays for provenance.
