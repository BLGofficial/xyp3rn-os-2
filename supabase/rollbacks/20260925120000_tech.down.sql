-- Rollback for 20260925120000_tech.sql. Idempotent. No CASCADE.
-- The xyp_trace_intake and xyp_planner roles stay (cluster-wide, like xyp_catalog); their privileges
-- go with the objects dropped here. The enum value rd_backlog_item stays in approval_item_type:
-- Postgres cannot drop an enum value, and nothing references it once rd_backlog is gone (its queue
-- pending rows are deleted first; a decided row is kept: a human decision is history).

do $$ begin
  if to_regclass('public.approval_queue') is not null then
    delete from public.approval_queue where item_type::text = 'rd_backlog_item' and status = 'pending';
  end if;
  if to_regclass('public.research_evidence') is not null then
    drop policy if exists planner_select on public.research_evidence;
    revoke select on table public.research_evidence from xyp_planner;
  end if;
  if to_regclass('public.research_sources') is not null then
    drop policy if exists planner_select on public.research_sources;
    revoke select on table public.research_sources from xyp_planner;
  end if;
end $$;

drop view if exists public.rd_backlog_items;
drop table if exists public.rd_backlog_evidence;
drop table if exists public.rd_backlog;
drop table if exists public.trace_analyses;
drop function if exists public.xyp_rd_backlog_evidence_frontier();
drop function if exists public.xyp_rd_backlog_cites_evidence();
drop function if exists public.xyp_rd_backlog_queue();
drop function if exists public.xyp_rd_backlog_immutable();
drop function if exists public.xyp_trace_analyses_guard();

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_trace_intake') then
    revoke usage on schema public from xyp_trace_intake;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_planner') then
    revoke usage on schema public from xyp_planner;
  end if;
end $$;
