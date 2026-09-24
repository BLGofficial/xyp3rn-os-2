---
name: research-orchestrator
class: Planning
domain: RESEARCH_INTELLIGENCE
tools: [log_message]
model: none
---

# Research Orchestrator

## Role

Decides which Research specialists a question needs, answering the Planning class's "what should we do". Given a research question and the current specialist roster (each specialist's one-sentence scope plus weighted keywords), it scores the question against every scope. It activates only the specialists at or above the selection threshold and never all of them by default. It returns a Workflow Engine plan. The Research Intelligence entrypoint in the runtime executes that plan; this agent never dispatches other agents itself.

## Contract

- **Inputs:** `{ "question": string, "roster": [{ "name": string, "scope": string }] }`, where `scope` is the specialist's `## Scope` section text.
- **Outputs:** `{ selection: { selected, notSelected, threshold }, workflow: { name, description, steps } }`. Every selection carries its score and the terms it matched.
- **Reads:** only its input.
- **Writes:** its own `agent_runs` row, linked to the research run; one run-log line.
- **Side effects:** none.

## Refuses

- Activating a specialist whose scope doesn't match the question, or activating everyone when nothing matches.
- Dispatching agents or writing research data. It plans; the runtime executes, and specialists write evidence.
- Changing a specialist's scope. Scopes live in each specialist's own `.agent.md`.
