-- Phase 14: TRACE intake and proposal-only R&D. Versioned analysis schema remains in tech/trace/analysis.ts.
alter table public.research_sources add column if not exists tags text[] not null default '{}';
create table if not exists public.rd_backlog (
 id uuid primary key default gen_random_uuid(), source_id uuid not null references public.research_sources(id),
 title text not null check(length(trim(title))>0), rationale text not null check(length(trim(rationale))>0),
 status text not null default 'proposed' check(status in ('proposed','accepted','rejected')),
 agent_run_id uuid not null references public.agent_runs(id), created_at timestamptz not null default now()
);
create table if not exists public.trace_analyses (
 id uuid primary key default gen_random_uuid(), analysis jsonb not null check(jsonb_typeof(analysis)='object' and coalesce(analysis->>'schema'='trace.analysis/v1',false)),
 report_id uuid not null references public.creative_artifacts(id), agent_run_id uuid not null references public.agent_runs(id),
 take_id uuid references public.suno_takes(id), track_id uuid references public.tracks(id), created_at timestamptz not null default now()
);
create index if not exists rd_backlog_source_idx on public.rd_backlog(source_id);
create index if not exists trace_analyses_report_idx on public.trace_analyses(report_id);
do $$ begin
 if not exists(select from pg_roles where rolname='xyp_planning') then create role xyp_planning nologin noinherit; end if;
 if not exists(select from pg_roles where rolname='xyp_trace') then create role xyp_trace nologin noinherit; end if;
end $$;
grant usage on schema public to xyp_planning, xyp_trace;
alter table public.rd_backlog enable row level security;
alter table public.trace_analyses enable row level security;
revoke all on public.rd_backlog, public.trace_analyses from public, anon, authenticated, service_role;
grant select on public.rd_backlog, public.trace_analyses to service_role;
grant select, insert on public.rd_backlog to xyp_planning;
grant select, insert on public.trace_analyses to xyp_trace;
grant select on public.research_sources to xyp_planning;
grant select on public.tracks, public.releases, public.suno_takes, public.creative_artifacts to xyp_trace;
grant update(mix_report_id) on public.tracks to xyp_trace;
grant insert on public.take_scores to xyp_trace;
drop policy if exists tech_read on public.rd_backlog;
create policy tech_read on public.rd_backlog for select to xyp_planning, service_role using(true);
drop policy if exists tech_propose on public.rd_backlog;
create policy tech_propose on public.rd_backlog for insert to xyp_planning with check(status='proposed');
drop policy if exists planning_source_read on public.research_sources;
create policy planning_source_read on public.research_sources for select to xyp_planning using(true);
drop policy if exists trace_read on public.trace_analyses;
create policy trace_read on public.trace_analyses for select to xyp_trace, service_role using(true);
drop policy if exists trace_insert on public.trace_analyses;
create policy trace_insert on public.trace_analyses for insert to xyp_trace with check(true);
drop policy if exists trace_track on public.tracks;
create policy trace_track on public.tracks for all to xyp_trace using(true) with check(true);
drop policy if exists trace_source on public.suno_takes;
create policy trace_source on public.suno_takes for select to xyp_trace using(true);
drop policy if exists trace_release on public.releases;
create policy trace_release on public.releases for select to xyp_trace using(true);
drop policy if exists trace_artifact on public.creative_artifacts;
create policy trace_artifact on public.creative_artifacts for select to xyp_trace using(true);
drop policy if exists trace_score on public.take_scores;
create policy trace_score on public.take_scores for insert to xyp_trace with check(scorer='trace:canonical-mix-rubric/v1' and not is_stub);
create or replace trigger trace_immutable before update or delete on public.trace_analyses for each row execute function public.xyp_creative_artifacts_immutable();
create or replace trigger trace_audit after insert on public.trace_analyses for each row execute function public.xyp_audit();
create or replace trigger rd_audit after insert or update on public.rd_backlog for each row execute function public.xyp_audit();
create or replace function public.xyp_rd_source() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select from public.research_sources where id=new.source_id and tags && array['frontier','emerging']) then
  raise exception 'R&D source must be tagged frontier or emerging' using errcode='check_violation';
 end if;
 return new;
end; $$;
revoke execute on function public.xyp_rd_source() from public,anon,authenticated;
create or replace trigger rd_source before insert or update on public.rd_backlog for each row execute function public.xyp_rd_source();
