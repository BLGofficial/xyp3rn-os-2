# XYP3RN OS 3.0 — Agent Registry & Tool Registry

Phase 07 reference covering the OS 3.0 Vault-backed Agent Registry (`04_AGENTS/`), the Tool Registry, capability-based deny-by-default security, and the 9 future DAW Brain tool contracts.

## 1. Agent Registry (`core/agent-registry/os3-agent-registry.ts`)

`Os3VaultAgentRegistry` loads and validates all migrated Markdown agent definitions in `<vaultRoot>/04_AGENTS/` (seeded from the 52 OS2 `agents/*.agent.md` files by `provisionOs3Vault()`).

### Required Metadata & Preserved Sections

Every OS3 agent frontmatter (`xyp3rn.agent/v3`) supports and validates:

| Field | Contract |
| :--- | :--- |
| `id` | Stable unique ID (e.g. `agent-suno-researcher`), checked for duplicates across `04_AGENTS/`. |
| `name` | `kebab-case`, must match the filename stem. |
| `class` | Strictly one of the 8 classes in `core/contracts/taxonomy.ts`: `Research`, `Knowledge`, `Planning`, `Creative`, `Critic`, `Revision`, `Execution`, `Governance`. |
| `domain` | Strictly one of `CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`. |
| `model` | `none` for deterministic agents or `<provider>:<model>` (`openrouter:`, `anthropic:`, `groq:`). |
| `tools` | `snake_case` list resolved against `Os3ToolRegistry`; class permission violations are rejected at parse time. |
| `permissions` / `capabilities` | Normalized `Os3AgentPermissions` (`capabilities`, `reads`, `writes`, `allowedTools`, `denyByDefault: true`); any capability forbidden to `agent.class` by `CLASS_CAPABILITIES` is rejected. |
| `version` | Positive integer (`>= 1`). |
| `status` | Valid entity lifecycle state (`live`, `active`, `draft`, `approved`, `canonical`, `paused`, `retired`, `archived`, `superseded`); inactive agents (`retired`, `archived`, `superseded`, `inactive`) cannot run. |

Markdown body preservation (`parseOs3AgentFile()`):
- Required sections: `## Role`, `## Contract` (inputs, outputs, reads, writes, side effects), `## Refuses`.
- Preserved optional/explicit sections & normalized fields: `responsibilities`, `inputContract`, `outputContract`, `readPermissions`, `writePermissions`, `procedure` (`## Procedure` or derived execution bounds), `constraints` (`## Constraints` or read/write/scope bounds), `refusals`, `escalation` (`## Escalation` or Governance/human approval escalation), and `scope` (`## Scope`).

Hot reload:
- `Os3VaultAgentRegistry.hotReload()` validates the entire candidate directory before replacing the active snapshot; any malformed edit preserves the last valid in-memory registry snapshot.

---

## 2. Tool Registry (`core/tool-registry/os3-tool-registry.ts`)

Primary runtime registry: `Os3ToolRegistry` wrapping the single-kernel `createToolRegistry()` (`core/tool-registry/registry.ts`) and `CLASS_CAPABILITIES` (`core/tool-registry/capabilities.ts`).

Every registered `Os3RegisteredToolSpec` defines:
- **Identity & Description:** unique `id`, unique `snake_case` `name`, `category`, `version`, `description`.
- **Schemas (`inputSchema`, `outputSchema`):** typed primitive/array/object rules, optional `required`, `additionalProperties: false`, string length bounds, numeric `minimum`/`maximum`, `enum` values, and `disallowUnsafePathsOrShell`. Validated symmetrically on inputs before execution and outputs before returning.
- **Permissions (`permissions`):** governing `capability`, `allowedClasses` (verified subset of `CLASS_CAPABILITIES[capability]`), `vaultAccess` (`none` | `read` | `write`), `externalOperation`, `requiresHumanApproval`, and `defaultDeny: true`.
- **Execution Policy (`executionPolicy`):** `mode` (`local_pure` | `vault_scoped` | `external_bounded` | `contract_only`), `implemented`, `idempotent`, and hard-enforced `allowShell: false`, `allowUnrestrictedFs: false`, `allowDirectDaw: false`.
- **Timeout & Retry (`timeoutMs`, `retryPolicy`):** finite positive timeout and bounded retry count/backoff with optional `retryablePattern`.
- **Audit Policy (`auditRequired`, `auditPolicy`):** writes `tool.success`, `tool.denied`, `tool.timeout`, and `tool.error` events to SQLite `runtime_events` with sensitive key redaction.

Built-in active registry:
- `createOs3BuiltinToolRegistry()` registers the 39 canonical OS3 tools mapped to `VaultEngine` and `Os3ContextEngine`.

---

## 3. Future DAW Tool Contracts (`core/tool-registry/daw-tool-contracts.ts`)

Phase 07 defines typed **contract-only** tool specifications across all **9 mandatory DAW categories**, without implementing live DAW commands in this phase (`executionPolicy.mode = 'contract_only'`, `executionPolicy.implemented = false`):

1. `daw_observation`: `daw_observe_health`, `daw_observe_transport` (`observe`)
2. `session_inspection`: `daw_inspect_session_state` (`observe`)
3. `track_inspection`: `daw_inspect_mixer_tracks` (`observe`)
4. `routing_inspection`: `daw_inspect_routing_graph` (`observe`)
5. `plugin_discovery`: `daw_discover_plugins` (`observe`)
6. `parameter_inspection`: `daw_inspect_plugin_parameters` (`observe`)
7. `audio_analysis`: `daw_analyze_audio_buffer` (`analyze`)
8. `daw_command_execution`: `daw_prepare_command_patch` (`prepare`), `daw_execute_command_patch` (`execute`, `requiresHumanApproval: true`, `requiresActiveLease: true`), `daw_rollback_command_patch` (`rollback`)
9. `project_validation`: `daw_validate_project_file` (`analyze`)

Helper functions:
- `validateDawToolContractCoverage()` verifies coverage across all 9 categories and confirms `implemented: false` and unrestricted flags remain `false`.
- `createOs3ToolRegistryWithDawContracts()` creates a unified `Os3ToolRegistry` containing all 39 active OS3 tools + 12 DAW contract tools (invoking any contract-only tool throws `Os3ToolExecutionError` with `code: 'NOT_IMPLEMENTED'` and appends a `tool.denied` audit record).

---

## 4. Deny-by-Default Security Guarantees

- Unregistered tools, ungranted capabilities, narrowed `allowedClasses` mismatches, and human-only capabilities (`canonical.write`, `approval.decide`, `audit.write`) are denied by default.
- Attempting to register any tool with `allowShell: true`, `allowUnrestrictedFs: true`, `allowDirectDaw: true`, or an escalated `allowedClasses` entry throws immediately at registry construction.
- Input arguments matching path traversal (`..`, `\0`) or shell metacharacters on path-like keys are rejected before handler execution with `SECURITY_POLICY_VIOLATION` / `INVALID_TOOL_INPUT` and audited.
