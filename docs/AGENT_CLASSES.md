# Agent Classes

Status: Phase 0 contract. The class ids are defined once in `core/contracts/taxonomy.ts`.

## Rules that apply to every class

- **Exactly one class per agent.** `class` in the frontmatter is single-valued. Hybrids are split into two agents chained by a workflow (proposed resolution of F10 in `ARCHITECTURE.md`).
- **Capabilities, not table names, are what tools declare.** Each tool in the Tool Registry (Phase 4C) declares one capability from the matrix below. A request `(agent_class, tool)` is allowed only if the matrix grants that class the tool's capability. Unregistered tools and undeclared capabilities are denied.
- **An agent's `tools` list can only narrow its class, never widen it.** A Research specialist listing only `write_evidence` gets less than the class allows, never more.
- **Three capabilities belong to no agent class:** `canonical.write` (Knowledge Promotion Gate service account only), `approval.decide` (humans holding an RBAC role only) and `audit.write` (DB triggers/services only). No agent frontmatter can obtain them.
- **Every run writes one `agent_runs` row** (Phase 4A). Logging is not optional and is not a capability an agent can drop.
- **A capability introduced by a later phase is added to the matrix in that same phase.** It is never granted implicitly.

## Capability matrix

`Y` = the class may be granted a tool with this capability. `—` = never.
The enforced copy lives in `core/tool-registry/capabilities.ts`; `tests/phase-04c` fails if the two tables drift apart.

| Capability | What it permits | Research | Knowledge | Planning | Creative | Critic | Revision | Execution | Governance |
|---|---|---|---|---|---|---|---|---|---|
| `context.read` | Query the Context Engine (canonical + sources, read-only) | Y | Y | Y | Y | Y | Y | Y | Y |
| `log.write` | Emit a log message attached to the current run | Y | Y | Y | Y | Y | Y | Y | Y |
| `web.read` | Fetch an external URL and register it as a research source (Phase 6C) | Y | — | — | — | — | — | — | — |
| `research.write` | INSERT `research_evidence` / `research_sources` / `research_findings` | Y | — | — | — | — | — | — | — |
| `research.read` | Read research evidence and its sources (Phase 14: the Frontier Scanner's output, for the R&D backlog) | — | — | Y | — | — | — | — | — |
| `candidate.propose` | INSERT `knowledge_candidates` with status `proposed` | Y | — | — | — | — | — | — | — |
| `plan.write` | Write plans, workflow drafts, `rd_backlog` proposals | — | — | Y | — | — | — | — | — |
| `artifact.write` | Write a new version of a creative artifact (never overwrite) | — | — | — | Y | — | Y | — | — |
| `artifact.read` | Read a creative artifact version by id (Phase 9) | — | — | — | Y | Y | Y | Y | Y |
| `critique.write` | Write a structured critique object | — | — | — | — | Y | — | — | — |
| `critique.read` | Read a critique by id (Phase 12) | — | — | — | — | Y | Y | — | Y |
| `catalog.read` | Read releases, tracks, current split sets, and a take's provenance chain (Phase 13) | — | Y | — | — | — | — | — | Y |
| `catalog.write` | Register releases/tracks, write split sets, assign ISRC/UPC, move a release through the calendar (Phase 13) | — | — | — | — | — | — | Y | — |
| `trace.write` | Record a TRACE analysis as received and link its mix report, once (Phase 14) | — | — | — | — | — | — | Y | — |
| `vault.write` | Register Creative Vault files and tag them; create and revise songs; link and unlink a song's targets (AOS-01) | — | — | — | — | — | — | Y | — |
| `vault.read` | Read a Vault file's metadata, tags and extracted text (AOS-01) | — | Y | — | Y | — | — | Y | — |
| `external.execute` | Perform an external side effect (API submit, file export) | — | — | — | — | — | — | Y | — |
| `governance.flag` | Write compliance/legal/rights flags; enqueue approval items | — | — | — | — | — | — | — | Y |
| `canonical.write` | INSERT/UPDATE `canonical_prompts` / `modules` | — | — | — | — | — | — | — | — |
| `approval.decide` | Approve/reject an `approval_queue` item | — | — | — | — | — | — | — | — |
| `audit.write` | Append to `audit_log` | — | — | — | — | — | — | — | — |

Records ops (Phase 13, F10 resolved as a split): `catalog.read` serves the catalog lookup (Knowledge) and the Rights check (Governance); `catalog.write` serves the two Execution agents, each narrowed by its `tools` list and its own DB role (`xyp_catalog`, `xyp_release_calendar`).

Creative Vault (AOS-01, A2): the owner's writes go through deterministic agents so every change leaves an `agent_runs` row. `vault.write` serves `vault-curator` (files) and `records-songs` (songs and links), both Execution, writing as `xyp_vault`. `vault.read` serves `x3lius-lyric-editor` (Creative: it reads a lyric sheet's text to import it) and is open to Knowledge and Execution for the same read. Approving a version is not a capability: it stays a human decision (`xyp_decide_artifact`, `service_role`).

