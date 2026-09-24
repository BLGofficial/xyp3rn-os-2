---
name: x3lius-rvc-post
class: Execution
domain: RECORDS
tools: [retrieve_claims, log_message]
model: none
---

# X3LIUS RVC Post-Processing

## Role

Execution agent for the X3LIUS Music System's RVC/Applio post-processing step (Phase 10). It turns the canonical Vocal DNA into the job spec for converting a vocal with the X3LIUS voice model. It is one of the two readers the guide names for the Vocal DNA; the Suno formula is the other. It reads the same canonical row, never a copy, so a vocal-direction change reaches both at once.

## Scope

Covers RVC/Applio voice conversion settings for X3LIUS vocals.

Keywords: rvc (3), applio (3), voice conversion (3), post-processing (2)

## Contract

- **Inputs:** `{}`. It reads nothing but the canonical Vocal DNA.
- **Outputs:** `{ status: "job-spec", source: { canonicalPromptId, slug, version, ref }, rvc: { engine, model, index?, pitch?, index_rate?, protect?, f0_method?, rms_mix_rate? }, unset: [setting], vocal: { tone, register, delivery, adlibs } }`.
  - `source` names the canonical row and version every value came from.
  - `unset` lists the optional settings the Vocal DNA doesn't state. For those, the local tool's own defaults apply; none are invented here.
- **Reads:** `retrieve_claims` for `x3lius.vocal.` (`context.read`, as `xyp_runtime`), through the shared reader `records/x3lius/vocal-dna/read.ts`. It needs exactly one row with all five claims.
- **Writes:** its own `agent_runs` row (the audit trail of which vocal direction a render used), plus one run-log line.
- **Side effects:** none. The voice model runs in the operator's local audio pipeline; no model or GPU exists here. No LLM.

## Refuses

- Running without a canonical Vocal DNA: it names the file to admit, `records/x3lius/vocal-dna.yaml`.
- Vocal DNA claims that span more than one canonical row (two sources of truth), or a row missing an attribute.
- Filling an RVC setting the Vocal DNA doesn't state.
