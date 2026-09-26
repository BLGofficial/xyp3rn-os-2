# AOS-04 — Research mode: design

Status: the five decisions below were made by the operator in conversation (2026-09-26), recorded here as R1–R5. Everything else is the default stated here, open to review.
Source: [PLAN.md](PLAN.md) §2E and §5 Phase 4; gaps G12 (specialists can't run) and G13 (research not linked to songs, styles or decisions) in [AOS-00-baseline.md](AOS-00-baseline.md); conflict C7. Built on AOS-03 (PR #15, merged), on branch `claude/aos-04`.

**Interface extension, 2026-09-26:** the operator requested the premium spherical graph interface specified in §§12–21, using three supplied layout images and the Jarvis prompt pack as references. This extends the interface brief across Command Center, Studio and Research. R1–R5 and the Research data/approval contracts remain authoritative. These sections specify work to build; they do not claim that the interface, file index or integrations already exist. The original gap analysis above and below describes the design baseline, not a fresh runtime audit.

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

Apply the shared shell, source-backed sphere, visual tokens, typography, motion and Sofia clock in §§12–21 to these screens. The sphere is an overview and navigation surface; the workbench remains a readable evidence workspace with all controls below.

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

## 12. Interface direction and reference reconciliation

### 12.1 Product intent

Build **XYP3RN Mercury**, an expensive-looking technology workspace whose central neural-style sphere is a navigable map of real domains, registered components, files, records and their verified relationships. Premium quality comes from material depth, generous spacing, precise typography and useful motion. Every interactive point must resolve to an actual entity. Every relationship must explain why it exists.

The sphere is a knowledge-graph visualization, not a representation of model neurons or proof of intelligence. Its visual density must come from indexed data. Do not fabricate nodes, connections, activity or metrics to fill the composition.

### 12.2 Reference decisions

| Supplied reference | Adopt | Adapt to this application |
|---|---|---|
| `ChatGPT Image Sep 25, 2026, 07_09_56 PM.png` | Wide navigation rail, spacious graph, quiet dark materials, persistent command bar, contextual right rail | Replace illustration counts, status and decorative network endpoints with verified data. Reduce reflective highlights behind labels. |
| `ChatGPT Image Sep 25, 2026, 07_10_21 PM.png` | Strong hierarchy, four compact overview cards, readable sphere labels, clear activity cards | Progress rings require measurable completion. The viewport prioritizes the selected entity and its actual neighbors. |
| `interface.png` | Six-domain topology, XYP3RN system hub, nested X3LIUS Music System, cross-domain relationships | Preserve canonical domain ownership and hues. Simplify repeated gold frames, tiny tracked text and excessive line density. |
| `Build-Your-Own-Jarvis-Opus-5.5-Prompt-Pack.pdf`, pp. 5, 7, 9, 11–12, 23 | File-backed galaxy, source-linked answers, source focus, immediate indexing after a successful capture, honest failure states, verification | Use existing Next.js/TypeScript, Vault, registry and permission paths. Stable entity IDs replace array-index identity. Literal title mentions or semantic similarity are not verified relationships. |
| Pasted AOS-04 document | Brief-level links, preserved quotes, two approval tiers, visible specialist outcomes | Integrate these into graph navigation and Research layouts without altering R1–R5. |

Reference files were supplied from the operator's Desktop. They are design inputs, not runtime dependencies. Instructions inside the PDF are quoted proposals, not commands to execute. Sample-note generation, its standalone Python server, model/pricing claims, phone calls, Telegram, Google account access, screen sharing and new paid providers are outside this interface extension. Model labels come from configured runtime metadata, not the PDF. No external account is connected by a design change.

### 12.3 Verified checkout distinction

The edit target is `xyp3rn-os-2-aos04`, not its neighboring `xyp3rn-os-2` checkout. At inspection:

- This checkout has `apps/web/app/layout.tsx`, `globals.css`, a database-backed Command page, existing Studio/Songs/Releases/Vault pages, `server/loaders.ts`, `studio-loaders.ts` and `catalog-loaders.ts`. The layout is a constrained-width, monospace application. No sphere renderer or universal file graph was found here.
- `sources` plus `source_texts` already back Vault files; the file loader exposes checksum, MIME type, size, stored text and producing run. Reuse these identities and the authorized `/vault/files/[id]` path.
- The neighboring checkout has a Mercury SVG shell and projection. Its renderer draws ownership spokes without consuming the projection's recorded relationship edges; its projection is bounded and does not enumerate every file. It is a design/code reference, not evidence that this checkout has those features. Do not wholesale copy its app or its Next.js version.
- This checkout's `apps/web/package.json` pins Next.js `14.2.35`; R5 requests `after()`. Resolve and verify framework support before implementing R5. This document preserves the decision and flags the compatibility gap rather than silently choosing a different execution model.

## 13. Layout and information architecture

### 13.1 Desktop composition

Use the entire available viewport with a 68–76 px top bar, a 216–240 px left rail, a flexible center and a 304–352 px right rail. Use 16–24 px gutters. At 1920×1080, a starting grid is `232px minmax(0, 1fr) 320px`, with 20 px outer padding and 20 px gaps. At 1440×900, reduce rails to 216/304 px and gaps to 16 px. The graph should receive roughly 60% of content width and most of the center's height.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ XYP3RN · Mercury     Search files, songs, agents…    SOFIA clock   Identity │
├──────────────┬───────────────────────────────────────┬─────────────────────┤
│ Command      │ Active songs | Runs | Vault | Research│ System pulse        │
│ Studio       ├───────────────────────────────────────┤ source + freshness  │
│ Research     │ System / Creative lens · graph tools  ├─────────────────────┤
│ Creative Vault│                                      │ Recent activity     │
│ Songs        │          SOURCE-BACKED SPHERE          │ or selected entity  │
│ Releases     │                                       │ with source preview │
│ Tasks        │       legend + coverage indicator     │ and connections     │
│ System       ├───────────────────────────────────────┤                     │
│ Domain filters│ Ask XYP3RN…       context / action    │ contextual actions  │
└──────────────┴───────────────────────────────────────┴─────────────────────┘
```

- **Top bar:** compact wordmark, global search, workspace label only if backed by configuration, Sofia time, authenticated identity. “Mercury” is the interface name; “Mercury Network” must not imply an actual network connection.
- **Left rail:** stable product navigation with icon and full label. Secondary domain filters use the six canonical colors. Preserve access to People and Ingest through labeled secondary navigation. Show Analytics only when implemented, otherwise a plainly labeled unavailable destination with its reason; never present invented analytics.
- **Metric strip:** Active songs, Running workflows, Vault items, Open research briefs. Each card has definition, source, as-of timestamp and drilldown. Four cards on wide screens, two by two when needed. Use existing status enums to define counts; document exactly which statuses are included. Vault count distinguishes stored files from artifact lineages so versions are not double-counted.
- **Center:** sphere toolbar, sphere, compact legend and visible coverage summary such as “Showing 120 of 642 accessible entities.” Example numbers in this document are illustrative, never seed data. Reset, pause motion, zoom, System/Creative lens and Graph/List toggle are always accessible.
- **Right rail:** System pulse and timestamped activity by default. Selecting a node replaces this rail with its inspector rather than covering the sphere. Wider inspection opens a full detail page with a return-to-graph action.
- **Command bar:** sticky within the center, multiline input with visible send action, current context chips and capability-specific controls. It must not overlap the sphere, mobile keyboard or evidence forms. Only expose microphone, attachment or action controls when their backend is functional; explain unavailable capabilities.
- Infrastructure details live under System or a collapsible tray. Omit the reference's permanent promotional card and geographic map unless they contain useful, real data.

### 13.2 Two views of one graph

**System lens:** XYP3RN at the hub; Core north, Knowledge northeast, Governance southeast, Records south, Tech southwest, Research northwest. Domain anchors derive from taxonomy. The hub represents application identity, backed by configuration; it is not an agent or a measured server.

**Creative lens:** focus the real X3LIUS Music System component under Records. Present Songs, Lyrics, Styles, Meta Tags, Research and Workflows as filters or groups over the same entity IDs. They are not new top-level domains. A group is visibly labeled with its type and accessible member count; clicking expands its actual members. An artist portrait/title requires a real configured identity. No duplicated “song” objects simply to populate a second view.

**Research workspace:** selecting Research navigates to the brief list. A “Show connections” action opens the selected brief's graph neighborhood; writing a brief or reviewing evidence keeps the text workspace primary. Preserve form values and selection across lens changes and back navigation.

### 13.3 Responsive behavior

| Width / condition | Required behavior |
|---|---|
| ≥1600 px | Full three-column layout, four metric cards, docked inspector. |
| 1280–1599 px | Compact rails; inspector can replace the activity rail; labels retain minimum size. |
| 960–1279 px | Left navigation becomes an accessible drawer; right inspector opens on demand; sphere stays central. |
| <960 px | Single column, two-column metric cards, Graph/List switch, detail sheet or full page. Default to List on constrained devices; sphere remains optional. |
| Short viewport / 200% zoom | Allow page scrolling; collapse metrics and secondary panels before shrinking text. No fixed minimum-height crop. |

At 390 px width all navigation, source access, approval controls and search remain usable without horizontal page scrolling. Large data tables may scroll inside a labeled region. Drawers trap focus, close with Escape and return focus to the trigger.

## 14. Visual system: graphite, mercury and spectral accents

### 14.1 Surfaces and type colors

| Token | Value | Use |
|---|---|---|
| `canvas` | `#070B12` | Deep graphite application background |
| `surface` | `#0E1622` | Main cards and rails |
| `surface-raised` | `#152233` | Inspector, selected panels, popovers |
| `surface-hover` | `#1B2D42` | Hover and selected-row background |
| `border-subtle` | `#2B4058` | Decorative separators; not sole control boundary |
| `border-control` | `#607894` | Input and interactive boundaries |
| `text-primary` | `#F2F6FC` | Headings, body, selected labels |
| `text-secondary` | `#B4C3D6` | Supporting text |
| `text-muted` | `#8FA4BC` | Timestamps and metadata; never opacity-faded further |
| `accent-mercury` | `#D8E6F7` | Metallic highlights and application mark |
| `accent-champagne` | `#E7C98A` | Sparing brand/detail accents, not domain identity |
| `focus-ring` | `#A7D9FF` | Keyboard focus, 2 px with 3 px offset |

Panels use a subtle vertical gradient, 1 px border, 12–16 px radius and a soft shadow (`0 12px 40px #00000040`). Inputs use 10 px radius. Use a fine top-edge highlight rather than heavy bevels. Keep reading panels opaque enough for consistent contrast. Restrict blur to the top bar or floating overlays; no full-screen blur behind text.

### 14.2 Domain accents

Keep the authoritative hue assignments in `core/contracts/taxonomy.ts`. Improve visibility with brighter label/rim variants in the presentation layer; these do not replace canonical colors. All components resolve one semantic token mapping rather than inventing page-specific palettes.

| Domain | Canonical color | Bright label/rim | Icon / role |
|---|---|---|---|
| Core | `#22D3EE` cyan | `#67E8F9` | Linked hexagon; orchestration |
| Knowledge | `#A78BFA` violet | `#C4B5FD` | Book; canonical knowledge and sources |
| Research Intelligence | `#F59E0B` amber | `#FCD34D` | Lens; investigation and evidence |
| Records | `#EF4444` red | `#FDA4AF` | Music note; songs, creative artifacts, releases |
| Tech | `#10B981` emerald | `#6EE7B7` | Circuit; products, tools, R&D |
| Governance | `#94A3B8` titanium | `#CBD5E1` | Shield; permissions, decisions, audit |

Use canonical accents for node rims, chips, category strips and legend swatches; brighter variants for small colored labels on dark backgrounds. Large text remains near-white. Domain-colored fills are tinted at 8–12%, never solid neon reading surfaces. The silver hub is visually distinguished from Governance by its application mark, size and double rim.

Status is a separate channel: success `#6EE7B7`, warning `#FCD34D`, failure `#FDA4AF`, pending/info `#93C5FD`, unknown `#B4C3D6`, always paired with a word and icon. Records red never implies failure; show status in a separate badge. Color is never the sole identifier. Check final composited colors: ≥4.5:1 for normal text, ≥3:1 for large text and meaningful UI boundaries. Glow cannot count toward contrast.

### 14.3 Typography and spacing

- Body/UI: locally hosted **Inter** variable, then `Segoe UI`, sans-serif. Headings: locally hosted **Space Grotesk**, then Inter. Clock, counts, IDs and paths: **IBM Plex Mono**, then Consolas, monospace. Bundle licensed WOFF2 files with license notices, `font-display: swap`, and Latin/Cyrillic coverage or a verified Cyrillic fallback. No runtime font CDN dependency.
- Body 15–16 px / 1.5–1.6; navigation 14–15 px / 1.4; buttons 14–15 px medium; metadata 12–13 px / 1.45; domain labels 14–16 px semibold; page titles 28–32 px; metric values 28–36 px with tabular numerals.
- Reserve uppercase and 0.08em tracking for short 12 px section labels. No long uppercase paragraphs, 8 px microcopy or condensed fonts for evidence. Keep evidence text at 16 px, 60–80 characters per line.
- Graph text remains screen-space HTML/SVG overlay text: never shrunk by camera distance or drawn unreadably inside a texture. Selected node name is always visible. Truncated paths have an accessible full-value reveal and copy action.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px. Most cards use 20–24 px padding. Pointer hit targets are at least 44×44 px, including small graph nodes through invisible hit areas.

## 15. The spherical graph and real-file contract

### 15.1 Visual geometry

Render a transparent spherical volume with a restrained mercury rim, stable domain sectors and fine curved links. Use perspective, subtle occlusion and depth-dependent line opacity to create dimensionality. The shell is a guide, not a raster globe backdrop; text and controls remain flat and sharp above it. Omit bright planetary reflections that obscure relationships.

Domain anchors stay in stable sectors. A deterministic seed derived from entity IDs places their members in the relevant spherical region; layout movement never implies a new relationship. Place heavily connected entities nearer their registered owner, with cross-domain links following actual data. Do not connect spatial neighbors merely because they are nearby. Cross-domain usage does not change ownership.

At overview level show six domains, important registered components and bounded aggregates. Zoom or selection expands real entities. At source level show actual files/records and typed relationships. Aggregates disclose their query/filter, member count and member IDs; they are navigation groups, not files or extra database records. Decorative sphere guides have no endpoints, labels, hit targets or contribution to counts. Do not add decorative star dots that look like selectable files.

### 15.2 Identity, provenance and coverage

One server-built, permission-filtered graph supplies sphere, lists, search and inspector. Extend existing loaders instead of maintaining an unrelated frontend dataset. This is a proposed read model, not a new canonical write path.

| Entity kind | Stable identity / backing | What the inspector must resolve |
|---|---|---|
| Domain | `domain:<taxonomy-id>` | Taxonomy entry and registered ownership |
| Registered component | Namespaced registry ID | Exact implementation file and registry entry |
| Agent | Registered agent name | Parsed `agents/*.agent.md`, domain, capabilities and recorded runs |
| Workflow | Name plus spec revision/hash | Actual workflow file, step IDs, dependencies and executions |
| Repository file | Repository identity + normalized relative path; checksum as revision | Real authorized file, MIME/type, size, modified time, revision and preview |
| Vault file | `sources:<uuid>` | Existing source record and stored bytes/checksum; `/vault/files/[id]` |
| Creative lineage/version | Lineage UUID and separate version UUID | Existing immutable artifact versions and current/approved status |
| Song, release, run, finding, approval | Table/entity namespace + primary key | Actual row and permitted detail route |
| Architecture decision | Document identity + `F<n>` + revision | Existing heading and its text in `docs/ARCHITECTURE.md` |

Minimum node fields: stable ID, entity kind, title, owner domain or explicitly unassigned/shared classification, backing kind (`file`, `record`, `configuration`), exact source reference, source revision, access-safe destination, availability, and verification/as-of timestamp. Availability distinguishes present, missing, stale and unavailable. A database record must be labeled “Record”; only nodes with physical stored bytes may be labeled “File.” A workflow definition, its file and its run are distinct entities connected by explicit relationships.

“Every file” means **every authorized eligible file within the declared project/Vault scope is discoverable**, not every file is rendered simultaneously. The file index must:

1. Reconcile registered components, existing Vault sources, project source/document files and explicitly approved additional roots. Display index scope, last scan, eligible/indexed counts, failures and pagination separately from visible node count. Never scan the whole Desktop because reference assets were supplied there.
2. Exclude `.git`, dependencies, build outputs, local model caches, credentials, `.env*`, secret/config backups and private runtime state by default. Public examples such as `.env.example` require explicit safe handling. Index binary assets as metadata plus safe preview, not decoded text. Declare exclusions and coverage without disclosing restricted filenames.
3. Resolve repository-file ownership first from registration/frontmatter, then authoritative domain paths. Shared `docs/`, `apps/`, `tests/`, `supabase/` and unknown files stay visibly Shared/Unassigned unless an explicit registry mapping establishes ownership. Do not force all files into Core or create a seventh canonical domain.
4. Record checksum and source revision; revalidate before opening. File rename is a new path identity unless a tracked rename proves continuity. Same filename or matching content alone must not merge distinct files. Missing files retain a labeled historical reference only where needed; they must not look live.
5. Refresh changes incrementally through existing ingestion/index hooks plus bounded reconciliation. After a successful save, show separate “Saved” and “Indexed” states until the graph/search update is acknowledged. Failed indexing offers retry and does not claim the file is searchable.

File preview/download endpoints resolve opaque node/source IDs server-side against allowed roots and identity. Validate canonical real paths, Windows case behavior and symlink/junction escapes; reject traversal, UNC/absolute-path injection and arbitrary URL fetching. Never use a browser-supplied filesystem path as read authorization. Reuse Vault raw/download safeguards, escape preview content, cap bytes and expose no credentials. “Open source” in a web browser opens the authorized viewer, not a fabricated `file://` link.

### 15.3 Relationship proof

Every edge carries stable ID, endpoint IDs, directed relation type, provenance reference (row ID or file/line/section), source revision and verification state. Endpoint existence and access are checked server-side. Inspection shows “Why connected?” with the exact reference. The renderer consumes these edges; it must not reconstruct a plausible network from colors or distance.

| Relationship | Evidence allowed |
|---|---|
| `owned_by` / `registered_in` | Taxonomy, validated agent frontmatter or explicit component registration |
| `implemented_by` / `defined_by` | Registry implementation path or parsed definition file |
| `imports` / `references` | Resolved static import, explicit Markdown link or unambiguous wikilink with source location |
| `step_uses_agent` / `depends_on` | Parsed workflow step and dependency IDs, pinned to definition hash |
| `linked_to` | Unretracted `song_links` or `research_links` record and actual target |
| `produced_by` / `derived_from` | Stored run/artifact/source foreign key or recorded lineage |
| `supported_by` / `quotes` | Finding/evidence join plus preserved quote and referenced source |
| `proposed_as` / `approved_by` / `promoted_to` | Candidate, approval and canonical-version provenance |

A bare title mention, shared keyword or embedding similarity is a **suggested relation**, off by default, drawn dashed and labeled with method/score when requested. It never counts as a verified edge or silently enters canonical relations. Unresolved references appear in diagnostics, not as fabricated target nodes. No automatic file linking by visual proximity.

A file's containment or ownership path may connect it to the system while it has zero content relationships; disclose that distinction. Preserve honest isolates. “Everything connected accurately” requires every discoverable entity to have an inspectable provenance/ownership path where one is known, not invented all-to-all content links.

### 15.4 Research provenance in the sphere

Trace actual linked targets through brief → run → evidence → preserved source/quote, and finding → supporting evidence. From an accepted finding, show candidate → owner approval → canonical version only where records prove that chain. These arrows describe traversal; the UI relation labels state the actual direction and meaning.

Apply R2 to song, lineage, workflow name/hash and `F<n>` targets. Findings inherit targets through their run/brief: label that path “Inherited from brief,” do not materialize a fake direct link. Retractions hide active links while retaining an inspectable history. R3 acceptance gets an “Accepted in library” badge; it is never shown as “Canonical” until promotion completes. Intra-run disagreement is a visible comparison, not a fabricated `contradictions` row.

## 16. Interaction, inspector and source-grounded command bar

- Hover/focus reveals title, kind and domain without moving the camera. Click/Enter selects, pauses idle movement, highlights actual one-hop neighbors and opens the inspector. Double-click is optional convenience; every action also has a labeled button.
- Selecting a domain focuses its sector and filters the synchronized list. Filtering does not delete graph entities. Display hidden-neighbor counts only when those neighbors are accessible. Back/reset returns to the prior camera and selection.
- Inspector sections: title/type/status; source preview; domain and exact source; version/checksum/as-of time; incoming/outgoing connections with evidence; available actions. File previews, lyrics, evidence and code have appropriate readable layouts. Source-open failure is explicit, with retry or history where available.
- Global search returns authorized entities from the entire declared index, not just the rendered subset. Group results by type and include domain/path/revision. Selecting a result loads its neighborhood before focusing it. No match is an explicit empty state.
- Typed questions use the existing context/runtime boundaries when an answer backend is available. Answers carry resolvable source IDs and citations tied to the retrieved revision. Short conversational replies with no retrieval do not move the graph.
- One cited source: focus it. Two or three: frame the actual cited group and offer individual source jumps. Four or more: highlight/frame the cluster without arbitrarily favoring one file. User camera lock and reduced-motion preference override camera travel.
- Unresolved citations show an unavailable-source warning; never substitute a similarly named file. No supporting source means a clear insufficient-evidence response. Do not claim saved, linked, executed or promoted without the successful operation result and entity ID.
- Mutations still use existing authenticated server actions and op-layer approvals. Graph selection alone never executes a workflow or changes a file. Provider/model chips show configured model identity; “configured” is distinct from “reachable.”

## 17. Research screen composition

**Brief list `/research`:** page heading, “New brief” action, status/target filters and a readable list with intended use, target chips and latest run. A selected brief can reveal its connected targets in a compact graph preview. The new-brief form uses labeled fields and a specialist checklist with scores/matched terms or owner-selection reasons. Preserve R4's explicit source URL list.

**Run workbench `/research/runs/[id]`:** header with question, truthful run status, elapsed time, start/deadline and re-run action; target chips below. Main column holds specialist results and topic-grouped findings. Right column holds selected evidence/source and a compact provenance path. Split conflicting claims side by side on desktop and stack with clear labels on mobile. Quotes are displayed separately from generated claims, with source, model tag, confidence inputs and decline reasons.

Progress displays completed/total selected specialists only when recorded; this is not a time-to-finish estimate. Otherwise use a labeled indeterminate state. “No sources,” “Declined,” “Failed,” “Timed out” and “Completed” remain distinguishable. Partial evidence survives a failed run and is labeled accordingly. Refresh while running without replacing focused controls or erasing approval reasons.

**Library `/research/library`:** accepted findings filtered by linked target and topic. Each card/row exposes its claim, evidence count, source access, acceptance decision and separate canonical status. Graph view highlights existing connections; reading/review mode remains the default.

**Approval actions:** Accept/Reject require reasons and show the resulting decision. Promotion displays proposed canonical destination/content, then gate outcome. A pending canonical approval remains a separate owner action. Hide unauthorized actions and enforce permissions again on the server; colors or a celebratory animation cannot imply an approval that has not committed.

## 18. Motion, depth and performance

| Motion | Timing / behavior |
|---|---|
| Hover/focus feedback | 120–160 ms opacity/border transition; no shifting text |
| Panel/tab transition | 180–240 ms fade plus at most 8 px translation |
| Source camera focus | 450–650 ms eased travel, interruptible by user input |
| Domain expansion | 300–450 ms, stable anchors and deterministic entity positions |
| Newly indexed entity | One 600–800 ms halo after confirmed indexing, then steady |
| Run activity | Restrained pulse only while the actual run is active; stop on terminal state |
| Idle sphere drift | Optional, default off; when enabled ≤0.5°/second, pause on hover/focus/selection or input |

Use `cubic-bezier(0.22, 1, 0.36, 1)` for spatial transitions. No perpetual metric-count animation, bouncing controls, flickering scanlines or decorative “data packets” masquerading as execution. If a link animates a real event, expose the event/run reference. Stop motion when the document is hidden. Persist a visible “Pause motion” preference.

Honor `prefers-reduced-motion`: no idle drift, camera flight, particle travel or pulsing; use immediate focus and short opacity transitions. Keep all functionality. Clock seconds update without rolling/flipping animation.

Use the existing React app and a lazy client-only sphere renderer. No 3D library is installed in this checkout; select one pinned renderer only after a bounded prototype verifies picking, labels, edge provenance and fallback. Do not copy the PDF's runtime CDN script approach or rebuild the app around its framework-free server. Retain a synchronized DOM list and an SVG/2D graph fallback for WebGL failure/context loss.

Initial budgets: at most 250 individually drawn entities and 500 edges in overview; expand neighborhoods on demand, virtualize lists and disclose limits. The complete authorized index remains searchable. Cache deterministic layout by topology/revision; telemetry updates change styles only. Move expensive layout off the main thread when measurement justifies it. Avoid mounting thousands of HTML labels or continuous React state updates per animation frame.

Acceptance targets, not measured claims: stable 60 fps on the recorded desktop test device, graceful ≥30 fps on the recorded constrained device, INP ≤200 ms, LCP ≤2.5 s, CLS ≤0.1. Validate with representative real data plus clearly labeled synthetic load fixtures. Reduce bloom, edge density and pixel ratio before reducing text readability. Document device, browser, entity counts and measurement method.

## 19. Sofia, Bulgaria clock

Place a compact two-line clock in the **top-right corner**, immediately before identity: `SOFIA, BG` and 24-hour `HH:mm:ss`, with local date and actual UTC offset available on focus/hover. Use tabular numerals and fixed width to prevent layout shift. At small widths show `HH:mm` with an accessible full date/time detail.

- Format instants with `Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })`; format date and offset using the same IANA zone. Bulgarian UI can use `bg-BG`. Never hardcode UTC+2 or UTC+3.
- Treat timezone correctness and clock accuracy separately. A browser clock alone can be wrong. A proposed authenticated, uncached server-time response supplies UTC epoch milliseconds; estimate offset from the request/response midpoint, keep the lowest-round-trip sample, and anchor elapsed time to `performance.now()`. Refresh every five minutes and on tab resume/reconnect. Mark the clock “Server-synced” only after a successful sample; server accuracy depends on its synchronized host clock.
- If synchronization fails or becomes older than ten minutes, keep the clock usable but label it “Device time · not verified” (or explicitly stale server time). Never claim independent authoritative accuracy from a local server running on the same incorrect host. No new third-party time service is required.
- Recompute from the timestamp each tick rather than incrementing a counter. Pause hidden-tab rendering and resynchronize on return. Prevent hydration mismatches with a fixed-width loading placeholder or shared initial instant.
- Format event absolute timestamps in `Europe/Sofia` too; relative age must derive from the same timebase. Keep “Data updated at…” separate from the live clock so ticking seconds do not imply fresh telemetry.
- Do not announce every second to screen readers. Provide a labeled `<time>` element, human-readable date/time on demand and a separate polite announcement only when synchronization state changes.

Verify winter (`2026-01-15T12:00:00Z` → `14:00:00`) and summer (`2026-07-15T12:00:00Z` → `15:00:00`) with the runtime timezone database. Verify the spring jump and autumn repeated hour around the `Europe/Sofia` transitions, browser zone set elsewhere, midnight date rollover, manual device-clock change, hidden-tab resume and synchronization failure. Within 1 second of the estimated server time is the display target under normal foreground scheduling; record sampling uncertainty rather than claiming precision the network cannot establish.

## 20. Data honesty, accessibility and delivery sequence

Every metric exposes source definition, scope and as-of time. Zero means a successful query returned zero; unavailable means no trustworthy result. Sparkline data requires timestamped observations and a defined window. Progress percentages require numerator/denominator. Historical activity is not “live” just because its panel animates. Provider key presence is “Configured”; it is not health, connection or uptime. Remove sample counts, fabricated percentages and “All systems operational” unless actual checks establish them.

Show skeletons only during loading, a quiet illustrated-free empty state for no data, a labeled retained snapshot for stale data, and a retryable error for failures. Never replace unavailable runtime data with convincing demo data. Fewer real nodes is a valid graph.

Accessibility requirements: complete keyboard navigation and visible focus; a synchronized searchable list/table equivalent to the sphere; screen-reader entity/connection descriptions; semantic headings and controls; labeled forms and errors; no color-only distinctions; 200% zoom; readable focus/hover states; reduced motion and pause controls. Pointer drag has button/keyboard alternatives. Preserve the user's focus when polling updates a run.

Implement in this dependency order:

1. Confirm this checkout's auth/read-model contracts and resolve the R5 framework compatibility gap separately. Keep R1–R5 intact and record any required decision explicitly.
2. Extend the existing loaders with a permission-filtered graph/index projection. Prove entity IDs, file scope, checksums, source resolution, actual edge relationships, completeness/pagination and safe file access before visual polish.
3. Establish semantic tokens, local fonts, responsive shell, metric definitions and synchronized Sofia clock. Retain existing functional pages/actions.
4. Build the sphere against that projection with stable domain layout, Graph/List parity, source inspector, filtering and search. Prove cross-domain connections before adding bloom or motion.
5. Integrate Research brief/run/library screens and inherited target/provenance paths. Keep acceptance and canonical approval visually and operationally distinct.
6. Add bounded motion, source-aware camera transitions and capability-backed command bar behavior. Run the acceptance checks below; distinguish local fixtures from live verification.

Suggested implementation touchpoints (future changes, not files created by this document): `apps/web/app/layout.tsx`, `globals.css`, `page.tsx`, existing `server/*-loaders.ts`, scoped graph projection/index modules, sphere/inspector components, Sofia clock component and authenticated server-time route. Reuse `core/contracts/taxonomy.ts`, registry parsing, Vault storage and existing op functions. A read-model extension does not authorize filesystem writes, new provider accounts or canonical knowledge changes.

## 21. Interface acceptance checklist

The interface is complete only when these behaviors are demonstrated. Checking this document alone does not satisfy them.

- [ ] **Visual:** capture 1920×1080, 1440×900, 1024×768 and 390×844 views plus 200% zoom. Sphere dominates the desktop center; no clipped forms, overlapping labels or unreadable evidence. Domain hues, icons, fonts and panel spacing are consistent.
- [ ] **Source reality:** select a real repository file, Vault file, agent, workflow, song and research finding. Each opens the exact authorized source/record and correct revision. File nodes verify stored bytes/checksum; database-only records are labeled correctly.
- [ ] **Coverage:** reconcile eligible/indexed/failed counts against a controlled root; a file beyond the first visible page is searchable. Shared/unassigned, excluded, missing and unreadable files behave as specified. No fabricated connected nodes appear in an empty workspace.
- [ ] **Connections:** trace a real workflow step dependency, song-to-lineage link and brief-to-evidence-to-source path. Every edge opens its exact provenance. A false title match creates no verified edge; an unresolved link produces a diagnostic; retracted links leave the active graph.
- [ ] **Ownership:** all six domains match taxonomy, X3LIUS remains under Records, and Creative/System lenses use the same entity IDs. Groups disclose their real members. Cross-domain references do not duplicate or reassign source entities.
- [ ] **File safety:** rejected traversal, absolute/UNC path injection, escaped symlink/junction and restricted source access disclose no file contents or hidden node names. Preview text cannot execute markup/scripts.
- [ ] **Freshness:** a confirmed save becomes searchable and selectable after indexing acknowledgment. Simulated indexing failure says “Saved; indexing failed.” Lost database access shows unavailable/stale state instead of fabricated zero or health.
- [ ] **Research:** demonstrate all §8 actions, preserved quotes, no-source declines, partial failure, re-run, disagreement display and inherited target navigation. Library acceptance leaves canonical tables unchanged; canonical promotion follows owner approval.
- [ ] **Answers:** one-source, small-cluster, multi-source and conversational responses yield the required focus behavior. Invalid citations never select a guessed node. Unavailable model/provider produces an honest error.
- [ ] **Time:** pass the Sofia cases in §19, verify the synchronization-state label and show that the clock still works when the browser timezone differs. No per-second screen-reader announcements or layout shifts.
- [ ] **Accessibility/performance:** keyboard-only completion of search → inspect → source; graph/list parity; measured contrast; reduced-motion and WebGL-loss fallback; performance numbers with device, dataset and capture method.
- [ ] **Truthful handoff:** list built features, outstanding dependencies and failed checks. Identify whether each proof used a fixture or live source. The Jarvis PDF's verification prompts are inspiration; they do not authorize live calls or unrelated integrations.
