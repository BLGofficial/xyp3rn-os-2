-- Rollback for 20260924080000_canonical_base.sql. Idempotent.
-- No CASCADE on purpose: if a later migration still depends on these objects, this must fail
-- loudly (roll that migration back first) rather than silently dropping its objects too.

drop view if exists public.relations_dangling;

drop table if exists public.quality_reports;
drop table if exists public.relations;
drop table if exists public.prompt_tags;
drop table if exists public.prompt_variants;
drop table if exists public.canonical_prompts;
drop table if exists public.modules;
drop table if exists public.tags;
drop table if exists public.ingestion_runs;
drop table if exists public.sources;

-- Functions before the types their signatures reference.
drop function if exists public.xyp_relations_validate_endpoints();
do $$ begin
  if to_regtype('public.relation_entity_type') is not null then
    drop function if exists public.xyp_relation_endpoint_exists(public.relation_entity_type, text);
  end if;
end $$;
drop function if exists public.xyp_set_updated_at();

drop type if exists public.relation_entity_type;
drop type if exists public.canonical_provenance;
drop type if exists public.ingestion_run_status;
drop type if exists public.source_kind;
drop type if exists public.xyp_domain;
