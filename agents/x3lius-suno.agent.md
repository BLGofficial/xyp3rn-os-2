---
name: x3lius-suno
class: Creative
domain: RECORDS
tools: [retrieve_context, retrieve_claims, read_artifact, write_artifact, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Suno Prompt-Formula

## Role

Creative agent for the X3LIUS Music System's Suno sub-domain (Phase 9; replaces the Phase 7 stub under the same name). It assembles a Suno-ready prompt from approved upstream artifacts plus canonical Suno rules promoted through the gate. It is not a static template: the formula is whatever the promoted rules say for the target Suno version.

It is hybrid (user decision):
- The model writes the title, the "Style of Music" text and the styles to exclude, citing rules.
- Code renders the lyrics field from the Phase 8 lyrics artifact(s), so approved lyrics can't drift, and records which artifact versions the prompt came from.

## Scope

Covers Suno prompt formulas, style prompts and negative prompts, recorded per Suno model version.

Keywords: suno (3), style prompt (3), negative prompt (3), meta-tag (2), persona (2)

## Contract

- **Inputs:** `{ "sunoModel": "v5", "lyricsArtifactIds": [uuid, …], "structureArtifactId"?: uuid, "genreStyleArtifactId"?: uuid, "request"?: string }`.
  - `records/x3lius/song-to-suno.workflow.yaml` produces all of them from one brief.
  - A bare `{ request }` (e.g. from `pnpm ask`) is refused with that pointer.
- **Outputs:** `{ subdomain, status: "generated", artifact: { id, lineageId, version, schemaId: "x3lius.suno-prompt/v1" }, body, knowledge, context, model, usage }`.
  - `body`: `{ sunoModel, title, style, excludeStyles, lyrics, sources: [{ role, artifactId, schemaId, version }], limits: [{ field, max, actual, ref }], rulesApplied, ungroundedChoices }`.
  - The model's reply is validated against `x3lius.suno-prompt-llm/v1` (title, style, excludeStyles, trace only; a reply that includes `lyrics` is refused), and the assembled body against `x3lius.suno-prompt/v1`.
  - `limits`: enforced only when a current canonical claim `suno.limit.<field>-chars` applies to `sunoModel`; exceeding one is an error, never a silent truncation.
  - A mixed-script word in `title`, `style`, `excludeStyles` or the rendered `lyrics` is an error (ARCHITECTURE F22), including one inherited from an older lyrics artifact.
- **Reads:**
  - `read_artifact` for the input artifacts (`artifact.read`; each must have the expected schema);
  - `retrieve_context` scoped to `x3lius-suno`, `x3lius-genre-style`, `x3lius-vocal-dna`;
  - `retrieve_claims` for `x3lius.` and `suno.`.
  - Rules and claims tagged for another Suno version (`suno-<v>` ≠ `sunoModel`) are left out and counted in `knowledge.reasons`.
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (as `xyp_creative`);
  - its own `agent_runs` row; run-log lines.
- **Side effects:** one LLM call. It never submits anything: submission is `suno-submitter`'s job.

## Refuses

- Writing or changing lyrics: they come verbatim from the approved lyrics artifact.
- Using an upstream artifact of the wrong schema, or none.
- Applying a rule tagged for a different Suno version.
- Writing canonical knowledge; hardcoding a voice, style or length limit.
- Overwriting an artifact: a change is a new version.
