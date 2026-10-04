# Jarvis agent integration — ordered implementation prompts

Use this pack inside **`C:\Users\blago\Desktop\oss2\xyp3rn-os-2-engine`**, the target repository root. Paste Prompt 00 once, then Prompts 01–09 in order. Each prompt is a bounded implementation task; finish its acceptance checks before advancing. In a new session, paste Prompt 00 plus the next unfinished prompt. Reuse passed checks unless inputs changed.

The audited source has 43 agents; target already has 51, including 41 source names. Intended result: **all 43 source identities supported through the target architecture, all 10 target-only agents preserved, 53 total definitions, one skipped template**. Existing target-only stubs remain honestly labelled. Integration means usable contracts, execution, persistence and Jarvis access, not file-count parity alone.

| Prompt | Outcome | Depends on |
|---|---|---|
| 00 | Shared execution contract | — |
| 01 | Fresh baseline and per-agent coverage matrix | 00 |
| 02 | Shared-agent and provider compatibility settled | 01 |
| 03 | Narrow governance storage migration | 02 |
| 04 | Two governance agents integrated and tested | 03 |
| 05 | Research roster and grounded execution verified | 04 |
| 06 | Creative, Records and Tech paths verified | 05 |
| 07 | Real agent visibility and governance controls in Jarvis | 06 |
| 08 | Regression, migration and browser acceptance | 07 |
| 09 | Live acceptance and operational handoff | 08 |

## Prompt 00 — execution contract

```text
You are integrating the source OS agents into my already-built Jarvis OS.

SOURCE (read-only): C:\Users\blago\Desktop\oss2\xyp3rn-os-2
SOURCE AGENTS: C:\Users\blago\Desktop\oss2\xyp3rn-os-2\agents
TARGET (implementation workspace): C:\Users\blago\Desktop\oss2\xyp3rn-os-2-engine
TARGET AGENTS: C:\Users\blago\Desktop\oss2\xyp3rn-os-2-engine\agents

Read applicable AGENTS.md instructions and these target documents:
- docs/agent-integration/AUDIT.md
- docs/agent-integration/INVENTORY.md
- docs/agent-integration/audit-snapshot.json
- docs/agent-integration/PROMPTS.md

Treat the audit as a dated baseline; verify files before changing them. Source agents provide intended responsibilities. Target code, schema, working contracts, authentication and approvals govern integration mechanics. Never bulk-copy agents, migrations, runtime directories, UI or package files from source. These are divergent Git worktrees.

Preserve the existing single registry, dispatcher, capability matrix, workflow engine, provider layer, context engine, promotion gate, Vault and Jarvis UI. Extend their owners. These Markdown files are OS contracts, not automatically Claude Code subagents. Do not create 53 skill wrappers or a parallel orchestration system.

Expected scope: retain 41 shared identities using target-compatible contracts; integrate governance-legal and governance-rights-conflict; preserve all 10 target-only identities. Final expected count is 53 agents plus a skipped template, unless a fresh audit identifies legitimate intervening changes. Account for every source identity by name, not count alone.

Default provider policy: preserve target model refs. LLM_ENGINE=claude-code only changes Anthropic refs; it does not move OpenRouter agents to Claude. Report effective provider honestly. A provider migration requires an explicit separate instruction; never invent a model ID or silently fall back to paid routes.

Preserve target human approval boundaries. Agents may flag metadata or proposed claims, never grant legal clearance, accept ownership, approve releases, promote canonical knowledge or decide approval-queue items on their own. Preserve append-only history, source/run provenance and strict JSON validation. Do not grant broader capabilities to make tests pass.

Inspect status, branch and worktrees first. Preserve unrelated work; no reset, clean, force-push, commits, PRs or deployment unless requested. Use npm.cmd/pnpm.cmd on Windows. Never print credentials or full environment files.

Work one numbered prompt at a time. Create docs/agent-integration/STATUS.md and update it after every prompt with files changed, exact checks, pass/fail/skipped, remaining limitations and next prompt. Keep a per-agent coverage matrix linked to evidence. Already-complete requirements should produce verification, not rewrites.

For tests, use isolated disposable databases after verifying the configured host/database and existing test helper behavior. Never run destructive test helpers against owner data. Do not auto-approve records, submit external generations or operate the owner's release calendar for verification. Use test fixtures and manual/dry paths where supported.

If a prerequisite is missing, finish independent work and record the exact blocked acceptance check. Do not mark the phase or integration complete with required checks unproven. Ask only for a genuine unresolved policy choice, necessary missing access or an action requiring authorization. Stop after the requested prompt with a concise evidence-based handoff.
```

