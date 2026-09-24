# Phase 12 — Critic + Revision System: design

Status: approved in conversation, section by section (2026-09-25). This file is the written spec for review before the implementation plan.
Branch: `claude/phase-12`, cut from `claude/phase-11` (PR #8, not yet merged).

## 1. Intent

The build guide's Phase 12 closes the creative loop:

- **Critic** (Critic class) checks any Creative output of Phases 8–11 against the canonical rules that govern it. It writes a structured JSON critique of specific violations, each tied to a rule id, and never edits the output.
- **Revision** (Revision class) reads a critique, proposes a concrete edit, and resubmits the result to the Critic.
- **Loop control**: a stated and justified iteration cap, plus escalation to the human queue on a stall. It never loops silently.
- **The Phase 6C Experiment Engine** scores trials through the Critic instead of the stub.
- **Proof**: one run that converges, one that hits the iteration cap and escalates, and a 5-bullet handoff for Phase 13.

Success means both proof runs pass on a real DB, and every critique and revision traces to rows. Every number (score, cap) must show where it comes from, and no stub remains in the 6C scoring path.

## 2. Decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | How the Critic finds violations | **Hybrid.** Code checks structured claims; the model judges prose rules; code verifies every model-found violation. | Code only (prose rules unchecked), model only (unreliable on numbers, not repeatable) |
| D2 | Mix reports | **Critiqued, then escalated to a human** as studio work. Never revised. | Revising the production artifact (speculative), critique only |
| D3 | Loop guard | **Max 3 revisions + stall rule** | 3 with no stall rule, 5 + stall, 1 + stall |
| D4 | Trial score | **Rules passed / rules checked** | Pass/fail, code-weighted |
| D5 | Where the loop runs | **A code controller over the Orchestrator's `dispatch`** | A `repeat` construct in the workflow engine (breaks Phase 5's tested no-cycles rule); the Critic calling Revision (bypasses the dispatch point) |

Assumptions the user did not correct:

- Proofs run on the FAKE model. There is no `OPENROUTER_API_KEY`, as in Phase 11.
- Phase 9 take scoring stays a stub, because a take is audio and the Critic reads JSON (§9).

## 3. Components

| Unit | Kind | Class / role | Tools / grants |
|---|---|---|---|
| `x3lius-evaluation` | agent (replaces the Phase 7 placeholder under the same name, so routing and scope carry over) | Critic, domain RECORDS, model-backed | `retrieve_context`, `retrieve_claims`, `read_artifact`, `read_critique`, `write_critique`, `log_message` |
| `x3lius-revision` | agent (new) | Revision, domain RECORDS, model-backed | `read_artifact`, `read_critique`, `write_artifact`, `log_message` |
| `write_critique` | tool (new) | capability `critique.write`; runs as `xyp_critic` | INSERT/SELECT `critiques` |
| `read_critique` | tool (new) | capability `critique.read` (new); runs as `xyp_runtime` | SELECT `critiques` |
| loop controller | service, not an agent (`records/x3lius/evaluation/loop.ts`, CLI `pnpm evaluate <artifactId>`) | DB role `xyp_evaluation_loop` | EXECUTE `xyp_escalate_critique` only |

- Both agents use the creative agents' model (`openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`) and the existing LLM runner and timeout.
- Code lives in `records/x3lius/evaluation/`: `critic.ts`, `checks.ts`, `revision.ts`, `loop.ts`, `scorer.ts`, `schemas.ts`, `cli.ts`.
- `research-intelligence/experiments/engine.ts` keeps only the `TrialScorer` interface. The research CLI wires in the Critic scorer, so the engine never imports from `records/`.

**New capability `critique.read`**: granted to Critic, Revision and Governance. It is added to `docs/AGENT_CLASSES.md` and `core/tool-registry/capabilities.ts` together, and the Phase 4C drift test enforces the match. Revision reuses `write_artifact` and its `xyp_creative` role, since `artifact.write` is already a Revision capability.

## 4. Data (one migration, with its rollback)

**`critiques`**: insert-only, and immutable for every role (trigger, same pattern as `creative_artifacts`).

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `artifact_id` | uuid not null → `creative_artifacts` | the version reviewed |
| `previous_id` | uuid null → `critiques` | the critique of the parent version, which chains a loop |
| `agent_run_id` | uuid not null → `agent_runs` | |
| `schema_id` | text | `x3lius.critique/v1` |
| `body` | jsonb object | §5.4 |
| `checked` | int ≥ 0 | rules checked |
| `passed` | int, 0 ≤ passed ≤ checked | rules with no violation |
| `created_at` | timestamptz | |

