---
name: x3lius-lyrics
class: Creative
domain: RECORDS
tools: [retrieve_context, retrieve_claims, read_artifact, write_artifact, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Lyrics

## Role

Creative agent for the X3LIUS Music System's Lyrics sub-domain (Phase 8; replaces the Phase 7 stub under the same name). It answers the Creative class's question, "what should the lyrics be?". Since the Phase 9 live runs it writes the whole song (`x3lius.lyrics/v2`, user decision). Given a song-structure artifact, it writes every section of it in order, one model call per section, hook included (ARCHITECTURE F21). The voice reference comes from canonical knowledge at run time: the guide's claim and any rule the Promotion Gate placed in `x3lius-lyrics` or `x3lius-vocal-dna`. It is never written into this file or its code.

## Scope

Covers lyric writing, rhyme schemes and wordplay in the X3LIUS voice.

Keywords: lyric (3), rhyme (3), wordplay (3), bar (2), punchline (2), flow (1)

## Contract

- **Inputs:** `{ "request": string, "structureArtifactId"?: uuid }`.
  - `records/x3lius/song-to-suno.workflow.yaml` passes the structure the songwriting step wrote.
  - A bare `{ request }` (routed here by the X3LIUS Music System entrypoint, or dispatched directly) writes the sections the brief asks for, following no structure.
- **Outputs:** `{ subdomain, status: "generated", artifact: { id, lineageId, version, schemaId: "x3lius.lyrics/v2" }, body, knowledge, warnings, context, model: { ref, served }, usage }`.
  - `body`: `{ sections: [{ sectionId, kind, label, bars: [{ n, text, language, rhymeTag }], rhymeScheme, devices: [{ bar, device, note }] }], instrumental: [sectionId], sources: [{ role: "structure", artifactId, schemaId, version }], rulesApplied: [{ ref, how }], ungroundedChoices: [string] }`.
  - With a structure:
    - Each call replies against `x3lius.lyrics-section-llm/v2`: `instrumental`, `label`, `bars`, `rhymeScheme`, `devices`, trace.
    - Each call sees the structure and the lyrics written so far, under `WRITE NOW: section <id> (<kind>, <bars> bars): <purpose>`.
    - Code sets `sectionId` and `kind` from the structure and records it in `sources`. So every structure section appears once, in order, written or in `instrumental`.
    - Each call's trace is kept, prefixed `[<sectionId>]`. A section marked instrumental may not have bars.
  - Without a structure: one call replies against `x3lius.lyrics-llm/v2`.
  - In both cases every section's bars are numbered 1..n in order, and no section id repeats.
  - Mixed-script words (Latin and Cyrillic letters in one word, a homoglyph corruption; ARCHITECTURE F22):
    - refused in bar text and section labels, which Suno receives verbatim;
    - anywhere else they are written to the artifact's `warnings`.
  - `language` is a free ISO 639-1 code (or `mixed`). Which languages to use is a canonical rule, not a schema constant.
  - `knowledge`: `{ sparse, threshold, scopedRules, perModule, voiceClaims, reasons }`. `sparse` is true below 3 scoped rules.
  - `context`: every canonical ref sent to the model, each with its source.
- **Reads:**
  - `read_artifact` for the structure artifact (`artifact.read`; it must be `x3lius.song-structure/v1`);
  - `retrieve_context` scoped to `x3lius-lyrics`, then to `x3lius-vocal-dna`;
  - `retrieve_claims` with topic prefix `x3lius.`.
  - Both are read-only as `xyp_runtime` (capability `context.read`).
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (capability `artifact.write`, as `xyp_creative`, insert-only);
  - its own `agent_runs` row; run-log lines.
- **Side effects:** LLM calls to the provider named by `model` (key from the environment): one per structure section, or one for a bare brief.
  - A failed call stops the run and nothing is written; the error names the section.
  - Progress is logged per section.

## Refuses

- Writing canonical knowledge, including the rules it consumes.
- Hardcoding a voice: with thin rules it says so (`knowledge.sparse`, `ungroundedChoices`) rather than falling back to a built-in style.
- Writing a reply that isn't schema-valid JSON, that cites a ref it wasn't given, that marks a section instrumental while giving it bars, or that has a mixed-script word in a bar or label: the run errors and nothing is written.
- Overwriting an artifact: a change is a new version.
