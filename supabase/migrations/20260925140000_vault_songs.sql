-- AOS-01 — the Creative Vault and the song schema (docs/artist-os/AOS-01-design.md §4).
-- - songs + song_revisions  a stable identity with append-only revisions (numbered by trigger);
--                           a song can't commit without one. current_songs = the latest revision.
-- - song_links              typed links, one FK per target kind, exactly one set (A1); a lineage link
--                           points at the lineage root; one live link per song and target;
--                           song_link_retractions unlink without deleting. current_song_links.
-- - sources (extended)      Vault files are sources rows with storage/media_class/language and the
--                           agent run that added them (no parallel item table); the bytes live in the
--                           VaultStore under checksum_sha256 (D4). source_texts + source_tags.
-- - approvals               xyp_decide_artifact records the owner's decision on a creative version
--                           in approval_queue (item_type artifact_version, F8); artifact_approvals
--                           shows each version's status and the lineage's approved version.
-- - vault_embeddings        the Vault corpus index (A3): artifacts, Vault files, research findings;
--                           xyp_match_vault ranks it. Agents' knowledge search is unchanged.
-- Roles: xyp_vault (owner writes, through agents: A2), xyp_web (the UI's reads: A4).
-- Idempotent. Rollback: supabase/rollbacks/20260925140000_vault_songs.down.sql

do $$ begin create type public.song_status as enum ('idea', 'writing', 'producing', 'releasing', 'released', 'archived');
exception when duplicate_object then null; end $$;

-- Not used below before commit: the function and view compare item_type as text.
alter type public.approval_item_type add value if not exists 'artifact_version';

-- ─── songs ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.songs (
  id           uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now()
);

create table if not exists public.song_revisions (
  id           uuid primary key default gen_random_uuid(),
  song_id      uuid not null references public.songs (id) on delete restrict,
  -- Derived by trigger (max + 1), never trusted from the writer.
  revision     integer not null default 0,
  title        text not null,
  artist       text not null,
  language     text,
  genre        text,
  status       public.song_status not null default 'idea',
  notes        text,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint song_revisions_song_id_revision_key unique (song_id, revision),
  constraint song_revisions_title_check check (length(btrim(title)) > 0),
  constraint song_revisions_artist_check check (length(btrim(artist)) > 0),
  constraint song_revisions_language_check check (language is null or language ~ '^([a-z]{2}|mixed|und)$'),
  constraint song_revisions_genre_check check (genre is null or length(btrim(genre)) > 0),
  constraint song_revisions_notes_check check (notes is null or length(btrim(notes)) > 0)
);

create index if not exists songs_agent_run_id_idx on public.songs (agent_run_id);
create index if not exists song_revisions_agent_run_id_idx on public.song_revisions (agent_run_id);

create or replace function public.xyp_song_revisions_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One revision writer per song at a time: the number is max + 1 of what is committed.
  perform pg_advisory_xact_lock(hashtext('xyp:song_revisions:' || new.song_id::text));
  select coalesce(max(r.revision), 0) + 1 into new.revision from public.song_revisions r where r.song_id = new.song_id;
  return new;
end;
$$;

create or replace trigger trg_song_revisions_number before insert on public.song_revisions
  for each row execute function public.xyp_song_revisions_number();

create or replace function public.xyp_songs_have_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select from public.song_revisions r where r.song_id = new.id) then
    raise exception 'songs % has no revision: a song is written with its first revision', new.id using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_songs_have_revision on public.songs;
create constraint trigger trg_songs_have_revision after insert on public.songs
  deferrable initially deferred
  for each row execute function public.xyp_songs_have_revision();

create or replace view public.current_songs with (security_invoker = true) as
  select s.id, s.created_at, s.agent_run_id, r.revision, r.title, r.artist, r.language, r.genre, r.status, r.notes,
         r.created_at as revised_at, r.agent_run_id as revision_run_id
  from public.songs s
  join lateral (select x.* from public.song_revisions x where x.song_id = s.id order by x.revision desc limit 1) r on true;

