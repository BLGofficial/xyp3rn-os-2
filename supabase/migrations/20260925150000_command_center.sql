-- AOS-02: the Command Center and catalog (docs/artist-os/AOS-02-design.md §4). What it adds:
-- - people, person_aliases       collaborators; one case-insensitive namespace of names and aliases (B1)
-- - credits (+ retractions)      a person, a role, exactly one song or track (B1)
-- - platform_links (+ retr.)     a fixed platform list; the URL's host must match (B3)
-- - release_artwork              a Vault image per release; the newest is current
-- - release_deliveries           distributor status events per release
-- - tracks.source_id             a track's recording is a Suno take or a Vault audio file (B4)
-- - tasks, task_events           the owner's to-dos with a status history (B2), written as xyp_tasks
-- - catalog_checks               readiness checks computed from the data, never stored (B2)
-- Every new table is append-only for every role (xyp_vault_immutable, AOS-01).
-- Idempotent. Rollback: supabase/rollbacks/20260925150000_command_center.down.sql

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_tasks') then
    create role xyp_tasks nologin noinherit;
  end if;
end $$;
grant usage on schema public to xyp_tasks;

-- ─── people (B1) ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.people (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint people_name_check check (length(btrim(name)) > 0)
);

create table if not exists public.person_aliases (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.people (id) on delete restrict,
  alias        text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint person_aliases_alias_check check (length(btrim(alias)) > 0)
);

create unique index if not exists people_name_key on public.people (lower(btrim(name)));
create unique index if not exists person_aliases_alias_key on public.person_aliases (lower(btrim(alias)));
create index if not exists person_aliases_person_id_idx on public.person_aliases (person_id);
create index if not exists people_agent_run_id_idx on public.people (agent_run_id);
create index if not exists person_aliases_agent_run_id_idx on public.person_aliases (agent_run_id);

-- Names and aliases share one namespace, so "X3LIUS" and "x3lius" can't be two people; the unique
-- indexes cover each table, this covers the pair. SECURITY DEFINER: reads both tables.
create or replace function public.xyp_person_name_free()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Through jsonb: plpgsql resolves new.name / new.alias per table, and each table has one of them.
  v_given text := btrim(coalesce(to_jsonb(new) ->> 'name', to_jsonb(new) ->> 'alias'));
  v_name text := lower(v_given);
begin
  perform pg_advisory_xact_lock(hashtext('xyp:person-name:' || v_name));
  if exists (select from public.people p where lower(btrim(p.name)) = v_name)
     or exists (select from public.person_aliases a where lower(btrim(a.alias)) = v_name) then
    raise exception 'people: "%" already names a person (a name or an alias)', v_given using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_people_name_free before insert on public.people
  for each row execute function public.xyp_person_name_free();
create or replace trigger trg_person_aliases_name_free before insert on public.person_aliases
  for each row execute function public.xyp_person_name_free();

-- ─── credits (B1) ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.credits (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references public.people (id) on delete restrict,
  role         text not null,
  song_id      uuid references public.songs (id) on delete restrict,
  track_id     uuid references public.tracks (id) on delete restrict,
  note         text,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint credits_target_check check (num_nonnulls(song_id, track_id) = 1),
  constraint credits_role_check check (role in ('writer', 'composer', 'lyricist', 'producer', 'vocalist', 'featured_artist', 'performer',
    'arranger', 'recording_engineer', 'mixing_engineer', 'mastering_engineer', 'artwork', 'other')),
  constraint credits_note_check check (note is null or length(btrim(note)) > 0)
);

create table if not exists public.credit_retractions (
  credit_id    uuid primary key references public.credits (id) on delete restrict,
  reason       text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint credit_retractions_reason_check check (length(btrim(reason)) > 0)
);

