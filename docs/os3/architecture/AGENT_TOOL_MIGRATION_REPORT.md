# XYP3RN OS 3.0 — Agent & Tool Registry Migration Report (Phase 7)

## 1. Migration Overview

- **Source of Truth (OS2):** `agents/*.agent.md` (52 active agent definitions + `_template.agent.md`).
- **Canonical Destination (OS3):** `<VaultRoot>/04_AGENTS/<name>.md` (52 validated agent definitions; 11 specialist researchers mirrored to `03_RESEARCH_INTELLIGENCE/SPECIALISTS/`).
- **Preserved Agent Classes (8):** `Research`, `Knowledge`, `Planning`, `Creative`, `Critic`, `Revision`, `Execution`, `Governance`.
- **Preserved Functional Domains (6):** `CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`.
- **Registered Canonical Tools:** 39 tools in `core/tool-registry/os3-tool-registry.ts`.

---

## 2. Documented Contract Extensions (OS2 -> OS3)

All 52 existing OS2 agent definitions preserve their exact `name`, `class`, `domain`, `model`, `tools`, and Markdown sections (`## Role`, `## Scope`, `## Contract`, `## Refuses`). The following additive contract fields were introduced for OS3 Vault compatibility:

| Contract Element | OS 2.0 (`agents/*.agent.md`) | OS 3.0 (`04_AGENTS/*.md`) | Reason for Extension |
|---|---|---|---|
| `schema` | *(none)* | `"xyp3rn.agent/v3"` | Enforces versioned schema validation across the Obsidian Vault. |
| `id` | *(implicit from `name`)* | `"agent-<name>"` | Provides globally unique, immutable entity ID across all 12 Vault directories. |
| `capabilities` | *(derived at runtime)* | Explicit `capabilities: [...]` list | Satisfies `xyp3rn.agent/v3` schema validation and explicit capability auditing. |
| `responsibilities` | `## Role` Markdown section | Preserved in `## Role` + mirrored in frontmatter `responsibilities` | Enables fast structural index queries without re-parsing Markdown sections. |
| `input_contract` / `output_contract` | `- **Inputs:**` / `- **Outputs:**` in `## Contract` | Preserved in `## Contract` + extracted into `input_contract`, `output_contract` | Structured contract inspection in `Os3VaultAgentRegistry`. |
| `read_permissions` / `write_permissions` | `- **Reads:**` / `- **Writes:**` in `## Contract` | Preserved in `## Contract` + extracted into `read_permissions`, `write_permissions` | Explicit read/write boundary auditing. |
| `refusals` | `## Refuses` Markdown section | Preserved in `## Refuses` + extracted into `refusals` | Explicit refusal contract inspection. |
| Tool Storage Backend | PostgreSQL role-scoped SQL (`xyp_research`, `xyp_vault`, etc.) | `VaultEngine` + `Os3ContextEngine` + `SqliteRuntimeDb` | Eliminates PostgreSQL/Supabase dependency while enforcing path safety, No-Overwrite Guard, and audit logging. |

---

## 3. Registered Tool Matrix (39 Tools)

All 39 tools declared across the 52 agents are registered in `core/tool-registry/os3-tool-registry.ts` with input/output schemas, capability checks, timeouts, retry policies, and `runtime_events` auditing:

| Tool Name | Capability | Allowed Classes | Vault Access | External Op |
|---|---|---|---|---|
| `retrieve_context` | `context.read` | All 8 classes | `read` | No |
| `retrieve_claims` | `context.read` | All 8 classes | `read` | No |
| `log_message` | `log.write` | All 8 classes | `none` | No |
| `fetch_source` | `web.read` | `Research` | `write` | Yes |
| `write_evidence` | `research.write` | `Research` | `write` | No |
| `read_frontier_evidence` | `research.read` | `Planning` | `read` | No |
| `write_rd_backlog` | `plan.write` | `Planning` | `write` | No |
| `write_artifact` | `artifact.write` | `Creative`, `Revision` | `write` | No |
| `read_artifact` | `artifact.read` | `Creative`, `Critic`, `Revision`, `Execution`, `Governance` | `read` | No |
| `write_critique` | `critique.write` | `Critic` | `write` | No |
| `read_critique` | `critique.read` | `Critic`, `Revision`, `Governance` | `read` | No |
| `read_catalog` | `catalog.read` | `Knowledge`, `Governance` | `read` | No |
| `resolve_take` | `catalog.read` | `Knowledge`, `Governance` | `read` | No |
| `add_person` .. `record_delivery` (12 tools) | `catalog.write` | `Execution` | `write` | No |
| `record_trace_analysis`, `link_trace_report` | `trace.write` | `Execution` | `write` | No |
| `read_vault_file` | `vault.read` | `Knowledge`, `Creative`, `Execution` | `read` | No |
| `register_vault_file` .. `unlink_song` (6 tools) | `vault.write` | `Execution` | `write` | No |
| `write_task`, `move_task` | `task.write` | `Execution` | `write` | No |
| `rate_take` | `feedback.write` | `Execution` | `write` | No |
| `submit_suno`, `capture_suno_takes` | `external.execute` | `Execution` | `write` | Yes |
