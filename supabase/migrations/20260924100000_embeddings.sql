-- Phase 3 — pgvector embeddings + retrieval roles.
-- Model: Supabase/gte-small (384-dim, mean-pooled, unit-normalized) — the same model Supabase's
-- built-in AI runs in Edge Functions, so locally made vectors match hosted ones.
-- Idempotent. Rollback: supabase/rollbacks/20260924100000_embeddings.down.sql

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Embeddings are derived index data, not canonical content: a dedicated role may write these
-- columns and nothing else (see grants below). input_sha256 makes re-embedding idempotent.
alter table public.canonical_prompts
  add column if not exists embedding extensions.vector(384),
  add column if not exists embedding_model text,
  add column if not exists embedding_input_sha256 text,
  add column if not exists embedding_truncated boolean,
  add column if not exists embedded_at timestamptz;

alter table public.sources
  add column if not exists embedding extensions.vector(384),
  add column if not exists embedding_model text,
  add column if not exists embedding_input_sha256 text,
  add column if not exists embedding_truncated boolean,
  add column if not exists embedded_at timestamptz;

-- All-or-nothing: a vector without its model/hash/truncation record can't be traced or refreshed.
do $$
declare
  t text;
begin
  foreach t in array array['canonical_prompts', 'sources'] loop
    if not exists (select from pg_constraint where conname = t || '_embedding_meta_check') then
      execute format(
        'alter table public.%I add constraint %I check (num_nulls(embedding, embedding_model, '
        'embedding_input_sha256, embedding_truncated, embedded_at) in (0, 5))',
        t, t || '_embedding_meta_check');
    end if;
  end loop;
end $$;

create index if not exists canonical_prompts_embedding_idx
  on public.canonical_prompts using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists sources_embedding_idx
  on public.sources using hnsw (embedding extensions.vector_cosine_ops);

-- Nearest neighbours across both embedded tables. Each branch orders by distance with its own
-- LIMIT so the HNSW index is usable; similarity = 1 - cosine distance.
create or replace function public.xyp_match_knowledge(p_query extensions.vector, p_limit integer)
returns table (entity_table text, entity_id uuid, similarity double precision)
language sql
stable
set search_path = ''
as $$
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
$$;

revoke execute on function public.xyp_match_knowledge(extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.xyp_match_knowledge(extensions.vector, integer) to service_role;

-- ─── roles ────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_embedder') then
    create role xyp_embedder nologin noinherit;
  end if;
  -- xyp_runtime: the agent runtime's read path (Context Engine). Phase 4A extends it with agent_runs.
  if not exists (select from pg_roles where rolname = 'xyp_runtime') then
    create role xyp_runtime nologin noinherit;
  end if;
end $$;

grant usage on schema public, extensions to xyp_embedder, xyp_runtime;

grant select on table public.canonical_prompts, public.sources, public.modules to xyp_embedder;
grant update (embedding, embedding_model, embedding_input_sha256, embedding_truncated, embedded_at)
  on table public.canonical_prompts, public.sources to xyp_embedder;

grant select on table
  public.sources, public.modules, public.canonical_prompts, public.prompt_variants,
  public.tags, public.prompt_tags, public.relations
  to xyp_runtime;
grant execute on function public.xyp_match_knowledge(extensions.vector, integer) to xyp_runtime;

do $$
declare
  t text;
begin
  foreach t in array array['canonical_prompts', 'sources', 'modules'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'embedder_select') then
      execute format('create policy embedder_select on public.%I for select to xyp_embedder using (true)', t);
    end if;
  end loop;
  foreach t in array array['canonical_prompts', 'sources'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'embedder_update') then
      execute format('create policy embedder_update on public.%I for update to xyp_embedder using (true) with check (true)', t);
    end if;
  end loop;
  foreach t in array array['sources', 'modules', 'canonical_prompts', 'prompt_variants', 'tags', 'prompt_tags', 'relations'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'runtime_select') then
      execute format('create policy runtime_select on public.%I for select to xyp_runtime using (true)', t);
    end if;
  end loop;
end $$;
