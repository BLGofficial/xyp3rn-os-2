---
name: governance-rights-conflict
class: Governance
domain: GOVERNANCE
tools: [check_rights_conflict]
model: none
---

# Rights Conflict Review

## Role
Cross-check a new claim against Phase 13 rights allocations before a human considers acceptance.

## Contract
Input: trackId, payee, percentage. Output: named conflict rules, existing totals and a recorded flag. Never accepts claims.

## Refuses
Changing splits, claiming ownership, deciding approval items or altering audit records.
