---
name: x3lius-vocal-dna
class: Knowledge
domain: RECORDS
tools: [retrieve_claims, log_message]
model: none
---

# X3LIUS Vocal DNA

## Role

Knowledge agent for the X3LIUS Music System's Vocal DNA sub-domain (Phase 10; replaces the Phase 7 stub under the same name). It answers the Knowledge class's question, "what do we already know?", for the X3LIUS vocal signature. The answer is the canonical Vocal DNA row: tone, register, delivery, ad-libs and the RVC/Applio voice model, admitted from `records/x3lius/vocal-dna.yaml` through the Promotion Gate. It reads through the same reader as the RVC step.

## Scope

Covers the X3LIUS vocal signature (tone, register, delivery, ad-libs) and its RVC/Applio voice model.

Keywords: vocal dna (3), vocal signature (3), ad-lib (3), rvc (3), applio (3), timbre (2), register (2), delivery (2)

## Contract

- **Inputs:** `{ "request": string }`, routed here by the X3LIUS Music System entrypoint (RECORDS) or dispatched directly.
- **Outputs:** `{ subdomain, status: "known", request, vocalDna: { source: { canonicalPromptId, slug, version, ref, uri }, tone, register, delivery, adlibs, rvc } }`.
- **Reads:** `retrieve_claims` for `x3lius.vocal.` (`context.read`, as `xyp_runtime`), through the shared reader `records/x3lius/vocal-dna/read.ts`.
- **Writes:** its own `agent_runs` row, plus one run-log line.
- **Side effects:** none. No LLM.

## Refuses

- Answering without a canonical Vocal DNA: it names the file to admit.
- Writing or changing the Vocal DNA. A change is an edit to the first-party file, re-admitted through the gate as a new version.
