---
name: x3lius-songwriting
class: Knowledge
domain: RECORDS
tools: [retrieve_context, log_message]
model: none
---

# X3LIUS Songwriting (stub)

## Role

Registered-but-empty stub for the X3LIUS Music System's Songwriting sub-domain (Phase 7). It answers the Knowledge class's question, "what do we already know?", for this sub-domain only: the rules the Promotion Gate placed in module `x3lius-songwriting`. It has no creative logic; the real Songwriting agents arrive in Phase 8.

## Scope

Covers song structure, hooks and toplines for X3LIUS tracks.

Keywords: songwriting (3), song structure (3), topline (3), hook (2), chorus (2), verse (2), bridge (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS).
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `x3lius-songwriting`, current versions only.
- **Reads:** long-term memory via `retrieve_context` with `scope.modules = ["x3lius-songwriting"]` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Producing creative output (lyrics, prompts, mixes, scores). It is a stub until its phase builds the real agent.
- Returning context from outside its sub-domain. The scope is its own module, never the whole knowledge base.
- Writing anything. It holds only `context.read` and `log.write`; canonical knowledge changes only through the Promotion Gate.