create index if not exists credits_person_id_idx on public.credits (person_id);
create index if not exists credits_song_id_idx on public.credits (song_id);
create index if not exists credits_track_id_idx on public.credits (track_id);
create index if not exists credits_agent_run_id_idx on public.credits (agent_run_id);
create index if not exists credit_retractions_agent_run_id_idx on public.credit_retractions (agent_run_id);

create or replace function public.xyp_credits_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('xyp:credits:' || coalesce(new.song_id, new.track_id)::text));
  if exists (
    select from public.credits c
    where c.person_id = new.person_id and c.role = new.role
      and c.song_id is not distinct from new.song_id and c.track_id is not distinct from new.track_id
      and not exists (select from public.credit_retractions r where r.credit_id = c.id)
  ) then
    raise exception 'credits: that person already has a live % credit here', new.role using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_credits_guard before insert on public.credits
  for each row execute function public.xyp_credits_guard();

create or replace view public.current_credits with (security_invoker = true) as
  select c.id, c.person_id, p.name as person_name, c.role, c.song_id, c.track_id, c.note, c.agent_run_id, c.created_at
  from public.credits c join public.people p on p.id = c.person_id
  where not exists (select from public.credit_retractions r where r.credit_id = c.id);

-- ─── platform links (B3) ────────────────────────────────────────────────────────────────────────
-- The URL must be https and its host must be the platform's (design §4.3). Immutable, so a CHECK.
create or replace function public.xyp_platform_url_ok(p_platform text, p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when h is null then false
    when p_platform = 'spotify' then h = 'open.spotify.com'
    when p_platform = 'apple_music' then h = 'music.apple.com'
    when p_platform = 'youtube' then h in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be')
    when p_platform = 'youtube_music' then h = 'music.youtube.com'
    when p_platform = 'soundcloud' then h in ('soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com')
    when p_platform = 'bandcamp' then h = 'bandcamp.com' or h ~ '^[a-z0-9-]+\.bandcamp\.com$'
    when p_platform = 'tidal' then h in ('tidal.com', 'listen.tidal.com')
    when p_platform = 'deezer' then h in ('deezer.com', 'www.deezer.com', 'link.deezer.com')
    when p_platform = 'amazon_music' then h ~ '^music\.amazon\.[a-z]{2,3}(\.[a-z]{2})?$'
    when p_platform = 'tiktok' then h in ('tiktok.com', 'www.tiktok.com')
    when p_platform = 'instagram' then h in ('instagram.com', 'www.instagram.com')
    when p_platform = 'other' then h ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'
    else false
  end
  from (select lower(substring(p_url from '^https://([^/?#:@]+)(:[0-9]+)?([/?#].*)?$')) as h) as u;
$$;

create table if not exists public.platform_links (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null,
  url          text not null,
  release_id   uuid references public.releases (id) on delete restrict,
  track_id     uuid references public.tracks (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint platform_links_target_check check (num_nonnulls(release_id, track_id) = 1),
  constraint platform_links_platform_check check (platform in ('spotify', 'apple_music', 'youtube', 'youtube_music', 'soundcloud',
    'bandcamp', 'tidal', 'deezer', 'amazon_music', 'tiktok', 'instagram', 'other')),
  constraint platform_links_url_check check (public.xyp_platform_url_ok(platform, url))
);

create table if not exists public.platform_link_retractions (
  platform_link_id uuid primary key references public.platform_links (id) on delete restrict,
  reason           text not null,
  agent_run_id     uuid not null references public.agent_runs (id) on delete restrict,
  created_at       timestamptz not null default now(),
  constraint platform_link_retractions_reason_check check (length(btrim(reason)) > 0)
);

create index if not exists platform_links_release_id_idx on public.platform_links (release_id);
create index if not exists platform_links_track_id_idx on public.platform_links (track_id);
create index if not exists platform_links_agent_run_id_idx on public.platform_links (agent_run_id);
create index if not exists platform_link_retractions_agent_run_id_idx on public.platform_link_retractions (agent_run_id);

create or replace function public.xyp_platform_links_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('xyp:platform_links:' || coalesce(new.release_id, new.track_id)::text));
  if exists (
    select from public.platform_links l
    where l.platform = new.platform
      and l.release_id is not distinct from new.release_id and l.track_id is not distinct from new.track_id
      and not exists (select from public.platform_link_retractions r where r.platform_link_id = l.id)
  ) then
    raise exception 'platform_links: a live % link already exists here; retract it first', new.platform using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_platform_links_guard before insert on public.platform_links
  for each row execute function public.xyp_platform_links_guard();

create or replace view public.current_platform_links with (security_invoker = true) as
  select l.id, l.platform, l.url, l.release_id, l.track_id, l.agent_run_id, l.created_at
  from public.platform_links l
  where not exists (select from public.platform_link_retractions r where r.platform_link_id = l.id);

-- ─── artwork and delivery status ────────────────────────────────────────────────────────────────
create table if not exists public.release_artwork (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  source_id    uuid not null references public.sources (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now()
);

create table if not exists public.release_deliveries (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  distributor  text not null,
  status       text not null,
  note         text,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint release_deliveries_distributor_check check (length(btrim(distributor)) > 0),
  constraint release_deliveries_status_check check (status in ('submitted', 'in_review', 'approved', 'live', 'rejected',
    'takedown_requested', 'taken_down')),
  constraint release_deliveries_note_check check (note is null or length(btrim(note)) > 0)
);

create index if not exists release_artwork_release_id_idx on public.release_artwork (release_id);
create index if not exists release_artwork_source_id_idx on public.release_artwork (source_id);
create index if not exists release_artwork_agent_run_id_idx on public.release_artwork (agent_run_id);
create index if not exists release_deliveries_release_id_idx on public.release_deliveries (release_id);
create index if not exists release_deliveries_agent_run_id_idx on public.release_deliveries (agent_run_id);

-- Artwork is a Vault image. SECURITY DEFINER: reads sources.
create or replace function public.xyp_release_artwork_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select from public.sources s where s.id = new.source_id and s.storage is not null and s.media_class = 'image') then
    raise exception 'release_artwork: source % is not a Vault image', new.source_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_release_artwork_guard before insert on public.release_artwork
  for each row execute function public.xyp_release_artwork_guard();

create or replace view public.current_release_artwork with (security_invoker = true) as
  select distinct on (a.release_id) a.id, a.release_id, a.source_id, a.agent_run_id, a.created_at
  from public.release_artwork a
  order by a.release_id, a.created_at desc, a.id desc;

create or replace view public.current_deliveries with (security_invoker = true) as
  select distinct on (d.release_id, lower(btrim(d.distributor))) d.id, d.release_id, btrim(d.distributor) as distributor, d.status, d.note,
         d.agent_run_id, d.created_at
  from public.release_deliveries d
  order by d.release_id, lower(btrim(d.distributor)), d.created_at desc, d.id desc;

-- ─── tracks: a Suno take or a Vault audio file (B4) ─────────────────────────────────────────────
alter table public.tracks alter column take_id drop not null;
alter table public.tracks add column if not exists source_id uuid references public.sources (id) on delete restrict;

do $$ begin
  if not exists (select from pg_constraint where conname = 'tracks_recording_check') then
    alter table public.tracks add constraint tracks_recording_check check (num_nonnulls(take_id, source_id) = 1);
  end if;
  if not exists (select from pg_constraint where conname = 'tracks_release_id_source_id_key') then
    alter table public.tracks add constraint tracks_release_id_source_id_key unique (release_id, source_id);
  end if;
end $$;

create index if not exists tracks_source_id_idx on public.tracks (source_id);

-- Phase 13's guard, widened: a Vault recording must be an audio file, and "one ISRC names one
-- recording" compares the recording, a take or a Vault file.
create or replace function public.xyp_tracks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.release_status;
  v_schema text;
begin
  if tg_op = 'INSERT' then
    -- FOR SHARE: a concurrent schedule of this release waits for this insert, and re-checks it.
    select r.status into v_status from public.releases r where r.id = new.release_id for share;
    if found and v_status <> 'draft' then
      raise exception 'tracks: release % is %; tracks are added to drafts only', new.release_id, v_status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.mix_report_artifact_id is not null then
      select a.schema_id into v_schema from public.creative_artifacts a where a.id = new.mix_report_artifact_id;
      if found and v_schema <> 'x3lius.mix-report/v1' then
        raise exception 'tracks: artifact % is %, not a x3lius.mix-report/v1', new.mix_report_artifact_id, v_schema
          using errcode = 'check_violation';
      end if;
    end if;
    if new.source_id is not null
       and not exists (select from public.sources s where s.id = new.source_id and s.storage is not null and s.media_class = 'audio') then
      raise exception 'tracks: source % is not a Vault audio file', new.source_id using errcode = 'check_violation';
    end if;
  elsif old.isrc is not null and new.isrc is distinct from old.isrc then
    raise exception 'tracks: % already has ISRC %; an assigned code never changes', old.id, old.isrc
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.isrc is not null and (tg_op = 'INSERT' or new.isrc is distinct from old.isrc) then
    perform pg_advisory_xact_lock(hashtext('xyp:isrc:' || new.isrc));
    if exists (
      select from public.tracks t
      where t.isrc = new.isrc and t.id <> new.id and (t.take_id, t.source_id) is distinct from (new.take_id, new.source_id)
    ) then
      raise exception 'tracks: ISRC % already names another recording', new.isrc using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ─── tasks (B2) ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  song_id      uuid references public.songs (id) on delete restrict,
  release_id   uuid references public.releases (id) on delete restrict,
  due_date     date,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint tasks_title_check check (length(btrim(title)) > 0),
  constraint tasks_target_check check (num_nonnulls(song_id, release_id) <= 1)
);

