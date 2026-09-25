drop table if exists public.trace_analyses;
drop table if exists public.rd_backlog;
drop function if exists public.xyp_rd_source();
do $$ declare t text; p record; begin
 for p in select tablename,policyname from pg_policies where schemaname='public'
   and policyname in ('trace_score','trace_artifact','trace_track','trace_source','trace_release','planning_source_read') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
 foreach t in array array['take_scores','creative_artifacts','tracks','suno_takes','releases'] loop
  if to_regclass('public.'||t) is not null then execute format('revoke all on public.%I from xyp_trace',t); end if;
 end loop;
 if to_regclass('public.research_sources') is not null then revoke all on public.research_sources from xyp_planning; end if;
end $$;
alter table if exists public.research_sources drop column if exists tags;
