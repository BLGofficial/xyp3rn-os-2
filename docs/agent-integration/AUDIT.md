# Source agents → Jarvis OS: integration audit

Audited 2026-10-03. This delivery contains documentation only; agent definitions, runtime code, database and provider configuration were not changed.

## Result

Jarvis already contains 41 of the 43 source agents. Integrate the two missing governance agents with their dependencies; preserve the target's newer implementations. A folder overwrite would break contracts and tool authorization.

| Item | Verified result |
|---|---:|
| Source definitions, excluding template | 43 |
| Target definitions, excluding template | 51 |
| Byte-identical shared agents | 16 |
| Shared agents differing only in model | 20 |
| Shared agents with contract differences | 5 |
| Source-only agents | 2 |
| Target-only agents | 10 |
| Intended final union | 53 |

Each directory also contains one skipped `_template.agent.md`. Source `New folder` is empty. The registry scans only the immediate directory; nested files would not be discovered.

Start with [PROMPTS.md](PROMPTS.md). [INVENTORY.md](INVENTORY.md) maps every source agent. [audit-snapshot.json](audit-snapshot.json) preserves per-file SHA-256, parsed source contracts, models, tools, differences and static target compatibility.

## Provenance and workspace boundaries

- Source: `C:\Users\blago\Desktop\oss2\xyp3rn-os-2\agents`; parent commit `528b1e2f3f5ba3928b6a306f03f7480004159b88`, branch `feat/claude-code-engine`.
- Target: `C:\Users\blago\Desktop\oss2\xyp3rn-os-2-engine\agents`; parent commit `252a5504689d9553bd7ab657a2cd9689571f4ef1`, branch `release/official-brand`.
- These are worktrees of the same Git repository, with divergent implementations. Directory names and shared ancestry do not establish contract compatibility.
- Both worktrees had pre-existing untracked files. Source: `.agents/`, `graphify-out/`. Target: `.agents/`, a generated image, `captures/`, two brand proof images, and `research-intelligence/.claude/`. Preserve them. This audit adds only `docs/agent-integration/`.

## Findings that determine the sequence

### 1. Definitions are contracts, not executable plugins

Target [registry](../../core/agent-registry/registry.ts) parses Markdown. [handlers](../../core/runtime/handlers.ts) map deterministic names to TypeScript; [programs](../../core/runtime/programs.ts) map LLM agents to programs; [tools](../../core/runtime/tools.ts) registers capabilities. [dispatch](../../core/orchestrator/dispatch.ts) checks every declared tool before execution and on each invocation.

All 51 target agents parse successfully, have a handler/program entry and pass declared-tool authorization against the constructed target registry. This is static wiring evidence. It does not prove runtime inputs, schema compatibility, provider availability, persistence or UI reachability. Target-only `tech-products` and `tech-ai-systems` deliberately use manifest stubs.

These files are OS agents. They are not automatically Claude Code subagents or skills. Do not copy them into `.claude/agents` or introduce an alternative runner to make them appear installed.

### 2. Two governance agents are absent, including their execution dependencies

Missing: `governance-legal` and `governance-rights-conflict`. Target has neither their handlers nor `check_legal` / `check_rights_conflict` tools. Source implementation lives in `governance/rules.ts`, `governance/tools.ts`, source runtime registrations, source governance migration and `tests/phase-15/governance.test.ts`.

Port the narrow metadata-review and conflict-check behavior. The source migration also installs authentication, approval, audit and projection changes; importing it wholesale would exceed the agent integration scope and conflict with the target architecture.

**Concrete schema incompatibility:** source conflict code reads all `rights_splits`, expects a non-null string payee and excludes literal `UNASSIGNED`. Target [Records migration](../../supabase/migrations/20260925110000_records_ops.sql) has versioned splits, nullable payees, and `current_rights_splits`. An unchanged port would double-count historical versions and can throw on `null.toLowerCase()`. Use the target's current-version semantics and handle null explicitly.

**Concrete migration collision:** source `20260925130000_governance.sql` shares its version with target `20260925130000_service_role_read_only.sql`. The [runner](../../core/db/migrate.ts) tracks applied migrations by version alone. Copying that source migration can silently skip it on an existing target database. Create a new, unique version after the target's latest migration, with its paired rollback.

Legal checks are recorded-metadata rules, not legal clearance. A nonempty consent or permission reference is not proof that the referenced permission is valid. Preserve that distinction in outputs and UI.

### 3. Five target contracts must win over their source counterparts

