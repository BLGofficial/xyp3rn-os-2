-- Rollback for 20260925140000_vault_songs.sql. Idempotent. No CASCADE.
-- The xyp_vault and xyp_web roles stay (cluster-wide); their privileges go with the objects dropped
-- here and the grants revoked below. The enum value artifact_version stays in approval_item_type
-- (Postgres cannot drop an enum value); its decided rows stay too: a human decision is history.

drop view if exists public.artifact_approvals;
drop view if exists public.current_song_links;
drop view if exists public.current_songs;
drop function if exists public.xyp_match_vault(extensions.vector, integer, text);
drop function if exists public.xyp_decide_artifact(uuid, text, text, text);
drop table if exists public.vault_embeddings;
drop table if exists public.song_link_retractions;
drop table if exists public.song_links;
drop table if exists public.song_revisions;
drop table if exists public.songs;
drop table if exists public.source_tags;
drop table if exists public.source_texts;
drop function if exists public.xyp_vault_embeddings_entity();
drop function if exists public.xyp_song_links_guard();
drop function if exists public.xyp_songs_have_revision();
drop function if exists public.xyp_song_revisions_number();
drop function if exists public.xyp_vault_immutable();
drop type if exists public.song_status;

do $$ begin
  if to_regclass('public.sources') is not null then
    alter table public.sources drop constraint if exists sources_vault_file_check;
    alter table public.sources drop constraint if exists sources_language_check;
    alter table public.sources drop constraint if exists sources_media_class_check;
    alter table public.sources drop constraint if exists sources_storage_check;
    drop index if exists public.sources_agent_run_id_idx;
    alter table public.sources drop column if exists agent_run_id, drop column if exists language,
      drop column if exists media_class, drop column if exists storage;
  end if;
end $$;

-- Policies and grants this migration added on tables that existed before it.
do $$
declare
  t text;
begin
  foreach t in array array['sources', 'tags'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists vault_select on public.%I', t);
      execute format('drop policy if exists vault_insert on public.%I', t);
      execute format('revoke select, insert on table public.%I from xyp_vault', t);
    end if;
  end loop;
  foreach t in array array['sources', 'tags', 'creative_artifacts', 'approval_queue', 'agent_runs', 'workflow_runs', 'ingestion_runs',
    'research_projects', 'research_questions', 'research_runs', 'research_findings', 'research_evidence', 'research_sources',
    'suno_submissions', 'suno_takes', 'take_scores', 'tracks', 'releases', 'rights_splits', 'trace_analyses', 'critiques',
    'canonical_prompts', 'modules', 'knowledge_versions', 'current_rights_splits'] loop
    if to_regclass('public.' || t) is not null then
      if t <> 'current_rights_splits' then
        execute format('drop policy if exists web_select on public.%I', t);
      end if;
      execute format('revoke select on table public.%I from xyp_web', t);
    end if;
  end loop;
  if to_regclass('public.research_findings') is not null then
    drop policy if exists runtime_select on public.research_findings;
    revoke select on table public.research_findings from xyp_runtime, xyp_embedder;
    drop policy if exists embedder_select on public.research_findings;
  end if;
  if to_regclass('public.creative_artifacts') is not null then
    drop policy if exists embedder_select on public.creative_artifacts;
    revoke select on table public.creative_artifacts from xyp_embedder;
  end if;
end $$;

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_vault') then
    revoke usage on schema public from xyp_vault;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_web') then
    revoke usage on schema public from xyp_web;
    revoke usage on schema extensions from xyp_web;
  end if;
end $$;
