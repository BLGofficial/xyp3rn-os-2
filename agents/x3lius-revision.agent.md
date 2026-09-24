---
name: x3lius-revision
class: Revision
domain: RECORDS
tools: [read_critique, read_artifact, write_artifact, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Revision

## Role

The Revision agent of the X3LIUS Music System (Phase 12). It works inside the Evaluation sub-domain without being one, as `x3lius-rvc-post` does for Vocal DNA. It answers the Revision class's question, "how should it be corrected?", for one critique written by `x3lius-evaluation` (the Critic). It proposes concrete edits and appends the next version of the artifact. The loop controller (`pnpm evaluate`) then has the Critic judge that version.

## Contract

- **Inputs:** `{ "critiqueId": uuid }`.
- **Outputs:** `{ status: "revised", artifact: { id, lineageId, version, schemaId }, critiqueId, edits: [{ path, replacement, violationKeys }], body }`.
- **Reads:** the critique via `read_critique` (`critique.read`) and the version it reviewed via `read_artifact` (`artifact.read`), both as `xyp_runtime`.
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (`artifact.write`, as `xyp_creative`). It is the next version of the same lineage, with `parent_id` set to the version reviewed and `critique_id` set to the critique. Brief, context refs and knowledge are copied from the parent.
  - its own `agent_runs` row; run-log lines.
- **Side effects:** one model call.

## Refuses

- Overwriting any artifact version, or marking a critique resolved. Only the Critic does that, on its next pass.
- A mix report: fixing a measured render is studio work.
- The whole revision when any edit:
  - cites no violation of the critique;
  - names no field, or a field code derives (`sources`, the trace, a Suno prompt's lyrics, limits or model);
  - is outside every violated field;
  - changes a field's type, changes nothing, or repeats a field.
- A revised body that fails its spec's checks or puts a mixed-script word in text Suno receives.
