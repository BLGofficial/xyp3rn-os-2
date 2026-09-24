---
# Canonical shape every agent file extends. Copy to agents/<name>.agent.md.
# Files prefixed "_" are templates: the Agent Registry (Phase 4B) reports them
# as skipped-template, it never loads or runs them.
#
# name   kebab-case, must equal the filename stem (suno-researcher.agent.md -> suno-researcher)
# class  exactly one of: Research | Knowledge | Planning | Creative | Critic | Revision | Execution | Governance
# domain exactly one of: CORE | KNOWLEDGE | RESEARCH_INTELLIGENCE | RECORDS | TECH | GOVERNANCE
# tools  Tool Registry names (snake_case). Deny-by-default: anything unlisted or unregistered is refused,
#        and each tool's capability must be allowed for `class` (docs/AGENT_CLASSES.md matrix).
# model  model id for LLM-backed agents (e.g. claude-sonnet-5), or `none` for deterministic agents.
# No other keys. The registry rejects unknown keys, so a typo never silently disables a field.
name: _template
class: Execution
domain: CORE
tools: []
model: none
---

# Agent Title

## Role

One paragraph: what this agent does, for which caller, inside which domain. State the one question from its class it answers.

## Contract

- **Inputs:** exact JSON shape the dispatcher passes in.
- **Outputs:** exact JSON shape returned. Structured objects, never prose-only blobs.
- **Reads:** tables and services it queries (Context Engine, specific tables).
- **Writes:** tables it writes. Must be a subset of its class's allowed outputs.
- **Side effects:** external calls, or `none`.

## Refuses

- Every class-level "forbidden to mutate" item that applies, restated in this agent's own terms.
- Agent-specific refusals, e.g. asserting a claim with no `research_sources` row backing it.
