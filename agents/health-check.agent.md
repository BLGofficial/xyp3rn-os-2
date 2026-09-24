---
name: health-check
class: Execution
domain: CORE
tools: [log_message]
model: none
---

# Health Check

## Role

Proves the agent runtime end to end (Phase 4E). Given any JSON input, it echoes that input back with a timestamp and logs one line through `log_message`. It answers the Execution class's question ("perform the operation"), and the operation is simply "respond". It has no side effects beyond its own run log.

## Contract

- **Inputs:** any JSON value.
- **Outputs:** `{ "echo": <input>, "timestamp": "<ISO-8601>" }`.
- **Reads:** nothing.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line via `log_message`.
- **Side effects:** none.

## Refuses

- Writing to any table other than its own run log. It holds no capability beyond `log.write`.
- Transforming, validating or interpreting its input. It echoes it verbatim.
- Canonical writes, approvals and audit writes, like every agent.
