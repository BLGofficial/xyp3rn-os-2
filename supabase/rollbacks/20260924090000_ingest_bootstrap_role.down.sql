-- Rollback for 20260924090000_ingest_bootstrap_role.sql. Idempotent, and safe after the
-- Phase 1 tables are already gone (every step is guarded).
-- The role itself is NOT dropped: roles are cluster-wide and may hold grants in other
-- databases (every test database, for one). Dropping it is a manual cluster-level operation.

do $$
declare
  t text;
begin
  foreach t in array array[
    'sources', 'modules', 'canonical_prompts', 'tags', 'prompt_tags', 'relations', 'quality_reports', 'ingestion_runs'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists ingest_bootstrap_select on public.%I', t);
      execute format('drop policy if exists ingest_bootstrap_insert on public.%I', t);
    end if;
  end loop;
  if to_regclass('public.ingestion_runs') is not null then
    drop policy if exists ingest_bootstrap_update on public.ingestion_runs;
  end if;

  if exists (select from pg_roles where rolname = 'xyp_ingest_bootstrap') then
    -- table-level REVOKE ALL also removes the column-level UPDATE grants
    revoke all on all tables in schema public from xyp_ingest_bootstrap;
    if to_regprocedure('public.xyp_relation_endpoint_exists(public.relation_entity_type, text)') is not null then
      revoke execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text)
        from xyp_ingest_bootstrap;
    end if;
    revoke usage on schema public from xyp_ingest_bootstrap;
  end if;
end $$;