-- ─── song_links (A1) ───────────────────────────────────────────────────────────────────────────
create table if not exists public.song_links (
  id                   uuid primary key default gen_random_uuid(),
  song_id              uuid not null references public.songs (id) on delete restrict,
  role                 text,
  artifact_lineage_id  uuid references public.creative_artifacts (id) on delete restrict,
  source_id            uuid references public.sources (id) on delete restrict,
  take_id              uuid references public.suno_takes (id) on delete restrict,
  track_id             uuid references public.tracks (id) on delete restrict,
  research_question_id uuid references public.research_questions (id) on delete restrict,
  agent_run_id         uuid not null references public.agent_runs (id) on delete restrict,
  created_at           timestamptz not null default now(),
  -- A new target kind is a new FK column here, and one more term below.
  constraint song_links_target_check check (num_nonnulls(artifact_lineage_id, source_id, take_id, track_id, research_question_id) = 1),
  constraint song_links_role_check check (role is null or length(btrim(role)) > 0)
);

create table if not exists public.song_link_retractions (
  song_link_id uuid primary key references public.song_links (id) on delete restrict,
  reason       text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint song_link_retractions_reason_check check (length(btrim(reason)) > 0)
);

create index if not exists song_links_song_id_idx on public.song_links (song_id);
create index if not exists song_links_artifact_lineage_id_idx on public.song_links (artifact_lineage_id);
create index if not exists song_links_source_id_idx on public.song_links (source_id);
create index if not exists song_links_take_id_idx on public.song_links (take_id);
create index if not exists song_links_track_id_idx on public.song_links (track_id);
create index if not exists song_links_research_question_id_idx on public.song_links (research_question_id);
create index if not exists song_links_agent_run_id_idx on public.song_links (agent_run_id);

-- SECURITY DEFINER: reads creative_artifacts (the root check) and every link of the song.
create or replace function public.xyp_song_links_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('xyp:song_links:' || new.song_id::text));
  if new.artifact_lineage_id is not null
     and not exists (select from public.creative_artifacts a where a.id = new.artifact_lineage_id and a.lineage_id = a.id) then
    raise exception 'song_links: artifact % is not a lineage root; link the lineage''s first version', new.artifact_lineage_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select from public.song_links l
    where l.song_id = new.song_id
      and l.artifact_lineage_id is not distinct from new.artifact_lineage_id
      and l.source_id is not distinct from new.source_id
      and l.take_id is not distinct from new.take_id
      and l.track_id is not distinct from new.track_id
      and l.research_question_id is not distinct from new.research_question_id
      and not exists (select from public.song_link_retractions r where r.song_link_id = l.id)
  ) then
    raise exception 'song_links: song % already has a live link to this target', new.song_id using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_song_links_guard before insert on public.song_links
  for each row execute function public.xyp_song_links_guard();

create or replace view public.current_song_links with (security_invoker = true) as
  select l.id, l.song_id, l.role,
         case when l.artifact_lineage_id is not null then 'artifact_lineage'
              when l.source_id is not null then 'source'
              when l.take_id is not null then 'take'
              when l.track_id is not null then 'track'
              else 'research_question' end as kind,
         coalesce(l.artifact_lineage_id, l.source_id, l.take_id, l.track_id, l.research_question_id) as target_id,
         l.artifact_lineage_id, l.source_id, l.take_id, l.track_id, l.research_question_id, l.agent_run_id, l.created_at
  from public.song_links l
  where not exists (select from public.song_link_retractions r where r.song_link_id = l.id);

-- ─── Vault files: sources, extended ────────────────────────────────────────────────────────────
alter table public.sources
  add column if not exists storage text,
  add column if not exists media_class text,
  add column if not exists language text,
  add column if not exists agent_run_id uuid references public.agent_runs (id) on delete restrict;

do $$ begin
  if not exists (select from pg_constraint where conname = 'sources_storage_check') then
    alter table public.sources add constraint sources_storage_check check (storage is null or storage = 'local-vault');
  end if;
  if not exists (select from pg_constraint where conname = 'sources_media_class_check') then
    alter table public.sources add constraint sources_media_class_check
      check (media_class is null or media_class in ('document', 'lyric_sheet', 'audio', 'image', 'other'));
  end if;
  if not exists (select from pg_constraint where conname = 'sources_language_check') then
    alter table public.sources add constraint sources_language_check check (language is null or language ~ '^([a-z]{2}|mixed|und)$');
  end if;
  -- A Vault file has both storage and a media class, and the run that added it; a knowledge source
  -- (ingested by path, Phases 2-14) has neither.
  if not exists (select from pg_constraint where conname = 'sources_vault_file_check') then
    alter table public.sources add constraint sources_vault_file_check
      check ((storage is null) = (media_class is null) and (storage is null or agent_run_id is not null));
  end if;
