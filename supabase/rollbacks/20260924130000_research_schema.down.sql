-- Rollback for 20260924130000_research_schema.sql. Idempotent. No CASCADE.
-- Policies on the Phase 1 tables are dropped explicitly; the role itself stays (cluster-wide).

do $$
declare
  t text;
begin
  foreach t in array array['sources', 'modules', 'canonical_prompts'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists research_select on public.%I', t);
    end if;
  end loop;
  if exists (select from pg_roles where rolname = 'xyp_research') then
    revoke all on all tables in schema public from xyp_research;
    revoke usage on schema public from xyp_research;
  end if;
  if to_regclass('public.agent_runs') is not null then
    drop index if exists public.agent_runs_research_run_id_idx;
    alter table public.agent_runs drop column if exists research_run_id;
  end if;
end $$;

drop table if exists public.knowledge_versions;
drop table if exists public.experiment_runs;
drop table if exists public.experiments;
drop table if exists public.contradictions;
drop table if exists public.knowledge_candidates;
drop table if exists public.research_finding_evidence;
drop table if exists public.research_findings;
drop table if exists public.research_evidence;
drop table if exists public.research_sources;
drop table if exists public.research_runs;
drop table if exists public.research_questions;
drop table if exists public.research_projects;
drop function if exists public.xyp_research_runs_seal();

drop type if exists public.canonical_table;
drop type if exists public.experiment_variant;
drop type if exists public.experiment_status;
drop type if exists public.contradiction_status;
drop type if exists public.contradiction_target;
drop type if exists public.knowledge_candidate_status;
drop type if exists public.knowledge_candidate_kind;
drop type if exists public.research_source_kind;
drop type if exists public.research_run_status;
drop type if exists public.research_question_status;
drop type if exists public.research_project_status;
