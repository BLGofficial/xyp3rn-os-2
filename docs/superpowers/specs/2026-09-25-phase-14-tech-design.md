# Phase 14 — XYP3RN Tech: design

Status: the four decisions below were made by the user in conversation (2026-09-25). Everything else is the default stated here. Updated to match what was built (§13).
Branch: `claude/build-audit-next-steps-ffve76`, on top of Phase 13 (PR #12, not yet merged). The session may push only to this branch, so PR #12 grows to cover Phases 13 and 14.

## 1. Intent

The guide's Phase 14 has three parts:

1. **The TRACE-shaped input/output contract** stubbed in Phase 11 becomes a real API surface. It is versioned and there is one source of truth: defining it twice is the bug.
2. **The R&D backlog agent** (Planning) reads the Phase 6 Frontier Scanner output and proposes candidate features into `rd_backlog`. It never auto-implements anything, and a human decides what ships.
3. **Register Products, Audio Tools, AI Systems and R&D** in the Agent Registry.

Output: the contract spec and its version, the R&D backlog agent, the migration, and a 5-bullet handoff for Phase 15.

**The guide's premises that don't hold:**

- **`research_sources` has no tags.** "Tagged frontier/emerging" doesn't exist. The Frontier Scanner's output is `research_evidence` with `specialist = 'frontier-tool-scanner-researcher'`, joined to its `research_sources`. The Phase 6 schema is unchanged.
- **The Frontier Scanner has never run.** The 20 specialists need an Anthropic key and have no LLM program. The backlog agent is proven on fixture evidence and the FAKE model.
- **Products / Audio Tools / AI Systems / R&D are not domains.** They are TECH sub-components: the reserved ids `products`, `audio-tools`, `ai-systems` and `r-and-d`. The six-domain taxonomy is tested and is not changed.

## 2. Decisions

| # | Decision | Chosen (user) | Rejected |
|---|---|---|---|
| D1 | TRACE API surface | **A local HTTP service.** `POST /v1/trace/analyses` validates `trace.analysis/v1` with the existing file, stores the analysis, runs Mix/Master and returns a TECH-owned `trace.report/v1`. The check type moves into `tech/trace` so Mix/Master and the API share one definition. A JSON Schema is generated from the TS contract, with a drift test. Bound to 127.0.0.1, with a bearer token. | A CLI file drop (no plugin could call it); the contract only (nothing runs end to end) |
| D2 | Registering the four | **A manifest plus agents, mirroring Phase 7.** `tech/tech.manifest.yaml` is admitted through the gate as a parent module and 4 sub-component modules. There is one agent per sub-component, named after its module, and a TECH entrypoint for `pnpm ask`. | Agents only (no scoped context path); a code constant (not in the registry) |
| D3 | How the backlog agent proposes | **An LLM with code verification** (the Critic's pattern). Every proposal must cite evidence ids it was given, fit the schema and not repeat a title; anything else is dropped as unverified. | Deterministic, one item per source (a triage list, not feature ideas) |
| D4 | Who decides what ships | **`approval_queue`**, with a new `item_type rd_backlog_item`, decided with `pnpm gate decide` (F8: one queue). The item's status is the queue row's status: a view, never a copy. | An operator status column (a second human-decision path) |

Defaults the user did not override: red tests first (D4 of Phase 13); frontier output read by `specialist` (§1).

## 3. The TRACE contract (TECH-owned, `tech/trace/`)

- **`analysis.ts`**: `trace.analysis/v1`, unchanged. This is its one definition.
- **`report.ts`** (new): `trace.report/v1`, what the OS answers TRACE with.

  ```
  { schema: 'trace.report/v1', analysisId, subject: { stage, label },
    checks: [TraceCheck], unset: [metric], rubricClaims, mixReportArtifactId }
  TraceCheck = { metric, unit, measured, rubric: { min?, max? }, action: keep|raise|lower, by, ref, version }
  ```

  - `TraceCheck` is Phase 11's `MixCheck` moved here. `records/x3lius/mix-master` imports it, so a check has one definition.
  - `validateTraceReport` validates it (shape, plus `ref`/`version` present).
- **JSON Schemas for the plugin (C++ VST3/AU):**
  - `tech/trace/schemas/trace.analysis.v1.schema.json` and `trace.report.v1.schema.json` are generated from the TS schemas by `pnpm trace:schemas`.
  - A test fails when a file differs from what generation would write, byte for byte.
  - The files state the shape. Ranges (correlation −1..1, band dB ≤ 0, …) are enforced by the service through `validateTraceAnalysis`, and each range is described in the field's description.
  - The optional `min`/`max` of a rubric bound use the subset's `required: []` directly, as Phase 11's rubric bound already did. `obj()` is unchanged.
- **"Defined once" is tested:** no file outside `tech/trace/` may declare the `trace.analysis/v1` or `trace.report/v1` ids, or a check type of its own. A grep test covers `core/`, `records/`, `tech/` and `knowledge/`.

## 4. The TRACE service (`tech/trace/server.ts`, `pnpm trace:serve`)

- It uses `node:http` with no framework. It listens on `XYP_TRACE_HOST` (default `127.0.0.1`) and `XYP_TRACE_PORT` (default `8787`).
- It refuses to start without `XYP_TRACE_TOKEN` (≥ 16 characters). Every request needs `Authorization: Bearer <token>`, compared in constant time.
- **`POST /v1/trace/analyses[?takeId=<uuid>]`**, body = a `trace.analysis/v1` (`application/json`, ≤ 256 KiB):
  - 401 when there is no token or it is wrong;
  - 415 when the body isn't JSON;
  - 413 when the body is too large;
  - 400 `{ error, violations }` for an invalid analysis (the full validator; nothing is stored);
  - otherwise it runs the workflow `tech/workflows/trace-intake.workflow.yaml`:
    1. `tech-audio-tools` records the analysis;
    2. `x3lius-mix-master` checks it against the canonical rubric;
    3. `tech-audio-tools` links the report to the analysis.
  - 201 returns `trace.report/v1`.
  - A failed step returns 422 `{ error, failedStep, analysisId? }`. The analysis stays recorded when the check fails, because it is the measurement.
- **`GET /v1/trace/analyses/:id`** returns the stored analysis's `trace.report/v1`, rebuilt from the linked report (404 when unknown or not yet linked).
- **`GET /v1/trace/health`**: `{ status: 'ok', contracts: ['trace.analysis/v1', 'trace.report/v1'] }`, without a token.
- Any other method or path returns 404.

## 5. TECH sub-components (D2)

- **`tech/tech.manifest.yaml`** (`xyp-module-manifest/v1`, domain `TECH`):
  - parent module `xyp3rn-tech`;
  - sub-components `tech-products` (built_in null), `tech-audio-tools` ('14'), `tech-ai-systems` (null), `tech-r-and-d` ('14').
  - It is admitted by `pnpm ingest --file tech/tech.manifest.yaml --origin first_party`, which is added to `scripts/session-start.sh`.
- **Agents** (module slug = agent name):

  | Agent | Class | Model | Tools |
  |---|---|---|---|
  | `tech-products` | Knowledge (stub) | none | `retrieve_context`, `log_message` |
  | `tech-ai-systems` | Knowledge (stub) | none | `retrieve_context`, `log_message` |
  | `tech-audio-tools` | Execution | none | `record_trace_analysis`, `link_trace_report`, `log_message` |
  | `tech-r-and-d` | Planning | the creative route (`openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`) | `read_frontier_evidence`, `write_rd_backlog`, `log_message` |

- **The stub handler is shared.** Phase 7's `subdomainStub` becomes `createManifestStub(load)` in `core/agents/manifest-stub.ts`. X3LIUS and TECH each bind it to their own manifest, and the Phase 7 behavior and tests are unchanged.
- **TECH entrypoint** (`tech/entrypoint.ts`, `ENTRYPOINTS.TECH = { service: 'tech-system' }`, `pnpm ask`):
  - It selects components by their `## Scope` keywords, as Phase 7 does, and runs the free-text ones (the stubs and R&D) with `{ request }`.
  - `tech-audio-tools` takes measurements, not text. When it is the only match, the answer is a clarify that names the TRACE service.
  - With no match, the answer is a clarify that names the components.

## 6. Data (one migration `20260925120000_tech`, with its rollback)

### 6.1 `trace_analyses`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `schema_id` | text | `= body->>'schema'` (check). Validated in code before insert; the DB never re-states the contract |
| `body` | jsonb object | the analysis as received |
| `take_id` | uuid null → `suno_takes` | the Suno take whose render was measured, when known |
| `mix_report_artifact_id` | uuid null → `creative_artifacts` | **set once**, null → value. It must be a `x3lius.mix-report/v1` whose `body.analysis` equals this row's `body` (23514) |
| `agent_run_id` | uuid not null → `agent_runs` | |
| `created_at` | timestamptz | |

- The table is append-only apart from the one link (55000 otherwise, the owner included).
- Role `xyp_trace_intake` (new): INSERT/SELECT, and UPDATE (`mix_report_artifact_id`) only.
- `xyp_runtime` and `service_role` have SELECT; `anon` and `authenticated` get nothing.

### 6.2 `rd_backlog`, `rd_backlog_evidence`, view `rd_backlog_items`

| `rd_backlog` column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `title` | text | non-blank, ≤ 120 characters, unique case-insensitively (`rd_backlog_title_key` on `lower(btrim(title))`) |
| `component` | text | `products` \| `audio-tools` \| `ai-systems` \| `r-and-d` |
| `proposal` | text | what to build (non-blank) |
| `rationale` | text | why, from the evidence (non-blank) |
| `model` | text | the model ref that proposed it |
| `agent_run_id` | uuid not null → `agent_runs` | |
| `created_at` | timestamptz | |

- **`rd_backlog_evidence`** (`rd_backlog_id`, `research_evidence_id`), with the pair as its primary key:
  - the evidence must be the Frontier Scanner's (`specialist = 'frontier-tool-scanner-researcher'`, trigger, 23514);
  - **every item cites at least one piece of evidence** (a deferred constraint trigger, 23514 at commit).
- **Every item is queued for a human** (D4): an AFTER INSERT trigger (`SECURITY DEFINER`) inserts one pending `approval_queue` row `(item_type 'rd_backlog_item', item_id, request { title, component, proposal, rationale })`. There is no path around it.
- The table is immutable (55000). A changed idea is a new item.
- **`rd_backlog_items`** (`security_invoker`): each item with its evidence ids and its approval status, `decided_by`, `decided_at` and `decision_reason`. SELECT is granted to `service_role`.
- Role `xyp_planner` (new):
  - INSERT/SELECT on `rd_backlog` and `rd_backlog_evidence`;
  - SELECT on `research_evidence` and `research_sources` (the read tool);
  - nothing on `approval_queue`: the trigger queues, and only `service_role` decides.

### 6.3 Enum `approval_item_type` gains `rd_backlog_item`.

`pnpm gate queue` shows the item's request, and `pnpm gate decide` records the decision. That is the whole of "a human decides what ships". Nothing reads an approval as a trigger to build anything.

## 7. Capabilities (matrix change, `capabilities.ts` + `AGENT_CLASSES.md` together)

| Capability | What it permits | Classes |
|---|---|---|
| `research.read` | Read research evidence and its sources (Phase 14: the Frontier Scanner's output) | Planning |
| `trace.write` | Record a TRACE analysis and link its mix report, once (Phase 14) | Execution |

`plan.write` (Planning) already exists; `write_rd_backlog` is its first tool.

## 8. Tools

| Tool | Capability | Role | Behaviour |
|---|---|---|---|
| `record_trace_analysis` | `trace.write` | `xyp_trace_intake` | validates with `validateTraceAnalysis`, inserts, returns `{ analysisId }` |
| `link_trace_report` | `trace.write` | `xyp_trace_intake` | sets `mix_report_artifact_id` once; the DB checks it is this analysis's report |
| `read_frontier_evidence` | `research.read` | `xyp_planner`, read only | the Frontier Scanner's evidence with its source, **excluding evidence already cited by a backlog item**, newest first, `limit` ≤ 50 |
| `write_rd_backlog` | `plan.write` | `xyp_planner` | writes each item and its evidence links under its own savepoint. A duplicate title (23505) is reported and skipped, never fatal. Returns `{ written: [{ id, title, approvalId }], duplicates }` |

## 9. The R&D backlog agent (`tech-r-and-d`, D3)

- **Input:** `{ request?: string, limit?: int }`. `request` steers the focus, and it is what `pnpm ask` sends.
- **Steps:**
  1. `read_frontier_evidence`. With no uncited evidence it returns `{ status: 'no-frontier-evidence' }`, with no model call.
  2. One model call (`tech.rd-proposals-llm/v1`): `{ proposals: [{ title, component, proposal, rationale, evidenceIds }] }`. The prompt lists each evidence item as `[evidence:<id>] claim — source title (kind, reliability), model tag, confidence`. A tool's marketing claim is a claim, not a fact (the scanner's own refusal).
  3. Code verifies each proposal. It is dropped to `unverified`, with its reason, when:
     - the title is blank or over 120 characters, or the proposal or rationale is blank;
     - `evidenceIds` is empty or names an id it wasn't given;
     - the title repeats another in the batch (case-insensitively).
  4. `write_rd_backlog` writes the verified items. Each one is queued by the DB.
- **Output:** `{ status: 'proposed', considered, written, duplicates, unverified }`.
- It never implements, schedules or approves anything, and never writes research or canonical rows.

## 10. Tests (written first)

`tests/phase-14/`:

- `tech-db.test.ts` (both tables, with exact SQLSTATEs):
  - `trace_analyses`: schema/body agreement, the link-once rule and its checks, append-only, grants.
  - `rd_backlog`: evidence required at commit, evidence from the scanner only, one queue row per item, the title key, immutability, grants.
  - The decision: `service_role` decides and the view follows; `xyp_planner` can't decide.
- `trace-contract.test.ts`: `trace.report/v1` validation; the schema files are free of drift; nothing is defined twice (§3).
- `trace-service.test.ts` (the real server on port 0, a throwaway DB, the fixture rubric admitted through the gate):
  - 401, 415, 413, 400, 404;
  - a 201 report that validates, with the rows linked;
  - GET by id; `takeId`;
  - the service refuses to start without a token, and binds 127.0.0.1 by default.
- `tech-system.test.ts`:
  - the manifest is admitted as 5 modules with `subdomain_of` edges;
  - the four agents: their class, tools, `validateAll()`, and no `tech-*` agent outside the manifest;
  - `pnpm ask` routing: stub run, audio-tools clarify, no-match clarify;
  - authorization of the new capabilities.
- `rd-backlog.test.ts` (FAKE model, scripted replies; fixture evidence from the scanner and from another specialist):
  - verified proposals are written and queued; unverified ones are kept with reasons;
  - evidence already cited is excluded on the next run;
  - a duplicate title is skipped;
  - no evidence means no model call;
  - an approval decided through `decideQueueItem` is visible on the view;
  - nothing else is written.

## 11. Documentation

- `docs/SCHEMA.md` gets a Phase 14 section. `docs/AGENT_CLASSES.md` gets the two new rows.
- `docs/ARCHITECTURE.md`:
  - F24 is updated: the contract is implemented, and `trace.report/v1` is added.
  - F33 records D1–D4 and the three premises of §1.
  - F34 lists what is open after Phase 14.
- `tech/README.md`, the README (build status and commands), the proof `docs/proofs/PHASE-14-tech.txt` and the handoff `docs/handoffs/PHASE-14.md`.

## 12. Out of scope (flagged)

- **Take scoring from a TRACE analysis.** An analysis can name its take, but turning a mix report into a take score is a scoring decision (the F28 analogue) that is not taken here. The `take_scores` stubs stay.
- **TRACE itself** (the VST3/AU plugin) lives in its own codebase. This phase builds its boundary.
- **Acting on an approved backlog item.** "Shipped" is outside the OS until someone decides otherwise.
- **The service is local-only.** Exposing it beyond localhost is a deployment decision.

## 13. Deviations found while building

- **No `obj()` change.** The subset's `required: []` already allowed optional keys. Phase 11's rubric bound used it, and it moved into `tech/trace/report.ts` unchanged.
- **The artifact schema was a second copy of the check shape.** Besides Mix/Master's TS type, the mix report artifact schema in `records/x3lius/creative/schemas.ts` carried its own copy. Both now import `TRACE_CHECK_SCHEMA` / `TraceCheck`, and the grep test covers both forms.
- **`write_rd_backlog` returns no approval ids.** `xyp_planner` has no grant on `approval_queue` by design, so the queue rows are read by the operator (`pnpm gate queue`), not by the planner.
- **`trace-intake` takes `takeId` as a required-null key.** The workflow engine has no optional inputs, as in Phase 13.

