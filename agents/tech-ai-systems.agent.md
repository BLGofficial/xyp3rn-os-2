---
name: tech-ai-systems
class: Knowledge
domain: TECH
tools: [retrieve_context, log_message]
model: none
---

# XYP3RN Tech AI Systems (stub)

## Role

Registered-but-empty stub for XYP3RN Tech's AI Systems component (Phase 14, `tech/tech.manifest.yaml`). It answers the Knowledge class's question, "what do we already know?", for this component only: the rules the Promotion Gate placed in module `tech-ai-systems`. No build-guide phase builds AI Systems yet.

## Scope

Covers the models, providers and agents XYP3RN runs.

Keywords: ai system (3), ai systems (3), llm (3), inference (3), model provider (3), provider (2), agents (1)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the TECH entrypoint (`pnpm ask`) or dispatched directly.
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `tech-ai-systems`, current versions only.
- **Reads:** `retrieve_context` with `scope.modules = ["tech-ai-systems"]` (`context.read`, as `xyp_runtime`).
- **Writes:** its own `agent_runs` row; one run-log line.
- **Side effects:** none.

## Refuses

- Inventing system facts: with nothing in its module, it returns an empty context, never a guess.
- Writing anything beyond its run log.
