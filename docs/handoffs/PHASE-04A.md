HANDOFF — Phase 4A complete

- **Built:**
  - `agent_runs` (migration `20260924110000_agent_runs.sql` and its rollback), with enums `agent_run_status` and `xyp_agent_class` (a copy of `AGENT_CLASSES`, checked for drift by a test) and indexes on `(agent_name, created_at)` and `(status)`.
  - Append-then-seal enforcement: `xyp_runtime` gets INSERT/SELECT plus column-level UPDATE on the outcome columns, and the `trg_agent_runs_seal` trigger rejects any update once a row has left `pending`.
  - 14 tests, written first: UPDATE of `agent_name`, `class`, `domain`, `input` or `created_at` → `42501`; DELETE → `42501`; any update after `success`/`error` → `55000`, even for the table owner; the `pending` → `success` transition is allowed; the hand-inserted row proving the enum is deleted, leaving 0 rows.
- **Key decisions:**
  - The seal trigger goes beyond grants, because grants alone would still let a finished run's output be rewritten. It also guarantees that a late handler can never overwrite a timed-out run.
  - `class`/`domain` are nullable and `agent_name` isn't a foreign key, so a dispatch for an unknown agent is still logged as an error run instead of failing to log at all.
- **Deviations from spec:**
  - `tokens_used` and `latency_ms` are added to the updatable set, since they are only known when a run finishes.
  - The runtime role is the existing `xyp_runtime` from Phase 3, not a new role.
- **Open flags:** none new.
- **Next phase needs:**
  - 4B reads `agents/_template.agent.md`: frontmatter keys `name`, `class`, `domain`, `tools`, `model`; body sections `## Role`, `## Contract`, `## Refuses`; unknown keys rejected; `_`-prefixed files skipped as templates.
  - The class and domain lists come from `core/contracts/taxonomy.ts` (`isAgentClass`, `isDomain`).
