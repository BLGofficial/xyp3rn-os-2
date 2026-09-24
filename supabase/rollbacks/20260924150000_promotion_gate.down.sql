-- Rollback for 20260924150000_promotion_gate.sql. Idempotent. No CASCADE.
-- Restores the pre-6D grants (bootstrap canonical INSERT, service_role full grants).
-- Not undone, by design:
--   * knowledge_versions rows (backfilled or gate-written): history is permanent;
--   * the 'pending_approval' enum value: Postgres can't drop an enum value (6A's rollback drops the type);
--   * the xyp_promotion role: cluster-wide (see the 6A/Phase 2 rollbacks).
-- Refuses while first-party gate versions exist: the pre-6D check would reject them, and deciding
-- what to do with promoted history is an operator decision, not a rollback side effect.

do $$
declare
  t text;
begin
  -- Nested, not AND-ed: the subquery would be planned (and fail) even when the table is gone.
  if to_regclass('public.knowledge_versions') is not null then
    if exists (select 1 from public.knowledge_versions where promoted_via = 'gate' and candidate_id is null) then
      raise exception 'rollback refused: first-party gate versions exist in knowledge_versions (history is permanent)';
    end if;
  end if;

  foreach t in array array[
    'sources', 'modules', 'canonical_prompts', 'prompt_variants', 'tags', 'prompt_tags', 'relations', 'quality_reports',
    'knowledge_versions', 'research_runs', 'research_sources', 'research_evidence', 'research_findings',
    'research_finding_evidence', 'knowledge_candidates', 'contradictions', 'experiments', 'experiment_runs'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists promotion_select on public.%I', t);
      execute format('drop policy if exists promotion_insert on public.%I', t);
      execute format('drop policy if exists promotion_update on public.%I', t);
    end if;
  end loop;
  if exists (select from pg_roles where rolname = 'xyp_promotion') then
    revoke all on all tables in schema public from xyp_promotion;
    if to_regprocedure('public.xyp_relation_endpoint_exists(public.relation_entity_type, text)') is not null then
      revoke execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text) from xyp_promotion;
    end if;
    revoke usage on schema public from xyp_promotion;
  end if;

  -- Pre-6D grants, exactly as Phase 1 / Phase 2 / 6A left them.
  if to_regclass('public.canonical_prompts') is not null then
    grant all on table public.modules, public.canonical_prompts to service_role;
  end if;
  if to_regclass('public.knowledge_versions') is not null then
    grant all on table public.knowledge_versions to service_role;
  end if;
  if to_regclass('public.canonical_prompts') is not null and exists (select from pg_roles where rolname = 'xyp_ingest_bootstrap') then
    grant select, insert on table
      public.modules, public.canonical_prompts, public.tags, public.prompt_tags, public.relations, public.quality_reports
      to xyp_ingest_bootstrap;
    grant execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text) to xyp_ingest_bootstrap;
    foreach t in array array['modules', 'canonical_prompts', 'tags', 'prompt_tags', 'relations', 'quality_reports'] loop
      if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'ingest_bootstrap_select') then
        execute format('create policy ingest_bootstrap_select on public.%I for select to xyp_ingest_bootstrap using (true)', t);
      end if;
      if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'ingest_bootstrap_insert') then
        execute format('create policy ingest_bootstrap_insert on public.%I for insert to xyp_ingest_bootstrap with check (true)', t);
      end if;
    end loop;
  end if;

  if to_regclass('public.knowledge_candidates') is not null then
    drop trigger if exists trg_knowledge_candidates_transition on public.knowledge_candidates;
  end if;
  if to_regclass('public.modules') is not null then
    drop trigger if exists trg_modules_requires_history on public.modules;
  end if;
  if to_regclass('public.canonical_prompts') is not null then
    drop trigger if exists trg_canonical_prompts_requires_history on public.canonical_prompts;
  end if;
  if to_regclass('public.knowledge_versions') is not null then
    alter table public.knowledge_versions drop constraint if exists knowledge_versions_gate_candidate_check;
    alter table public.knowledge_versions drop constraint if exists knowledge_versions_promotion_run_id_fkey;
    drop index if exists public.knowledge_versions_promotion_run_id_idx;
    alter table public.knowledge_versions drop column if exists promotion_run_id;
    alter table public.knowledge_versions add constraint knowledge_versions_gate_candidate_check
      check (promoted_via <> 'gate' or candidate_id is not null);
  end if;
end $$;

drop table if exists public.regression_queue;
drop table if exists public.promotion_runs;
drop table if exists public.approval_queue;

drop function if exists public.xyp_decide_approval(uuid, text, text, text);
drop function if exists public.xyp_approval_queue_seal();
drop function if exists public.xyp_knowledge_candidates_transition();
drop function if exists public.xyp_canonical_requires_history();

drop type if exists public.regression_status;
drop type if exists public.regression_kind;
drop type if exists public.promotion_outcome;
drop type if exists public.promotion_mode;
drop type if exists public.approval_status;
drop type if exists public.approval_item_type;
