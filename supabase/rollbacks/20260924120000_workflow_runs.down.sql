-- Rollback for 20260924120000_workflow_runs.sql. Idempotent. No CASCADE.

do $$ begin
  if to_regclass('public.agent_runs') is not null then
    drop index if exists public.agent_runs_workflow_run_id_idx;
    alter table public.agent_runs
      drop constraint if exists agent_runs_step_pair_check,
      drop column if exists step_id,
      drop column if exists workflow_run_id;
  end if;
end $$;

drop table if exists public.workflow_runs;
drop function if exists public.xyp_workflow_runs_seal();
drop type if exists public.workflow_run_status;