## Research

- **Question**: What is true, and what actually works?
- **Allowed inputs**: A research question or project; Context Engine results; external sources (web, changelogs, docs, observed generations) read through registered tools.
- **Allowed outputs**: INSERT-only `research_evidence`, `research_sources` and `research_findings`, each claim tagged with its model/version, a confidence value and a source row. It may also INSERT `knowledge_candidates` with status `proposed`.
- **Forbidden to mutate**: `canonical_prompts`, `modules`, `knowledge_versions`, and any `knowledge_candidates` status beyond `proposed`. It may not UPDATE or DELETE existing evidence or findings, and may not write creative artifacts or approvals.

## Knowledge

- **Question**: What do we already know?
- **Allowed inputs**: A query or topic; Context Engine and Knowledge Graph reads.
- **Allowed outputs**: A context bundle or cited answer returned to the caller. Every item carries its source row and score. Nothing is persisted beyond the run log.
- **Forbidden to mutate**: Every table. Knowledge agents are strictly read-only, and this includes canonical knowledge, which only the gate writes.

## Planning

- **Question**: What should we do?
- **Allowed inputs**: A goal; context bundles; research findings; backlog state.
- **Allowed outputs**: Structured plans, workflow-spec drafts, and `rd_backlog` proposals. A proposal is only a proposal: a human decides what ships.
- **Forbidden to mutate**: Canonical knowledge, research tables and creative artifacts. It performs no external side effect, since executing a plan is Execution's job.

## Creative

- **Question**: What should the song, lyrics or style be?
- **Allowed inputs**: A brief; canonical style, voice and rubric rules pulled through the Context Engine; prior artifact versions; a structured measurement of a render (a `trace.analysis/v1`, Phase 11).
- **Allowed outputs**: A new version of a structured creative artifact (JSON objects, not prose blobs, so the Critic can diff them against a rubric).
- **Forbidden to mutate**: Canonical knowledge, including the rules it consumes; research tables; critiques; previously written artifact versions. It may not hardcode a voice or style rule.

## Critic

- **Question**: What is wrong with the result?
- **Allowed inputs**: A creative artifact version, the canonical rules that govern it, and the critique of its parent version when it continues a loop (Phase 12).
- **Allowed outputs**: A structured critique object listing specific violations, each tied to a rubric rule id.
- **Forbidden to mutate**: The artifact under review (editing it is Revision's job, so doing it would violate the class boundary); the rubric; canonical knowledge; research tables.

## Revision

- **Question**: How should it be corrected?
- **Allowed inputs**: A critique object (read with critique.read) plus the artifact version it targets.
- **Allowed outputs**: A new artifact version containing a concrete proposed edit, which is resubmitted to the Critic.
- **Forbidden to mutate**: The original artifact version, which is never overwritten; the critique, which it cannot mark resolved (only the Critic can); canonical knowledge; research tables.

## Execution

- **Question**: How do we perform the operation?
- **Allowed inputs**: A fully specified operation (e.g. an assembled Suno prompt), with its parameters coming from upstream agents.
- **Allowed outputs**: The operation's result (e.g. captured takes, an export path). The full request payload is logged to `agent_runs`, because Governance's audit trail depends on it.
- **Forbidden to mutate**: Canonical knowledge, research tables, and approvals. It must not decide *what* to do: it creates no content and makes no plans.

## Governance

- **Question**: Is this authorized and compliant?
- **Allowed inputs**: Any object under review (sources, generated content, rights claims, queue items) and the audit log, all read-only.
- **Allowed outputs**: Rule-based verdicts (allow/deny plus the rule id checked), compliance flags, and approval-queue entries.
- **Forbidden to mutate**: The object under review; `audit_log`, which nobody may update or delete; canonical knowledge. It may not decide approval-queue items, since only humans with an RBAC role do.
