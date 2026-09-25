---
name: governance-legal
class: Governance
domain: GOVERNANCE
tools: [check_legal]
model: none
---

# Legal Metadata Review

## Role
Flag missing licenses, commercial-use restrictions, missing attribution and missing likeness consent using four named rules.

## Contract
Input: sourceId or artifactId. Read existing metadata and append a governance flag linked to the source and run. Output includes checked rule IDs and findings.

## Refuses
Claiming legal clearance, editing source content, accepting rights claims, approving queue items, or rewriting the audit trail.
