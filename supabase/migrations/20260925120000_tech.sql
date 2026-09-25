-- Phase 14 — XYP3RN Tech: the TRACE intake and the R&D backlog.
-- - trace_analyses   a trace.analysis/v1 as received (validated in code, tech/trace/analysis.ts — the
--                    DB never re-states the contract), optionally the Suno take it measured, and the
--                    mix report that checked it: linked once, and only to a report of this analysis.
--                    Append-only otherwise. Written as xyp_trace_intake (capability trace.write).
-- - rd_backlog       R&D proposals (Planning, capability plan.write, as xyp_planner). Each cites at
--                    least one piece of the Frontier Scanner's evidence (rd_backlog_evidence; deferred
--                    check), and each is queued for a human in approval_queue (item_type
--                    rd_backlog_item) by a trigger: there is no unqueued proposal. Immutable.
-- - rd_backlog_items the backlog with its evidence and its approval status (the queue row is the one
--                    source of the status; nothing copies it).
-- Idempotent. Rollback: supabase/rollbacks/20260925120000_tech.down.sql

-- ADD VALUE inside the migration transaction is fine as long as nothing below *uses* the new value
-- before commit: the trigger body compares at run time, and the view casts item_type to text.
alter type public.approval_item_type add value if not exists 'rd_backlog_item';

-- ─── trace_analyses ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.trace_analyses (
  id                     uuid primary key default gen_random_uuid(),
  schema_id              text not null,
  body                   jsonb not null,
  take_id                uuid references public.suno_takes (id) on delete restrict,
  mix_report_artifact_id uuid references public.creative_artifacts (id) on delete restrict,
  agent_run_id           uuid not null references public.agent_runs (id) on delete restrict,
  created_at             timestamptz not null default now(),
  constraint trace_analyses_schema_id_check check (schema_id ~ '^trace\.analysis/v[0-9]+$'),
  -- The row's schema id is the body's own: a v2 body can never be filed as v1.
  constraint trace_analyses_body_check check (jsonb_typeof(body) = 'object' and body ->> 'schema' = schema_id)
);

create index if not exists trace_analyses_take_id_idx on public.trace_analyses (take_id);
create index if not exists trace_analyses_mix_report_artifact_id_idx on public.trace_analyses (mix_report_artifact_id);
create index if not exists trace_analyses_agent_run_id_idx on public.trace_analyses (agent_run_id);

-- SECURITY DEFINER: the link check reads creative_artifacts, which xyp_trace_intake cannot.
create or replace function public.xyp_trace_analyses_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schema text;
  v_analysis jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'trace_analyses % is append-only', old.id using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (new.id, new.schema_id, new.body, new.take_id, new.agent_run_id, new.created_at)
     is distinct from (old.id, old.schema_id, old.body, old.take_id, old.agent_run_id, old.created_at) then
    raise exception 'trace_analyses % is append-only: only its mix report link is set, once', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.mix_report_artifact_id is not null then
    raise exception 'trace_analyses % is already linked to report %; a link is set once', old.id, old.mix_report_artifact_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.mix_report_artifact_id is null then
    return new;
  end if;
  select a.schema_id, a.body -> 'analysis' into v_schema, v_analysis from public.creative_artifacts a where a.id = new.mix_report_artifact_id;
  if not found then
    return new; -- the FK reports it
  end if;
  if v_schema <> 'x3lius.mix-report/v1' then
    raise exception 'trace_analyses: artifact % is %, not a x3lius.mix-report/v1', new.mix_report_artifact_id, v_schema
      using errcode = 'check_violation';
  end if;
  if v_analysis is distinct from new.body then
    raise exception 'trace_analyses: report % checked a different analysis than %', new.mix_report_artifact_id, new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_trace_analyses_guard before update or delete on public.trace_analyses
  for each row execute function public.xyp_trace_analyses_guard();

-- ─── rd_backlog ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.rd_backlog (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  component    text not null,
  proposal     text not null,
  rationale    text not null,
  model        text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint rd_backlog_title_check check (length(btrim(title)) between 1 and 120),
  -- The TECH sub-components (tech/tech.manifest.yaml, reserved in ARCHITECTURE).
  constraint rd_backlog_component_check check (component in ('products', 'audio-tools', 'ai-systems', 'r-and-d')),
  constraint rd_backlog_proposal_check check (length(btrim(proposal)) > 0),
  constraint rd_backlog_rationale_check check (length(btrim(rationale)) > 0),
  constraint rd_backlog_model_check check (length(btrim(model)) > 0)
);

-- One idea, one item: a title repeated in another case or with other spacing is the same title.
create unique index if not exists rd_backlog_title_key on public.rd_backlog (lower(btrim(title)));
create index if not exists rd_backlog_agent_run_id_idx on public.rd_backlog (agent_run_id);

create table if not exists public.rd_backlog_evidence (
  rd_backlog_id        uuid not null references public.rd_backlog (id) on delete restrict,
  research_evidence_id uuid not null references public.research_evidence (id) on delete restrict,
  created_at           timestamptz not null default now(),
  constraint rd_backlog_evidence_pkey primary key (rd_backlog_id, research_evidence_id)
);

create index if not exists rd_backlog_evidence_research_evidence_id_idx on public.rd_backlog_evidence (research_evidence_id);

-- SECURITY DEFINER: reads research_evidence whatever the caller's RLS view of it.
create or replace function public.xyp_rd_backlog_evidence_frontier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_specialist text;
begin
  select e.specialist into v_specialist from public.research_evidence e where e.id = new.research_evidence_id;
  if found and v_specialist <> 'frontier-tool-scanner-researcher' then
    raise exception 'rd_backlog_evidence: evidence % is %''s, not the Frontier Scanner''s', new.research_evidence_id, v_specialist
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_rd_backlog_evidence_frontier before insert on public.rd_backlog_evidence
  for each row execute function public.xyp_rd_backlog_evidence_frontier();