create table if not exists public.task_events (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete restrict,
  status       text not null,
  note         text,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint task_events_status_check check (status in ('open', 'done', 'cancelled')),
  constraint task_events_note_check check (note is null or length(btrim(note)) > 0)
);

create index if not exists tasks_song_id_idx on public.tasks (song_id);
create index if not exists tasks_release_id_idx on public.tasks (release_id);
create index if not exists tasks_agent_run_id_idx on public.tasks (agent_run_id);
create index if not exists task_events_task_id_idx on public.task_events (task_id);
create index if not exists task_events_agent_run_id_idx on public.task_events (agent_run_id);

create or replace view public.current_tasks with (security_invoker = true) as
  select t.id, t.title, t.song_id, t.release_id, t.due_date, t.agent_run_id, t.created_at,
         coalesce(e.status, 'open') as status, e.note as status_note, coalesce(e.created_at, t.created_at) as status_at
  from public.tasks t
  left join lateral (
    select ev.status, ev.note, ev.created_at from public.task_events ev where ev.task_id = t.id order by ev.created_at desc, ev.id desc limit 1
  ) e on true;

-- ─── append-only, for every role, the owner included ───────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['people', 'person_aliases', 'credits', 'credit_retractions', 'platform_links', 'platform_link_retractions',
    'release_artwork', 'release_deliveries', 'tasks', 'task_events'] loop
    execute format('create or replace trigger %I before update or delete on public.%I for each row execute function public.xyp_vault_immutable()',
      'trg_' || t || '_immutable', t);
  end loop;