| Agent | Source → target difference | Integration decision |
|---|---|---|
| `records-catalog` | Direct registration with `read_release` → operation envelope, separate lookup agent, versioned splits, codes, people, credits, links, artwork, delivery | Keep target; prove existing callers/workflows |
| `records-rights-splits` | `read_release` / `flag_release`, `schedulable` output → `read_catalog`, run-linked verdict and named flags | Keep target output used by scheduling guard |
| `records-release-calendar` | Propose date into approval flow → explicit schedule/unschedule/release with verified passing rights run | Keep target behavior; do not resurrect source scheduling tables |
| `suno-submitter` | Submit `formulaArtifactId` / prompt artifact → `packageId`, approved lyric/style/tag versions, Vault capture and owner rating | Keep target package readiness gate |
| `tech-r-and-d` | Deterministic `propose_rd_backlog` → LLM Planning program over Frontier evidence with verified proposals | Keep target program and tools |

Loading all source definitions against target registrations exposes six agents with missing tools or executors: both governance agents, the three Records agents above, and `tech-r-and-d`. `suno-submitter` passes tool registration checks but still has an incompatible payload. Registration-only validation cannot detect this contract problem.

The user requested agent integration, not a change to Jarvis's release approval policy. If the source proposal-before-scheduling policy is also wanted, treat it as a separate explicit policy change.

### 4. Provider configuration differs from the engine name

All 20 source Research specialists use `claude-sonnet-5`; their target copies differ only by using `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`. Their roles, scopes and contracts match exactly. All 30 target LLM agents currently declare OpenRouter model refs.

Target [provider routing](../../core/llm/providers.ts) applies `LLM_ENGINE=claude-code` only to Anthropic model refs. OpenRouter agents still use the OpenRouter path. The Claude headless skill/deep-task layer does not automatically change the model used inside an OS agent.

Preserve target refs during this integration. If subscription-only execution is separately requested, validate a supported Claude model through the configured CLI, change the complete intended roster explicitly, and test effective routing. Neither model string availability nor live account access was verified here.

### 5. Preserve the target Jarvis surface and authentication

Target `apps/web` is its existing Next 15 / React 18 application; source root scripts describe a different Next 16 / React 19 arrangement. Do not copy source web code, package files or lockfiles.

Target [web runtime](../../apps/web/server/runtime.ts) constructs one cached OS runtime per process. Agent registry refresh is manual; updating files alone does not update an already-running server. Use an intentional restart or the existing refresh mechanism and verify the loaded roster.

Target [session](../../apps/web/lib/session.ts) and [action guard](../../apps/web/app/action-kit.ts) implement local single-owner authentication with `XYP_WEB_TOKEN`. The source's multi-role governance authentication is not installed here. Preserve the target guard; do not write prompts that assume source RBAC is present.

Target [entrypoints](../../core/orchestrator/orchestrate.ts) include Research, Records and Tech, but no Governance entrypoint. Missing governance agents need a real, guarded Jarvis invocation path. Use explicit typed inputs for source/artifact IDs and rights claims; keyword routing cannot safely invent these inputs.

Existing `/system` shows registry counts. A count is not evidence every agent can run. Prefer a small registry-backed agent directory and explicit review controls in existing UI over a new dashboard or 53 independent skill wrappers.

## Verification performed

1. Parsed all source and target definitions using the target's actual `loadAgents`: 43 and 51 accepted, zero failures, one template skipped in each.
2. Compared bytes and model-normalized content; computed SHA-256 per agent.
3. Imported actual target handler/program maps and constructed its tool registry with a database stub that throws if invoked. Checked executor lookup and tool authorization for every target and source definition. No database connections or tool handlers were executed.
4. Focused tests: **222 passed across three files**: `core/agent-registry/registry.test.ts` (also contains parser tests), `core/tool-registry/authorize.test.ts`, `research-intelligence/orchestrator/select.test.ts`.
5. Claude engine transport tests: **10 passed**, using the suite's fake CLI runner. This proves transport behavior, not a logged-in live model call.

Commands from target root:

```powershell
pnpm.cmd exec vitest run core/agent-registry/registry.test.ts core/tool-registry/authorize.test.ts research-intelligence/orchestrator/select.test.ts --reporter=dot
pnpm.cmd exec vitest run tests/claude-engine/claude-cli-transport.test.ts --reporter=dot
```

Not performed: full suite, typecheck, web build, DB migrations, database integration tests, live provider calls, live dispatch, browser acceptance, or implementation of the integration. The prompt sequence defines those gates. No agent is claimed newly installed by this documentation delivery.
