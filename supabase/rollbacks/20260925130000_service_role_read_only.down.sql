-- Rollback for 20260925130000_service_role_read_only.sql. Idempotent. No CASCADE.
-- Restores exactly what service_role held before: full DML on the relations created before this
-- migration that had never been revoked, REFERENCES/TRIGGER on the three canonical tables (6D revoked
-- only their writes), and the Supabase default privileges on new tables.

do $$
declare
  v text;
begin
  foreach v in array array[
    'agent_runs', 'canonical_claims', 'contradictions', 'creative_artifacts', 'critiques', 'experiment_runs',
    'experiments', 'ingestion_runs', 'knowledge_candidate_eligibility', 'knowledge_candidates', 'prompt_tags',
    'prompt_variants', 'quality_reports', 'relations', 'relations_dangling', 'research_evidence',
    'research_finding_evidence', 'research_findings', 'research_projects', 'research_questions', 'research_runs',
    'research_sources', 'sources', 'suno_submissions', 'suno_takes', 'tags', 'take_scores', 'workflow_runs'
  ] loop
    if to_regclass('public.' || v) is not null then
      execute format('grant insert, update, delete, truncate, references, trigger on table public.%I to service_role', v);
    end if;
  end loop;
  foreach v in array array['canonical_prompts', 'modules', 'knowledge_versions'] loop
    if to_regclass('public.' || v) is not null then
      execute format('grant references, trigger on table public.%I to service_role', v);
    end if;
  end loop;
end $$;

alter default privileges in schema public grant insert, update, delete, truncate, references, trigger on tables to service_role;
