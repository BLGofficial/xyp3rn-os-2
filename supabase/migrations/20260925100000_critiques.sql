-- Phase 12 — critiques: the Critic class's only output (capability critique.write), and the link
-- from a revised creative artifact version to the critique it answers.
-- - critiques: insert-only and immutable for every role (trigger). previous_id chains a loop: it must
--   be the critique of the reviewed artifact's parent version. Written as xyp_critic (write_critique);
--   xyp_runtime reads (read_critique, capability critique.read).
-- - creative_artifacts.critique_id: set by Revision on the version it writes; the critique must be
--   about that version's parent.
-- - xyp_escalate_critique: the loop controller's one way into the human approval_queue
--   (item_type critique_escalation, ARCHITECTURE F8). EXECUTE is xyp_evaluation_loop's alone.
-- Idempotent. Rollback: supabase/rollbacks/20260925100000_critiques.down.sql

create table if not exists public.critiques (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references public.creative_artifacts (id) on delete restrict,
  previous_id  uuid references public.critiques (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  schema_id    text not null,
  body         jsonb not null,
  checked      integer not null,
  passed       integer not null,
  created_at   timestamptz not null default now(),
  constraint critiques_schema_id_check check (schema_id ~ '^[a-z0-9]+([.-][a-z0-9]+)*/v[0-9]+$'),
  constraint critiques_body_check check (jsonb_typeof(body) = 'object'),
  constraint critiques_counts_check check (checked >= 0 and passed >= 0 and passed <= checked)
);

create index if not exists critiques_artifact_id_idx on public.critiques (artifact_id);
create index if not exists critiques_previous_id_idx on public.critiques (previous_id);
create index if not exists critiques_agent_run_id_idx on public.critiques (agent_run_id);

-- SECURITY DEFINER: the check reads creative_artifacts, which xyp_critic has no grant on.
create or replace function public.xyp_critiques_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_artifact uuid;
  v_parent uuid;
begin
  if new.previous_id is null then
    return new;
  end if;
  select artifact_id into v_prev_artifact from public.critiques where id = new.previous_id;
  if not found then
    return new; -- the previous_id FK reports it
  end if;
  select parent_id into v_parent from public.creative_artifacts where id = new.artifact_id;
  if v_parent is distinct from v_prev_artifact then
    raise exception 'critiques: previous critique % reviewed %, not the parent of %', new.previous_id, v_prev_artifact, new.artifact_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_critiques_chain before insert on public.critiques
  for each row execute function public.xyp_critiques_chain();

create or replace function public.xyp_critiques_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'critiques % is immutable: the Critic writes a new critique instead', old.id
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create or replace trigger trg_critiques_immutable before update or delete on public.critiques
  for each row execute function public.xyp_critiques_immutable();

alter table public.creative_artifacts add column if not exists critique_id uuid references public.critiques (id) on delete restrict;

do $$ begin
  if not exists (select from pg_constraint where conname = 'creative_artifacts_critique_check') then
    alter table public.creative_artifacts
      add constraint creative_artifacts_critique_check check (critique_id is null or parent_id is not null);
  end if;
end $$;

create index if not exists creative_artifacts_critique_id_idx on public.creative_artifacts (critique_id);

-- SECURITY DEFINER: runs as xyp_creative's insert, which has no grant on critiques.
create or replace function public.xyp_creative_artifacts_critique()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  -- A critique on a v1 is reported by creative_artifacts_critique_check, not here.
  if new.critique_id is null or new.parent_id is null then
    return new;
  end if;
  select artifact_id into v_target from public.critiques where id = new.critique_id;
  if not found then
    return new; -- the critique_id FK reports it
  end if;
  if v_target is distinct from new.parent_id then
    raise exception 'creative_artifacts: critique % reviewed %, not this version''s parent %', new.critique_id, v_target, new.parent_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_creative_artifacts_critique before insert on public.creative_artifacts
  for each row execute function public.xyp_creative_artifacts_critique();

create or replace function public.xyp_escalate_critique(p_critique_id uuid, p_request jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select from public.critiques where id = p_critique_id) then
    raise exception 'no critique %', p_critique_id using errcode = 'foreign_key_violation';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' or coalesce(p_request ->> 'reason', '') = '' then
    raise exception 'an escalation needs a request object with a reason' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.approval_queue (item_type, item_id, request)
  values ('critique_escalation', p_critique_id, p_request)
  returning id into v_id;
  return v_id;
end;
$$;

-- Roles are cluster-wide: two databases migrating at once (parallel test files) can both pass the
-- "not exists" check, so the loser's duplicate is ignored rather than failing its migration.
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_critic') then
    create role xyp_critic nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_evaluation_loop') then
    create role xyp_evaluation_loop nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;

grant usage on schema public to xyp_critic, xyp_evaluation_loop;

alter table public.critiques enable row level security;
revoke all on table public.critiques from anon, authenticated;
grant select on table public.critiques to service_role, xyp_runtime;
grant select, insert on table public.critiques to xyp_critic;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'critic_select') then
    create policy critic_select on public.critiques for select to xyp_critic using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'critic_insert') then
    create policy critic_insert on public.critiques for insert to xyp_critic with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'runtime_select') then
    create policy runtime_select on public.critiques for select to xyp_runtime using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'service_select') then
    create policy service_select on public.critiques for select to service_role using (true);
  end if;
end $$;

revoke execute on function
  public.xyp_critiques_chain(),
  public.xyp_critiques_immutable(),
  public.xyp_creative_artifacts_critique()
  from public, anon, authenticated;
revoke execute on function public.xyp_escalate_critique(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.xyp_escalate_critique(uuid, jsonb) to xyp_evaluation_loop;
