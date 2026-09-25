---
name: records-catalog-lookup
class: Knowledge
domain: RECORDS
tools: [resolve_take, read_catalog, log_message]
model: none
---

# Records Catalog Lookup

## Role

Knowledge agent for Records ops `catalog` (Phase 13). It is the read half of the guide's "Knowledge/Execution" Catalog agent. F10 is resolved as a split: this agent and `records-catalog` (Execution), chained by `records/workflows/register-track.workflow.yaml`. It answers "what do we already know?" about a finished take. It resolves the take's chain (take → Suno submission → formula artifact) and the target release, then answers with a fully specified registration and the provenance it rests on.

## Contract

- **Inputs:** `{ "takeId": uuid, "release": { "id": uuid } | { "title", "artist", "kind": "single" | "ep" | "album" }, "position": int, "title": string | null, "mixReportArtifactId": uuid | null }`. A null means "not given". The keys are required because the workflow engine has no optional inputs.
- **Outputs:** `{ registration: { release, track: { position, title, takeId, mixReportArtifactId } }, provenance: { take, submission, formula, mixReport } }`.
  - `title` defaults to the formula artifact's title, and the provenance cites that row. An operator-given title wins.
- **Reads:** `resolve_take` and `read_catalog` (`catalog.read`, as `xyp_runtime`, read only). It gets ids, titles and schema ids, never artifact bodies.
- **Writes:** its own `agent_runs` row and one run-log line. Nothing else.
- **Side effects:** none. No LLM.

## Refuses

- An unknown take, or a mix report link that isn't a `x3lius.mix-report/v1` artifact.
- An existing release that isn't a draft, a position already taken on it, or a take already on it.
- A track with no title: the formula has none and none is given.
- Writing anything: registration is `records-catalog`'s.
