---
name: suno-submitter
class: Execution
domain: RECORDS
tools: [submit_suno, capture_suno_takes, log_message]
model: none
---

# Suno Submitter

## Role

Execution agent for Suno generation (Phase 9). It answers the Execution class's question, "how do we perform the operation?". It submits one approved `x3lius.suno-prompt/v1` artifact to Suno through the adapter the caller names, and records the takes that come back. It creates no content and makes no choice: the artifact and the adapter are inputs.

Suno has no official public API (as of 2026-09). The adapters are:
- `manual`: the prompt is recorded, the operator generates in the Suno UI and registers the takes.
- `sunoapi`: the sunoapi.org reseller, unverified until `SUNO_API_KEY` exists.

## Contract

- **Inputs:** exactly one of:
  - `{ "submit": { "formulaArtifactId": uuid, "adapter": "manual" | "sunoapi" } }`
  - `{ "capture": { "submissionId": uuid, "takes"?: [{ "audioUrl": "https://…", "title"?: string, "durationSeconds"?: number }] } }`, where `takes` is required for `manual` and refused for `sunoapi` (whose takes come from one provider poll).
- **Outputs:**
  - submit: `{ submissionId, adapter, sunoModel, providerTaskId, status: "awaiting-takes" | "submitted" }`.
  - capture: `{ submissionId, status: "captured" | "pending", inserted, alreadyCaptured, takes: [{ id, audioUrl }], scoring: { status: "stub", scorer, rows } }`.
- **Reads:** the formula artifact by id, as `xyp_execution`. The submitted prompt is copied from the artifact, never taken from the caller.
- **Writes:**
  - `suno_submissions`, `suno_takes`, `take_scores` (insert-only, as `xyp_execution`, capability `external.execute`).
  - Each new take gets one STUB `take_scores` row with no score until the Phase 12 Critic exists.
  - Its own `agent_runs` row, whose log carries the **full prompt text** of every submission, written before the external call (the Governance audit trail).
- **Side effects:** `sunoapi` only: one `POST /api/v1/generate` per submit and one `GET /api/v1/generate/record-info` per capture. `manual`: none.

## Refuses

- Choosing the adapter or the artifact: a missing adapter or a non-`x3lius.suno-prompt/v1` artifact is an error.
- Submitting anything but the artifact's own prompt fields.
- Scoring a take: the hook writes a stub marker, never a number.
- Retrying a submission (Phase 4D: no retries on side-effecting agents until idempotency keys exist).
- Updating or deleting a submission, take or score.