end $$;

create index if not exists sources_agent_run_id_idx on public.sources (agent_run_id);

-- A Vault file never changes (a changed file is new bytes, a new row); only the knowledge index's
-- embedding columns are still written to it. The one other update is a promotion: the checksum is
-- unique, so bytes `pnpm ingest` already registered become a Vault file by setting the Vault
-- columns on that row, once. The constraints above decide whether the promoted row is valid.
create or replace function public.xyp_sources_vault_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_index constant text[] := array['embedding', 'embedding_model', 'embedding_input_sha256', 'embedding_truncated', 'embedded_at', 'updated_at'];
begin
  if old.storage is not null and (to_jsonb(new) - v_index) is distinct from (to_jsonb(old) - v_index) then
    raise exception 'source % is a Vault file: it never changes (a changed file is a new file)', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

create or replace trigger trg_sources_vault_guard before update on public.sources
  for each row execute function public.xyp_sources_vault_guard();

create table if not exists public.source_texts (
  source_id    uuid primary key references public.sources (id) on delete restrict,
  text         text not null,
  extractor    text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint source_texts_extractor_check check (length(btrim(extractor)) > 0)
);

create table if not exists public.source_tags (
  source_id    uuid not null references public.sources (id) on delete restrict,
  tag_id       uuid not null references public.tags (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint source_tags_pkey primary key (source_id, tag_id)
);

create index if not exists source_tags_tag_id_idx on public.source_tags (tag_id);

-- ─── append-only, for every role, the owner included ───────────────────────────────────────────
create or replace function public.xyp_vault_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: a change is a new row (a revision, a retraction, a new file)', tg_table_name
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['songs', 'song_revisions', 'song_links', 'song_link_retractions', 'source_texts', 'source_tags'] loop
    execute format('create or replace trigger %I before update or delete on public.%I for each row execute function public.xyp_vault_immutable()',
      'trg_' || t || '_immutable', t);
  end loop;
end $$;

-- ─── approvals of creative versions (G6, F8, D2) ───────────────────────────────────────────────
-- The owner's decision on one version, recorded already decided: an owner-initiated approval has no
-- pending phase. One decision per version (approval_queue_item_key). EXECUTE: service_role only.
create or replace function public.xyp_decide_artifact(p_artifact_id uuid, p_decision text, p_approver text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a record;
  v_id uuid;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject, got %', p_decision using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_approver), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'a decision needs an approver and a reason' using errcode = 'invalid_parameter_value';
  end if;
  select a.id, a.lineage_id, a.version, a.schema_id into v_a from public.creative_artifacts a where a.id = p_artifact_id;
  if not found then
    raise exception 'no artifact %', p_artifact_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.approval_queue (item_type, item_id, request, status, decided_at, decided_by, decision_reason)
  values ('artifact_version', p_artifact_id,
          jsonb_build_object('reason', 'the owner''s decision on a creative version', 'artifactId', v_a.id,
                             'lineageId', v_a.lineage_id, 'version', v_a.version, 'schemaId', v_a.schema_id),
          (case p_decision when 'approve' then 'approved' else 'rejected' end)::public.approval_status,
          now(), p_approver, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

-- Each version's status (draft = no decision) and its lineage's approved version: a newer version
-- never moves the approved pointer until it is approved itself.
create or replace view public.artifact_approvals with (security_invoker = true) as
  select a.id, a.lineage_id, a.version, a.schema_id, a.agent_name, a.created_at,
         coalesce(q.status::text, 'draft') as status, q.id as approval_id, q.decided_by, q.decided_at, q.decision_reason,
         max(a.version) filter (where q.status::text = 'approved') over (partition by a.lineage_id) as approved_version
  from public.creative_artifacts a
  left join public.approval_queue q on q.item_type::text = 'artifact_version' and q.item_id = a.id;

-- ─── the Vault corpus index (A3) ───────────────────────────────────────────────────────────────
create table if not exists public.vault_embeddings (
  entity_kind  text not null,
  entity_id    uuid not null,
  embedding    extensions.vector(384) not null,
  model        text not null,
  input_sha256 text not null,
  truncated    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint vault_embeddings_pkey primary key (entity_kind, entity_id, model),
  constraint vault_embeddings_entity_kind_check check (entity_kind in ('artifact', 'source', 'research_finding')),
  constraint vault_embeddings_input_sha256_check check (input_sha256 ~ '^[0-9a-f]{64}$'),
  constraint vault_embeddings_model_check check (length(btrim(model)) > 0)
);

-- The entity must exist (the kinds are immutable, so an index row never dangles). SECURITY DEFINER:
-- xyp_embedder can't read every entity table. An unknown kind is left to the check constraint.
create or replace function public.xyp_vault_embeddings_entity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if new.entity_kind = 'artifact' then
    select exists (select from public.creative_artifacts where id = new.entity_id) into v_found;
  elsif new.entity_kind = 'source' then
    select exists (select from public.sources where id = new.entity_id) into v_found;
  elsif new.entity_kind = 'research_finding' then
    select exists (select from public.research_findings where id = new.entity_id) into v_found;
  else
    return new;
  end if;
  if not v_found then
    raise exception 'vault_embeddings: no % %', new.entity_kind, new.entity_id using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_vault_embeddings_entity before insert or update on public.vault_embeddings
  for each row execute function public.xyp_vault_embeddings_entity();
create or replace trigger trg_vault_embeddings_updated_at before update on public.vault_embeddings
  for each row execute function public.xyp_set_updated_at();

create or replace function public.xyp_match_vault(p_query extensions.vector, p_limit integer, p_model text)
returns table (entity_kind text, entity_id uuid, similarity double precision)
language sql
stable
set search_path = ''
as $$
  select v.entity_kind, v.entity_id, 1 - (v.embedding operator(extensions.<=>) p_query)
  from public.vault_embeddings v
  where v.model = p_model
  order by v.embedding operator(extensions.<=>) p_query, v.entity_kind, v.entity_id
  limit p_limit;
$$;

-- ─── roles and grants ──────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_vault') then
    create role xyp_vault nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_web') then
    create role xyp_web nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;

grant usage on schema public to xyp_vault, xyp_web;
grant usage on schema extensions to xyp_web;

do $$
declare
  t text;
begin
  foreach t in array array['songs', 'song_revisions', 'song_links', 'song_link_retractions', 'source_texts', 'source_tags', 'vault_embeddings'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
revoke all on table public.songs, public.song_revisions, public.song_links, public.song_link_retractions, public.source_texts,
  public.source_tags, public.vault_embeddings, public.current_songs, public.current_song_links, public.artifact_approvals
  from anon, authenticated, service_role;

-- service_role reads everything new (G20: reads only).
grant select on table public.songs, public.song_revisions, public.song_links, public.song_link_retractions, public.source_texts,
  public.source_tags, public.vault_embeddings, public.current_songs, public.current_song_links, public.artifact_approvals to service_role;

-- xyp_vault: the owner's writes, through vault-curator / records-songs (A2).
grant select, insert on table public.songs, public.song_revisions, public.song_links, public.song_link_retractions,
  public.source_texts, public.source_tags, public.sources, public.tags to xyp_vault;
grant select on table public.current_songs, public.current_song_links to xyp_vault;
-- The promotion (xyp_sources_vault_guard): the Vault columns only, never title, uri or checksum.
grant update (storage, media_class, language, agent_run_id) on table public.sources to xyp_vault;

-- xyp_web: the UI's reads (A4). Never a write.
grant select on table public.songs, public.song_revisions, public.song_links, public.song_link_retractions, public.source_texts,
  public.source_tags, public.vault_embeddings, public.current_songs, public.current_song_links, public.artifact_approvals,
  public.sources, public.tags, public.creative_artifacts, public.approval_queue, public.agent_runs, public.workflow_runs,
  public.ingestion_runs, public.research_projects, public.research_questions, public.research_runs, public.research_findings,
  public.research_evidence, public.research_sources, public.suno_submissions, public.suno_takes, public.take_scores,
  public.tracks, public.releases, public.rights_splits, public.current_rights_splits, public.trace_analyses, public.critiques,
  public.canonical_prompts, public.modules, public.knowledge_versions to xyp_web;

-- xyp_runtime: the Context Engine's vault corpus reads what it ranks.
grant select on table public.vault_embeddings, public.source_texts, public.source_tags, public.research_findings, public.songs,
  public.song_revisions, public.song_links, public.song_link_retractions, public.current_songs, public.current_song_links to xyp_runtime;

-- xyp_embedder: fills the vault index from the entities' text.
grant select, insert, update on table public.vault_embeddings to xyp_embedder;
grant select on table public.creative_artifacts, public.source_texts, public.research_findings to xyp_embedder;

do $$
declare
  v record;
begin
  for v in select * from (values
    ('songs', 'vault'), ('song_revisions', 'vault'), ('song_links', 'vault'), ('song_link_retractions', 'vault'),
    ('source_texts', 'vault'), ('source_tags', 'vault'), ('sources', 'vault'), ('tags', 'vault')
  ) as p(tbl, who) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'vault_select') then
      execute format('create policy vault_select on public.%I for select to xyp_vault using (true)', v.tbl);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'vault_insert') then
      execute format('create policy vault_insert on public.%I for insert to xyp_vault with check (true)', v.tbl);
    end if;
  end loop;
  -- The promotion; xyp_sources_vault_guard and the column grant bound what it may change.
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'vault_update') then
    create policy vault_update on public.sources for update to xyp_vault using (true) with check (true);
  end if;
  for v in select * from (values
    ('songs'), ('song_revisions'), ('song_links'), ('song_link_retractions'), ('source_texts'), ('source_tags'), ('vault_embeddings'),
    ('sources'), ('tags'), ('creative_artifacts'), ('approval_queue'), ('agent_runs'), ('workflow_runs'), ('ingestion_runs'),
    ('research_projects'), ('research_questions'), ('research_runs'), ('research_findings'), ('research_evidence'), ('research_sources'),
    ('suno_submissions'), ('suno_takes'), ('take_scores'), ('tracks'), ('releases'), ('rights_splits'), ('trace_analyses'),
    ('critiques'), ('canonical_prompts'), ('modules'), ('knowledge_versions')
  ) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'web_select') then
      execute format('create policy web_select on public.%I for select to xyp_web using (true)', v.tbl);
    end if;
  end loop;
  for v in select * from (values
    ('vault_embeddings'), ('source_texts'), ('source_tags'), ('research_findings'), ('songs'), ('song_revisions'), ('song_links'),
    ('song_link_retractions')
  ) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'runtime_select') then
      execute format('create policy runtime_select on public.%I for select to xyp_runtime using (true)', v.tbl);
    end if;
  end loop;
  for v in select * from (values ('vault_embeddings'), ('creative_artifacts'), ('source_texts'), ('research_findings')) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'embedder_select') then
      execute format('create policy embedder_select on public.%I for select to xyp_embedder using (true)', v.tbl);
    end if;
  end loop;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'vault_embeddings' and policyname = 'embedder_insert') then
    create policy embedder_insert on public.vault_embeddings for insert to xyp_embedder with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'vault_embeddings' and policyname = 'embedder_update') then
    create policy embedder_update on public.vault_embeddings for update to xyp_embedder using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'vault_embeddings' and policyname = 'service_select') then
    create policy service_select on public.vault_embeddings for select to service_role using (true);
  end if;
end $$;

revoke execute on function
  public.xyp_song_revisions_number(), public.xyp_songs_have_revision(), public.xyp_song_links_guard(),
  public.xyp_vault_immutable(), public.xyp_vault_embeddings_entity(), public.xyp_sources_vault_guard()
  from public, anon, authenticated;
revoke execute on function public.xyp_decide_artifact(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.xyp_decide_artifact(uuid, text, text, text) to service_role;
revoke execute on function public.xyp_match_vault(extensions.vector, integer, text) from public, anon, authenticated;
grant execute on function public.xyp_match_vault(extensions.vector, integer, text) to xyp_runtime, xyp_web;
