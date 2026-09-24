---
name: x3lius-vocal-dna
class: Knowledge
domain: RECORDS
tools: [retrieve_context, log_message]
model: none
---

# X3LIUS Vocal DNA (stub)

## Role

Registered-but-empty stub for the X3LIUS Music System's Vocal DNA sub-domain (Phase 7). It answers the Knowledge class's question, "what do we already know?", for this sub-domain only: the rules the Promotion Gate placed in module `x3lius-vocal-dna`. It has no creative logic; the real Vocal DNA agents arrive in Phase 10.

## Scope

Covers the X3LIUS vocal signature (tone, register, delivery, ad-libs) and its RVC/Applio voice model.

Keywords: vocal dna (3), vocal signature (3), ad-lib (3), rvc (3), applio (3), timbre (2), register (2), delivery (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS).
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `x3lius-vocal-dna`, current versions only.
- **Reads:** long-term memory via `retrieve_context` with `scope.modules = ["x3lius-vocal-dna"]` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Producing creative output (lyrics, prompts, mixes, scores). It is a stub until its phase builds the real agent.
- Returning context from outside its sub-domain. The scope is its own module, never the whole knowledge base.
- Writing anything. It holds only `context.read` and `log.write`; canonical knowledge changes only through the Promotion Gate.
