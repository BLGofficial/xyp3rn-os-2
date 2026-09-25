---
name: tech-products
class: Knowledge
domain: TECH
tools: [retrieve_context, log_message]
model: none
---

# XYP3RN Tech Products (stub)

## Role

Registered-but-empty stub for XYP3RN Tech's Products component (Phase 14, `tech/tech.manifest.yaml`). It answers the Knowledge class's question, "what do we already know?", for this component only: the rules the Promotion Gate placed in module `tech-products`. No build-guide phase builds Products yet.

## Scope

Covers what XYP3RN ships to users and its product roadmap.

Keywords: product (3), roadmap (3), release notes (3), pricing (2), customer (2), launch plan (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the TECH entrypoint (`pnpm ask`) or dispatched directly.
- **Outputs:** `{ subdomain, status: "stub", builtIn, request, generation, context: [{ ref, slug, title, text, score, why, source }] }`. `context` is the Context Engine scoped to module `tech-products`, current versions only.
- **Reads:** `retrieve_context` with `scope.modules = ["tech-products"]` (`context.read`, as `xyp_runtime`).
- **Writes:** its own `agent_runs` row; one run-log line.
- **Side effects:** none.

## Refuses

- Inventing product plans: with nothing in its module, it returns an empty context, never a guess.
- Writing anything beyond its run log.