- A trigger requires that, when `previous_id` is set, the previous critique's artifact is the parent of `artifact_id`.
- Grants: `xyp_critic` has INSERT and SELECT (RLS policies as in `creative_artifacts`); `xyp_runtime` and `service_role` have SELECT; `anon` and `authenticated` are revoked.

**`creative_artifacts.critique_id`**: a new nullable FK to `critiques`.

- A version written by Revision names the critique it answers.
- Check: `critique_id is null or parent_id is not null`.
- The version trigger additionally requires `critique.artifact_id = new.parent_id`.

**`xyp_escalate_critique(p_critique_id uuid, p_request jsonb) returns uuid`**:

- `SECURITY DEFINER`, `search_path = ''`. It inserts `approval_queue(item_type 'critique_escalation', item_id p_critique_id, request p_request)`.
- EXECUTE is granted only to `xyp_evaluation_loop`.
- `unique (item_type, item_id)` already allows only one escalation per critique.

## 5. Critic

### 5.1 Rules in force

- The Critic reads the artifact through `read_artifact` and finds the producing sub-domain's `CreativeSpec` from the artifact's **schema id**, not its `agent_name`: a revised version is written by `x3lius-revision`. Only schema ids a current spec writes are supported; legacy `x3lius.lyrics/v1` artifacts are refused.
- It pulls the rules **in force now**, querying with the artifact's stored `brief`, reusing the creative program's retrieval: the spec's modules through the scoped Context Engine, and its claim namespaces through `retrieve_claims`. A rule the Gate changes therefore reaches older output too.
- **Applicability:** an entry with no model scope always applies. An entry scoped to a model applies only when the artifact body names that model (`sunoModel`), using the existing `appliesTo` and `scopeOf`. Every other scoped entry (for example RVC or `trace`) is out of scope for text artifacts.
- **Mix reports** (`x3lius.mix-report/v1`) skip retrieval. Their rules are the report's own checks, each with its claim ref and version:
  - a raise/lower check becomes a code-found violation;
  - an `unset` metric is not counted as checked.

### 5.2 Code checks

A table keyed by claim topic pattern. Each entry maps a claim to an artifact path and a comparison, reusing existing functions:

- `suno.limit.<field>-chars` → the Suno formula's measured length versus the claim value.
- Mix-report checks → their recorded status (the check itself was computed by `checkMetric` in Phase 11).

A rule with a code check has `method: 'code'`. Every other rule, including every prose rule, has `method: 'model'`.

### 5.3 Model checks

- One model call per critique. The model sees the artifact body without its trace fields, and the model-method rules (ref, title, text or value).
- LLM schema: `violations: [{ ruleRef, path, quote, expected, found }]`.
- Code verifies each reported violation. It is **dropped to `unverified`** (with the reason and a warning in the run log) when:
  - `ruleRef` isn't exactly one of the model-method rules given (using the program's existing ref normalisation; a code-method ref is refused);
  - `path` (a JSON Pointer) doesn't exist in the body;
  - `quote` isn't a verbatim substring of the string value at `path`, or of a string anywhere under it.
- Duplicate violations with the same key are merged.

### 5.4 Critique body `x3lius.critique/v1`

```
artifact:           { id, schemaId, version, agent }
previousCritiqueId?: uuid          # omitted on a first pass
rules:              [{ ref, kind: 'rule' | 'claim', method: 'code' | 'model', version? }]
violations:         [{ key, ruleRef, method, path, quote, expected, found, ruleVersion? }]
resolved:           [key]   # keys of previousCritique.violations absent now
unverified:         [{ ruleRef, path, quote, reason }]
counts:             { checked, passed, violations }
```

- `version` / `ruleVersion` are present only where the source states one (mix-report checks). A `canonical_prompts:<id>` ref already names one immutable canonical version. The JSON-schema subset has no null, so absent fields are omitted, not null.
- `key = ruleRef + '@' + path` tracks the same violation across iterations.
- `checked` = `rules.length`, and `passed` = the rules with no violation.
- When `previousCritiqueId` is given, the Critic refuses unless that critique reviewed this artifact's parent.
- Only the Critic marks violations resolved, through `resolved`.

## 6. Revision

