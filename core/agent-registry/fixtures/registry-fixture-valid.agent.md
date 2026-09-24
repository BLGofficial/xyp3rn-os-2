---
name: registry-fixture-valid
class: Knowledge
domain: KNOWLEDGE
tools: [log_message]
model: none
---

# Registry Fixture (valid)

## Role

Test fixture for the Phase 4B Agent Registry parser. Never dispatched. It exists so the
parser has one file that matches the `_template.agent.md` shape exactly.

## Contract

- **Inputs:** none.
- **Outputs:** none.
- **Reads:** nothing.
- **Writes:** nothing.
- **Side effects:** none.

## Refuses

- Being dispatched: it is a parser fixture, not an agent.
