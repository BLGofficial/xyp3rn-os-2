---
name: x3lius-mix-master
class: Knowledge
domain: RECORDS
tools: [retrieve_context, log_message]
model: none
---

# X3LIUS Mix/Master (stub)

## Role

Registered-but-empty stub for the X3LIUS Music System's Mix/Master sub-domain (Phase 7). It answers the Knowledge class's question, "what do we already know?", for this sub-domain only: the rules the Promotion Gate placed in module `x3lius-mix-master`. It has no creative logic; the real Mix/Master agents arrive in Phase 11.

## Scope

Covers mix and master decisions against a rubric, from structured TRACE-shaped analysis.

Keywords: mix (3), mixing (3), master (3), mastering (3), lufs (3), loudness (3), trace (2), eq (2), compression (2), limiter (2), stereo width (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS).
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `x3lius-mix-master`, current versions only.
- **Reads:** long-term memory via `retrieve_context` with `scope.modules = ["x3lius-mix-master"]` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Producing creative output (lyrics, prompts, mixes, scores). It is a stub until its phase builds the real agent.
- Returning context from outside its sub-domain. The scope is its own module, never the whole knowledge base.
- Writing anything. It holds only `context.read` and `log.write`; canonical knowledge changes only through the Promotion Gate.
