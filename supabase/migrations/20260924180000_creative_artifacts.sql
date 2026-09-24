-- Phase 8 — creative_artifacts: the Creative class's only output (capability artifact.write).
-- Insert-only and versioned. A new version names its parent; lineage and version number are derived
-- here, never taken from the caller, so history is linear and can't be forged. No role (the owner
-- included) may UPDATE or DELETE a written version: Revision (Phase 12) appends, it never rewrites.
-- Written as xyp_creative (the write_artifact tool); xyp_runtime (context reads) gets no write.
-- Also: xyp_runtime may read canonical_claims, the Context Engine's exact claim lookup (retrieve_claims).
-- Idempotent. Rollback: supabase/rollbacks/20260924180000_creative_artifacts.down.sql

create table if not exists public.creative_artifacts (
  id           uuid primary key default gen_random_uuid(),
  lineage_id   uuid not null,
  version      integer not null,
  parent_id    uuid references public.creative_artifacts (id) on delete restrict,
  -- Versioned output schema, e.g. x3lius.lyrics/v1 — the contract the Phase 12 Critic diffs against.
  schema_id    text not null,
  agent_name   text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  brief        text not null,
  body         jsonb not null,
  -- The canonical refs the artifact was built from (rules + claims), exactly as sent to the model.
  context_refs jsonb not null,
  -- How much canonical knowledge backed it (Phase 8 sparsity flag), so thin output is never silent.
  knowledge    jsonb not null,
  -- Frontmatter model ref (provider:model) the run used.
  model        text not null,
  created_at   timestamptz not null default now(),
  constraint creative_artifacts_lineage_version_key unique (lineage_id, version),
  constraint creative_artifacts_version_check check (version >= 1),
  constraint creative_artifacts_root_check check ((parent_id is null) = (version = 1)),
  constraint creative_artifacts_schema_id_check check (schema_id ~ '^[a-z0-9]+([.-][a-z0-9]+)*/v[0-9]+$'),
  constraint creative_artifacts_agent_name_check check (length(agent_name) > 0),
  constraint creative_artifacts_body_check check (jsonb_typeof(body) = 'object'),
  constraint creative_artifacts_context_refs_check check (jsonb_typeof(context_refs) = 'array'),
  constraint creative_artifacts_knowledge_check check (jsonb_typeof(knowledge) = 'object')
);

create index if not exists creative_artifacts_agent_run_id_idx on public.creative_artifacts (agent_run_id);
create index if not exists creative_artifacts_parent_id_idx on public.creative_artifacts (parent_id);

-- Derives lineage/version from the parent. A second child of the same parent collides on
-- (lineage_id, version): linear history, no forks. A version keeps its parent's schema.
create or replace function public.xyp_creative_artifacts_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent record;
begin
  if new.parent_id is null then
    new.lineage_id := new.id;
    new.version := 1;
    return new;
  end if;
  select lineage_id, version, schema_id into v_parent from public.creative_artifacts where id = new.parent_id;
  if not found then
    return new; -- the parent_id FK reports it
  end if;
  if v_parent.schema_id <> new.schema_id then
    raise exception 'creative_artifacts: version of % must keep schema % (got %)', new.parent_id, v_parent.schema_id, new.schema_id
      using errcode = 'check_violation';
  end if;
  new.lineage_id := v_parent.lineage_id;
  new.version := v_parent.version + 1;
  return new;
end;
$$;

create or replace trigger trg_creative_artifacts_version before insert on public.creative_artifacts
  for each row execute function public.xyp_creative_artifacts_version();

-- Immutable once written, for every role: grants can't bind the owner, a trigger can.
create or replace function public.xyp_creative_artifacts_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'creative_artifacts % is immutable: write a new version instead', old.id
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create or replace trigger trg_creative_artifacts_immutable before update or delete on public.creative_artifacts
  for each row execute function public.xyp_creative_artifacts_immutable();

revoke execute on function public.xyp_creative_artifacts_version() from public, anon, authenticated;
revoke execute on function public.xyp_creative_artifacts_immutable() from public, anon, authenticated;

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_creative') then
    create role xyp_creative nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_creative;

alter table public.creative_artifacts enable row level security;
revoke all on table public.creative_artifacts from anon, authenticated;
-- service_role reads; nobody but xyp_creative inserts, and nobody rewrites (trigger above).
grant select on table public.creative_artifacts to service_role;
grant select, insert on table public.creative_artifacts to xyp_creative;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'creative_artifacts' and policyname = 'creative_select') then
    create policy creative_select on public.creative_artifacts for select to xyp_creative using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'creative_artifacts' and policyname = 'creative_insert') then
    create policy creative_insert on public.creative_artifacts for insert to xyp_creative with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'creative_artifacts' and policyname = 'service_select') then
    create policy service_select on public.creative_artifacts for select to service_role using (true);
  end if;
end $$;

-- retrieve_claims: the Context Engine reads current canonical claims by topic (security_invoker view
-- over canonical_prompts, which xyp_runtime already reads).
grant select on table public.canonical_claims to xyp_runtime;
