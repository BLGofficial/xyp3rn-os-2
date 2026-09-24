-- Phase 5 — workflow_runs + step linkage on agent_runs.
-- One workflow run = one row here + one agent_runs row per executed step. A run is sealed once
-- it leaves 'running' (same append-then-seal rule as agent_runs).
-- Idempotent. Rollback: supabase/rollbacks/20260924120000_workflow_runs.down.sql

do $$ begin
  create type public.workflow_run_status as enum ('running', 'success', 'error');
exception when duplicate_object then null; end $$;

create table if not exists public.workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  workflow_name text not null,
  -- Provenance: exactly which spec bytes ran, and the parsed spec as executed.
  spec_sha256   text not null,
  spec          jsonb not null,
  input         jsonb not null,
  output        jsonb,
  status        public.workflow_run_status not null default 'running',
  failed_step   text,
  -- Steps never started because an upstream step failed (no silent partial success).
  skipped_steps text[] not null default '{}',
  error_detail  text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint workflow_runs_spec_sha256_check check (spec_sha256 ~ '^[0-9a-f]{64}$'),
  constraint workflow_runs_completion_check check ((status = 'running') = (completed_at is null)),
  constraint workflow_runs_error_check check (status <> 'error' or (error_detail is not null and failed_step is not null))
);

create index if not exists workflow_runs_workflow_name_created_at_idx on public.workflow_runs (workflow_name, created_at);

create or replace function public.xyp_workflow_runs_seal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'running' then
    raise exception 'workflow_runs % is sealed (status %)', old.id, old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

create or replace trigger trg_workflow_runs_seal before update on public.workflow_runs
  for each row execute function public.xyp_workflow_runs_seal();
revoke execute on function public.xyp_workflow_runs_seal() from public, anon, authenticated;

-- Step linkage is identity: set at INSERT, never updatable (not in xyp_runtime's UPDATE grant).
alter table public.agent_runs
  add column if not exists workflow_run_id uuid references public.workflow_runs (id) on delete restrict,
  add column if not exists step_id text;

do $$ begin
  if not exists (select from pg_constraint where conname = 'agent_runs_step_pair_check') then
    alter table public.agent_runs add constraint agent_runs_step_pair_check
      check ((workflow_run_id is null) = (step_id is null));
  end if;
end $$;

create index if not exists agent_runs_workflow_run_id_idx on public.agent_runs (workflow_run_id);

alter table public.workflow_runs enable row level security;
revoke all on table public.workflow_runs from anon, authenticated;
grant all on table public.workflow_runs to service_role;
grant select, insert on table public.workflow_runs to xyp_runtime;
grant update (status, output, failed_step, skipped_steps, error_detail, completed_at)
  on table public.workflow_runs to xyp_runtime;

do $$
declare
  v_cmd text;
begin
  foreach v_cmd in array array['select', 'insert', 'update'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = 'workflow_runs'
                   and policyname = 'runtime_' || v_cmd) then
      execute format(
        'create policy %I on public.workflow_runs for %s to xyp_runtime %s',
        'runtime_' || v_cmd, v_cmd,
        case v_cmd when 'insert' then 'with check (true)' when 'update' then 'using (true) with check (true)' else 'using (true)' end);
    end if;
  end loop;
end $$;