## Prompt 01 — refresh the audit and prove the baseline

```text
Execute Prompt 01 under the shared execution contract. Audit first; do not change runtime behavior.

1. Verify source and target roots, current branches/commits, worktree relationship and dirty files. Recompute agent inventory, including templates and nested folders. Compare raw bytes and content with only the model field normalized. Preserve the original audit snapshot as dated evidence; write a new snapshot if it changed.
2. Read target core/agent-registry/{parse-agent-file,registry}.ts, core/runtime/{handlers,programs,tools}.ts, core/orchestrator/{dispatch,orchestrate,ask}.ts and core/tool-registry/{registry,capabilities}.ts. Trace how CLI and apps/web/server/runtime.ts obtain these dependencies.
3. Build docs/agent-integration/COVERAGE.md: one row per source agent and target-only agent; class/domain; source/target disposition; deterministic handler or LLM program; declared tools and authorization; input/output schema; storage/role dependencies; workflow or direct entrypoint; Jarvis access path; fixture test; live evidence; blocker. Distinguish definition-valid, statically-wired, fixture-verified and live-verified. Record stubs explicitly.
4. Run agents:validate. Check every definition against actual executor maps and tool authorization. Use an existing checker if available; otherwise add one small read-only verification script or test using existing registries, with no DB/provider calls. It must catch a missing deterministic handler, missing LLM program, missing tool, denied capability and missing source identity. Do not infer readiness from names or counts.
5. Establish focused baseline: registry, authorization, scope selection and Claude transport tests. Inspect DB test setup before using it. Record existing failures distinctly from integration regressions.

Acceptance: complete fresh inventory; zero unexplained duplicates; all 43 source identities accounted for; 10 target-only identities protected; mismatch report for the two missing agents and five changed contracts; baseline evidence and STATUS.md written. No source files changed.
```

## Prompt 02 — reconcile shared agents and effective providers

```text
Execute Prompt 02. Reuse target behavior; repair only demonstrated inconsistencies.

1. Verify the 16 identical shared agents need no file changes. Confirm the 20 Research specialists differ only in model. Keep their target scopes, grounded-evidence program and current model refs.
2. Inspect target handlers, schemas, workflows and callers for records-catalog, records-rights-splits, records-release-calendar, suno-submitter and tech-r-and-d. Retain target operation envelopes, verified rights-run scheduling, Suno package readiness, owner ratings and evidence-backed R&D. Document source-to-target payload mappings and any intentionally superseded source behavior. Do not reintroduce read_release/propose_schedule/flag_release/propose_rd_backlog to imitate obsolete contracts.
3. Verify each model ref parses through core/llm/providers.ts; list configured ref and effective transport with LLM_ENGINE unset and set to claude-code. Check configuration presence as booleans only. Separate syntactic model validity from live provider availability. Keep deterministic agents at model:none. Do not edit credentials or provider policy.
4. Review malformed frontmatter, unknown keys, missing sections and Windows line endings. Only add CRLF normalization if an actual parser/copy issue is demonstrated; preserve strict unknown-key rejection.
5. Confirm target-only agents and the package/Vault/catalog flows retain their definitions and registrations. Do not touch package versions, lockfiles or branding.

Acceptance: shared-agent contract decisions recorded, target call sites remain compatible, no provider silently changed, static runtime coverage passes for all existing 51 agents, relevant focused tests pass. If nothing needs changing, finish with verified evidence instead of manufactured diffs.
```

## Prompt 03 — add minimal governance persistence

```text
Execute Prompt 03. Implement only the database support required by the two missing governance agents.

Read source governance/rules.ts, governance/tools.ts and the governance_flags portions of supabase/migrations/20260925130000_governance.sql. Read the target schema, migration runner, RLS/grants, audit implementation and governance/approvals.ts before designing the port.

Critical incompatibilities:
- The source governance migration version 20260925130000 is already used by target service_role_read_only. Use a new unique 14-digit version after the target's latest migration, with its matching rollback; never rename or edit an applied migration.
- Target splits are versioned; current_rights_splits exposes the current set and payee NULL means unassigned. Never import source rights tables or UNASSIGNED conventions.
- Source migration also rewrites authentication, approvals and global audit behavior. Do not import those unrelated changes. Target authentication stays intact.

Implement the smallest target-native storage for immutable governance results: real reviewed-object reference, legal/rights kind, actual agent run ID, structured result and timestamp. Reuse an existing suitable table if one exists after reinspection. Enforce valid references/run provenance to the extent supported by the target's database conventions. Do not allow orphan or forged successful review records.

Use least-privilege role access: read only the necessary source/artifact/current-split data; append review results; no rights mutations, canonical writes, release transitions or approval decisions. Retain RLS and service_role restrictions. Extend existing auditing narrowly if required; do not replace the global audit function from source or fabricate historical actor IDs.

Test migration up/down/up only on a verified disposable database. Test append-only protection and denial of update/delete/truncate or other bypasses, forbidden-role access, missing references and required provenance. Verify existing Records, Vault, Studio and approval contracts still work. Rollback may delete review data only in the disposable test; document data-preserving operational rollback separately.

Acceptance: additive migration plus rollback, isolated database proof, minimal grants, unchanged target auth/approval policy, no migration version collision. No owner database migration without a reviewed rollout and appropriate authorization.
```

