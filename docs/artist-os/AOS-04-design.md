# AOS-04 — Research mode: design

Status: the five decisions below were made by the operator in conversation (2026-09-26), recorded here as R1–R5. Everything else is the default stated here, open to review.
Source: [PLAN.md](PLAN.md) §2E and §5 Phase 4; gaps G12 (specialists can't run) and G13 (research not linked to songs, styles or decisions) in [AOS-00-baseline.md](AOS-00-baseline.md); conflict C7. Built on AOS-03 (PR #15, merged), on branch `claude/aos-04`.

## 1. Intent

The plan's AOS-04:

- **Work:** research briefs, specialist agent execution, source capture, contradiction handling, and approval into canonical knowledge.
- **Deliverables:** a research workbench and an approved findings library.
- **Gate:** reusable findings retain their sources and cannot silently become canonical without approval.

What already exists and is reused, not rebuilt:

- The Phase 6 chain: `research_projects → research_questions → research_runs`, `research_sources` (content-addressed, reliability rubric), `research_evidence` (source, model tag, confidence with inputs), `research_findings` (+ `research_finding_evidence`), `knowledge_candidates`, `contradictions`, `experiments`.
- The Research Orchestrator (keyword scope selection) and `runResearch` (orchestrator → one workflow step per selected specialist).
- The 20 specialists (`agents/*-researcher.agent.md`) with their Scope, Contract and Refuses sections; `fetch_source` (`web.read`), `write_evidence` (`research.write`), `retrieve_context` (`context.read`).
- The Evidence Engine, `citeIngestedSource` (verbatim excerpt check against canonical bodies), `recordFinding` (confidence + contradiction check), `proposeCandidate`.
- The Promotion Gate (`runGate`, `decideQueueItem`) and D2: every canonical change goes to the owner through `approval_queue`.
- The Phase 8 LLM runner (`LLM_PROGRAMS`, providers Anthropic / Groq / OpenRouter, schema-validated JSON replies, transient retries, `LLM_TIMEOUT_MS`).
- `song_links.research_question_id` (A1): a song already links a research question.
- Owner decisions as pre-decided `approval_queue` rows (`xyp_decide_artifact`, AOS-01).

What is missing today (why the gate fails now):

| Gate clause | Today |
|---|---|
| specialists run | No LLM program is registered for any specialist; dispatch fails "no LLM program registered" (G12, C7). Evidence exists only from the human CLI. |
| findings from a run | Nothing turns a run's evidence into findings; `recordFinding` is CLI-only. |
| retain their sources | A research source keeps one 500-char excerpt; the passage behind each claim is not kept, and a web page's text is gone after the fetch. |
| linked to what they inform | Only songs (A1). No link to a style (recipe, tag set), workflow or decision (G13). |
| approval | Canonical approval exists (gate + D2), CLI only. No owner acceptance of a finding that is reusable but not canonical; no library. |
| workbench | No Research UI. |

## 2. Decisions

| # | Decision | Chosen (operator) | Rejected |
|---|---|---|---|
| R1 | Which LLM the specialists run on | **OpenRouter free route**, `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`, the creative agents' model. The key is already set; $0. Swappable per agent in frontmatter. | Anthropic `claude-sonnet-5` (needs `ANTHROPIC_API_KEY`, not set); an OpenRouter paid model |
| R2 | How research links to what it informs | **Brief-level typed links.** A song ↔ brief link stays in `song_links` (A1). A new append-only `research_links` holds exactly one of: an artifact lineage (recipe, tag set, lyric), a workflow (name + spec sha256), or a decision key (`F<n>`). Retractions like `song_link_retractions`. Findings inherit targets through run → brief. | Finding-level links (every finding needs a chosen target); songs and styles only |
| R3 | Approval of reusable findings | **Two tiers.** (1) The owner accepts or rejects a finding into the **Findings Library** (an owner decision, not canonical). (2) **Promote to canonical** = candidate → Promotion Gate → `approval_queue`, decided by the owner, now also in the Research UI. | Gate only (heavy for song-specific findings that aren't prompts or modules); library only (canonical stays CLI) |
| R4 | How a specialist runs | **One shared grounded-evidence program** for all 20, parametrized by each agent's own sections. Passages come from the knowledge corpus and the brief's URLs only; one LLM call; every claim quotes its passage verbatim, and the quote is verified in the DB before it is written. Deterministic synthesis into findings. | A generic tool loop (unreliable tool calls on the free route; the model would invent URLs); 20 bespoke programs |
| R5 | How the web runs a multi-minute run | **In the background of the web server**: the action records the brief and returns; the run executes in Next's `after()`; the workbench refreshes while it is running. A run past its deadline (e.g. the server stopped) is sealed as an error. `pnpm research ask` does the same from a terminal. | Terminal only; a job table + worker process |

Defaults the operator did not override:

- Red tests first; one migration `20260926100000_research_mode` with its rollback.
- **External sources are the brief's URLs only** (the plan's "where configured"). The model never proposes a URL; the free model can't browse.
- **No sources, no claims.** A specialist with no passages makes no LLM call and declines. Specialists never assert from model memory (their Refuses sections already forbid unsourced claims).
- **The owner can override the selection.** The brief form previews the keyword selection and lets the owner tick or untick specialists; the run's `selection` records owner picks. This answers the Phase 6B "brittle keywords" flag.
- **A failed specialist fails the run loudly** (dispatch has no retries, 4D); evidence already written stays (insert-only). Re-run creates a new run of the same brief.
- **Promotion requires library acceptance first**, enforced in the op layer (web and CLI), not the DB, so the Phase 6 and 14 fixtures that propose candidates directly stay valid. The gate's safety does not depend on it: D2 already puts every canonical change before the owner.
- **Owner signals as passages** (a recipe's tested notes, a take's keep/change ratings): not built. The Research class has no `artifact.read`; AOS-07 (§10).

## 3. Components and owners

| Unit | Kind | Owner (domain) | Class / role |
|---|---|---|---|
| brief columns on `research_questions`; `research_runs.expires_at` | columns | RESEARCH_INTELLIGENCE | written as `xyp_research` |
| `research_links`, `research_link_retractions`, `research_targets` | tables, view | RESEARCH_INTELLIGENCE | written as `xyp_research` |
| `research_sources.text`, `research_evidence.quote` | columns | RESEARCH_INTELLIGENCE | written as `xyp_research` |
| `xyp_decide_finding`, `current_finding_decisions`, `findings_library` | SQL function, views | GOVERNANCE (decision log) / RESEARCH_INTELLIGENCE (views) | EXECUTE: `service_role` |
| specialist program | `research-intelligence/specialists/program.ts` | RESEARCH_INTELLIGENCE | registered in `LLM_PROGRAMS` for the 20 |
| `write_evidence`, `fetch_source` | existing tools, changed | RESEARCH_INTELLIGENCE | Research, `research.write` / `web.read` |
| synthesis | `research-intelligence/synthesis/synthesize.ts` | RESEARCH_INTELLIGENCE | called by `runResearch`, as `xyp_research` |
| `runResearch` | existing entrypoint, changed | RESEARCH_INTELLIGENCE | — |
| Research screens | `apps/web` | UI | reads as `xyp_web`; writes through the ops below |
| `pnpm research ask`, `pnpm research decide` | CLI | RESEARCH_INTELLIGENCE | — |

No new agent, tool or capability. The 20 specialists change model only (R1).

## 4. Data: migration `20260926100000_research_mode`

**The brief** is the existing `research_questions` row, gaining:

- `intended_use text` — what the answer is for (plan §2E step 1). Nullable in the DB (old rows, and the Phase 6/14 fixtures that insert questions directly); required by the brief ops (web form, `pnpm research ask`), which are the only AOS-04 way to open a brief.
- `urls text[] not null default '{}'` — the external sources the owner allows for this brief; each `http(s)`.
- `specialists text[]` — the owner's selection override; null = keyword selection.

All three are set at insert and immutable after (the existing lifecycle-column UPDATE rule does not cover them).

**Run deadline:** `research_runs.expires_at timestamptz not null default now() + interval '10 minutes'` (existing rows are backfilled from `created_at`; existing inserts need no change). It starts at 10 minutes when the run opens (the orchestrator is deterministic) and raised to `now() + n × LLM_TIMEOUT_MS + 5 min` once `n` specialists are selected. The sweep seals every `running` run past its deadline as `error` with `abandoned: no result by <expires_at>`. It runs at web server boot and before any run starts (web or CLI).

**Links (R2):**

- `research_links`: `question_id` + exactly one of `artifact_lineage_id` (a lineage root, checked by trigger as for `song_links`), (`workflow_name`, `workflow_sha256`) together, or `decision_key` (`^F[0-9]+$`); an optional `role`. Append-only. A decision key is checked against the `**F<n>.` headings of `docs/ARCHITECTURE.md` at write time (op layer; the DB checks the pattern).
- `research_link_retractions` (link id, reason). Same shape as `song_link_retractions`.
- View `research_targets`: every live target of a brief, as (`question_id`, `kind`, `target_id` or key, `role`) — the unretracted `song_links` with a `research_question_id` (kind `song`) union the unretracted `research_links` (kinds `lineage`, `workflow`, `decision`).

**Sources kept (the gate's first clause):**

- `research_sources.text text` (nullable, ≤ 20 000 chars, the fetcher's `TEXT_LIMIT`). `fetch_source` stores the page text it read, so a web quote can be re-verified forever. Old rows keep null.
- `research_evidence.quote text`. The verbatim passage behind the claim. Nullable for old rows; required by `write_evidence` for every agent write (§5).

**Library tier (R3):**

- `approval_item_type` gains `research_finding` (the rollback cannot drop an enum value, as in Phase 14).
- `xyp_decide_finding(p_finding_id uuid, p_decision text, p_approver text, p_reason text)`: `SECURITY DEFINER`, the shape of `xyp_decide_artifact`. It inserts one pre-decided `approval_queue` row (`item_type research_finding`, status approved or rejected, `decided_by`, `decision_reason`). Decision, approver and reason are required. EXECUTE: `service_role` only.
- View `current_finding_decisions`: the latest decision per finding.
- View `findings_library`: accepted findings with their claim, topic, value, model tag, confidence, run, brief, targets, evidence count, and canonical status (none / candidate pending / promoted / rejected).

**Grants:** `xyp_web` SELECT on the research chain (`research_*`, `contradictions`, `knowledge_candidates`), the new tables and views.

## 5. The specialist program (R4)

`research-intelligence/specialists/program.ts` exports one `LlmProgram`. `core/runtime/programs.ts` registers it under every Research agent that has a `## Scope`. Input: `{ question, intendedUse, urls }`.

1. **Passages.**
   - `retrieve_context(question)` supplies canonical rows. A row with a source is a citable passage (the `source_id` path below). A row without one is given to the model as known context, marked not citable, so the specialist doesn't re-prove canonical rules.
   - Each brief URL goes through `fetch_source`, which registers the source and stores its text. A failed fetch is logged and skipped.
   - Passages are numbered and capped at about 24 000 chars in total, in retrieval order.
2. **No citable passages →** no LLM call; output `{ evidenceIds: [], declined: [{ reason: 'no sources' }] }`.
3. **One LLM call.**
   - System prompt: the agent's own Role, Scope and Refuses sections, plus the rules: quote verbatim, one claim per quote, a topic in dotted kebab, a model tag (`<tool>-<version>` or `model-agnostic`), confidence with its inputs, decline what's out of scope.
   - User prompt: the question, the intended use, the passages.
   - Reply schema: `{ claims: [{ passage, quote, claim, claim_topic, claim_value, model_tag, confidence, confidence_inputs }], declined: [{ claim?, reason }] }`, validated by the runner as today.
4. **Write.** `write_evidence` (changed) takes `quote` (required for agent writes) and exactly one of:
   - `research_source_id` (from `fetch_source`): the tool checks the quote against `research_sources.text`;
   - `source_id` (an ingested source): the tool cites it through `citeIngestedSource`, which checks the quote against the canonical bodies quoting that source.

   The check squashes whitespace on both sides; it runs in SQL, as `citeIngestedSource` already does. A claim whose passage number is unknown or whose quote fails is not written: it moves to `declined` with the reason.
5. **Output:** `{ evidenceIds, declined }`, stored on the agent run as today.

The human CLI paths (`pnpm research observation` / `cite`) keep working; `quote` stays optional for them (they carry the excerpt already).

## 6. Synthesis and the run

`runResearch` (changed):

- Takes the brief: `{ projectSlug, question, intendedUse, urls, specialists?, links? }`, inserts the question, its links and the run (with `expires_at`) in one transaction, then selects.
- Selection: the brief's `specialists` if set (each `reason: owner`), else the keyword selection. The workflow's specialist steps get the brief as input.
- After the specialist steps succeed, it runs **synthesis** (`research-intelligence/synthesis/synthesize.ts`, deterministic, as `xyp_research`):
  - Groups the run's evidence by (`claim_topic`, canonical JSON of `claim_value`, `model_tag`); evidence without a topic is listed, not synthesized.
  - Calls the existing `recordFinding` once per group. The finding's claim text is its highest-confidence evidence's claim. `recordFinding` computes confidence and runs the contradiction engine against candidates and canonical rows, as today.
  - A topic with two values in one run becomes two findings; the workbench shows them side by side as a disagreement.
- Seals the run `success` with the workflow run id, or `error` with the reason (a failed step, a failed synthesis). Evidence written before a failure stays.
- Split for the web: `openResearch(brief)` (insert + select, returns the run id quickly) and `executeResearch(runId)` (specialists + synthesis + seal). `runResearch` = both, used by the CLI and tests.

## 7. Approval (R3)

- **Accept / reject into the library:** `xyp_decide_finding`, with a required reason. The latest decision is current; a finding can be re-decided. No canonical table is touched.
- **Promote:** only for a finding whose current decision is `accept` (op layer). The form takes kind (`canonical_prompt` | `module`), target slug, title, body, domain. The op calls `proposeCandidate`, then `runGate`, and shows the outcome (promoted is impossible here: D2 queues every candidate; rejected with reasons; or pending).
- **Decide the pending approval:** the existing `decideQueueItem`, which re-runs the gate on approve and embeds the promotion (as `pnpm gate decide` does).
- The approver is `XYP_OWNER`, else `owner`, as for artifacts.

## 8. UI (`apps/web`)

- **Nav:** Research.
- **`/research`:** briefs (question, intended use, targets, latest run status), and the new-brief form:
  - question, intended use, URLs (one per line);
  - link targets: song, recipe / tag set / lyric lineage, workflow (from the checked-in workflow files; the sha256 is computed on submit), decision key;
  - the specialist preview (the keyword selection with scores and matched terms, as tick boxes).
  - Submit runs the sweep, `openResearch`, then `after(() => executeResearch(runId))`, and redirects to the run.
- **`/research/runs/[id]` (the workbench):**
  - Status; refreshes itself every few seconds while `running`.
  - The brief and its targets; the selection (scores, matched terms, owner picks).
  - Evidence per specialist: claim, quote, source (link, kind, reliability), confidence and its inputs, model tag. Declined claims with reasons.
  - Findings grouped by topic: disagreements side by side, contradictions with the row they contradict, the evidence behind each finding.
  - Per finding: Accept / Reject (with reason); Promote (form); the candidate's gate outcome; Approve / Reject a pending approval.
  - Re-run (a new run of the same brief).
- **`/research/library`:** accepted findings, filterable by target kind and target; each with its sources and quotes, its brief and run, and its canonical status.
- **Song page, recipe page, tag-set page:** a Research section: the briefs linked to it, and their library findings.
- **Server boot:** the sweep (Next `instrumentation.ts`).
- `pnpm web:smoke` gains the Research journey (the LLM stubbed in the smoke server).

## 9. CLI and export

- `pnpm research ask '<brief json>'`: sweep, then `runResearch` with the runtime LLM runner; prints the run, evidence and findings.
- `pnpm research decide <findingId> accept|reject "<reason>"`.
- `pnpm gate` is unchanged and still decides every approval type.
- **Export (`xyp-vault-export/v1`):** `research_questions` and `research_runs` are already exported as the closure of `song_links`; the new columns ride along. AOS-04 adds `research_links`, `research_link_retractions`, `research_sources`, `research_evidence`, `research_findings`, `research_finding_evidence` and `contradictions` to `EXPORT_TABLES`, and the closure follows an exported brief to its runs' evidence, sources, findings and their `research_finding` decisions. `knowledge_candidates` stays out: canonical knowledge moves only through the gate.

## 10. Testing, proof and docs

- **Red first:** DB (migration, checks, triggers, `xyp_decide_finding`, views, grants, rollback idempotent), the program (passages, no-sources decline, quote verification, declined claims), `write_evidence` and `fetch_source` changes, synthesis (grouping, disagreement, no-topic evidence), `openResearch` / `executeResearch` / sweep, ops and loaders, export.
- **The LLM is stubbed** through the runner's `fetch` override (an OpenRouter chat-completion fixture), so CI needs no key.
- **Gate test** `tests/aos-04/brief-to-canonical.test.ts`, one flow:
  1. A brief linked to a song, a recipe lineage and a decision key, with one URL (stubbed fetch).
  2. The run: one claim with a real quote is written; one with a fabricated quote is declined and not written.
  3. Findings are synthesized; each chains to evidence (with quote) → research source (with text).
  4. Accept into the library: canonical tables unchanged.
  5. Promote: a candidate, a pending approval; canonical tables still unchanged.
  6. Approve: the canonical row exists and chains back to the finding, the evidence, the quote and the source.
  7. The brief and its research survive an export and re-import.
- **Gates on every push** (as AOS-03): typecheck, the full suite, `agents:validate`, a migration down/up/down/up on the dev DB, `web:build`.
- **Proof** `docs/proofs/AOS-04-research.txt`: the gate three ways (test, CLI, browser) and one live OpenRouter run. If the free route is overloaded that day, the proof says so rather than faking a run.
- **Docs:** ARCHITECTURE F42 (R1–R5, decided) and F43 (open), SCHEMA, `docs/research/SPECIALISTS.md` regenerated, handoff `docs/handoffs/AOS-04.md`, PLAN untouched.

## 11. Open after AOS-04 (F43)

- Owner signals (recipe tested notes, take ratings) as research passages: AOS-07.
- Model-proposed URLs or web search: needs a search provider; not configured.
- A server stopped mid-run leaves the run `running` until its deadline (up to `n × 30 min`).
- Editing a finding: findings are insert-only; a better finding comes from a new run.
- Decision keys cover ARCHITECTURE `F<n>` entries only, not the baseline's C/D or the phases' A/S/R tables.
- Intra-run disagreements are shown, not recorded as `contradictions` rows (the engine checks candidates and canonical rows only).