-- Deferred to commit: an item and its evidence links are written in one transaction, checked whole.
create or replace function public.xyp_rd_backlog_cites_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select from public.rd_backlog_evidence e where e.rd_backlog_id = new.id) then
    raise exception 'rd_backlog % "%" cites no evidence', new.id, new.title using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_rd_backlog_cites_evidence on public.rd_backlog;
create constraint trigger trg_rd_backlog_cites_evidence after insert on public.rd_backlog
  deferrable initially deferred
  for each row execute function public.xyp_rd_backlog_cites_evidence();

-- Every proposal is queued for a human (F8: one queue). SECURITY DEFINER: xyp_planner holds no grant
-- on approval_queue, so this trigger is its only way in, and only for its own new item.
create or replace function public.xyp_rd_backlog_queue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.approval_queue (item_type, item_id, request)
  values ('rd_backlog_item', new.id, jsonb_build_object(
    'reason', 'an R&D proposal: a human decides what ships',
    'title', new.title, 'component', new.component, 'proposal', new.proposal, 'rationale', new.rationale,
    'model', new.model, 'agentRunId', new.agent_run_id));
  return null;
end;
$$;

create or replace trigger trg_rd_backlog_queue after insert on public.rd_backlog
  for each row execute function public.xyp_rd_backlog_queue();

create or replace function public.xyp_rd_backlog_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is immutable: a changed idea is a new backlog item', tg_table_name
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create or replace trigger trg_rd_backlog_immutable before update or delete on public.rd_backlog
  for each row execute function public.xyp_rd_backlog_immutable();
create or replace trigger trg_rd_backlog_evidence_immutable before update or delete on public.rd_backlog_evidence
  for each row execute function public.xyp_rd_backlog_immutable();

-- The backlog as the operator sees it: the approval row is the one source of each item's status.
create or replace view public.rd_backlog_items with (security_invoker = true) as
  select b.id, b.title, b.component, b.proposal, b.rationale, b.model, b.agent_run_id, b.created_at,
         coalesce((select array_agg(e.research_evidence_id order by e.research_evidence_id)
                   from public.rd_backlog_evidence e where e.rd_backlog_id = b.id), '{}') as evidence_ids,
         a.id as approval_id, a.status::text as status, a.decided_by, a.decided_at, a.decision_reason
  from public.rd_backlog b
  left join public.approval_queue a on a.item_id = b.id and a.item_type::text = 'rd_backlog_item';

-- ─── roles and grants ────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_trace_intake') then
    create role xyp_trace_intake nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_planner') then
    create role xyp_planner nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;

grant usage on schema public to xyp_trace_intake, xyp_planner;

alter table public.trace_analyses enable row level security;
alter table public.rd_backlog enable row level security;
alter table public.rd_backlog_evidence enable row level security;
-- service_role loses the Supabase default ALL (SCHEMA.md checklist): it reads; agents write.
revoke all on table public.trace_analyses, public.rd_backlog, public.rd_backlog_evidence, public.rd_backlog_items
  from anon, authenticated, service_role;

grant select on table public.trace_analyses to service_role, xyp_runtime, xyp_trace_intake;
grant insert on table public.trace_analyses to xyp_trace_intake;
grant update (mix_report_artifact_id) on table public.trace_analyses to xyp_trace_intake;

grant select on table public.rd_backlog, public.rd_backlog_evidence to service_role, xyp_planner;
grant insert on table public.rd_backlog, public.rd_backlog_evidence to xyp_planner;
grant select on table public.rd_backlog_items to service_role;

-- read_frontier_evidence (capability research.read) reads the research chain as xyp_planner.
grant select on table public.research_evidence, public.research_sources to xyp_planner;

do $$
declare
  v record;
begin
  for v in select * from (values
    ('trace_analyses', 'trace_intake_select', 'select', 'xyp_trace_intake'),
    ('trace_analyses', 'trace_intake_insert', 'insert', 'xyp_trace_intake'),
    ('trace_analyses', 'trace_intake_update', 'update', 'xyp_trace_intake'),
    ('trace_analyses', 'runtime_select', 'select', 'xyp_runtime'),
    ('trace_analyses', 'service_select', 'select', 'service_role'),
    ('rd_backlog', 'planner_select', 'select', 'xyp_planner'),
    ('rd_backlog', 'planner_insert', 'insert', 'xyp_planner'),
    ('rd_backlog', 'service_select', 'select', 'service_role'),
    ('rd_backlog_evidence', 'planner_select', 'select', 'xyp_planner'),
    ('rd_backlog_evidence', 'planner_insert', 'insert', 'xyp_planner'),
    ('rd_backlog_evidence', 'service_select', 'select', 'service_role'),
    ('research_evidence', 'planner_select', 'select', 'xyp_planner'),
    ('research_sources', 'planner_select', 'select', 'xyp_planner')
  ) as p(tbl, policy, cmd, role) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.policy) then
      execute format('create policy %I on public.%I for %s to %I %s', v.policy, v.tbl, v.cmd, v.role,
        case v.cmd when 'insert' then 'with check (true)' when 'update' then 'using (true) with check (true)' else 'using (true)' end);
    end if;
  end loop;
end $$;

revoke execute on function
  public.xyp_trace_analyses_guard(),
  public.xyp_rd_backlog_evidence_frontier(),
  public.xyp_rd_backlog_cites_evidence(),
  public.xyp_rd_backlog_queue(),
  public.xyp_rd_backlog_immutable()
  from public, anon, authenticated;
