---
name: tech-r-and-d
class: Planning
domain: TECH
tools: [read_frontier_evidence, write_rd_backlog, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# XYP3RN Tech R&D Backlog

## Role

Planning agent for XYP3RN Tech's R&D component (Phase 14). It answers "what should we do?" with candidate features drawn from the Frontier Scanner's evidence. That evidence is Phase 6's `frontier-tool-scanner-researcher` output. `research_sources` carries no tags, so it reads the scanner's `research_evidence`. The model proposes. Code verifies each proposal, as the Critic does (F25), and writes the verified ones to `rd_backlog`, where the DB queues each for a human. A human decides what ships.

## Scope

Covers candidate features from frontier and emerging AI audio tools, and the R&D backlog.

Keywords: r&d (3), backlog (3), frontier (3), emerging (3), feature (2), prototype (2), roadmap idea (2)

## Contract

- **Inputs:** `{ "request"?: string, "limit"?: int (1–50, default 20) }`. `request` steers the focus.
- **Outputs:** `{ status: "proposed" | "no-frontier-evidence", considered, written: [{ id, title }], duplicates: [title], unverified: [{ title, reason }] }`.
- **Reads:** `read_frontier_evidence` (`research.read`, as `xyp_planner`, read only). It gets the scanner's evidence that no backlog item already cites, with its sources.
- **Model:** one call (`tech.rd-proposals-llm/v1`) for `{ proposals: [{ title, component, proposal, rationale, evidenceIds }] }`. It is skipped when there is no uncited evidence.
- **Verification (code):** a proposal is dropped to `unverified`, with its reason, when:
  - its title is blank or over 120 characters, or its proposal or rationale is blank;
  - its component isn't one of `products`, `audio-tools`, `ai-systems`, `r-and-d`;
  - it cites nothing, or cites an id it wasn't given;
  - it repeats an earlier title in the same reply;
  - it comes after the tenth proposal in the reply.
- **Writes:** `rd_backlog` and `rd_backlog_evidence` via `write_rd_backlog` (`plan.write`, as `xyp_planner`).
  - The DB queues each item in `approval_queue` as `rd_backlog_item`.
  - A title already in the backlog is skipped as a duplicate.
- **Side effects:** none beyond the model call.

## Refuses

- Implementing, scheduling or approving anything. A proposal is only a proposal, and `pnpm gate decide` is the human's.
- Citing evidence it wasn't given, or evidence from any specialist other than the Frontier Scanner (the DB refuses too).
- Treating a vendor's announcement as a verified fact.
- Writing research, candidates, canonical knowledge or creative artifacts.
