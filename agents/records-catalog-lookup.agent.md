---
name: records-catalog-lookup
class: Knowledge
domain: RECORDS
tools: [resolve_take, read_catalog, read_vault_file, log_message]
model: none
---

# Records Catalog Lookup

## Role

Knowledge agent for Records ops `catalog` (Phase 13). It is the read half of the guide's "Knowledge/Execution" Catalog agent. F10 is resolved as a split: this agent and `records-catalog` (Execution), chained by `records/workflows/register-track.workflow.yaml`. It answers "what do we already know?" about a finished recording, and resolves the target release. It then answers with a fully specified registration and the provenance it rests on. The recording is one of:

- a Suno take, resolved through its chain (take → Suno submission → formula artifact);
- since AOS-02 (B4), a Vault audio file, such as an FL Studio bounce.

## Contract

- **Inputs:** `{ "takeId": uuid | null, "sourceId": uuid | null, "release": { "id": uuid } | { "title", "artist", "kind": "single" | "ep" | "album" }, "position": int, "title": string | null, "mixReportArtifactId": uuid | null }`.
  - Exactly one of `takeId` / `sourceId` is set.
  - A null means "not given". The keys are required because the workflow engine has no optional inputs.
- **Outputs:** `{ registration: { release, track: { position, title, takeId, sourceId, mixReportArtifactId } }, provenance }`.
  - The provenance is `{ take, submission, formula, mixReport }` for a take, or `{ vaultFile }` for a Vault file.
  - The default `title` is the formula artifact's title (take), or the title of the one song the file is linked to (Vault file). An operator-given title wins.
- **Reads:**
  - `resolve_take` and `read_catalog` (`catalog.read`);
  - `read_vault_file` (`vault.read`).

  All run as `xyp_runtime`, read only. It gets ids, titles and schema ids, never artifact bodies.
- **Writes:** its own `agent_runs` row and one run-log line. Nothing else.
- **Side effects:** none. No LLM.

## Refuses

- Both a take and a Vault file, or neither.
- An unknown take, a Vault file that isn't audio, or a mix report link that isn't a `x3lius.mix-report/v1` artifact.
- An existing release that isn't a draft, a position already taken on it, or a recording already on it.
- A track with no title: none is given and none can be derived (the formula has none, or the file isn't linked to exactly one song).
- Writing anything: registration is `records-catalog`'s.
