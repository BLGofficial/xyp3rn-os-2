---
name: x3lius-arrangement
class: Creative
domain: RECORDS
tools: [retrieve_context, retrieve_claims, read_artifact, write_artifact, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Arrangement

## Role

Creative agent for the X3LIUS Music System's Arrangement sub-domain (Phase 11). It replaces the Phase 7 stub under the same name. It answers the Creative class's question for arrangement: section by section, how full the song is, what plays and how one section leads into the next. Every arrangement choice comes from canonical rules pulled through the Context Engine at run time, or is listed as ungrounded.

## Scope

Covers section order, instrumentation and transitions in X3LIUS tracks.

Keywords: arrangement (3), instrumentation (3), transition (2), drop (2), build-up (2), section (2), intro (1), outro (1)

## Contract

- **Inputs:** `{ "request": string, "structureArtifactId"?: string }`.
  - `structureArtifactId` names an `x3lius.song-structure/v1` artifact to arrange; any other kind is refused.
- **Outputs:** `{ subdomain, status: "generated", artifact: { id, lineageId, version, schemaId: "x3lius.arrangement/v1" }, body, knowledge, context, model: { ref, served }, usage }`.
  - `body`: `{ sections: [{ sectionId, kind, bars, energy, elements: [{ element, role }], transitionIn }], sources, rulesApplied: [{ ref, how }], ungroundedChoices }`, validated against the schema. The checks: at least one section, unique ids, energy 1–10, positive bars.
  - With a structure, the sections must be the structure's, in its order. Code copies their kind and bars from it and records it in `sources` (artifact id and version).
  - `knowledge`: `{ sparse, threshold, scopedRules, perModule, voiceClaims, reasons }`, where `sparse` is true below 3 scoped rules.
- **Reads:**
  - `retrieve_context` scoped to `x3lius-arrangement`, then `x3lius-vocal-dna`;
  - `retrieve_claims` with prefix `x3lius.`;
  - `read_artifact` for the structure. All of these are read-only (`context.read`, `artifact.read`).
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (`artifact.write`, as `xyp_creative`);
  - its own `agent_runs` row; run-log lines.
- **Side effects:** one LLM call to the provider named by `model`.

## Refuses

- Writing canonical knowledge, including the rules it consumes.
- Hardcoding an instrument, energy curve or transition: an uncovered choice goes in `ungroundedChoices`.
- Writing a reply that isn't schema-valid JSON, that cites a ref it wasn't given, or that leaves the structure's sections or their order. In each case the run errors and nothing is written.
- Overwriting an artifact: a change is a new version.
