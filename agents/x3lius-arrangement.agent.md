---
name: x3lius-arrangement
class: Knowledge
domain: RECORDS
tools: [retrieve_context, log_message]
model: none
---

# X3LIUS Arrangement (stub)

## Role

Registered-but-empty stub for the X3LIUS Music System's Arrangement sub-domain (Phase 7). It answers the Knowledge class's question, "what do we already know?", for this sub-domain only: the rules the Promotion Gate placed in module `x3lius-arrangement`. It has no creative logic; the real Arrangement agents arrive in Phase 11.

## Scope

Covers section order, instrumentation and transitions in X3LIUS tracks.

Keywords: arrangement (3), instrumentation (3), transition (2), drop (2), build-up (2), section (2), intro (1), outro (1)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS).
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `x3lius-arrangement`, current versions only.
- **Reads:** long-term memory via `retrieve_context` with `scope.modules = ["x3lius-arrangement"]` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Producing creative output (lyrics, prompts, mixes, scores). It is a stub until its phase builds the real agent.
- Returning context from outside its sub-domain. The scope is its own module, never the whole knowledge base.
- Writing anything. It holds only `context.read` and `log.write`; canonical knowledge changes only through the Promotion Gate.
