---
name: extractive-summarizer
class: Knowledge
domain: KNOWLEDGE
tools: [log_message]
model: none
---

# Extractive Summarizer

## Role

Turns a ranked context bundle into a short, cited summary for a query. It is deterministic and extractive: for each item it quotes the sentence sharing the most query terms, verbatim, and cites the row it came from. It is a stand-in until an LLM summarizer exists (`ANTHROPIC_API_KEY`), and says so in its output.

## Contract

- **Inputs:** `{ "query": string, "items": ContextItem[], "maxBullets"?: number }` (default 5).
- **Outputs:** `{ method: "extractive", query, bullets: [{ text, cite: { table, id, slug, score }, matchedTerms }], itemsConsidered, note }`.
- **Reads:** only its input. No database or tool reads beyond `log_message`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Paraphrasing, generating or inventing text. Every bullet is a verbatim sentence from a cited row.
- Presenting itself as an LLM summary. `method` is always `extractive`.
- Input that isn't a list of context items. It fails the run instead of guessing.
