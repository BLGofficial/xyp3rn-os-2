-- F16 (pre-Phase 8): the global retrieval path serves current canonical versions only, like the
-- Phase 7 scoped path. A superseded (slug, version) is history, never consumable context.
-- Canonical prompts are scanned exactly (MATERIALIZED current set): with pgvector 0.6 a filtered
-- HNSW scan can silently return fewer rows than exist. Exact cosine over a few thousand 384-dim
-- rows is milliseconds; revisit with pgvector >= 0.8 iterative scans if the corpus grows large.
-- Sources are unversioned and keep their HNSW branch unchanged.
-- Idempotent. Rollback: supabase/rollbacks/20260924170000_global_current_versions.down.sql

create or replace function public.xyp_match_knowledge(p_query extensions.vector, p_limit integer)
returns table (entity_table text, entity_id uuid, similarity double precision)
language sql
stable
set search_path = ''
as $$
  with current_prompts as materialized (
    select cp.id, cp.embedding
    from public.canonical_prompts cp
    where cp.embedding is not null
      and cp.version = (select max(x.version) from public.canonical_prompts x where x.slug = cp.slug)
  )
  select hits.entity_table, hits.entity_id, hits.similarity
  from (
    (select 'canonical_prompts'::text, c.id, 1 - (c.embedding operator(extensions.<=>) p_query)
     from current_prompts c
     order by c.embedding operator(extensions.<=>) p_query
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
$$;
