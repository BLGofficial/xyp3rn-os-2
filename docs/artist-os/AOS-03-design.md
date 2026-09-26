# AOS-03 — Studio mode and Suno-ready workflows: design

Status: the four decisions below were made by the operator in conversation (2026-09-25; asked there as C1–C4, recorded here as S1–S4 because the baseline's conflicts already use C1–C7). Everything else is the default stated here, open to review.
Source: [PLAN.md](PLAN.md) §3B ("Style recipes", "Meta-tag sets", "Song sessions"), §3F and §5 Phase 3; gaps G6 (styles, tags), G9, G10 and G11 (optional inputs) in [AOS-00-baseline.md](AOS-00-baseline.md); conflict C3 (meta tags). Built on AOS-02 (PR #14, merged), on branch `claude/aos-03-rekz1t`.

## 1. Intent

The plan's AOS-03:

- **Work:** lyric editing/versioning, style and meta-tag builders, generation tracking, reusable templates, and manual handoff/import.
- **Deliverables:** an end-to-end song creation workflow and a Suno prompt package export.
- **Gate:** every generation attempt can be traced to the exact lyric, style, tags, workflow version, and resulting audio.

What already exists and is reused, not rebuilt:

- Lyric editing and versioning (AOS-01): `x3lius-lyric-editor`, lyric sheets, owner approval (`xyp_decide_artifact`, `artifact_approvals`), the lineage page.
- `creative_artifacts` lineages: insert-only versions, derived version numbers, immutability, export, Vault search.
- The Phase 9 Suno trail: `suno_submissions`, `suno_takes`, `take_scores`, the `manual` and `sunoapi` adapters, `suno-submitter`.
- `song_links` (a song links an artifact lineage, a take, a Vault file…), and `register-track`, which already takes a Suno take (AOS-02).

What is missing today (why the gate fails now):

| Gate clause | Today |
|---|---|
| exact lyric | The formula's `sources` name the lyric version, but nothing checks it was approved (the formula and submitter docs say "approved"; no code checks it). |
| exact style | Only the model-written `x3lius.genre-style/v1`; no owner recipe, no approval. |
| exact tags | Code (`sectionLabels`, F21); no version. |
| workflow version | Only indirectly, and only when the formula was built in a workflow run. |
| resulting audio | An https URL; no bytes, no Vault file. |

## 2. Decisions

| # | Decision | Chosen (operator) | Rejected |
|---|---|---|---|
| S1 | Where style recipes and meta-tag sets live | **Creative-artifact lineages** (`x3lius.style-recipe/v1`, `x3lius.meta-tag-set/v1`), written by a deterministic owner agent and approved like lyrics. Reuse across songs = one lineage used by many packages. | Own tables (a second versioning and approval mechanism); canonical knowledge via the gate (per-song recipes aren't knowledge) |
| S2 | Where section tags live (baseline C3, F21) | **A default tag set v1, seeded from `sectionLabels`.** Every package names a tag-set version. Owner edits are new versions; owner cues render into Suno's lyrics field. Code keeps the seed and the renderer. | Code labels plus an optional cue layer (an attempt without a set traces to "code", not a version); deferring tag sets |
| S3 | Suno handoff and audio import | **A prompt package + a Vault take.** The package (title, style, exclusions, rendered lyrics, every version id, the workflow) is exported as JSON and as copy-paste text, and recorded as the `manual` submission. The result is uploaded into the Vault and registered as a take of that submission (`suno_takes.source_id`). | A plain Vault file linked by metadata (weaker trace); the sunoapi reseller as the main path |
| S4 | Approval before handoff | **A hard gate at submit.** Drafts can build and preview a package; a submission is refused unless its lyric, style recipe and tag set versions are each approved. Enforced in the DB. | Warn only; a workflow-engine approval step |

Defaults the operator did not override:

- Red tests first; one migration `20260925160000_studio` with its rollback.
- **A package is a creative artifact too** (`x3lius.suno-package/v1`), built deterministically by `x3lius-suno-package` inside a workflow (`build-suno-package`), so every attempt has a workflow version. Only that agent may write that schema (a DB guard), so a package can't be forged by another writer.
- **A package is immutable and never revised.** A new lyric, style or tag version means a new package. The history of the creative content lives in its own lineages.
- **The LLM path stays a proposer.** `song-to-suno` still writes a `x3lius.suno-prompt/v1` formula. It can no longer be submitted. Its style and exclusions become a recipe draft through `recipeFrom`, and the owner approves it.
- **Ratings:** the owner rates a take 1–5, with optional notes on what to keep and what to change. They are append-only, and the latest is current (`take_ratings`). This is the owner's feedback, kept apart from the Critic's `take_scores` stubs.
- **Optional workflow inputs (G11, part):** `input.optional`. An absent optional input binds as `null`. `register-track` uses it for `takeId`, `sourceId`, `title` and `mixReportArtifactId`; callers that pass `null` today are unchanged.
- **Engine approval steps (G11, the rest):** not built. S4 puts the gate on the submission. Engine pause/resume stays AOS-08.
- **Instrumental sections** are not rendered, as today. A tag set can't yet tag an instrumental break (§9).

## 3. Components and owners

| Unit | Kind | Owner (domain) | Class / role |
|---|---|---|---|
| `x3lius.style-recipe/v1`, `x3lius.meta-tag-set/v1`, `x3lius.suno-package/v1` | artifact schemas | RECORDS (`records/x3lius/creative/schemas.ts`) | written as `xyp_creative` |
| `x3lius-studio-editor` | agent, `model: none` | RECORDS | Creative, `artifact.write` + `artifact.read` |
| `x3lius-suno-package` | agent, `model: none` | RECORDS | Creative, `artifact.write` + `artifact.read` + `context.read` |
| `build-suno-package.workflow.yaml` | workflow | RECORDS (`records/workflows`) | package → link to the song |
| `suno-submitter` | existing agent: package-only submit, Vault takes, `rate` | RECORDS | Execution, `external.execute` + `feedback.write` (new) |
| `suno_takes.source_id`, `take_ratings` | column, table | RECORDS | written as `xyp_execution` |
| `xyp_suno_package_ready`, the submission gate, the package writer guard | SQL function, triggers | RECORDS | — |
| `generation_attempts`, `generation_takes` | views (the trace) | RECORDS | read as `xyp_web` |
| optional inputs | `core/workflow-engine` | CORE | — |
| Studio screens | `apps/web` | UI | reads as `xyp_web`, writes via dispatch |

**Capabilities:**

| Capability | Change | Classes |
|---|---|---|
| `feedback.write` | new: the owner's ratings of a generation's result (`take_ratings`). AOS-07's feedback loop reads them. | Execution |

## 4. Data

### 4.1 Artifact schemas (code; validated by `write_artifact`)

Every body ends with the traceability pair (`rulesApplied`, `ungroundedChoices`), as every creative schema does. Owner-authored bodies carry `rulesApplied: []` and `ungroundedChoices: ["owner-authored"]`, as the lyric editor's do.

**`x3lius.style-recipe/v1`** (PLAN §3B: "reusable style prompts, exclusions, production direction, mood, and tested notes"):

| Field | Sent to Suno | Meaning |
|---|---|---|
| `name` | no | the recipe's name |
| `style` | yes, verbatim | the "Style of Music" field |
| `excludeStyles` | yes, verbatim | the exclusions (negative prompt) |
| `mood` | no | mood words |
| `production` | no | production direction notes |
| `notes` | no | tested notes: what worked, what didn't |
| `sources` | no | `[{ role: "suno-prompt", artifactId, schemaId, version }]` when seeded from a formula, else `[]` |

**`x3lius.meta-tag-set/v1`** (PLAN §3B: "section tags, vocal/performance instructions, arrangement cues, and version history"):

- `name`, `notes` (not sent), `sources` (`[]`);
- `sections`: one entry per section kind it covers, each `{ kind, label, numbered, cues }`:
  - `kind` is one of the existing section kinds (`intro`, `verse`, `pre-chorus`, `chorus`, `post-chorus`, `hook`, `bridge`, `breakdown`, `outro`), at most once per set;
  - `label` is the tag text, e.g. `Chorus`;
  - `numbered`: occurrences are numbered in song order (`Verse 1`, `Verse 2`);
  - `cues`: extra tags for that kind, e.g. `Whispered`, `Full band`.
- Labels and cues can't be blank or contain `[` or `]`.

**Rendering (code, `renderWithTags`):** for each sung section of the lyrics, in order:

1. `[<label>]`, or `[<label> <n>]` when numbered;
2. then one `[<cue>]` line per cue;
3. then the bars, one per line.

Sections are separated by a blank line. A section kind the set doesn't cover refuses the package, naming the kind.

**The default set (S2):** `defaultTagSet()` covers all nine kinds, with `label` = the kind's name as `sectionLabels` writes it, `numbered` only for `verse`, and no cues. A test pins that rendering with it equals `renderLyrics` (today's formula output) for lyrics from both writers (the Lyrics agent and the lyric editor).

**`x3lius.suno-package/v1`:**

- `sunoModel`, `title`, `style`, `excludeStyles`, `lyrics` (rendered with the tag set);
- `sources`: exactly one each of `lyrics` (`x3lius.lyrics/v2`), `style-recipe` and `meta-tag-set`, each `{ role, artifactId, schemaId, version }`;
- `limits`: `[{ field, max, actual, ref }]` from the `suno.limit.<field>-chars` claims for that Suno model (the formula's rule, F20). A field over its limit refuses the package;
- `rulesApplied`: the limit claims applied; `ungroundedChoices`: `[]`.

### 4.2 Migration `20260925160000_studio` (with its rollback)

- **Package writer guard** (`trg_creative_artifacts_package_writer`): a `x3lius.suno-package/v1` row must have `agent_name = 'x3lius-suno-package'` (23514).
- **Takes from the Vault (S3):**
  - `suno_takes.audio_url` becomes nullable, and `suno_takes.source_id` (FK `sources`) is added;
  - exactly one of `audio_url` / `source_id` is set (23514);
  - `source_id` must be a Vault file of media class `audio` (a trigger, 23514);
  - unique `(submission_id, source_id)` (23505), like `(submission_id, audio_url)`.
- **`xyp_suno_package_ready(p_artifact_id) returns text[]`** (SECURITY DEFINER; EXECUTE for `xyp_execution` and `xyp_web`). It returns the reasons a package can't be submitted, and none when it can:
  - it is not a `x3lius.suno-package/v1`;
  - a source is missing, or doesn't match its artifact (id, schema, version);
  - a source version is not approved (`artifact_approvals.status`), naming each draft or rejected version;
  - it was not built in a workflow run that succeeded.
- **The submission gate (S4)** (`trg_suno_submissions_gate`, BEFORE INSERT). It refuses a submission when:
  - `xyp_suno_package_ready` returns any reason (55000, the reasons in the message);
  - `prompt` is not the package's `{title, style, excludeStyles, lyrics}`, or `suno_model` is not its `sunoModel` (23514).

  Rows written before AOS-03 stay as they are; the trigger runs on insert only.
- **`take_ratings`:** `take_id`, `rating` (1–5), `keep`, `change` (optional, non-blank when set), `agent_run_id`, `created_at`. Append-only. **`current_take_ratings`** is the latest per take.
- **The trace views** (`security_invoker`):
  - `generation_attempts`, one row per submission:
    - the package and its version;
    - its song (the live `suno-package` link);
    - its title and model;
    - the lyric, recipe and tag set, each id and version;
    - the workflow run, name and spec sha256;
    - its take count, and `is_traced` (false for a pre-AOS-03 submission).
  - `generation_takes`, one row per take: the Vault file and its sha256 (or the URL), and the current rating.
- **Roles:**
  - `xyp_execution` gains INSERT/SELECT on `take_ratings` (and `current_take_ratings`) and EXECUTE on `xyp_suno_package_ready`;
  - `xyp_web` gains SELECT on `take_ratings` and the views, and EXECUTE on the function;
  - `service_role` stays read-only (G20).

## 5. Agents, workflows and operations

- **`x3lius-studio-editor`** (Creative, deterministic). Every version it writes is a draft until the owner decides. It takes exactly one of:
  - `{ recipe: { name, style, excludeStyles?, mood?, production?, notes?, parentId? } }`: a new recipe lineage, or the next version of `parentId`'s;
  - `{ recipeFrom: { artifactId, name? } }`: a new recipe from a `x3lius.suno-prompt/v1` formula's style and exclusions, citing it; the name defaults to the formula's title;
  - `{ tagSet: { name, sections, notes?, parentId? } }`;
  - `{ defaultTagSet: {} }`: the code default (S2) as a new lineage.

  F22 applies to what Suno receives (`style`, `excludeStyles`, labels, cues): a mixed-script word there is refused. Elsewhere it is a warning.
- **`x3lius-suno-package`** (Creative, deterministic): `{ lyricsArtifactId, styleRecipeArtifactId, tagSetArtifactId, title, sunoModel }` → a package, v1 of a new lineage. It reads each input (refusing a wrong schema), renders the lyrics with the tag set, measures the limits, checks F22, and writes. It builds from drafts too (a preview); only the submission requires approvals (S4).
- **`records/workflows/build-suno-package.workflow.yaml`:** all six inputs required (`songId`, the three artifact ids, `title`, `sunoModel`). The steps are:
  1. `package` (`x3lius-suno-package`);
  2. `link` (`records-songs`: the package lineage to the song, role `suno-package`).
- **`suno-submitter`:**
  - `{ submit: { packageId, adapter } }`: a package only. It calls `xyp_suno_package_ready` first, so a draft never reaches an adapter (`sunoapi` makes no call). The DB gate enforces the same rule again. The Phase 9 `formulaArtifactId` key is refused with a pointer to packages.
  - `{ capture: { submissionId, takes } }`: `manual` takes are each `{ sourceId }` (a Vault audio file) or `{ audioUrl }`, plus an optional `title` / `durationSeconds`. A Vault take without a title shows its file's (`generation_takes.file_title`).
  - `{ rate: { takeId, rating, keep?, change? } }` (new tool `rate_take`, `feedback.write`).
- **Optional inputs (engine):** `input: { required: [...], optional: [...] }`. A name in both lists, or a `$from input.x` that neither declares, is a spec error. The run's stored spec records both lists.
- **Import a take (UI and CLI):** the audio goes into the Vault first (`vault-curator`), then `capture` with its `sourceId`. This is the artwork pattern from AOS-02.
- **The package export** (`records/x3lius/suno/package.ts`, `packageExport`), format `xyp-suno-package/v1`:
  - the package id and version, the Suno model;
  - the four Suno fields;
  - the sources with their approval status;
  - the workflow name, sha256 and run.

  It is also rendered as copy-paste text, one block per Suno field. It is served by the web export route and by `pnpm studio export <packageId>`.

## 6. UI (`apps/web`)

- **`/studio`:**
  - style recipes and tag sets: name, latest version, approved version;
  - forms for a new recipe, a new tag set, and the default tag set;
  - recent attempts across songs.
- **`/studio/recipes/[id]`** and **`/studio/tags/[id]`** (a lineage):
  - the current version, and every version with its status;
  - approve or reject a version;
  - edit, which writes a new version;
  - the packages that used it.
- **`/studio/packages/[id]`:**
  - the copy-paste blocks and a JSON download;
  - the trace (lyric, recipe and tag set versions with their status, and the workflow);
  - what blocks the handoff (`xyp_suno_package_ready`), and "hand off (manual)";
  - its attempts, each with its takes: upload audio (Vault → take), play it, rate it.
- **`/songs/[id]`** gains a Studio section: build a package from the song's lyric versions, a recipe and a tag set (each version listed with its status), the Suno model, and a title (defaulting to the song's), plus the song's packages and attempts.
- The nav gains Studio.

## 7. Export

- `take_ratings` joins `xyp-vault-export/v1`.
- The closure gains:
  - the lineages an exported artifact cites in `body.sources` (whole, with their approvals). This also closes a gap for Phase 9 formulas, whose lyric source was exported only if linked;
  - the submissions of exported packages;
  - the takes of exported submissions;
  - the ratings of exported takes.
- **Import order:** a submission is inserted after its package's source versions and their approvals, because the gate trigger runs on import too.
- The format stays `v1` (additive); the AOS-01 and AOS-02 round trips stay byte-identical.

## 8. Tests (written first)

- **`tests/aos-03/studio-db.test.ts`** (exact SQLSTATEs):
  - the package writer guard;
  - Vault takes: exactly one of URL/file, audio only, once per submission;
  - the submission gate: a formula, a draft source, no workflow, a failed workflow, a prompt or model mismatch, and the approved path;
  - the readiness reasons;
  - ratings (range, notes, append-only, current);
  - the trace views;
  - the grants.
- **`tests/aos-03/studio-agents.test.ts`:**
  - the studio editor's four operations and its refusals;
  - the default tag set rendering equal to `renderLyrics`;
  - the package agent (cues, numbering, a missing kind, limits, F22);
  - `build-suno-package`;
  - the submitter (package only; no adapter call for a draft; Vault takes; `rate`);
  - optional inputs in the engine and in `register-track`.
- **`tests/aos-03/idea-to-take.test.ts`** (the gate), through agents and workflows:
  1. a song at `idea`, with a lyric sheet;
  2. a recipe from a model formula, edited;
  3. the default tag set, edited with cues;
  4. a package (workflow);
  5. the submission refused while a source is a draft, then accepted once each is approved;
  6. a bounce uploaded as the take;
  7. rated;
  8. registered on a release.

  Then the attempt's trace: the exact versions, the workflow sha256, the audio's sha256. It survives an export round trip.
- **Updated on purpose:** the Phase 9, Phase 13 and shared fixtures that inserted a bare formula submission now build an approved package (`tests/helpers/package-fixture.ts`). The Phase 9 submit tests submit a package, and assert that a formula is refused.
- **`apps/web`:** loader and ops tests for Studio. `pnpm web:smoke` is extended: recipe → tag set → approve → package → hand off → upload a take → rate.

## 9. Out of scope (flagged)

- **Instrumental sections in tag sets:** v2 lyrics list instrumental sections by id only, so a set can't tag an instrumental break yet.
- **Recipes and tag sets from agents:** only the owner's editor writes them (and `recipeFrom` seeds from a formula). Model-proposed versions are AOS-07's improvement proposals.
- **Engine approval steps and resume:** AOS-08 (S4 enforces approval on the submission instead).
- **Takes from the reseller API:** `sunoapi` takes stay URL-only (no download into the Vault).
- **Same recording, two paths:** a Vault bounce registered directly and the same file as a take count as two recordings for the ISRC rule.
- **Take scoring by the Critic:** the `take_scores` stubs stay (F30); the owner's rating is not a Critic score.
