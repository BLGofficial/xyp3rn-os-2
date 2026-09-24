-- Rollback for 20260924170000_global_current_versions.sql: restores the Phase 3 definition
-- (every embedded version searchable). Idempotent; skipped once the vector type is gone.
do $$ begin
  if to_regtype('extensions.vector') is not null then
    create or replace function public.xyp_match_knowledge(p_query extensions.vector, p_limit integer)
    returns table (entity_table text, entity_id uuid, similarity double precision)
    language sql
    stable
    set search_path = ''
    as $f$
      select hits.entity_table, hits.entity_id, hits.similarity
      from (
        (select 'canonical_prompts'::text, cp.id, 1 - (cp.embedding operator(extensions.<=>) p_query)
         from public.canonical_prompts cp
         where cp.embedding is not null
         order by cp.embedding operator(extensions.<=>) p_query
         limit p_limit)
        union all
        (select 'sources'::text, s.id, 1 - (s.embedding operator(extensions.<=>) p_query)
         from public.sources s
         where s.embedding is not null
         order by s.embedding operator(extensions.<=>) p_query
         limit p_limit)
      ) as hits (entity_table, entity_id, similarity)
      order by hits.similarity desc, hits.entity_table, hits.entity_id
      limit p_limit;
    $f$;
  end if;
end $$;
