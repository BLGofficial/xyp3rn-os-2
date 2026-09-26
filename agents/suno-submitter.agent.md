---
name: suno-submitter
class: Execution
domain: RECORDS
tools: [submit_suno, capture_suno_takes, rate_take, log_message]
model: none
---

# Suno Submitter

## Role

Execution agent for Suno generation (Phase 9). It answers the Execution class's question, "how do we perform the operation?". It hands one ready Suno prompt package (`x3lius.suno-package/v1`, AOS-03) to Suno through the adapter the caller names, records the takes that come back, and records the owner's rating of a take. It creates no content and makes no choice: the package, the adapter and the rating are inputs.

Suno has no official public API (as of 2026-09). The adapters are:
- `manual`: the prompt is recorded, the operator generates in the Suno UI, uploads the result into the Vault and registers it as a take.
- `sunoapi`: the sunoapi.org reseller, unverified until `SUNO_API_KEY` exists.

## Contract

- **Inputs:** exactly one of:
  - `{ "submit": { "packageId": uuid, "adapter": "manual" | "sunoapi" } }`
  - `{ "capture": { "submissionId": uuid, "takes"?: [{ "sourceId": uuid } | { "audioUrl": "https://…" }, plus "title"?: string, "durationSeconds"?: number] } }`, where `takes` is required for `manual` and refused for `sunoapi` (whose takes come from one provider poll). A `sourceId` is a Vault audio file (AOS-03, S3).
  - `{ "rate": { "takeId": uuid, "rating": 1–5, "keep"?: string, "change"?: string } }` (AOS-03).
- **Outputs:**
  - submit: `{ submissionId, packageId, adapter, sunoModel, providerTaskId, status: "awaiting-takes" | "submitted" }`.
  - capture: `{ submissionId, status: "captured" | "pending", inserted, alreadyCaptured, takes: [{ id, audioUrl, sourceId }], scoring: { status: "stub", scorer, rows } }`.
  - rate: `{ ratingId, takeId, rating, keep, change }`.
- **Reads:** the package by id, as `xyp_execution`, and its readiness (`xyp_suno_package_ready`) before any adapter call. The submitted prompt is copied from the package, never taken from the caller.
- **Writes:**
  - `suno_submissions`, `suno_takes`, `take_scores` (insert-only, as `xyp_execution`, capability `external.execute`). The DB gate refuses a submission whose package isn't ready (S4) or whose prompt isn't the package's own.
  - `take_ratings` (insert-only, as `xyp_execution`, capability `feedback.write`).
  - Each new take gets one STUB `take_scores` row with no score until the Phase 12 Critic exists.
  - Its own `agent_runs` row, whose log carries the **full prompt text** of every submission, written before the external call (the Governance audit trail).
- **Side effects:** `sunoapi` only: one `POST /api/v1/generate` per submit and one `GET /api/v1/generate/record-info` per capture. `manual`: none.

## Refuses

- Choosing the adapter or the package: a missing adapter is an error.
- Anything but a ready package (AOS-03, S4): a Phase 9 formula (or the old `formulaArtifactId` key), a package whose lyric, style recipe or tag set version is not approved, or one no successful workflow run built. Readiness is checked before the adapter is called, so a draft never reaches Suno.
- Submitting anything but the package's own prompt fields.
- A take that names both a URL and a Vault file, or neither; a Vault file that is not audio.
- A rating outside 1–5.
- Scoring a take: the hook writes a stub marker, never a number. A rating is the owner's feedback, not a score.
- Retrying a submission (Phase 4D: no retries on side-effecting agents until idempotency keys exist).
- Updating or deleting a submission, take, score or rating.