## Prompt 04 — integrate both governance agents

```text
Execute Prompt 04 after governance storage passes its gate.

Implement governance-legal and governance-rights-conflict using the source behavior adapted to target contracts. Add their .agent.md definitions directly under target agents/. Use deterministic model:none, class:Governance, domain:GOVERNANCE and only required declared tools. Update target core/runtime/handlers.ts and core/runtime/tools.ts; do not replace these files wholesale.

Legal review:
- Exactly one valid sourceId or artifactId; reject malformed IDs, invalid shapes, both/neither and missing objects.
- Read recorded metadata from the target's actual source/artifact structure; do not invent missing permission data.
- Preserve named checks license.required, license.commercial, attribution.required, consent.required; validate field types and report every check.
- Persist real object/run provenance. Missing metadata must not become legal clearance. A clean rule result means no detected metadata-rule violation only; do not claim rights ownership or verify consent from a string alone.

Rights conflict:
- Validate trackId, trimmed nonempty payee and finite percentage in (0,100].
- Read current_rights_splits or the target's existing current-set reader. NULL payees are unassigned and must never be lowercased. Ignore historical versions when computing current totals.
- Define a proposal for an existing payee as its proposed replacement allocation; a new payee adds a claim. Preserve named existing-claim and overallocation checks. Reuse target decimal/percentage conventions to avoid rounding errors.
- Return checked rules, flags, proposed claim, current split version/totals and accepted:false. A conflict-free claim still requires human review. A track with no split set must be explicit in the result; it is not approved ownership.
- Persist review only. Never write splits or schedule releases.

Dispatch through the real dispatcher and tool authorization using isolated fixtures. Test: malformed inputs, both/neither legal IDs, missing objects, invalid metadata types, all legal rules, missing/current/revised split sets, null payee, same-payee changed allocation, new-payee overallocation, fractional percentages and no-conflict requires-human-review. Confirm reviewed rows unchanged, review history append-only, run closes success/error correctly, denied capabilities remain denied. A successful run may legitimately contain flags.

Acceptance: both agents execute through CLI/runtime dependencies, reviewed-object and run links resolve, permissions enforced, focused tests pass, 53 target definitions validate with one skipped template. Update coverage without claiming live-provider proof.
```

## Prompt 05 — verify the complete Research roster

```text
Execute Prompt 05. Research agents already exist; close coverage gaps without rewriting their system.

Use INVENTORY.md to verify all 20 Research specialist names against research-intelligence/specialists/program.ts, their Scope keywords and research-orchestrator. Inspect research-intelligence/entrypoint.ts, brief validation, fetch-source/write-evidence, synthesis and Findings Library paths.

Prove each specialist has the shared grounded-evidence program, correct allowed tools and one minimal valid fixture execution, reusing/extending tests/aos-04/specialist-program.test.ts and existing roster tests. Test per-name registration across all 20; test shared behavior once where repetition adds no evidence. Do not start all 20 live calls by default.

Verify scope selection with matched terms, selected/not-selected explanations and no-match behavior. Research input must preserve intended use, permitted URLs and owner selection where supported. Direct dispatch must not bypass required research-run/brief context. Fail clearly on missing context; do not fabricate a research run to claim success.

Check fetch boundaries, missing or unreachable sources, evidence quote/source validation, model-version tags, cancellation/timeouts and synthesis provenance. Research output must not become canonical automatically. Findings acceptance and canonical promotion remain distinct existing owner actions.

Trace the existing Jarvis Research interface through the same runtime. Verify results link to real run/evidence/findings records. Record provider prerequisites and a representative live acceptance command for the final prompt; fixture tests are not provider evidence.

Acceptance: 20/20 specialists and research-orchestrator have explicit coverage, no duplicate roster/program, no default all-agent fanout, evidence validation and approval boundaries intact, existing Research UI still connected.
```

