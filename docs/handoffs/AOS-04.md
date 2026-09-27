HANDOFF — Artist OS AOS-04 Plan A (Research mode) complete; Plans B and C (Mercury interface) next

- **Built** (design `docs/artist-os/AOS-04-design.md` §§1–11 and §17, plan `docs/artist-os/AOS-04-plan.md`, decisions R1–R5 in ARCHITECTURE F42; proof `docs/proofs/AOS-04-research.txt`):
  - **Data:** migration `20260926100000_research_mode` (+ rollback) adds:
    - the brief on `research_questions`: `intended_use`, `urls` (http(s) only), `specialists` (the owner's pick);
    - `research_runs.expires_at`, the run deadline the sweep enforces;
    - kept sources and quotes: `research_sources.text` (what a fetch read) and `research_evidence.quote`, checked verbatim by the DB on insert;
    - `research_links` + `research_link_retractions` (a brief's lineage, workflow and decision targets), with `research_targets` adding the songs that link the brief (A1);
    - the owner's finding decisions: `xyp_decide_finding` (one final decision per finding, in `approval_queue`), `current_finding_decisions`, `findings_library`.
  - **The specialists run (R1, R4):** all 20 on `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`, sharing one program (`research-intelligence/specialists/program.ts`):
    - passages are the brief's URLs first (`fetch_source`), then retrieved canonical rows that trace to an ingested source, within 24 000 chars;
    - no passages, no model call (declined `no sources`);
    - one call with the agent's own Role, Scope and Refuses; each claim quotes a passage; a fabricated or typographically different quote, an unknown passage, a bad topic or a non-JSON value is declined with its reason, never written.
  - **Evidence path:** `fetch_source` stores the page text (injectable fetch); `write_evidence` requires a quote from an agent and cites exactly one of a fetched page or a canonical row's source.
  - **Synthesis:** `synthesizeRun` groups a run's evidence by (topic, value, model tag) into findings through `recordFinding`; runs after the specialists, also after a failure (the partial evidence stays, labelled by the run's error).
  - **The run:** `openResearch` (validates the brief before any write, writes question + links + run in one transaction, asks the orchestrator, records the selection and the deadline), `executeResearch` (the specialists with `LLM_TIMEOUT_MS` each, synthesis, the seal on every path), `sweepResearch`, and `runResearch` = both (the Phase 6A call still works). The orchestrator takes the owner's picks (`selection.owner`).
  - **The Findings Library (R3):** `decideFinding`, `promoteFinding` (accepted findings only → candidate → gate → pending approval), `decidePromotion`.
  - **CLI:** `pnpm research ask | decide | promote`.
  - **Export:** an exported brief (reached through `song_links`) brings its links and retractions, runs, evidence with sources and text, findings, contradictions and the owner's decisions. Candidates stay out.
  - **UI:**
    - `/research`: the briefs with targets and latest run; the new-brief form with the specialist preview (scores, matched terms), links to songs, lineages, workflows and decisions, and the owner override;
    - `/research/runs/[id]`: the workbench (each specialist's outcome, passages, declines and failed URLs; findings by topic, side by side when they disagree; the quotes with source and confidence inputs; accept/reject; promote; approve canonical; unlink; re-run), refreshing itself while running with no finding yet;
    - `/research/library`: accepted findings, filterable by target, canonical status shown apart from acceptance;
    - a Research section on the song, recipe and tag set pages;
    - runs execute in the background of `next start` (R5 on Next 14.2: a detached promise); `instrumentation.ts` sweeps abandoned runs at boot.
    - `pnpm web:smoke` drives the Research journey in Chromium.
- **Numbers:** 51 agents, 37 tools, 23 capabilities (none new), 57 tables (+2) and 21 views (+3), 1322 tests (up from 1263 at AOS-03), all passing.
  - Gates on every push: typecheck, the full suite, `agents:validate`, a migration down/up/down/up on the dev DB, and `web:build`; `web:smoke` before the proof.
- **The gate** (PLAN §5 Phase 4: reusable findings retain their sources and cannot silently become canonical without approval): shown by `tests/aos-04/brief-to-canonical.test.ts` (with the real retrieval over the ingested build guide), the CLIs (proof §2) and the browser (proof §3). The promoted canonical row chains to its candidate, finding, evidence, verbatim quote and the page text the quote was checked against; canonical counts don't move on accept or promote, only on the owner's approval.
  - Honest note: the gate test and the smoke extension were written after the features they drive, so they were never red. Every other AOS-04 test was committed red first.
  - Not run live: the specialists' model call (no `OPENROUTER_API_KEY` in this environment). Proof §2a runs the live path up to it: a real page fetched, 20 000 chars kept, the run sealed `error` naming the missing key.
- **Changed on purpose:**
  - The 20 specialists' model: `claude-sonnet-5` → the OpenRouter free route (R1). `tests/phase-06b/roster.test.ts` pins the new model.
  - `write_evidence` requires a quote from an agent; `tests/phase-06c/engines.test.ts` passes one and registers its source with the text it comes from.
  - The orchestrator's plan binds each step's input from the workflow input (`question`, optional `intendedUse`, `urls`); `planResearch` takes the owner's picks.
  - `runResearch` is open + execute; an orchestrator failure's returned error now carries the stored `research-orchestrator failed:` prefix.
  - The web runtime has an `llmRunner` (`createRuntimeLlmRunner`).
- **Found and fixed on the way:**
  - The plan's `findings_library` reported `rejected` for a finding with no candidate: an aggregate over zero rows still returns a row, so its `coalesce(…, 'none')` never fired. It is `none` now (`having count(*) > 0`).
  - The plan granted `service_role` ALL on the new tables, against G20 (read-only). It reads only.
  - `research_targets` needs `xyp_research` to read `song_links` (security invoker): granted, with policies, and removed by the rollback.
  - With the build guide ingested, retrieved canonical rows could use the whole passage budget and drop the owner's own URLs. The brief's pages come first now (a red test pins it).
  - The provider-failure test in the plan threw inside `fetch`, which skips the retry path; it now answers HTTP 429 through the retries after a first specialist succeeds, and checks that specialist's evidence became a finding.
  - `instrumentation.ts` broke the edge compile (`lib/os.ts` has `node:` imports): the sweep lives in `instrumentation-node.ts`, imported only under `NEXT_RUNTIME=nodejs`, and a boot without the DB logs and still serves `/login`.
  - `promoteOp` takes the form's domain as text and checks it against `DOMAINS` before writing a candidate.
  - A research link re-added after its retraction is ordered after the retraction on import (the live-duplicate guard), as song links are.
- **Open** (F43): owner signals as passages (AOS-07); no web search; a stopped server's run waits for its deadline; findings are insert-only; decision keys are `F<n>` only; intra-run disagreements aren't `contradictions` rows; legacy sources without text can't back a new quote; ingested-source quotes depend on the canonical bodies (a restore without them would be refused; not exercised by a test); a gate-promoted row has no source, so it is context, not a citable passage; no live specialist run here; Plans B and C not built.
- **Next:**
  1. **Plan B:** the Mercury shell (design §§13–14): tokens, layout, the Research screens re-skinned. **Plan C:** the graph, file index and sphere (§§15–16, 18–21).
  2. **A live run:** with `OPENROUTER_API_KEY` set, `pnpm research ask` on a real brief, to see the free route's quote fidelity (the DB check will decline paraphrases; expect some).
  3. Then **AOS-05** (Whisper and Kokoro).

---

HANDOFF — AOS-04 Plan B (the Mercury shell) complete; Plan C (graph, file index, sphere) next

- **Built** (plan `docs/artist-os/AOS-04-plan-B.md`, decisions M1–M3 in ARCHITECTURE F44; proof `docs/proofs/AOS-04-mercury.txt`):
  - **Tokens and base layer (M1):** `apps/web/lib/tokens.ts` feeds Tailwind and a contrast test. `globals.css` restyles every page through the shared classes: headings, tables, controls at 44 px, the 2 px focus ring, reduced motion. Status is its own channel (word + glyph + colour); "Accepted in library" has its own colour, never the promoted green.
  - **Fonts (M2):** Inter, Space Grotesk and IBM Plex Mono from pinned `@fontsource` packages, with `FONT-NOTICES.md` and the Cyrillic fallback pinned by a test.
  - **The Sofia clock:** `lib/clock.ts` (IANA zone, offset estimate, sync state), `/api/time`, and the client clock in the top bar. Every `<Time>` renders Sofia time with its offset.
  - **Shell loaders:** the metric strip (exact definitions, one as-of time, per-card savepoints so a failed card reads "unavailable"), the system pulse (what was checked; provider keys Configured / Not configured), recent activity.
  - **The shell:**
    - a top bar with Vault search, clock and identity;
    - the left rail, with `aria-current` and Analytics listed as not built;
    - a modal `<dialog>` drawer below 1280 px (only when JS is present);
    - the `WithRail` right-rail slot.
  - **Command:** the metric strip, then the existing sections, with pulse and activity in the right rail.
  - **Research (§17):**
    - list filters by latest-run status and by target, and a New brief action;
    - on the workbench: outcome words (Completed, No sources, Declined, Failed, Timed out), elapsed time from recorded timestamps, the selected evidence with its provenance path, and a refresh that pauses while anything is typed;
    - library filters by target and topic, with separate acceptance and canonical badges.
  - **Every table** sits in a labelled scroll region, so no page scrolls sideways at 390 px.
- **Numbers:** tests (the real count, from `pnpm test`, is in the proof's gates section); 3 font dependencies; no migration; no new agent, tool or capability.
- **Changed on purpose:**
  - timestamps render in Sofia time with the offset (UTC on hover), not UTC;
  - Records red is no longer a generic accent;
  - the smoke's pending-approval check is scoped to the finding card, since the provenance path repeats the status.
- **Found and fixed on the way:**
  - the fonts test first imported the `.mjs` Tailwind config statically, which typecheck refused; a commit landed with typecheck red and the next commit fixed it;
  - the first 390 px run found six pages scrolling sideways, all from tables.
- **Open** (F45): global search and domain filters wait on Plan C; no performance numbers; 200% zoom approximated; forms still keep typed values (F39); Plan C not built.
- **Next:** Plan C, written and reviewed before code, as Plan B was. The live `pnpm research ask` still waits on `OPENROUTER_API_KEY`.
