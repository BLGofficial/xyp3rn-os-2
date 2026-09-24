-- Rollback for 20260924100000_embeddings.sql. Idempotent; every step guarded.
-- Roles are left in place (cluster-wide, see the Phase 2 rollback note). The `extensions`
-- schema is left in place too: on hosted Supabase it is platform-managed.

do $$
declare
  t text;
begin
  foreach t in array array['canonical_prompts', 'sources', 'modules', 'prompt_variants', 'tags', 'prompt_tags', 'relations'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists embedder_select on public.%I', t);
      execute format('drop policy if exists embedder_update on public.%I', t);
      execute format('drop policy if exists runtime_select on public.%I', t);
    end if;
  end loop;

  if exists (select from pg_roles where rolname = 'xyp_embedder') then
    revoke all on all tables in schema public from xyp_embedder;
    revoke usage on schema public from xyp_embedder;
    if to_regnamespace('extensions') is not null then
      revoke usage on schema extensions from xyp_embedder;
    end if;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_runtime') then
    revoke all on all tables in schema public from xyp_runtime;
    revoke usage on schema public from xyp_runtime;
    if to_regnamespace('extensions') is not null then
      revoke usage on schema extensions from xyp_runtime;
    end if;
  end if;

  if to_regtype('extensions.vector') is not null then
    drop function if exists public.xyp_match_knowledge(extensions.vector, integer);
  end if;
end $$;

drop index if exists public.canonical_prompts_embedding_idx;
drop index if exists public.sources_embedding_idx;

alter table if exists public.canonical_prompts
  drop constraint if exists canonical_prompts_embedding_meta_check,
  drop column if exists embedding,
  drop column if exists embedding_model,
  drop column if exists embedding_input_sha256,
  drop column if exists embedding_truncated,
  drop column if exists embedded_at;

alter table if exists public.sources
  drop constraint if exists sources_embedding_meta_check,
  drop column if exists embedding,
  drop column if exists embedding_model,
  drop column if exists embedding_input_sha256,
  drop column if exists embedding_truncated,
  drop column if exists embedded_at;

-- No CASCADE: if anything else still uses vector, this fails loudly instead of dropping it.
drop extension if exists vector;
