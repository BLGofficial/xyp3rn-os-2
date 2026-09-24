-- Phase 2 — xyp_ingest_bootstrap: the temporary pre-gate canonical writer (ARCHITECTURE.md F1).
-- Append-only: SELECT + INSERT on knowledge tables, no UPDATE/DELETE/TRUNCATE on any of them.
-- Phase 6D revokes its canonical INSERT and routes ingestion through knowledge_candidates.
-- Idempotent. Rollback: supabase/rollbacks/20260924090000_ingest_bootstrap_role.down.sql

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_ingest_bootstrap') then
    -- nologin: services assume it via SET ROLE from a trusted connection; a login role with its
    -- own credentials is a deployment decision, not a schema one.
    create role xyp_ingest_bootstrap nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_ingest_bootstrap;

grant select, insert on table
  public.sources, public.modules, public.canonical_prompts, public.tags,
  public.prompt_tags, public.relations, public.quality_reports, public.ingestion_runs
  to xyp_ingest_bootstrap;

-- A run opens as 'running' and is closed exactly once. What was requested and when it started
-- stay immutable: only the outcome columns are updatable.
grant update (source_id, checksum_sha256, status, stats, error_detail, completed_at)
  on table public.ingestion_runs to xyp_ingest_bootstrap;

-- The relations endpoint trigger runs as the inserting role.
grant execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text)
  to xyp_ingest_bootstrap;

-- RLS is on with no client policies (Phase 1). This role sees and appends every row: the OS is
-- single-tenant, so row scoping would add nothing here — the grants above do the restricting.
do $$
declare
  t text;
begin
  foreach t in array array[
    'sources', 'modules', 'canonical_prompts', 'tags', 'prompt_tags', 'relations', 'quality_reports', 'ingestion_runs'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t
                   and policyname = 'ingest_bootstrap_select') then
      execute format('create policy ingest_bootstrap_select on public.%I for select to xyp_ingest_bootstrap using (true)', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t
                   and policyname = 'ingest_bootstrap_insert') then
      execute format('create policy ingest_bootstrap_insert on public.%I for insert to xyp_ingest_bootstrap with check (true)', t);
    end if;
  end loop;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'ingestion_runs'
                 and policyname = 'ingest_bootstrap_update') then
    create policy ingest_bootstrap_update on public.ingestion_runs for update to xyp_ingest_bootstrap
      using (true) with check (true);
  end if;
end $$;