end $$;

-- ─── computed readiness checks (B2) ─────────────────────────────────────────────────────────────
-- Never stored: fixing the data clears the check. Blockers are what the calendar would refuse or a
-- release can't ship without; warnings are gaps worth a look. The Rights check and the calendar
-- guard stay the enforcing rules (F31); this view is the dashboard's reading of the same data.
create or replace view public.catalog_checks with (security_invoker = true) as
  select 'blocker'::text as severity, 'release'::text as subject_kind, r.id as subject_id, r.id as release_id,
         'no_tracks'::text as code, 'the release has no tracks'::text as message
  from public.releases r where not exists (select from public.tracks t where t.release_id = r.id)
  union all
  select 'blocker', 'release', r.id, r.id, 'no_artwork', 'the release has no artwork'
  from public.releases r where not exists (select from public.release_artwork a where a.release_id = r.id)
  union all
  select 'warning', 'release', r.id, r.id, 'no_upc', 'the release has no UPC'
  from public.releases r where r.upc is null
  union all
  select 'warning', 'release', r.id, r.id, 'scheduled_no_delivery', 'scheduled, but no distributor delivery is recorded'
  from public.releases r where r.status = 'scheduled' and not exists (select from public.release_deliveries d where d.release_id = r.id)
  union all
  select 'warning', 'release', r.id, r.id, 'released_no_platform_link', 'released, but no platform link is recorded'
  from public.releases r
  where r.status = 'released'
    and not exists (select from public.current_platform_links l where l.release_id = r.id)
    and not exists (select from public.current_platform_links l join public.tracks t on t.id = l.track_id where t.release_id = r.id)
  union all
  select 'blocker', 'track', t.id, t.release_id, 'track_no_splits', 'the track has no rights split set'
  from public.tracks t where not exists (select from public.rights_splits s where s.track_id = t.id)
  union all
  select 'blocker', 'track', t.id, t.release_id, 'track_unassigned_share', 'the current split set has an unassigned share'
  from public.tracks t where exists (select from public.current_rights_splits c where c.track_id = t.id and c.payee is null)
  union all
  select 'warning', 'track', t.id, t.release_id, 'track_no_isrc', 'the track has no ISRC'
  from public.tracks t where t.isrc is null
  union all
  select 'warning', 'track', t.id, t.release_id, 'track_no_credits', 'the track has no credits'
  from public.tracks t where not exists (select from public.current_credits c where c.track_id = t.id)
  union all
  select 'warning', 'song', s.id, null::uuid, 'lyrics_not_approved', 'linked lyrics have no approved version'
  from public.current_songs s
  where s.status not in ('idea', 'archived')
    and exists (
      select from public.current_song_links l
      where l.song_id = s.id and l.artifact_lineage_id is not null
        and not exists (select from public.artifact_approvals a where a.lineage_id = l.artifact_lineage_id and a.status = 'approved'))
  union all
  select 'warning', 'song', s.id, null::uuid, 'no_credits', 'the song has no credits'
  from public.current_songs s
  where s.status not in ('idea', 'archived') and not exists (select from public.current_credits c where c.song_id = s.id)
  union all
  select 'warning', 'song', s.id, null::uuid, 'status_behind', 'a linked track is released, but the song is not marked released'
  from public.current_songs s
  where s.status not in ('released', 'archived')
    and exists (
      select from public.current_song_links l join public.tracks t on t.id = l.track_id join public.releases r on r.id = t.release_id
      where l.song_id = s.id and r.status = 'released')
  union all
  select 'warning', 'song', s.id, null::uuid, 'status_ahead', 'the song is marked released, but no linked track is released'
  from public.current_songs s
  where s.status = 'released'
    and not exists (
      select from public.current_song_links l join public.tracks t on t.id = l.track_id join public.releases r on r.id = t.release_id
      where l.song_id = s.id and r.status = 'released');

