HANDOFF — Phase 12 built and proven on the FAKE model; not run live yet (no model key)

- **Built:**
  - **The Critic, `x3lius-evaluation`** (class Critic; it replaces the last Phase 7 stub under the same name, so routing and scope carry over):
    - It checks one creative artifact version against the canonical rules in force for it and writes an `x3lius.critique/v1`. Each violation has its rule ref, a JSON Pointer path, a verbatim quote, and what was expected and found, so Phase 16 can render it as a diff.
    - Code checks structured claims: Suno `suno.limit.<field>-chars`, measured from the text, and a mix report's own checks. The model judges only prose rules.
    - Code verifies every model-found violation: the rule must have been given, the path must exist, and the quote must be there word for word. Anything else is kept as `unverified` with its reason and never counts.
    - It never edits the artifact. When a loop continues, it lists which of the previous critique's violations are `resolved`.
  - **Revision, `x3lius-revision`** (class Revision; it works inside Evaluation without being a sub-domain, like `x3lius-rvc-post`):
    - It reads the critique, asks the model for edits (`path`, `replacement`, `violationKeys`), and applies them in code, all or nothing.
    - It refuses an edit that:
      - cites no violation of this critique;
      - names no field, or a field code derives (`sources`, the trace, a Suno prompt's lyrics, limits and model);
      - is outside every violated field;
      - changes a field's type, changes nothing, or repeats a field.
    - It writes version N+1 with `critique_id` set. A Suno prompt's measured lengths are recomputed after the edit.
  - **Loop controller**, `records/x3lius/evaluation/loop.ts` and `pnpm evaluate <artifactId>`:
    - It runs Critic, then Revision, then Critic, all through the Orchestrator.
    - At most 3 revisions, and a stall rule escalates early (ARCHITECTURE F27).
    - Escalations go to `approval_queue` as `critique_escalation`, through `xyp_escalate_critique`, which only `xyp_evaluation_loop` can call.
    - A mix report is critiqued and then escalated as studio work (F26).
  - **Data** (migration `20260925100000_critiques`):
    - an insert-only `critiques` table, chained to the parent version's critique;
    - `creative_artifacts.critique_id`;
    - roles `xyp_critic` and `xyp_evaluation_loop`;
    - capability `critique.read` (Critic, Revision, Governance).
  - **6C unstubbed.** Trials are scored by the Critic as rules passed / rules checked (F28). The research CLI designs and records experiments with the Critic scorer, and an experiment whose every trial the Critic scored can validate.
  - **Proof:** `docs/proofs/PHASE-12-critic-revision.txt`.
    - PROOF 1 converges (counts [2, 0]). PROOF 2 hits the cap (counts [4, 3, 2, 1]) and is escalated.
    - Also proven: stall, `revision_failed`, `studio_work`, and refusal of bad ids.
    - 9/9 mutations caught.
- **Key decisions (user):**
  - D1: the Critic is hybrid (F25).
  - D2: a mix report is studio work (F26).
  - D3: at most 3 revisions, plus a stall rule (F27).
  - D4: score = passed / checked (F28).
  - D5: a code controller over the Orchestrator (F29).
- **Deviations from spec (all but the fixture move are also written into the spec, §5, §6 and §13):**
  - The Critic finds a version's spec by **schema id**, not `agent_name`, because a revised version is written by `x3lius-revision`. Legacy `x3lius.lyrics/v1` artifacts are refused.
  - `version` / `ruleVersion` are optional, present only for mix-report checks. The JSON-schema subset has no null, and a `canonical_prompts:<id>` ref already names one immutable version.
  - A Suno prompt's lyrics are derived (rendered from the lyrics artifacts), so a lyrics violation there persists and is escalated for a human to fix on the lyrics artifact.
  - `read_artifact` also returns `brief`, `parentId`, `critiqueId`, `contextRefs` and `knowledge`. `write_artifact` takes `critiqueId`.
  - Evaluation was the last Phase 7 stub. The stub handler stays as the fallback for a future sub-domain; its Phase 7 proofs run on a registry double, and the Phase 9 "still a stub" list is empty.
  - The Phase 11 TRACE fixture moved to `tests/helpers/trace-fixture.ts`, shared with Phase 12.
- **Open flags (F30):**
  - Escalation decisions are only recorded until the Phase 15 API and Phase 16 UI.
  - Revision makes no structural edits.
  - Take scoring waits on Phase 14's TRACE analysis.
  - The Critic and Revision have not run against a live model.
  - The Phase 3 ranking test still fails on this machine until PR #7 merges (test-only fix).
- **Next phase needs (13):**
  1. Records ops (catalog, releases, rights splits) is the F10 decision still open. Its "Knowledge/Execution" agents need the same single-class split Phase 11 used.
  2. Records ops capabilities (catalog, rights) are undefined. Add them to the matrix in `core/tool-registry/capabilities.ts` and `docs/AGENT_CLASSES.md` in Phase 13, never implicitly.
  3. `approval_queue` now carries two item types. Governance and the Phase 15 API must render `critique_escalation` requests (reason, version chain, counts per pass).
  4. F14 auto-approve can now fire from Critic-scored experiments. Watch the first auto-approvals.
  5. The Critic's code checks are a table keyed by claim topic (`records/x3lius/evaluation/checks.ts`). A Records rule with a structured value (e.g. split percentages summing to 100) is a new row there, not a new checker.