## Prompt 06 — verify creative, Records and Tech workflows

```text
Execute Prompt 06. Complete the non-Research coverage matrix using existing code and tests.

Cover context-retriever, extractive-summarizer, health-check; all 12 source x3lius-* agents; records-catalog, records-rights-splits, records-release-calendar, suno-submitter and tech-r-and-d. Preserve all 10 target-only agents and their current implementation/stub status.

Trace and test dependency order rather than dispatching agents with invented generic requests:
- Context retrieval → deterministic cited summary; unknown or unresolved refs fail honestly.
- Song structure → complete lyrics and other creative artifacts according to existing workflow schemas; canonical context or explicit ungrounded choices; valid lineage/version links.
- Vocal DNA → Suno formula and RVC job spec; a returned job spec must not be described as rendered audio.
- Critic → Revision through the existing bounded controller; retain revision cap, stall escalation and no fabricated scores.
- Mix/Master uses TRACE-shaped measured input and canonical rubric; do not fabricate measurements.
- Existing Studio lyric/style/tag editing → build-suno-package → readiness gate → manual handoff/capture/rating. The legacy song-to-suno workflow may stop at a formula; do not claim that is a ready submission package or weaken approval requirements.
- Catalog lookup → registration, current split set → passing rights run → calendar. Reject forged/mismatched rights passes, unassigned shares and invalid transitions. Test only isolated releases.
- Frontier evidence → tech-r-and-d proposals; unverified proposals rejected, accepted writes remain queued for human decision. Do not build tech-products or tech-ai-systems merely to hide their documented stubs.

Reuse tests/phase-08 through phase-14 and tests/aos-01 through aos-04 as appropriate. Add focused regression cases only for uncovered integration risks. Verify each source agent's exact valid input/output contract and invocation path in COVERAGE.md. Keep side-effecting adapters stubbed/manual in automated checks; no real submission or release scheduling on owner data.

Acceptance: every source identity now has target wiring and meaningful fixture evidence or an explicit unresolved blocker; no duplicate implementations; immutable artifacts, human approvals and target-only features preserved. All blockers must be resolved before final integration completion.
```

## Prompt 07 — expose the integrated agents in the existing Jarvis UI

```text
Execute Prompt 07. Make the integrated roster discoverable and the new governance reviews usable inside my current Jarvis OS. Preserve layout, branding, voice behavior, accessibility and existing navigation.

Inspect apps/web/app/system/page.tsx, server/admin-loaders.ts, server/runtime.ts, app/action-kit.ts, lib/session.ts, existing run views, Ask tiers/skills and Research/Studio/Records actions. Reuse their patterns and authentication. This target uses a single-owner token session; do not assume source governance RBAC exists.

Add or extend the smallest existing agent directory surface (prefer System) backed by the runtime registry. Show all actual definitions, class/domain, responsibility, configured model/effective provider and supported invocation path. Clearly distinguish registered, configured, stub and last observed run status. Never infer live health from file presence or show synthetic activity. Avoid a second manually maintained roster.

Link agents to their existing domain workflows and real run records. Research specialists should enter the Research brief flow; dependent creative agents should enter Studio/workflow flows. Do not expose unrestricted arbitrary dispatch or tool execution from browser-supplied names/JSON.

For governance-legal and governance-rights-conflict, add authenticated server actions and explicit typed forms in an appropriate existing surface. Resolve supplied source/artifact/track IDs against real data, enforce input validation and existing request-origin/session protections server-side, and call dispatch with server-allowlisted agent names. Show checked rules, flags, reviewed object, current split version where relevant and run ID. No Approve/Clear/Accept ownership button: these actions perform reviews only.

Governance has no target natural-language entrypoint. Deliver working explicit review controls first. If adding Ask routing, use a narrow typed plan with required inputs and clarification; never guess IDs or percentages, bypass guards, or send missing context through a generic request. Preserve Tier 2 read-only behavior and the explicit Tier 3 trigger.

Registry is cached per process. Implement/use existing safe refresh or document/restart the correct target server, then verify its loaded roster includes both new agents. Do not terminate unrelated processes.

Acceptance: authenticated Jarvis shows the real complete roster; both governance reviews work through UI → dispatcher → tool → persisted result → visible run; unauthenticated/malformed requests fail; existing Research, Studio, Records, voice and tier routing retain behavior. Verify keyboard access, labels, focus/error states, desktop and narrow mobile views.
```

## Prompt 08 — regression and acceptance gates

