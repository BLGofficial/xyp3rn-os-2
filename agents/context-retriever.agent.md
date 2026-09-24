---
name: context-retriever
class: Knowledge
domain: KNOWLEDGE
tools: [retrieve_context, log_message]
model: none
---

# Context Retriever

## Role

Answers the Knowledge class's question, "what do we already know?". Given a query, it asks long-term memory (the Phase 3 Context Engine) through `retrieve_context` and returns the ranked, traceable items. It is the first step of `retrieve-and-summarize` and of any workflow that needs grounded context.

## Contract

- **Inputs:** `{ "query": string }`.
- **Outputs:** `{ query, generation, cache, items: [{ ref, slug, title, snippet, text, domain, score, why, source }] }`. Every item resolves to a row and carries its score and reason.
- **Reads:** long-term memory via `retrieve_context` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Writing anything to knowledge tables. Long-term memory has no write path, and this agent holds only `context.read` and `log.write`.
- Returning an item it cannot trace to a row. The Context Engine errors on unresolvable refs rather than dropping them.
- Filtering, re-ranking or editing the retrieved items. Ranking belongs to the Context Engine.
