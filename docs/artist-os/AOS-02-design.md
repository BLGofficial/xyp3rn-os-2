# AOS-02 — Command Center + catalog: design

Status: the four decisions below were made by the operator in conversation (2026-09-25). Everything else is the default stated here, open to review.
Source: [PLAN.md](PLAN.md) §5 Phase 2 and §3B ("Release records"); gap G8 and the rest of G7 in [AOS-00-baseline.md](AOS-00-baseline.md). Built on AOS-01 (PR #14, not yet merged), on the same branch `claude/build-audit-next-steps-ffve76`.

## 1. Intent

The plan's AOS-02:

- **Work:** song and release views, statuses, task tracking, collaborators/credits, identifiers, and platform links.
- **Deliverables:** a catalog dashboard and a song detail workspace.
- **Gate:** a song can move from idea to release with its creative history and metadata intact.

This phase closes:

| Gap | What it adds |
|---|---|
| G8 | artwork, platform links, credits by role, delivery status, tasks, collaborators |
| G7 (rest) | the Command Center dashboard, release views, the song workspace |
| F32 (part) | a track whose recording is not a Suno take |

What already exists (Phase 13 + AOS-01) and is reused, not rebuilt:

- `releases`, `tracks`, `rights_splits`: ISRC/UPC, the draft → scheduled → released calendar, versioned splits, and the Rights check.
- `songs` with revisions (status idea → archived) and typed `song_links` (a song already links to tracks).
- The owner-write pattern (A2): deterministic agents, one `agent_runs` row per change; the UI reads as `xyp_web` and writes through dispatch.

## 2. Decisions

| # | Decision | Chosen (operator) | Rejected |
|---|---|---|---|
| B1 | Credits and collaborators | **People + credits.** A `people` table (name + aliases, matched case-insensitively) and credits by role on a song or a track. Append-only, with retractions. | Free-text credits (duplicates forever, no link to splits later); split payees only (conflates money and credit) |
| B2 | Tasks | **Own table + computed checks.** Manual tasks with a status history, plus readiness checks computed from the data (never stored, so never stale), shown as alerts. | Checks only (no manual to-dos); approval-queue items (mixes to-dos into the decisions queue, F8) |
| B3 | Platform links | **Fixed platform list, on releases and tracks.** The URL's host must match the platform; one live link per platform per release or track; history kept. | Any URL on the song (no attribution for AOS-06 analytics); release only (loses per-track links) |
| B4 | Non-Suno recordings | **A track's recording is a Suno take or a Vault audio file**, exactly one. Closes the F32 item. | Suno takes only (your own FL Studio bounces could never reach a release) |

Defaults the operator did not override:

- Red tests first; one migration `20260925150000_command_center` with its rollback.
- Artwork and delivery status are part of this phase (both are in G8 and PLAN §3B), in the shape of §4.4–4.5.
- Song status stays the owner's to set. The release stage is derived from the song's linked tracks and shown next to it; a mismatch is a computed check, never an automatic change.
- Payees stay free text in `rights_splits` for now. Linking a payee to a person is the next step of F32 (flagged, §9).

## 3. Components and owners

| Unit | Kind | Owner (domain) | Class / role |
|---|---|---|---|
| `people`, `person_aliases` | tables | RECORDS | written as `xyp_catalog` |
| `credits`, `credit_retractions` | tables | RECORDS | written as `xyp_catalog` |
| `platform_links`, `platform_link_retractions` | tables | RECORDS | written as `xyp_catalog` |
| `release_artwork`, `release_deliveries` | tables | RECORDS | written as `xyp_catalog` |
| `tracks.source_id` (B4) | column | RECORDS | written as `xyp_catalog` |
| `tasks`, `task_events` | tables | RECORDS (Command Center) | written as `xyp_tasks` (new) |
| `catalog_checks` | view (computed) | RECORDS | read as `xyp_runtime`, `xyp_web` |
| `records-catalog` | existing agent, more operations | RECORDS | Execution, `catalog.write` |
| `records-catalog-lookup` | existing agent, resolves a Vault recording too | RECORDS | Knowledge, `catalog.read` + `vault.read` |
| `records-tasks` | agent, `model: none` | RECORDS | Execution, `task.write` (new) |
| Command Center screens | `apps/web` | UI | reads as `xyp_web`, writes via dispatch |

**Capabilities:**

| Capability | Change | Classes |
|---|---|---|
| `catalog.write` | now also: people and aliases, credits, platform links, artwork, delivery status | Execution (unchanged) |
| `task.write` | new: create a task, move it (done, cancelled, reopened) | Execution |

## 4. Data (one migration `20260925150000_command_center`, with its rollback)

### 4.1 People and credits (B1)

- **`people`:** `id`, `name`, `agent_run_id`, `created_at`. Immutable.
- **`person_aliases`:** `person_id`, `alias`, `agent_run_id`, `created_at`. Append-only.
- **One namespace.** A name or alias belongs to one person: `lower(btrim(…))` is unique across all names and aliases together (a trigger, 23505). So "X3LIUS" and "x3lius" can't be two people; adding "x3lius" as an alias of X3LIUS is how the second spelling resolves.
- **`credits`:** `person_id`, `role`, exactly one of `song_id` / `track_id`, an optional `note`, `agent_run_id`.
  - `role` is one of: `writer`, `composer`, `lyricist`, `producer`, `vocalist`, `featured_artist`, `performer`, `arranger`, `recording_engineer`, `mixing_engineer`, `mastering_engineer`, `artwork`, `other`.
  - One live credit per target, person and role (23505).
- **`credit_retractions`:** `credit_id` (pk), `reason`. **`current_credits`** shows live credits.

### 4.2 Tasks (B2)

- **`tasks`:** `id`, `title`, at most one of `song_id` / `release_id` (none = a general task), `due_date` (optional), `agent_run_id`, `created_at`. Immutable.
- **`task_events`:** `task_id`, `status` (`done`, `cancelled`, `open` = reopened), `note`, `agent_run_id`, `created_at`. Append-only.
- **`current_tasks`:** each task with its latest status (`open` when it has no event yet).
- A task's history is its events; a changed title is a new task and a cancelled old one.

### 4.3 Platform links (B3)

- **`platform_links`:** `platform`, `url`, exactly one of `release_id` / `track_id`, `agent_run_id`, `created_at`.
- **`platform`** is one of: `spotify`, `apple_music`, `youtube`, `youtube_music`, `soundcloud`, `bandcamp`, `tidal`, `deezer`, `amazon_music`, `tiktok`, `instagram`, `other`.
- **The URL must be `https://`, and its host must match the platform** (a trigger, 23514):

  | Platform | Hosts |
  |---|---|
  | spotify | `open.spotify.com` |
  | apple_music | `music.apple.com` |
  | youtube | `youtube.com`, `www.youtube.com`, `youtu.be` |
  | youtube_music | `music.youtube.com` |
  | soundcloud | `soundcloud.com`, `on.soundcloud.com` |
  | bandcamp | `*.bandcamp.com` |
  | tidal | `tidal.com`, `listen.tidal.com` |
  | deezer | `deezer.com`, `www.deezer.com`, `link.deezer.com` |
  | amazon_music | `music.amazon.<tld>` |
  | tiktok | `tiktok.com`, `www.tiktok.com` |
  | instagram | `instagram.com`, `www.instagram.com` |
  | other | any host |

- One live link per target and platform (23505). **`platform_link_retractions`** keeps history; **`current_platform_links`** shows live ones.

### 4.4 Artwork

- **`release_artwork`:** `release_id`, `source_id` (a Vault file whose media class is `image`), `agent_run_id`, `created_at`. Append-only.
- A release's current artwork is its newest row, so the history of covers is kept. **`current_release_artwork`** shows it.

### 4.5 Delivery status

- **`release_deliveries`:** `release_id`, `distributor` (free text, e.g. DistroKid), `status`, `note`, `agent_run_id`, `created_at`. Append-only events.
- **`status`** is one of `submitted`, `in_review`, `approved`, `live`, `rejected`, `takedown_requested`, `taken_down`.
- **`current_deliveries`:** the latest status per release and distributor (case-insensitive).
- This records what the owner reports; no distributor is connected (AOS-06 connectors).

### 4.6 Tracks from Vault audio (B4)

- `tracks.take_id` becomes nullable; `tracks.source_id` (FK `sources`) is added; exactly one is set (23514).
- `source_id` must be a Vault file of media class `audio` (a trigger, 23514).
- Unique `(release_id, source_id)`, like `(release_id, take_id)`.
- The ISRC rule ("one ISRC names one recording") compares the recording, a take or a Vault file.

### 4.7 Computed checks (B2): the view `catalog_checks`

`catalog_checks` has columns `severity` (`blocker` / `warning`), `subject_kind` (`song` / `release` / `track`), `subject_id`, `code` and `message`.

- **Release, blockers before scheduling:**
  - `no_tracks`;
  - `track_no_splits`;
  - `track_unassigned_share`;
  - `no_artwork`.
- **Release, warnings:**
  - `no_upc`;
  - `track_no_isrc`;
  - `track_no_credits`;
  - `released_no_platform_link`;
  - `scheduled_no_delivery`.
- **Song, warnings:**
  - `lyrics_not_approved`: a linked lyrics lineage with no approved version;
  - `status_behind`: a linked track on a released release, but the song isn't `released`;
  - `status_ahead`: the song is `released`, but no linked track is on a released release;
  - `no_credits`.

Checks are never stored, so fixing the data clears them. The Rights check and the calendar guard stay the enforcing rules for scheduling (F31). These checks are the dashboard's view, not a second gate.

### 4.8 Roles

- **`xyp_catalog`** gains INSERT/SELECT on the new catalog tables, and INSERT of `tracks.source_id`.
- **`xyp_tasks`** (new): INSERT/SELECT on `tasks` and `task_events`, plus SELECT on `songs` and `releases` for the FKs.
- **`xyp_web`** gains SELECT on everything new.
- **`xyp_runtime`** gains SELECT on what the lookup and the checks read.
- **`service_role`** stays read-only (G20).

## 5. Agents and operations

- **`records-catalog`** (Execution) keeps `register`, `splits` and `assign`, and gains these operations, each with its own tool (`catalog.write`):
  - `person` and `alias`;
  - `credit` and `uncredit`;
  - `link` and `unlink` (platform links);
  - `artwork`;
  - `delivery`.
- **`records-catalog-lookup`** (Knowledge) resolves a registration's recording: `{ takeId }` as now, or `{ sourceId }` through `read_vault_file`, which must be an audio Vault file.
  - The title defaults to the formula's title (take), or to the one song the file is linked to (Vault audio); otherwise a title is required.
- **`register-track.workflow.yaml`** gains a `sourceId` input, and exactly one of `takeId` / `sourceId` is non-null. The workflow engine has no optional inputs, so the Phase 13 test helper passes `sourceId: null`.
- **`records-tasks`** (Execution, new): `{ create: { title, songId?, releaseId?, dueDate? } }` and `{ move: { taskId, status, note? } }`.

## 6. UI (`apps/web`)

- **`/` (the Command Center dashboard)** replaces the redirect to `/vault`. Every figure shows its source and time. It has:
  - songs by status;
  - releases by status, with their date and blocker count;
  - open tasks, by due date;
  - alerts (the checks, blockers first);
  - recent research (questions and findings);
  - connector health ("none connected; AOS-06").
- **`/releases`** and **`/releases/[id]`:**
  - tracks (recording, ISRC, current splits, credits);
  - UPC, artwork, platform links, deliveries, checks and tasks;
  - forms for: register a track (from a take or a Vault audio file), ISRC/UPC, splits, credit, link, artwork, delivery and task;
  - schedule (runs `schedule-release`: the Rights check, then the calendar) and mark released.
- **`/songs/[id]` workspace** adds credits, tasks, the derived release stage, the song's checks, and a "new release from this song" path.
- **`/people`**: people with aliases and their credits; add a person or an alias.
- **`/tasks`**: open and done tasks, with create and move.
- **As built:**
  - `/tasks` also lists cancelled tasks; a move takes an optional note.
  - The release workspace offers "add a track" on drafts only (Phase 13: tracks join drafts), and "schedule" or "mark released" by status.
  - The song workspace registers the song's own Vault audio on a new release; a Suno take is registered from `/releases` (F39).
  - A form's return path is kept on this origin (`lib/paths.ts`), control characters included: the URL parser drops tabs and newlines, so `/\t/host` would reach `//host`.

## 7. Export

- The new tables join `xyp-vault-export/v1`, found through the export closure:
  - credits of exported songs and tracks, with their people and aliases;
  - platform links, artwork and deliveries of exported releases and tracks;
  - tasks of exported songs and releases, with their events.
- **As built:** every person (with their aliases) and every task (with its events) is exported whole, like songs. A general task, or a collaborator not yet credited, belongs to no song, so the closure alone would drop them. A credit or platform link that was re-added after a retraction is ordered after that retraction, the same rule as song links.
- The format version stays `v1`: the tables are additive, and an older export imports unchanged.
- A released release still can't be exported (F37: a restore recreates drafts only), and that includes the gate's own final state (§8). Release history is AOS-08.

## 8. Tests (written first)

- **`tests/aos-02/command-db.test.ts`** (exact SQLSTATEs):
  - the name/alias namespace;
  - credit and link targets, and one live row per key;
  - the URL host table, row by row;
  - artwork as an image, and a Vault-audio track;
  - the ISRC rule across recordings;
  - task history;
  - every check code raised and cleared;
  - the grants.
- **`tests/aos-02/catalog-agents.test.ts`:**
  - the new `records-catalog` operations;
  - `records-tasks`;
  - `register-track` with Vault audio;
  - the Phase 13 workflows still green.
- **`tests/aos-02/idea-to-release.test.ts`** (the gate), end to end through agents and workflows:
  1. a song at `idea`;
  2. a lyric sheet, approved;
  3. a Vault bounce registered as a track on a new draft release;
  4. credits, splits, ISRC, UPC and artwork;
  5. tasks, done;
  6. the checks cleared;
  7. `schedule-release`, then released;
  8. a platform link and a delivery;
  9. the song at `released`, with no checks left.

  At the end, the song's history is intact: every revision, link, lyric version and approval, the track's recording traced to its Vault file and run, and every credit.
- **`apps/web`:** loader and ops tests for the dashboard, releases, people and tasks. `pnpm web:smoke` extended: dashboard → release → register a Vault track → artwork → schedule → released → link.

## 9. Out of scope (flagged)

- **Payee identity** (F32): splits don't reference people yet. The next step is an optional `person_id` on split rows.
- **Master vs publishing splits** (F32).
- **Editing** a person's name or a task's title: each is a new record.
- **Distributor connectors and analytics:** AOS-06.
- **Task assignees:** one owner (AOS-07/08 bring identities).
- **Exporting past-draft releases:** F37, AOS-08.