```text
Execute Prompt 08. Validate integration as one system; fix integration regressions before proceeding.

1. Rerun agent definition/executor/tool coverage and identity-set comparisons. Expected final union: all 43 source names plus all 10 target-only names, 53 definitions, one skipped template. Verify source SHA-256 values unchanged; explain intentional target changes. Existing stubs remain labelled.
2. Run focused governance/routing/UI tests and existing regression suites for touched modules. Run tests/aos-00/single-kernel.test.ts and prerequisites.test.ts with their proper environment. Verify no duplicate kernel or broadened grants.
3. Run pnpm.cmd typecheck and pnpm.cmd web:build. Inspect actual scripts first; do not copy source Next commands into target. Run the full pnpm.cmd test suite against verified isolated test databases, with bounded concurrency if existing DB harness requires it. Capture exit codes and totals; no pipeline may hide a failing exit code.
4. Verify migration plan uniqueness, fresh database up, upgrade from target baseline and disposal-only rollback/up. Recheck target service_role restrictions, immutable result history, current-split semantics, audit links and existing approval functions. Do not use the owner database as a migration test.
5. Exercise running target UI: registry roster, legal metadata flagged/clean-rule cases, rights conflict/no-conflict/null/unassigned/current-version cases, research selection and result navigation, Studio package gate, catalog workflows, authentication failure and invalid inputs. Use fixtures, preserve real data, collect screenshots and run IDs. Check desktop and mobile plus keyboard operation. Existing graph/HUD should continue to load without synthetic agent state.

Record exact command, environment category, result and artifact location in docs/agent-integration/VERIFICATION.md. Separate static checks, fake-model tests, database proofs, browser checks and live-provider evidence. Record pre-existing failures with comparison evidence; do not label uninvestigated failures unrelated. Do not claim green completion when required gates fail or are skipped.

Acceptance: integration regressions fixed, all available required gates pass, evidence is reviewable, missing live prerequisites explicitly listed for Prompt 09. Report actual limits, not a fabricated 100% success score.
```

## Prompt 09 — live proof and final handoff

```text
Execute Prompt 09. Complete live acceptance and produce the final operator handoff.

Read STATUS.md, COVERAGE.md and VERIFICATION.md. Resolve remaining integration defects. Verify the intended target server, database and effective provider configuration without exposing secrets.

Run representative acceptance through the actual runtime with safe fixture data and available authorized providers:
- health-check with its real run row;
- legal and rights reviews through authenticated Jarvis controls, including persisted flags and matching object/run links;
- one narrow Research brief through selected specialist → evidence → synthesis, using an allowed source and its actual quote provenance;
- one small creative request through the configured model, yielding schema-valid persisted output with real refs;
- an existing Studio package preview/readiness check and a Records rights check on fixture data, without real external submission, owner approvals or production release transitions.

All 43 source identities require structural and fixture evidence; representative live runs verify shared provider/runtime paths. Do not imply every agent was live-run if only representatives were. Provider credentials, CLI login or owner-only approval steps unavailable to you remain explicit acceptance blockers; do not bypass them, invent data or replace a live test with a mock while calling it live. Complete independent handoff work while access is pending.

Write docs/agent-integration/HANDOFF.md containing:
- source/target revisions and final coverage counts;
- per-agent mapping with links to actual handlers/programs/tools and tests;
- two added governance agents and retained target contract decisions;
- exact target start/restart, registry validation and verification commands;
- required configuration variable names, effective provider behavior and secret-safe setup notes;
- Jarvis locations and valid minimal examples for both new review actions;
- which checks used fixtures, which used a live database/provider/browser, and proof/run IDs;
- documented target-only stubs and any remaining limitations;
- rollout order: reviewed DB migration before dependent code, registry reload, post-start checks;
- rollback: revert only integration code/config, retain review/audit data, and use tested down migration only on disposable data or after explicit authorization and backup. No force-reset or history deletion.

Run final diff/status checks. Ensure source unchanged and unrelated work preserved. Mark integration COMPLETE only when all required acceptance gates have actual evidence; otherwise mark the precise remaining stage BLOCKED, identify what is needed and do not claim all agents operational. Do not commit, push or deploy unless requested.
```

## Completion criteria

The migration is complete when every source identity has a supported target contract, registered executor, authorized tools, tested dependency path and a documented Jarvis invocation path; the two new governance agents persist traceable reviews; all 10 target-only identities and existing approval boundaries are preserved; regression gates pass; and representative live acceptance is recorded. A folder copy, a passing Markdown parser, a 53-agent count or a green UI badge alone does not meet this bar.
