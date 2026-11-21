# XYP3RN OS 3.0 + DAW Brain — Extensibility, Agent/Tool/Workflow & DAW SDK Guide (Phase 25)

This guide defines the engineering contracts for authoring new OS3 Agents, Tools, Workflows, and vendor-isolated DAW Adapters, and summarizes the mandatory DAW Safety controls.

---

## 1. Agent Development Guide (`xyp3rn.agent/v3`)

All OS3 agents live in `<VaultRoot>/04_AGENTS/<agent-name>.md` and are loaded by `Os3VaultAgentRegistry` (`core/agent-registry/os3-agent-registry.ts`).

### Required Frontmatter & Sections
- **Frontmatter (`schema: "xyp3rn.agent/v3"`):**
  - `id`: `"agt-<kebab-name>"`
  - `name`: `"<kebab-name>"` (must match filename `<kebab-name>.md`)
  - `title`, `domain` (`CORE` | `KNOWLEDGE` | `RESEARCH` | `RECORDS` | `TECH` | `GOVERNANCE`), `sector`: `"04_AGENTS"`
  - `class`: Exactly **one** of the 8 canonical classes (`Orchestration`, `Research`, `Knowledge`, `Creative`, `Critic`, `Planning`, `Execution`, `Governance`)
  - `status`: `"active"` | `"disabled"` | `"deprecated"`
  - `version`: integer `>= 1`, `model`: provider-prefixed tag or `"none"`
  - `tools`: array of registered snake_case tool names (every declared tool must be permitted for the agent's `class` by `CLASS_CAPABILITIES`)
  - `capabilities`, `input_contract`, `output_contract`, `read_permissions`, `write_permissions`, `approval_requirements`, `provenance`
- **Mandatory Markdown Headings:**
  - `## Responsibilities`
  - `## Context Requirements`
  - `## Operating Procedure`
  - `## Refusal Conditions`
  - `## Escalation Rules`
  - `## Evaluation Criteria`
- **Rule:** Do not create redundant agents when an existing specialist owns the capability; hot-reload (`registry.reload()`) atomically retains the last valid snapshot if any new file fails schema validation.

---

## 2. Tool Development Guide (`Os3ToolRegistry`)

Tools are registered in `core/tool-registry/os3-tool-registry.ts` (`Os3ToolSpec`).

1. **Naming & Capability Mapping:**
   - `name` must be lower `snake_case` (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`).
   - Every tool binds to a single governing `Capability` in `core/tool-registry/capabilities.ts` (`CLASS_CAPABILITIES[capability]` determines `allowedClasses`).
2. **Input & Output Schema Validation:**
   - Declare `inputSchema` and `outputSchema` (`required`, `properties`, `additionalProperties: false`).
   - Any file path or URI parameter must set `disallowUnsafePathsOrShell: true` and `maxLength: 512`.
3. **Execution & Audit Policies:**
   - Default-deny (`permissions.defaultDeny: true`).
   - Mutating Vault tools must route exclusively through `VaultEngine`; mutating DAW tools must route exclusively through `DawCommandGateway` (`Execution` class only).

---

## 3. Workflow Development Guide (`xyp3rn.workflow/v3`)

Workflows are YAML specifications stored in `<VaultRoot>/05_WORKFLOWS/DEFINITIONS/<name>.workflow.yaml` (and canonical domain sets in `core/daw-brain/workflows/daw-workflows.ts` and `research-intelligence/workflows/research-workflows.ts`).

1. **Structure:**
   - `id`, `version`, `name`, `description`
   - `input: { required: [...], optional: [...] }`
   - `steps`: DAG of `{ id, agent, tool?, toolArgs?, dependsOn?, condition?, retry?, fallbackOutput?, approvalGate? }`
   - `output`: bindings referencing `$from: steps.<stepId>.output...`
2. **Compile-Time Checks (`Os3WorkflowEngine`):**
   - Rejects unknown agents, undeclared tools on the step's agent, dependency cycles, unknown step references, and unapproved `approvalGate` transitions.

---

## 4. DAW Adapter SDK Guide (`DawAdapter`)

Vendor-specific DAW integrations live under `core/daw-adapters/<vendor>/` and implement `DawAdapter` (`core/daw-brain/daw-adapter-sdk.ts`). **Zero vendor code is permitted inside `core/daw-brain/`.**

### Required `DawAdapter` Methods
1. `manifest`: `{ adapterId, displayName, hostKind, adapterVersion, supportedHostVersions, transportKind, isSimulated }`
2. `discover()`: Probes host binaries, running processes, and transport ports without throwing when the DAW is absent (`reachable: false`).
3. `connect(options)`: Verifies host version compatibility (`DawVersionManager`), opens transport in **`connected_read_only`** (`observe` tier), and returns initial `DawStateSnapshot`.
4. `disconnect(sessionId)` & `healthCheck(sessionId)`: Updates reachability and marks session `stale: true` on disconnect without discarding `cached` state.
5. `getCapabilities()`: Returns honest `DawCapability[]` (`SUPPORTED`, `READ_ONLY`, `EXPERIMENTAL`, `UNSUPPORTED`, `UNKNOWN`) with accurate `rollbackSupported` flags.
6. `observe(sessionId)` & `subscribe(sessionId, listener)`: Normalizes host state into `DawStateSnapshot` using `DawAvailability<T>` (`available`, `unavailable`, `unsupported`, `unknown`) — never fabricating empty arrays for unsupported host features.
7. `validateCommand(command, snapshot)` & `execute(command, snapshot)`: Validates target existence and executes only verified capabilities.
8. **Contract Conformance:** Every adapter must pass `validateAdapterContract(adapter)` and the shared cross-DAW conformance suite in `tests/os3-phase17-reaper-multi-daw/reaper-and-multi-daw.test.ts`.

---

## 5. DAW Safety Guide (`DawCommandGateway`)

Every DAW command passes through the **11-stage Command Gateway lifecycle** (`core/daw-brain/daw-command-gateway.ts`):

1. **Request & Correlation ID:** Unique `commandId` and `correlationId`.
2. **Capability Verification:** Must be `SUPPORTED` by the active adapter and present in `permittedCapabilities` (`daw.transport.control`, `daw.mixer.fader_pan_mute`, `daw.plugin.bypass` initial allowlist; `ALWAYS_PROHIBITED_COMMAND_KINDS` always blocked).
3. **Input & Safety Range Validation:** Fader step clamped to `[-60, +3.0 dB]`, Master Bus ceiling `<= 0.0 dBFS`, pan `[-1.0, +1.0]`, tempo `[20, 300 BPM]`, unattended `recording: true` blocked.
4. **Permission & Lease Check:** Requires `requestedClass === 'Execution'`, an active unexpired human `DawSessionLease` covering `targetRef`, and verified DAW instance & project identity (`verifyDawInstanceIdentity`, `expectedProjectId`/`Path`/`Sha256`).
5. **State Freshness & Drift Check:** Rejects stale or offline sessions (`DAW_STALE_STATE`, `DAW_HOST_OFFLINE`) and aborts if `targetRef` drifted between `prepare` and `execute` (`DAW_TARGET_DRIFT`).
6. **Risk Classification & Dry-Run Diff:** Computes side-effect-free `before -> after` `DawStateDiffEntry[]` and `rollbackSupported` truth.
7. **Human Approval (`F35-D2`):** Proposer and agent identities (`AGENT_OR_SYSTEM_ACTOR_RE`) cannot approve commands (`403 SELF_APPROVAL_FORBIDDEN`). Non-rollback operations require `human_strong` confirmation. Single-use approval IDs cannot be replayed (`DAW_APPROVAL_REPLAY`).
8. **Execution, Postcondition Readback, Audit & Rollback:** Verifies live postcondition readback (`DAW_POSTCONDITION_FAILED` triggers automatic compensating rollback when supported), persists an immutable `daw_commands` receipt + `daw.command.executed` event, and supports single-shot `rollbackCommand()`.
