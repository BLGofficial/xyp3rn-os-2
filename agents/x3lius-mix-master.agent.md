---
name: x3lius-mix-master
class: Creative
domain: RECORDS
tools: [retrieve_claims, write_artifact, log_message]
model: none
---

# X3LIUS Mix/Master

## Role

Creative agent for the X3LIUS Music System's Mix/Master sub-domain (Phase 11). It replaces the Phase 7 stub under the same name. It is deterministic (user decision, ARCHITECTURE F10): it checks a TRACE-shaped analysis of one render against the canonical mix/master rubric and writes the adjustments as an artifact. Every bound it applies is a canonical claim, cited by ref and version. A metric the rubric doesn't bound is reported as unset, never checked against a default.

## Scope

Covers mix and master decisions against a rubric, from structured TRACE-shaped analysis.

Keywords: mix (3), mixing (3), master (3), mastering (3), lufs (3), loudness (3), trace (2), eq (2), compression (2), limiter (2), stereo width (2)

## Contract

- **Inputs:** `{ "analysis": trace.analysis/v1, "request"?: string }`.
  - The contract is `tech/trace/analysis.ts`: loudness, tonal balance over seven fixed bands, stereo correlation and width (full band and per band), and crest factor, for the `mix` or the `master` stage.
  - An invalid analysis is refused with every violation named.
- **Outputs:** `{ subdomain, status: "checked", artifact: { id, lineageId, version, schemaId: "x3lius.mix-report/v1" }, body, knowledge, context }`.
  - `body`: `{ stage, analysis, checks: [{ metric, unit, measured, rubric: { min?, max? }, action: keep|raise|lower, by, ref, version }], unset: [metric] }`.
  - `checks` is in contract order. `by` is the distance to the nearest bound in the metric's unit.
  - `knowledge`: `{ rubricClaims, unset, reasons }`. `context`: every rubric claim applied.
- **Reads:** `retrieve_claims` with prefix `x3lius.<stage>.`, keeping claims scoped `trace` (`context.read`, as `xyp_runtime`). The claims come from `records/x3lius/mix-rubric.yaml` or from research candidates, both admitted through the gate.
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (`artifact.write`, as `xyp_creative`);
  - its own `agent_runs` row; run-log lines.
- **Side effects:** none. No LLM, no audio, no DAW. TRACE itself is wired in Phase 14.

## Refuses

- Running without an analysis, or with one that isn't a valid `trace.analysis/v1`.
- A threshold from code: with no rubric claim for a metric, it lists the metric as `unset`.
- A metric bounded by two current canonical rows (two sources of truth), or a malformed bound.
- Writing canonical knowledge, including the rubric it applies.