- **Input:** `{ critiqueId }`. It reads the critique and the version it reviewed. It refuses mix reports.
- **One model call.** LLM schema: `edits: [{ path, replacement, violationKeys }]`. The prompt holds the body and the violations (ref, path, quote, expected, found).
- **Code applies the edits** to a copy of the body, and **refuses the whole run** (nothing is written) when an edit:
  - has a path that doesn't exist;
  - has a path that is neither equal to nor under some violation's `path`. Fields owned by code (section ids and kinds) are therefore untouchable unless a violation targets them;
  - replaces a value with a different JSON type. Only string, number and boolean leaves can be replaced;
  - cites no key from the critique's `violations`;
  - is a no-op (the replacement equals the current value).
- Partial fixes are allowed. Whether a violation is fixed is decided by the Critic on the next pass.
- **Derived fields are recomputed, never edited.** A schema whose body stores measurements of other fields supplies a `rederive(body)` hook, which runs after the edits. Today that is only the Suno prompt, which recomputes `limits[].actual` from the edited text. Edits to a derived path are refused. Derived paths are:
  - `/sources`, `/rulesApplied` and `/ungroundedChoices` in every schema;
  - `/limits`, `/sunoModel` and `/lyrics` in the Suno prompt. Its lyrics are rendered from the lyrics artifacts, so a lyrics violation there is fixed on the lyrics artifact by a human (it persists, so the stall rule escalates it). The Suno code check itself measures the text fields directly and never trusts the stored `limits`.
- **Validation before writing** is the same as a creative write: the schema for the version's schema id, the spec's `check`, and F22's mixed-script rule (`sunoTextPaths` refuse, anything else becomes a warning).
- **Write:** `write_artifact` with `parent_id` = the reviewed version and `critique_id`. `brief`, `context_refs` and `knowledge` are copied from the parent, and `model` is Revision's own. The edit is the difference between the parent and child bodies.
- **Not in scope:** structural edits (adding or removing array items). A violation that needs one persists, the stall rule fires, and a human takes it (flag §10).

## 7. Loop controller

`evaluate(artifactId)`, with `MAX_REVISIONS = 3`:

- **Why 3:** each round costs two model calls (one Critic, one Revision), and a call took minutes on the free route in the Phase 9 live runs. So 3 rounds plus the final Critic pass is at most 7 calls. Three targeted edit rounds that fail to clear the violations are unlikely to be cleared by a fourth, and the stall rule stops a stuck loop earlier.
- The number is recorded in code and in ARCHITECTURE.md. Changing it is a new flagged decision, never a silent edit.

**Before starting**, the controller refuses an artifact that isn't the latest version of its lineage, since revising an older version would fork the history.

**After each Critic pass**, the first matching rule decides:

