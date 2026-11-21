# XYP3RN OS 3.0 — JARVIS Core, Task Orchestrator & Workflow Engine

Phase 08 architecture and operational specification covering central orchestration (`Os3JarvisCore`), dependency-graph execution (`Os3Orchestrator`), Vault-canonical YAML workflows (`Os3WorkflowEngine`), and the vendor-agnostic DAW Brain delegation contract (`DawDelegationCoordinator`).

---

## 1. JARVIS Core (`core/gateway/os3-jarvis-core.ts`)

`Os3JarvisCore` orchestrates every directive through explicit stages:

1. **Request Interpretation & Intent Classification (`classifyRequest()`):**
   Classifies directives into `workflow`, `agent`, `daw`, `context`, `approval`, or `status`, resolving the target `Domain`, domain/explicit `AgentDefinition`, canonical `WorkflowDefinition`, or `DawDelegationAction`.
2. **Task Decomposition, Permission Verification & Execution Planning (`decomposeAndPlan()`):**
   Builds an inspectable `JarvisExecutionPlan` containing ordered `JarvisDecomposedTask` steps (`context_retrieval` -> `permission_verification` -> dispatch -> optional `human_escalation` -> `result_aggregation`), plus a `permissionVerdict` (`allowed`, `actorClass`, `authorizedTools`, `deniedTools`, `requiresHumanApproval`).
3. **Context Retrieval:** Retrieves ranked Obsidian context via `Os3ContextEngine.retrieveContext()`, plus `retrieveDawContext()` for `daw` intents.
4. **Dispatch & Monitoring:** Propagates a unique `correlationId` (`corr-<uuid>`) into `Os3WorkflowEngine`, `Os3Orchestrator`, or `DawDelegationCoordinator`, recording `jarvis.classified`, `jarvis.workflow.*`, `jarvis.agent.*`, and `jarvis.daw.*` telemetry alongside `JarvisMonitoringTelemetry` (`startedAt`, `completedAt`, `durationMs`, `eventsLogged`).
5. **Human Escalation & Result Aggregation:** Returns explicit `approvalRecord` on `awaiting_approval` gates (never self-approved) and compiles `aggregatedSummary`.

---

## 2. Task Orchestrator (`core/orchestrator/os3-orchestrator.ts`)

`Os3Orchestrator` executes bounded agent graphs (capped by `MAX_ORCHESTRATION_STEPS = 32`):

- **Execution Modes:** `executeSingleAgent()`, `executeSequential()`, `executeMultiAgent()`, and dependency-resolved `executeDag()`.
- **Dependency Graph (`executeDag`):** Validates unknown `dependsOn` refs and rejects cycles before starting; dispatches ready dependency waves concurrently; skips dependents if an upstream step is skipped.
- **Reliability & Traceability:**
  - `correlationId` propagated into `Os3AgentExecutionContext`, `agent_runs`, and `runtime_events` (`orchestrator.task.started | retrying | completed | recovered | failed | cancelled | deduplicated`).
  - `idempotencyKey` deduplication returns cached completed results cleanly (`deduplicated: true`) without re-executing handlers.
  - Per-step `timeoutMs`, `maxRetries`, `retryBackoffMs`, `AbortSignal` cancellation, and `fallbackOutput` recovery.

---

## 3. Workflow Engine & Schema (`core/workflow-engine/os3-workflow-engine.ts`)

Canonical workflow definitions live inside Obsidian Vault (`05_WORKFLOWS/` and `05_WORKFLOWS/DEFINITIONS/*.workflow.yaml`) and can be loaded from `definitionsDir` or directly via `Os3WorkflowEngine.loadFromVault(vault, vaultPath)`.

### Workflow DSL Schema (`OS3_WORKFLOW_SCHEMA` — `xyp3rn.workflow-dsl/v3`)

Top-level keys: `id` (optional), `version` (optional integer >= 1), `name` (kebab-case), `description`, `input` (`required`, `optional`), `steps`, `output`.

Step keys:
- `id` (`[a-z][a-z0-9_-]*`) and `agent` (must resolve in `Os3VaultAgentRegistry`)
- `dependsOn`: acyclic upstream step IDs (all `$from: "steps.<id>.output..."` references must target upstream dependencies)
- `tools`: optional allowlist subset of `agent.tools`
- `tool` + `toolArgs`: optional first-class direct invocation of a registered `Os3ToolRegistry` tool executed through `tools.execute()` under `agent.class` permission checks and recorded in `agent_runs`
- `input`: static mapping or `{ $from: "input.*" | "steps.<id>.output.*" }` bindings (rejects `__proto__`, `constructor`, `prototype`)
- `when`: conditional branching (`$from`, `equals`, `notEquals`, `exists`)
- `approvalGate`: `{ itemType, reason }` pausing at `awaiting_approval` and queueing SQLite `pending_approvals`
- `retryPolicy`: `{ maxRetries, backoffMs }`
- `timeoutMs` & `onError`: `'fail' | 'fallback' | 'continue'` + optional `fallbackOutput`

Execution outputs include `aggregation` (`correlationId`, `totalSteps`, `succeededSteps`, `failedSteps`, `skippedStepsCount`, `awaitingApprovalSteps`, `totalAttempts`).

---

## 4. Vendor-Agnostic DAW Brain Delegation Contract (`core/orchestrator/daw-delegation-contract.ts`)

JARVIS delegates DAW requests exclusively through `DawBrainDelegate` + `DawDelegationCoordinator`, never calling vendor-specific FL Studio / REAPER APIs directly:

- **Supported Actions (`DawDelegationAction`):** `observe`, `inspect_session`, `inspect_tracks`, `inspect_routing`, `discover_plugins`, `inspect_parameters`, `analyze_audio`, `validate_project`, `propose_patch`, `prepare_patch`, `execute_patch`, `rollback_patch`.
- **Security & Policy Gates Before Delegation:**
  1. **Vendor Isolation Guard:** Rejects payloads containing raw vendor keys (`flStudioRawSysEx`, `rawMidiPort`, `directMidiSend`, `reaperRawReaScript`, `directHostBinaryExec`, `rawShellCommand`, `directFlpWrite`, `vendorRawApi`) with `SECURITY_VENDOR_COUPLING_FORBIDDEN`.
  2. **Permission Check:** Verifies `actorClass` against matching contracts in `DAW_TOOL_CONTRACTS` and `Os3ToolRegistry`.
  3. **Lease & Approval Enforcement (for `execute_patch` / `rollback_patch`):** Requires a non-expired, non-revoked SQLite `daw_session_leases` row covering the required tier plus a human-approved `pending_approvals` row (automatically queueing an `awaiting_approval` escalation when omitted and rejecting self-approval).
- **Typed Response (`DawDelegationResult`):** Always returns `correlationId`, `executionStatus` (`succeeded | awaiting_approval | denied | unsupported | unimplemented | failed`), `stateTier`, `capabilityInfo` (`capabilityId`, `dawToolContract`, `requiredTier`, `supportStatus`), `result`, and timestamped `evidence[]`.
