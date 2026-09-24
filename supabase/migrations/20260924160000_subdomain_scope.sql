-- Phase 7 — module-scoped retrieval: the context path of an X3LIUS sub-domain (or any module).
-- Current versions only: a superseded (slug, version) is history, never consumable context.
-- MATERIALIZED keeps the scoped set exact: an HNSW scan with a module filter can silently return
-- fewer rows than exist; sub-domain sets are small, so an exact scan is cheap and correct.
-- Idempotent. Rollback: supabase/rollbacks/20260924160000_subdomain_scope.down.sql

create or replace function public.xyp_match_knowledge_in_modules(p_query extensions.vector, p_limit integer, p_module_slugs text[])
returns table (entity_table text, entity_id uuid, similarity double precision)
language sql
stable
set search_path = ''
as $$
  with scoped as materialized (
    select cp.id, cp.embedding
    from public.canonical_prompts cp
    join public.modules m on m.id = cp.module_id
    where m.slug = any(p_module_slugs)
      and cp.embedding is not null
      and cp.version = (select max(x.version) from public.canonical_prompts x where x.slug = cp.slug)
  )
  select 'canonical_prompts'::text, s.id, 1 - (s.embedding operator(extensions.<=>) p_query)
  from scoped s
  order by s.embedding operator(extensions.<=>) p_query, s.id
  limit p_limit;
$$;

revoke execute on function public.xyp_match_knowledge_in_modules(extensions.vector, integer, text[]) from public, anon, authenticated;
grant execute on function public.xyp_match_knowledge_in_modules(extensions.vector, integer, text[]) to service_role, xyp_runtime;