-- ─── grants, RLS ────────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['people', 'person_aliases', 'credits', 'credit_retractions', 'platform_links', 'platform_link_retractions',
    'release_artwork', 'release_deliveries', 'tasks', 'task_events'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

revoke all on table public.people, public.person_aliases, public.credits, public.credit_retractions, public.platform_links,
  public.platform_link_retractions, public.release_artwork, public.release_deliveries, public.tasks, public.task_events,
  public.current_credits, public.current_platform_links, public.current_release_artwork, public.current_deliveries,
  public.current_tasks, public.catalog_checks
  from anon, authenticated, service_role;

-- service_role reads everything new (G20: reads only).
grant select on table public.people, public.person_aliases, public.credits, public.credit_retractions, public.platform_links,
  public.platform_link_retractions, public.release_artwork, public.release_deliveries, public.tasks, public.task_events,
  public.current_credits, public.current_platform_links, public.current_release_artwork, public.current_deliveries,
  public.current_tasks, public.catalog_checks to service_role;

-- xyp_catalog: catalog metadata through records-catalog (catalog.write).
grant select, insert on table public.people, public.person_aliases, public.credits, public.credit_retractions, public.platform_links,
  public.platform_link_retractions, public.release_artwork, public.release_deliveries to xyp_catalog;
grant select on table public.current_credits, public.current_platform_links, public.current_release_artwork, public.current_deliveries
  to xyp_catalog;

-- xyp_tasks: the owner's to-dos through records-tasks (task.write).
grant select, insert on table public.tasks, public.task_events to xyp_tasks;
grant select on table public.current_tasks to xyp_tasks;

-- xyp_web: the UI reads everything new, and the checks' underlying tables it did not read yet.
grant select on table public.people, public.person_aliases, public.credits, public.credit_retractions, public.platform_links,
  public.platform_link_retractions, public.release_artwork, public.release_deliveries, public.tasks, public.task_events,
  public.current_credits, public.current_platform_links, public.current_release_artwork, public.current_deliveries,
  public.current_tasks, public.catalog_checks to xyp_web;

-- xyp_runtime: read_catalog and the catalog lookup read credits, links, artwork and deliveries.
grant select on table public.people, public.person_aliases, public.credits, public.credit_retractions, public.platform_links,
  public.platform_link_retractions, public.release_artwork, public.release_deliveries, public.current_credits,
  public.current_platform_links, public.current_release_artwork, public.current_deliveries to xyp_runtime;

do $$
declare
  v record;
begin
  for v in select * from (values
    ('people'), ('person_aliases'), ('credits'), ('credit_retractions'), ('platform_links'), ('platform_link_retractions'),
    ('release_artwork'), ('release_deliveries')
  ) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'catalog_select') then
      execute format('create policy catalog_select on public.%I for select to xyp_catalog using (true)', v.tbl);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'catalog_insert') then
      execute format('create policy catalog_insert on public.%I for insert to xyp_catalog with check (true)', v.tbl);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'runtime_select') then
      execute format('create policy runtime_select on public.%I for select to xyp_runtime using (true)', v.tbl);
    end if;
  end loop;
  for v in select * from (values ('tasks'), ('task_events')) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'tasks_select') then
      execute format('create policy tasks_select on public.%I for select to xyp_tasks using (true)', v.tbl);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'tasks_insert') then
      execute format('create policy tasks_insert on public.%I for insert to xyp_tasks with check (true)', v.tbl);
    end if;
  end loop;
  for v in select * from (values
    ('people'), ('person_aliases'), ('credits'), ('credit_retractions'), ('platform_links'), ('platform_link_retractions'),
    ('release_artwork'), ('release_deliveries'), ('tasks'), ('task_events')
  ) as p(tbl) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = 'web_select') then
      execute format('create policy web_select on public.%I for select to xyp_web using (true)', v.tbl);
    end if;
  end loop;
end $$;

revoke execute on function
  public.xyp_person_name_free(), public.xyp_credits_guard(), public.xyp_platform_links_guard(), public.xyp_release_artwork_guard()
  from public, anon, authenticated;
-- The URL check is a pure function inside a CHECK constraint: every role that inserts links needs it.
revoke execute on function public.xyp_platform_url_ok(text, text) from public, anon, authenticated;
grant execute on function public.xyp_platform_url_ok(text, text) to xyp_catalog, xyp_web, service_role;
