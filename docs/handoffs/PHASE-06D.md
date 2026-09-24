HANDOFF — Phase 6D complete

- **Built:**
  - **Migration `20260924150000_promotion_gate.sql`:**
    - `xyp_promotion` is the gate's service account: INSERT-only on canonical tables, and the only role in the cluster with INSERT on `canonical_prompts`/`modules`/`knowledge_versions` (catalog-proven).
    - A deferred constraint trigger refuses any canonical row committed without its `knowledge_versions` row, even from `xyp_promotion`.
    - `approval_queue` (F8): the gate may only open pending items; decisions are sealed; `xyp_decide_approval` is executable by the operator only.
    - `promotion_runs` is append-only and records every step with its reason; `regression_queue` holds the checks each promotion owes.
    - A candidate state-machine trigger (with `pending_approval`) and the F1 backfill.
  - **Decision rule** (`knowledge/promotion-gate/decide.ts`): pure, with the nine steps in the guide's order.
  - **Pipeline** (`gate.ts`):
    - `runGate` takes a candidate through the steps. Blocked, rejected and pending runs are recorded; a candidate is queued once. On promotion it appends the next version plus its history, then propagates.
    - `decideApproval` records the operator's decision.
    - `admitFirstParty` is ingestion's route in.
  - **CLI:**
    - `pnpm gate run|queue|decide`.
    - `pnpm research cite`: quotes an ingested first-party document as evidence and refuses any excerpt that isn't in the document verbatim.
  - **Proof:** `docs/proofs/PHASE-06D-e2e.txt`; 531/531 tests; 3 mutations caught (service_role INSERT, pre-decided approval, no transition trigger).
    - On the dev DB, a real claim (Phase 10: "RVC/Applio voice model already exists for X3LIUS") went cite → finding (0.608) → candidate → gate → `pending_approval`, and the known-wrong voice candidate was blocked.
    - On a clone, approve → promoted v1 (9 steps, history, regression queued) → embedded → ranked #1 in retrieval (0.9586).
- **Key decisions:**
  - **Threshold (F14):**
    - 0.8 confidence, a validated experiment where candidate b beats control a, and sources ≤180 days old.
    - Otherwise the candidate goes to a human.
    - A single source can never auto-approve (it is capped at 0.75 support), so nothing auto-approves before Phase 12 scoring.
  - **First-party admission path (user):** ingestion now writes `promoted_via='gate'` rows with `first-party-ingest` history. Third-party material is refused and must come through Research Intelligence.
  - **Operator command (user):** only `service_role` can decide an approval. Agents calling `xyp_decide_approval` get 42501.
  - **Outcome rules:**
    - An open contradiction blocks the candidate, which stays `proposed`; resolve the contradiction and re-run.
    - Inconsistent tags reject it.
    - Only `canonical_prompt` candidates are promotable: modules carry no claims, so they would escape contradiction guarding.
- **Deviations from spec:**
  - **F1 as written** said ingestion would flow through `knowledge_candidates`. Replaced by the first-party admission path, per your choice.
  - **Promoted rules** are stored in a gate-owned per-domain module (`records-validated-rules`) until Phase 7's sub-domain modules exist.
  - **Earlier-phase changes:** the Phase 2 tests now expect `gate` provenance and bootstrap policies on `sources`/`ingestion_runs` only. `summarizeExperiment` was extracted from the 6C engine; its convention is a = control, b = candidate.
  - **A mistake during the proof:** an autocommitted probe wrote a history-less `direct-write` module as `xyp_promotion`. I deleted the row as superuser, and that gap is why the history-required trigger exists.
- **Open flags:**
  - **Dev DB approval `f64ddef7…` is pending your decision.** Approve with:
    ```sh
    pnpm gate decide f64ddef7-fc97-405a-a0e0-a28593d40a17 approve "<you>" "<why>"
    ```
    The container is ephemeral, so the pending item vanishes with it.
  - **A blocked candidate never leaves `proposed`,** and it keeps blocking conflicting candidates until the verifier resolves the contradiction. A direct "withdraw" belongs to the Phase 15 API.
  - **Freshness uses `retrieved_at`, not the publication date,** which isn't captured yet.
  - **The approver is free text** until Phase 15/16 add auth.
  - **`regression_queue` has no consumer** until Phase 13.
  - **The Context Engine shows `source: none` for candidate-promoted rows.** Their trace runs through `knowledge_versions` → candidate → evidence, and the bundle doesn't follow that path yet.
  - **Rollback refuses** once first-party gate history exists.
- **Next phase needs (7):**
  - **Sub-domain modules:** the ten X3LIUS sub-domains as registered, empty module stubs under RECORDS.
  - **Propagation wiring:** consume gate promotions (`promotion_runs` outcome `promoted`, `regression_queue`) and map candidate tags or domain to a sub-domain module, so promoted rules land in the right sub-domain's Context Engine scope.
  - **Stop using the stopgap module:** decide whether the gate should target sub-domain modules directly instead of `records-validated-rules`.
  - **Keep all writes in the gate:** any canonical write Phase 7 needs (module stubs) goes through the gate, i.e. `admitFirstParty` or a new gate entrance, never a direct INSERT (the grants and the history trigger would refuse it anyway).
  - **Provenance in the bundle:** surface the knowledge_versions → candidate → evidence provenance in the Context Engine, so "every result traces back to a row" includes the evidence behind promoted rules.
