-- Rollback for 20260924140000_research_engines.sql. Idempotent. No CASCADE.

do $$
declare
  t text;
begin
  foreach t in array array[
    'research_projects', 'research_questions', 'research_runs', 'research_sources', 'research_evidence',
    'research_findings', 'research_finding_evidence', 'knowledge_candidates', 'contradictions',
    'experiments', 'experiment_runs', 'canonical_prompts'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists verifier_select on public.%I', t);
      execute format('drop policy if exists verifier_insert on public.%I', t);
      execute format('drop policy if exists verifier_update on public.%I', t);
    end if;
  end loop;
  if exists (select from pg_roles where rolname = 'xyp_verifier') then
    revoke all on all tables in schema public from xyp_verifier;
    revoke usage on schema public from xyp_verifier;
  end if;
  if to_regclass('public.research_findings') is not null then
    drop trigger if exists trg_research_findings_detect on public.research_findings;
  end if;
  if to_regclass('public.knowledge_candidates') is not null then
    drop trigger if exists trg_knowledge_candidates_detect on public.knowledge_candidates;
  end if;
end $$;

drop view if exists public.knowledge_candidate_eligibility;
drop function if exists public.xyp_research_findings_detect();
drop function if exists public.xyp_knowledge_candidates_detect();
drop function if exists public.xyp_detect_contradictions(uuid, text, jsonb, text, uuid);
drop view if exists public.canonical_claims;
drop function if exists public.xyp_model_scopes_overlap(text, text);

drop index if exists public.research_findings_claim_topic_idx;
drop index if exists public.knowledge_candidates_claim_topic_idx;

do $$
declare
  t text;
begin
  foreach t in array array['research_findings', 'knowledge_candidates', 'research_evidence'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_claim_topic_check');
      execute format('alter table public.%I drop column if exists claim_topic, drop column if exists claim_value', t);
    end if;
  end loop;
  if to_regclass('public.research_evidence') is not null then
    alter table public.research_evidence drop constraint if exists research_evidence_claim_pair_check;
  end if;
end $$;
