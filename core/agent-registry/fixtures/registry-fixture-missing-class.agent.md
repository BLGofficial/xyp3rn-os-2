---
name: registry-fixture-missing-class
domain: KNOWLEDGE
tools: [log_message]
model: none
---

# Registry Fixture (broken: no class)

## Role

Test fixture for the Phase 4B Agent Registry validator. Deliberately omits `class`, which
every agent must declare; validateAll() must reject it with a clear reason.

## Contract

- **Inputs:** none.
- **Outputs:** none.
- **Reads:** nothing.
- **Writes:** nothing.
- **Side effects:** none.

## Refuses

- Being dispatched: it is a parser fixture, not an agent.
