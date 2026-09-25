-- Phase 13 — Records ops: the catalog (releases, tracks), rights splits and the release calendar.
-- - releases       registered as drafts by xyp_catalog; moved through the calendar
--                  (draft → scheduled → released, scheduled → draft) by xyp_release_calendar only.
-- - tracks         one finished take (a Phase 9 suno_takes row) on a release; added to drafts only.
-- - rights_splits  append-only, versioned per track. Every committed set sums to exactly 100
--                  (deferred constraint trigger, every role, the owner included). payee null is the
--                  explicit unassigned share, which the sum counts (ARCHITECTURE F31).
-- - The scheduling guard: a release enters scheduled/released only with tracks, a current split set
--   on every track, no unassigned share, a valid date, and a passing records-rights-splits run.
-- - ISRC / UPC: nullable until assigned, format-checked, assigned once.
-- Concurrency: split writes serialize per track (advisory lock), and split, track and calendar writes
-- all lock the release row, so a set and a schedule can never both commit past each other's check.
-- Idempotent. Rollback: supabase/rollbacks/20260925110000_records_ops.down.sql

do $$ begin create type public.release_status as enum ('draft', 'scheduled', 'released');
exception when duplicate_object then null; end $$;

-- GS1 mod-10 check digit (UPC-A 12 digits, EAN-13 13 digits): weights 3,1,3,… from the right,
-- skipping the check digit itself. Pure, so a CHECK constraint can call it.
create or replace function public.xyp_is_valid_gs1(p_code text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select p_code ~ '^[0-9]{12,13}$'
    and (10 - (
      select sum(substr(p_code, length(p_code) - i, 1)::int * case when i % 2 = 1 then 3 else 1 end)
      from generate_series(1, length(p_code) - 1) as i
    ) % 10) % 10 = right(p_code, 1)::int
$$;

create table if not exists public.releases (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  artist              text not null,
  kind                text not null,
  upc                 text,
  status              public.release_status not null default 'draft',
  release_date        date,
  -- The records-rights-splits run whose passing verdict cleared this release (§4.5 rule 5).
  rights_check_run_id uuid references public.agent_runs (id) on delete restrict,
  agent_run_id        uuid not null references public.agent_runs (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint releases_upc_key unique (upc),
  constraint releases_title_check check (length(btrim(title)) > 0),
  constraint releases_artist_check check (length(btrim(artist)) > 0),
  constraint releases_kind_check check (kind in ('single', 'ep', 'album')),
  constraint releases_upc_check check (upc is null or public.xyp_is_valid_gs1(upc)),
  constraint releases_date_check check (status = 'draft' or release_date is not null),
  constraint releases_rights_check_run_check check (status = 'draft' or rights_check_run_id is not null)
);

create table if not exists public.tracks (
  id                     uuid primary key default gen_random_uuid(),
  release_id             uuid not null references public.releases (id) on delete restrict,
  position               integer not null,
  title                  text not null,
  isrc                   text,
  take_id                uuid not null references public.suno_takes (id) on delete restrict,
  mix_report_artifact_id uuid references public.creative_artifacts (id) on delete restrict,
  agent_run_id           uuid not null references public.agent_runs (id) on delete restrict,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint tracks_release_id_position_key unique (release_id, position),
  constraint tracks_release_id_take_id_key unique (release_id, take_id),
  constraint tracks_release_id_isrc_key unique (release_id, isrc),
  constraint tracks_title_check check (length(btrim(title)) > 0),
  constraint tracks_position_check check (position > 0),
  -- ISO 3901, stored without hyphens: country (2), registrant (3), year (2), designation (5).
  constraint tracks_isrc_check check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$')
);

create table if not exists public.rights_splits (
  id           uuid primary key default gen_random_uuid(),
  track_id     uuid not null references public.tracks (id) on delete restrict,
  version      integer not null,
  -- null = the unassigned share: counted by the sum, refused once the release is scheduled.
  payee        text,
  percentage   numeric(6, 3) not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint rights_splits_track_id_version_payee_key unique nulls not distinct (track_id, version, payee),
  constraint rights_splits_version_check check (version >= 1),
  constraint rights_splits_payee_check check (payee is null or length(btrim(payee)) > 0),
  constraint rights_splits_percentage_check check (percentage > 0 and percentage <= 100)
);

create index if not exists releases_agent_run_id_idx on public.releases (agent_run_id);
create index if not exists releases_rights_check_run_id_idx on public.releases (rights_check_run_id);
create index if not exists tracks_take_id_idx on public.tracks (take_id);
create index if not exists tracks_isrc_idx on public.tracks (isrc);
create index if not exists tracks_mix_report_artifact_id_idx on public.tracks (mix_report_artifact_id);
create index if not exists tracks_agent_run_id_idx on public.tracks (agent_run_id);
create index if not exists rights_splits_agent_run_id_idx on public.rights_splits (agent_run_id);

-- Each track's highest-version split set. security_invoker: callers read with their own grants.
create or replace view public.current_rights_splits with (security_invoker = true) as
  select rs.id, rs.track_id, rs.version, rs.payee, rs.percentage, rs.agent_run_id, rs.created_at
  from public.rights_splits rs
  where rs.version = (select max(m.version) from public.rights_splits m where m.track_id = rs.track_id);

-- ─── releases: registered as drafts; codes assigned once; the calendar and its guard ─────────────
-- SECURITY DEFINER: the guard reads tracks, rights_splits and agent_runs, which xyp_release_calendar
-- cannot all read.
create or replace function public.xyp_releases_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_track record;
  v_run record;
  v_unassigned numeric;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'releases: a release is registered as a draft, not %', new.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;

  if old.upc is not null and new.upc is distinct from old.upc then
    raise exception 'releases: % already has UPC %; an assigned code never changes', old.id, old.upc
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.status is distinct from old.status
     and (old.status, new.status) not in (('draft', 'scheduled'), ('scheduled', 'draft'), ('scheduled', 'released')) then
    raise exception 'releases: % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.status in ('scheduled', 'released')
     and (new.status is distinct from old.status
          or new.release_date is distinct from old.release_date
          or new.rights_check_run_id is distinct from old.rights_check_run_id) then
    if new.rights_check_run_id is null then
      raise exception 'releases: % needs a passing records-rights-splits run to be %', new.id, new.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if not exists (select from public.tracks t where t.release_id = new.id) then
      raise exception 'releases: % has no tracks', new.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    for v_track in select t.id from public.tracks t where t.release_id = new.id order by t.position loop
      if not exists (select from public.rights_splits rs where rs.track_id = v_track.id) then
        raise exception 'releases: track % has no split set', v_track.id
          using errcode = 'object_not_in_prerequisite_state';
      end if;
      select c.percentage into v_unassigned from public.current_rights_splits c where c.track_id = v_track.id and c.payee is null;
      if found then
        raise exception 'releases: track % has an unassigned share (% percent)', v_track.id, v_unassigned
          using errcode = 'object_not_in_prerequisite_state';
      end if;
    end loop;
    if new.status = 'scheduled' and new.release_date < current_date then
      raise exception 'releases: % cannot be scheduled for % (in the past)', new.id, new.release_date
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if new.status = 'released' and new.release_date > current_date then
      raise exception 'releases: % cannot be released before its date %', new.id, new.release_date
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    -- dispatch stores a run's output as { result: <handler output>, logs } (core/orchestrator/dispatch.ts).
    select r.agent_name, r.status::text as status, r.output into v_run from public.agent_runs r where r.id = new.rights_check_run_id;
    if not found
       or v_run.agent_name <> 'records-rights-splits'
       or v_run.status <> 'success'
       or coalesce(v_run.output #>> '{result,verdict}', '') <> 'pass'
       or coalesce(v_run.output #>> '{result,releaseId}', '') <> new.id::text then
      raise exception 'releases: run % is not a passing records-rights-splits check of %', new.rights_check_run_id, new.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_releases_guard before insert or update on public.releases
  for each row execute function public.xyp_releases_guard();
create or replace trigger trg_releases_updated_at before update on public.releases
  for each row execute function public.xyp_set_updated_at();

-- ─── tracks: drafts only; a mix report link is a mix report; an ISRC names one recording ─────────
-- SECURITY DEFINER: reads releases (row lock), creative_artifacts and other tracks.
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
  elsif old.isrc is not null and new.isrc is distinct from old.isrc then
    raise exception 'tracks: % already has ISRC %; an assigned code never changes', old.id, old.isrc
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.isrc is not null and (tg_op = 'INSERT' or new.isrc is distinct from old.isrc) then
    perform pg_advisory_xact_lock(hashtext('xyp:isrc:' || new.isrc));
    if exists (select from public.tracks t where t.isrc = new.isrc and t.take_id <> new.take_id and t.id <> new.id) then
      raise exception 'tracks: ISRC % already names another recording (take)', new.isrc
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_tracks_guard before insert or update on public.tracks
  for each row execute function public.xyp_tracks_guard();
create or replace trigger trg_tracks_updated_at before update on public.tracks
  for each row execute function public.xyp_set_updated_at();

-- ─── rights_splits: version order, no unassigned share once scheduled, sum = 100, append-only ────
-- SECURITY DEFINER: reads tracks and releases (row lock) and every row of the track's sets.
create or replace function public.xyp_rights_splits_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.release_status;
  v_max integer;
begin
  -- One split writer per track at a time, until commit: the version rule and the deferred sum
  -- then always see the other writer's committed rows.
  perform pg_advisory_xact_lock(hashtext('xyp:rights_splits:' || new.track_id::text));
  select r.status into v_status
    from public.tracks t join public.releases r on r.id = t.release_id
    where t.id = new.track_id
    for share of r;
  if new.payee is null and v_status in ('scheduled', 'released') then
    raise exception 'rights_splits: track % is on a % release; an unassigned share is refused', new.track_id, v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select max(rs.version) into v_max from public.rights_splits rs where rs.track_id = new.track_id;
  if new.version <> coalesce(v_max, 0) + 1 and new.version is distinct from v_max then
    raise exception 'rights_splits: track % is at version %; a new row is version % or %',
      new.track_id, coalesce(v_max, 0), coalesce(v_max, 1), coalesce(v_max, 0) + 1
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_rights_splits_guard before insert on public.rights_splits
  for each row execute function public.xyp_rights_splits_guard();

create or replace function public.xyp_rights_splits_sum()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sum numeric;
begin
  select sum(rs.percentage) into v_sum from public.rights_splits rs
    where rs.track_id = new.track_id and rs.version = new.version;
  if v_sum <> 100 then
    raise exception 'rights_splits: track % version % sums to %, not 100', new.track_id, new.version, v_sum
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- Deferred to commit: a set is written row by row in one transaction and checked whole.
drop trigger if exists trg_rights_splits_sum on public.rights_splits;
create constraint trigger trg_rights_splits_sum after insert on public.rights_splits
  deferrable initially deferred
  for each row execute function public.xyp_rights_splits_sum();

create or replace function public.xyp_rights_splits_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rights_splits % is append-only: a change of splits is a new version', old.id
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create or replace trigger trg_rights_splits_immutable before update or delete on public.rights_splits
  for each row execute function public.xyp_rights_splits_immutable();

-- ─── resolve_take's one read of the Suno trail ────────────────────────────────────────────────────
-- xyp_runtime may not read the Suno trail (Phase 9 boundary, tests/phase-09). The catalog lookup needs
-- one take's chain, so this returns exactly that — ids, titles, schema id — and nothing else.
create or replace function public.xyp_resolve_take(p_take_id uuid)
returns table (
  take_id uuid, audio_url text, take_title text, duration_seconds numeric,
  submission_id uuid, adapter text, suno_model text,
  formula_artifact_id uuid, formula_schema_id text, formula_title text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.audio_url, t.title, t.duration_seconds,
         s.id, s.adapter, s.suno_model,
         a.id, a.schema_id, a.body ->> 'title'
  from public.suno_takes t
  join public.suno_submissions s on s.id = t.submission_id
  join public.creative_artifacts a on a.id = s.formula_artifact_id
  where t.id = p_take_id
$$;

-- ─── roles and grants ────────────────────────────────────────────────────────────────────────────
-- Roles are cluster-wide: parallel test databases can race on "not exists" (Phase 12 pattern).
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_catalog') then
    create role xyp_catalog nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_release_calendar') then
    create role xyp_release_calendar nologin noinherit;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;

grant usage on schema public to xyp_catalog, xyp_release_calendar;

alter table public.releases enable row level security;
alter table public.tracks enable row level security;
alter table public.rights_splits enable row level security;
-- service_role loses the Supabase default ALL: it reads; every write goes through an agent run.
revoke all on table public.releases, public.tracks, public.rights_splits, public.current_rights_splits from anon, authenticated, service_role;

grant select on table public.releases, public.tracks, public.rights_splits, public.current_rights_splits
  to service_role, xyp_runtime, xyp_catalog, xyp_release_calendar;
grant insert on table public.releases, public.tracks, public.rights_splits to xyp_catalog;
grant update (upc) on table public.releases to xyp_catalog;
grant update (isrc) on table public.tracks to xyp_catalog;
grant update (status, release_date, rights_check_run_id) on table public.releases to xyp_release_calendar;


do $$
declare
  v record;
begin
  for v in select * from (values
    ('releases', 'catalog_select', 'select', 'xyp_catalog'),
    ('releases', 'catalog_insert', 'insert', 'xyp_catalog'),
    ('releases', 'catalog_update', 'update', 'xyp_catalog'),
    ('releases', 'release_calendar_select', 'select', 'xyp_release_calendar'),
    ('releases', 'release_calendar_update', 'update', 'xyp_release_calendar'),
    ('releases', 'runtime_select', 'select', 'xyp_runtime'),
    ('releases', 'service_select', 'select', 'service_role'),
    ('tracks', 'catalog_select', 'select', 'xyp_catalog'),
    ('tracks', 'catalog_insert', 'insert', 'xyp_catalog'),
    ('tracks', 'catalog_update', 'update', 'xyp_catalog'),
    ('tracks', 'release_calendar_select', 'select', 'xyp_release_calendar'),
    ('tracks', 'runtime_select', 'select', 'xyp_runtime'),
    ('tracks', 'service_select', 'select', 'service_role'),
    ('rights_splits', 'catalog_select', 'select', 'xyp_catalog'),
    ('rights_splits', 'catalog_insert', 'insert', 'xyp_catalog'),
    ('rights_splits', 'release_calendar_select', 'select', 'xyp_release_calendar'),
    ('rights_splits', 'runtime_select', 'select', 'xyp_runtime'),
    ('rights_splits', 'service_select', 'select', 'service_role')
  ) as p(tbl, policy, cmd, role) loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = v.tbl and policyname = v.policy) then
      execute format('create policy %I on public.%I for %s to %I %s', v.policy, v.tbl, v.cmd, v.role,
        case v.cmd when 'insert' then 'with check (true)' when 'update' then 'using (true) with check (true)' else 'using (true)' end);
    end if;
  end loop;
end $$;

revoke execute on function
  public.xyp_releases_guard(),
  public.xyp_tracks_guard(),
  public.xyp_rights_splits_guard(),
  public.xyp_rights_splits_sum(),
  public.xyp_rights_splits_immutable()
  from public, anon, authenticated;
revoke execute on function public.xyp_is_valid_gs1(text) from public, anon, authenticated;
grant execute on function public.xyp_is_valid_gs1(text) to service_role, xyp_runtime, xyp_catalog, xyp_release_calendar;
revoke execute on function public.xyp_resolve_take(uuid) from public, anon, authenticated, service_role;
grant execute on function public.xyp_resolve_take(uuid) to xyp_runtime;
