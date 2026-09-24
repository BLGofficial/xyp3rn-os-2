# Naming Conventions

Status: Phase 0 contract. One rule and one worked example per category. Add new categories here in the phase that introduces them.

### Domains

Ids are `UPPER_SNAKE`. Directories are the kebab-case form. Both are defined only in `core/contracts/taxonomy.ts`.
Example: `RESEARCH_INTELLIGENCE` → `research-intelligence/`

### Sub-components

Kebab-case, unique within their domain. See the reserved list in `ARCHITECTURE.md`.
Example: `contradiction-engine` (domain `RESEARCH_INTELLIGENCE`)

### Agent classes

A single PascalCase word from the fixed set of eight.
Example: `class: Critic`

### Agent files

Kebab-case `<name>.agent.md` in `agents/`. The frontmatter `name` must equal the filename stem. A `_` prefix marks a template, which is never loaded as an agent.
Example: `agents/suno-researcher.agent.md` with `name: suno-researcher`

### Tables

`snake_case`, plural noun. A join table is `<singular_left>_<plural_right>`. Domain-prefix a table when the bare noun would be ambiguous across domains.
Example: `research_findings`; join table `prompt_tags` (joins `canonical_prompts` ↔ `tags`)

### Columns

`snake_case`. The primary key is `id uuid`. A foreign key is `<singular_referenced_table>_id`. Timestamps are `timestamptz` named `created_at` / `updated_at` / `completed_at`. Booleans read as predicates (`is_`, `has_`).
Example: `agent_runs.research_run_id → research_runs.id`

### Enums

The type is named `<table_singular>_<column>`, and values are lower_snake.
Example: `agent_run_status` with values `pending`, `success`, `error`

### Indexes and constraints

Indexes are `<table>_<col>[_<col>]_idx`. Unique constraints are `<table>_<cols>_key` and checks are `<table>_<rule>_check`, matching Postgres defaults where they exist.
Example: `relations_subject_type_subject_id_idx`

### Triggers and SQL functions

Functions are prefixed `xyp_` with a verb phrase. Triggers are `trg_<table>_<purpose>`.
Example: `trg_sources_updated_at` executes `xyp_set_updated_at()`

### Migrations

`supabase/migrations/<YYYYMMDDHHMMSS>_<snake_description>.sql`. Every migration has a matching rollback, `supabase/rollbacks/<same stem>.down.sql`. Rollbacks sit outside `migrations/` so the Supabase CLI never applies them as forward migrations.
Example: `supabase/migrations/20260924080000_canonical_base.sql` + `supabase/rollbacks/20260924080000_canonical_base.down.sql`

### DB roles

`xyp_<component>`, least-privilege, one per component that connects (F7).
Example: `xyp_research` (INSERT-only on evidence/findings, no UPDATE/DELETE)

### Tools

`snake_case` `<verb>_<object>`. Each tool declares exactly one capability.
Example: `log_message` (capability `log.write`)

### Capabilities

`<resource>.<verb>`, lowercase, from the matrix in `AGENT_CLASSES.md`.
Example: `research.write`

### TypeScript modules

Files are kebab-case `.ts` and imports use the explicit `.ts` extension (they run under Node 22's native type stripping, with no build step). Functions are camelCase, types PascalCase, module-level constants `UPPER_SNAKE`. The style is functional: pure functions over data, no classes, enums or namespaces (`erasableSyntaxOnly`). Exported functions carry JSDoc.
Example: `core/agent-registry/parse-agent-file.ts` exports `parseAgentFile(): AgentDefinition`

### Tests

Unit tests are colocated as `<module>.test.ts`. Phase acceptance proofs go in `tests/phase-<NN>[<sub>]/`.
Example: `core/tool-registry/authorize.test.ts`; `tests/phase-04c/deny-by-default.test.ts`

### Environment variables

`UPPER_SNAKE`, prefixed `XYP_`. Never committed; `.env.example` lists the names only.
Example: `XYP_DATABASE_URL`

### Handoffs

`docs/handoffs/PHASE-<NN>[<sub>].md`, using the Appendix A template of the build guide.
Example: `docs/handoffs/PHASE-06B.md`