| # | Condition | Outcome |
|---|---|---|
| 1 | Critic run failed | `error`: the run error is returned; no queue item (a system fault, not a creative stall) |
| 2 | `checked = 0` | `no_rules`: returned; nothing to revise and nothing for a human to judge (Phase 8's sparsity flag already covers it) |
| 3 | `violations = 0` | `converged` |
| 4 | schema is `x3lius.mix-report/v1` | escalate `studio_work` |
| 5 | revisions made = `MAX_REVISIONS` | escalate `iteration_cap` |
| 6 | a revision was made and `violations ≥ previous violations` | escalate `stall` |
| 7 | otherwise | dispatch Revision(critiqueId), then dispatch the Critic on the new version with `previousCritiqueId` |

A failed Revision run escalates `revision_failed`, and the request includes the error.

**Escalation request:**

```
{ reason, revisions, maxRevisions, critiqueIds[], artifactIds[], counts[] }
```

It is queued through `xyp_escalate_critique` against the final critique.

**Deciding an escalation:** the operator uses the existing `pnpm gate queue` / `pnpm gate decide`, which already handle every item type. Approve means accept the latest version as it is; reject means don't use it. In Phase 12 the decision is only recorded (flag §10).

**Concurrency:** two loops on one lineage cannot fork it. The second Revision write collides on `(lineage_id, version)`, and that loop ends as `revision_failed`.

**Result** (returned, and printed by the CLI):

```
{ outcome, revisions, critiqueIds[], artifactIds[], counts[], escalationId? }
```

`outcome` is one of `converged`, `no_rules`, `studio_work`, `iteration_cap`, `stall`, `revision_failed` or `error`.

## 8. Phase 6C scoring

- `TrialScorer.score` becomes `async`, because the Critic is a dispatched agent run. `stubScorer` is adapted.
- `criticScorer(deps)`:
  - `output.artifactId` must be a creative artifact id. The scorer dispatches **one** Critic pass, with no revision.
  - `score = passed / checked`, and `score_inputs = { critiqueId, passed, checked, violations }`.
  - No `artifactId`, a failed Critic run, or `checked = 0` gives `score: null` with the reason in `score_inputs`. It never makes up a number.
- `pnpm research experiment:design` records `scoring_method = criticScorer.id`, and `experiment:trial` scores with it. The stub remains only as an explicit argument, for tests.
- `experimentResult` is unchanged. Its "validated only when every trial has a real score" rule can now be met.
- ARCHITECTURE F14 gets a note: auto-approve can now fire.

## 9. Phase 9 take scoring

It stays a stub. A take is audio, and an honest score needs a `trace.analysis/v1` of the render (Phase 14).

- New stub rows use the marker `stub:needs-trace-analysis` with an updated note. Existing rows keep `stub:phase-12-critic`, since rows are never rewritten.
- The Phase 14 handoff inherits the flag.

## 10. Flags recorded for later phases

- Escalation decisions are only recorded. Acting on approve/reject waits for the Phase 15 API and Phase 16 UI.
- Revision makes no structural edits (§6).
- There's no live-model run of the Critic or Revision until a model key is available.
- Take scoring waits on TRACE analysis (§9).

## 11. Testing and proof

- **Pure units:**
  - the code-check table;
  - model-violation verification (bad ref, code-method ref, missing path, misquote, duplicate);
  - edit application (each refusal in §6);
  - the loop decision function (each row of the §7 table);
  - the score calculation, including `checked = 0`.
- **Database:**
  - `critiques` is immutable;
  - grants (only `xyp_critic` inserts; `xyp_runtime` reads; only `xyp_evaluation_loop` executes the escalation function; `anon` and `authenticated` get nothing);
  - the `previous_id` trigger and the `critique_id` trigger;
  - the capability matrix and doc stay in sync.
- **Proof runs** (FAKE model, real DB, logged to `docs/proofs/PHASE-12-critic-revision.txt`):
  1. **Converges:** a Suno-prompt artifact with 2 violations: one code-found (the style text over a `suno.limit.style-chars` claim) and one model-found (a prose rule). One revision fixes both, and the Critic then reports 0. Outcome `converged`. (Suno prompts and mix reports are the only schemas with code checks today.)
  2. **Hits the cap:** a lyrics artifact with 4 model-found violations; each revision fixes exactly one (so the stall rule never fires); 1 is left after 3 revisions. Outcome `iteration_cap`, with one `critique_escalation` row.
  3. Also: `stall`, `studio_work` (a mix report), `revision_failed`, and a Critic-scored 6C trial.
- **Mutation check** on the loop and verification logic, as in earlier phases.
- **Full suite** before and after, and typecheck clean.

## 12. Docs

- `docs/handoffs/PHASE-12.md`: summary, decisions, deviations, open flags, and 5 bullets for Phase 13.
- `docs/AGENT_CLASSES.md`: the `critique.read` row.
- `docs/SCHEMA.md`: `critiques`, `critique_id`, and the escalation function.
- `docs/ARCHITECTURE.md`: flag entries for D1–D5, the F14 note, and the take-scoring flag.
- `README.md`: the Phase 12 checkbox.

## 13. Consequences for earlier phases

- **Evaluation was the last Phase 7 placeholder.** After Phase 12, every manifest sub-domain has a built agent.
  - `subdomainStub` stays as the fallback handler for any sub-domain a future manifest adds.
  - Its Phase 7 proofs (a placeholder returns its promoted rule; routing reaches it end to end) move to a registry double that presents `x3lius-evaluation` as a Knowledge placeholder, because no real one remains.
  - The Phase 9 "still a stub" list becomes empty.
- **`x3lius-revision` works inside the Evaluation sub-domain without being one**, like `x3lius-rvc-post` does for Vocal DNA. It joins the Phase 7 test's list of sub-domain members.
- **A routed bare request to Evaluation is refused.** The Critic needs `{ artifactId }`, the same way Mix/Master needs an analysis.
- **`read_artifact` returns more fields:** also `brief`, `parentId`, `critiqueId`, `contextRefs` and `knowledge`. The Critic queries rules with the brief, and Revision copies the brief, refs and knowledge into the new version.
- **`write_artifact` takes an optional `critiqueId`.**
