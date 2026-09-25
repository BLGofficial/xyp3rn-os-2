HANDOFF — Phase 14 built and proven (TRACE service, TECH components, R&D backlog); the R&D model call not run live (no key)

- **Built:**
  - **The TRACE contract, now a real API surface** (D1, F24/F33):
    - `trace.analysis/v1` is unchanged. `trace.report/v1` is the answer (`tech/trace/report.ts`), and the check type moved there, so Mix/Master and the mix report artifact import it (defined once, grep-tested).
    - JSON Schema files for the plugin are generated from the TS contract (`pnpm trace:schemas`, drift-tested).
    - `pnpm trace:serve` (127.0.0.1, bearer `XYP_TRACE_TOKEN`) serves:
      - `POST /v1/trace/analyses`: validate, then the `trace-intake` workflow (record → X3LIUS Mix/Master against the canonical rubric → link), answering `trace.report/v1`;
      - `GET /v1/trace/analyses/:id` and `/v1/trace/health`.
  - **TECH components** (D2): `tech/tech.manifest.yaml` is admitted through the gate (`xyp3rn-tech` plus 4 modules) with one agent each:
    - `tech-products` and `tech-ai-systems`: stubs on the shared `core/agents/manifest-stub.ts`, with X3LIUS rebound to it unchanged;
    - `tech-audio-tools`: Execution, the TRACE intake;
    - `tech-r-and-d`: Planning, LLM.
    - `ENTRYPOINTS.TECH` routes `pnpm ask`.
  - **The R&D backlog** (D3, D4):
    - It reads the Frontier Scanner's uncited evidence. The model proposes and code verifies (evidence given, schema, unique title).
    - Verified items go to `rd_backlog`, where a trigger queues each in `approval_queue` (`rd_backlog_item`). `pnpm gate queue` / `decide` is the human's.
  - **Data** (migration `20260925120000_tech`):
    - `trace_analyses`: append-only; the report is linked once, and only a report of this very analysis.
    - `rd_backlog` + `rd_backlog_evidence`: scanner evidence required at commit; the view `rd_backlog_items` reads the status from the queue.
    - Roles `xyp_trace_intake` and `xyp_planner`; capabilities `trace.write` (Execution) and `research.read` (Planning).
  - **Proof:** `docs/proofs/PHASE-14-tech.txt`.
    - 37 Phase 14 tests, written red first.
    - The live service over HTTP on a throwaway DB, with the operator's real mix rubric: 7 checks, each naming its claim.
    - Direct-SQL bypasses refused with 23514 / 42501 / 55000.
    - Full suite 1012/1012, typecheck clean.
- **Key decisions (user):**
  - D1: a local HTTP service plus `trace.report/v1`.
  - D2: manifest + agents.
  - D3: an LLM with code verification.
  - D4: `approval_queue`.
- **Premises corrected (F33):**
  - `research_sources` has no tags; the backlog reads evidence by `specialist`.
  - The Frontier Scanner has never run.
  - The four are TECH components, not domains; the taxonomy is unchanged.
- **Open (F34):**
  - **R&D not live.** `OPENROUTER_API_KEY` isn't set here: the agent reaches its model call and stops (proof §2g). It is proven on the FAKE model.
  - **Take scoring from a TRACE analysis** is still a decision to make (the F28 analogue).
  - **The service is local-only.**
  - **Nothing acts on an approved backlog item.**
  - **Carried from Phase 13 (F32):** the `service_role` DML on earlier-phase tables.
- **Next phase needs (15):**
  1. The approval API over the one `approval_queue`. It now carries three item types: `knowledge_candidate`, `critique_escalation`, `rd_backlog_item`. The per-type request shapes are in SCHEMA.md, and `pnpm gate queue` shows them.
  2. RBAC: who may decide each item type. Today it is any `service_role` holder, with a free-text approver. The role table replaces that.
  3. Rights-conflict reads Phase 13's `rights_splits` / `current_rights_splits` (`catalog.read` is already Governance's). Legal flags need a rule list, and TRACE analyses and backlog items are new objects under review.
  4. The audit log joins canonical mutations to `agent_runs` and approvers. The Phase 13/14 tables already carry `agent_run_id` on every row, and the TRACE and backlog writes are all agent runs.
  5. Fix the pre-existing `service_role` DML on `creative_artifacts`, `critiques` and the Suno trail (F32) before building audit on top of it.
