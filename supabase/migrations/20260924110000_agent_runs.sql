-- Phase 4A — agent_runs: the generic execution log (any class, any domain).
-- Append-then-seal: identity columns are immutable from INSERT (grant level); the whole row is
-- sealed once it leaves 'pending' (trigger). Phase 6A adds a nullable research_run_id FK.
-- Idempotent. Rollback: supabase/rollbacks/20260924110000_agent_runs.down.sql

do $$ begin
  create type public.agent_run_status as enum ('pending', 'success', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Mirrors core/contracts/taxonomy.ts AGENT_CLASSES; tests/phase-04a fails on drift.
  create type public.xyp_agent_class as enum
    ('Research', 'Knowledge', 'Planning', 'Creative', 'Critic', 'Revision', 'Execution', 'Governance');
exception when duplicate_object then null; end $$;

create table if not exists public.agent_runs (
  id           uuid primary key default gen_random_uuid(),
  -- Free text, not an FK: a dispatch for an unknown or invalid agent must still be logged.
  agent_name   text not null,
  -- Null only when the agent could not be resolved (registry failure) — the run is then an error.
  class        public.xyp_agent_class,
  domain       public.xyp_domain,
  input        jsonb not null,
  output       jsonb,
  tokens_used  integer,
  latency_ms   integer,
  status       public.agent_run_status not null default 'pending',
  error_detail text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint agent_runs_agent_name_check check (length(agent_name) > 0),
  constraint agent_runs_completion_check check ((status = 'pending') = (completed_at is null)),
  constraint agent_runs_error_detail_check check (status <> 'error' or error_detail is not null),
  constraint agent_runs_tokens_used_check check (tokens_used is null or tokens_used >= 0),
  constraint agent_runs_latency_ms_check check (latency_ms is null or latency_ms >= 0)
);

create index if not exists agent_runs_agent_name_created_at_idx on public.agent_runs (agent_name, created_at);
create index if not exists agent_runs_status_idx on public.agent_runs (status);

-- Seal: grants can't express "only while pending", so a trigger does. Applies to every role,
-- the owner included — a late-finishing handler can never rewrite a timed-out run.
create or replace function public.xyp_agent_runs_seal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending' then
    raise exception 'agent_runs % is sealed (status %)', old.id, old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

create or replace trigger trg_agent_runs_seal before update on public.agent_runs
  for each row execute function public.xyp_agent_runs_seal();

revoke execute on function public.xyp_agent_runs_seal() from public, anon, authenticated;

alter table public.agent_runs enable row level security;
revoke all on table public.agent_runs from anon, authenticated;
grant all on table public.agent_runs to service_role;

-- xyp_runtime (created in Phase 3) opens and closes runs. Outcome columns only: tokens_used and
-- latency_ms join the guide's list because they are only known when the run finishes.
grant select, insert on table public.agent_runs to xyp_runtime;
grant update (status, output, error_detail, completed_at, tokens_used, latency_ms)
  on table public.agent_runs to xyp_runtime;

do $$
declare
  v_cmd text;
begin
  foreach v_cmd in array array['select', 'insert', 'update'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = 'agent_runs'
                   and policyname = 'runtime_' || v_cmd) then
      execute format(
        'create policy %I on public.agent_runs for %s to xyp_runtime %s',
        'runtime_' || v_cmd, v_cmd,
        case v_cmd when 'insert' then 'with check (true)' when 'update' then 'using (true) with check (true)' else 'using (true)' end);
    end if;
  end loop;
end $$;
