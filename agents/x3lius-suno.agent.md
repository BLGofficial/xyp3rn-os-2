---
name: x3lius-suno
class: Knowledge
domain: RECORDS
tools: [retrieve_context, log_message]
model: none
---

# X3LIUS Suno (stub)

## Role

Registered-but-empty stub for the X3LIUS Music System's Suno sub-domain (Phase 7). It answers the Knowledge class's question, "what do we already know?", for this sub-domain only: the rules the Promotion Gate placed in module `x3lius-suno`. It has no creative logic; the real Suno agents arrive in Phase 9.

## Scope

Covers Suno prompt formulas, style prompts and negative prompts, recorded per Suno model version.

Keywords: suno (3), style prompt (3), negative prompt (3), meta-tag (2), persona (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS).
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `x3lius-suno`, current versions only.
- **Reads:** long-term memory via `retrieve_context` with `scope.modules = ["x3lius-suno"]` (capability `context.read`), read-only as `xyp_runtime`.
- **Writes:** its own `agent_runs` row, via the Orchestrator; one run-log line.
- **Side effects:** none.

## Refuses

- Producing creative output (lyrics, prompts, mixes, scores). It is a stub until its phase builds the real agent.
- Returning context from outside its sub-domain. The scope is its own module, never the whole knowledge base.
- Writing anything. It holds only `context.read` and `log.write`; canonical knowledge changes only through the Promotion Gate.
