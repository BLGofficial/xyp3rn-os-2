-- Rollback for 20260924110000_agent_runs.sql. Idempotent. No CASCADE: Phase 6A's
-- research_run_id FK must be rolled back first, or this fails loudly.
-- Policies and grants go with the table; xyp_runtime itself belongs to the Phase 3 migration.

drop table if exists public.agent_runs;
drop function if exists public.xyp_agent_runs_seal();
drop type if exists public.xyp_agent_class;
drop type if exists public.agent_run_status;
