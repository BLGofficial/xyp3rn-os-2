-- Phase 13 — XYP3RN Records: releases, tracks, rights_splits (ARCHITECTURE F3, spec
-- docs/superpowers/specs/2026-09-25-phase-13-records-design.md), plus the general audit_log
-- ARCHITECTURE.md names and no earlier migration created.
-- Every rule is a constraint or trigger: a direct INSERT cannot bypass it.
-- Idempotent. Rollback: supabase/rollbacks/20260925110000_records.down.sql

do $$ begin create type public.release_kind as enum ('single', 'ep', 'album');
exception when duplicate_object then null; end $$;
do $$ begin create type public.release_status as enum ('draft', 'pending_schedule', 'scheduled', 'released', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.split_role as enum ('writer', 'producer', 'performer', 'publisher', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.releases (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  kind         public.release_kind not null,
  upc          text,
  status       public.release_status not null default 'draft',
  release_date date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint releases_title_check check (length(trim(title)) > 0),
  constraint releases_upc_check check (upc is null or upc ~ '^[0-9]{12,13}$')
);
create unique index if not exists releases_upc_key on public.releases (upc) where upc is not null;

create table if not exists public.tracks (
  id               uuid primary key default gen_random_uuid(),
  release_id       uuid not null references public.releases (id) on delete restrict,
  position         integer not null,
  title            text not null,
  isrc             text,
  duration_seconds numeric,
  suno_take_id     uuid references public.suno_takes (id) on delete restrict,
  master_uri       text,
  master_sha256    text,
  artifact_ids     uuid[] not null default '{}',
  mix_report_id    uuid references public.creative_artifacts (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tracks_release_position_key unique (release_id, position),
  constraint tracks_position_check check (position >= 1),
  constraint tracks_title_check check (length(trim(title)) > 0),
  constraint tracks_isrc_check check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  constraint tracks_duration_check check (duration_seconds is null or duration_seconds > 0),
  constraint tracks_one_source check ((suno_take_id is not null) <> (master_uri is not null)),
  constraint tracks_master_hash_check check ((master_uri is null) = (master_sha256 is null)
    and (master_sha256 is null or master_sha256 ~ '^[0-9a-f]{64}$'))
);
create unique index if not exists tracks_isrc_key on public.tracks (isrc) where isrc is not null;
create index if not exists tracks_suno_take_id_idx on public.tracks (suno_take_id);
create index if not exists tracks_mix_report_id_idx on public.tracks (mix_report_id);

create table if not exists public.rights_splits (
  id         uuid primary key default gen_random_uuid(),
  track_id   uuid not null references public.tracks (id) on delete cascade,
  payee      text not null,
  role       public.split_role not null,
  percentage numeric(5, 2) not null,
  constraint rights_splits_payee_check check (length(trim(payee)) > 0),
  constraint rights_splits_percentage_check check (percentage > 0 and percentage <= 100),
  constraint rights_splits_track_payee_role_key unique (track_id, payee, role)
);

create or replace function public.xyp_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create or replace trigger trg_releases_touch before update on public.releases
  for each row execute function public.xyp_touch_updated_at();
create or replace trigger trg_tracks_touch before update on public.tracks
  for each row execute function public.xyp_touch_updated_at();

-- SECURITY DEFINER: the agent role that registers a track may not read every artifact column.
create or replace function public.xyp_tracks_links()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_missing uuid;
  v_schema text;
begin
  select a into v_missing from unnest(new.artifact_ids) as a
  where not exists (select from public.creative_artifacts c where c.id = a) limit 1;
  if v_missing is not null then
    raise exception 'tracks: artifact % does not exist', v_missing using errcode = 'foreign_key_violation';
  end if;
  if new.mix_report_id is not null then
    select schema_id into v_schema from public.creative_artifacts where id = new.mix_report_id;
    if found and v_schema <> 'x3lius.mix-report/v1' then
      raise exception 'tracks: mix_report_id % is a %, not x3lius.mix-report/v1', new.mix_report_id, v_schema
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger trg_tracks_links before insert or update on public.tracks
  for each row execute function public.xyp_tracks_links();

-- ─── audit_log: append-only, general ───────────────────────────────────────────
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  table_name text not null,
  row_id     uuid not null,
  op         text not null,
  old        jsonb,
  new        jsonb,
  constraint audit_log_op_check check (op in ('insert', 'update', 'delete'))
);
create index if not exists audit_log_row_id_idx on public.audit_log (row_id);

-- SECURITY DEFINER so any writing role can append. The actor is the SET ROLE in force (the agent's
-- xyp_* role, or service_role), not the definer: current_setting('role') survives the definer switch.
create or replace function public.xyp_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor, table_name, row_id, op, old, new)
  values (coalesce(nullif(current_setting('role', true), 'none'), session_user), tg_table_name,
          coalesce(new.id, old.id), lower(tg_op),
          case when tg_op = 'INSERT' then null else to_jsonb(old) end,
          case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return null;
end;
$$;
create or replace trigger trg_releases_audit after insert or update or delete on public.releases
  for each row execute function public.xyp_audit();
create or replace trigger trg_tracks_audit after insert or update or delete on public.tracks
  for each row execute function public.xyp_audit();
create or replace trigger trg_rights_splits_audit after insert or update or delete on public.rights_splits
  for each row execute function public.xyp_audit();

create or replace function public.xyp_audit_log_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.xyp_audit_log_immutable();

alter table public.audit_log enable row level security;
revoke all on table public.audit_log from anon, authenticated, service_role;
grant select on table public.audit_log to service_role;
do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'audit_log' and policyname = 'service_select') then
    create policy service_select on public.audit_log for select to service_role using (true);
  end if;
end $$;

-- Default deny from the start (tests/phase-01 guards every public table and function): RLS on,
-- nothing for anon/authenticated. Role grants and policies follow with the roles below.
alter table public.releases enable row level security;
alter table public.tracks enable row level security;
alter table public.rights_splits enable row level security;
revoke all on table public.releases, public.tracks, public.rights_splits from anon, authenticated;
revoke execute on function
  public.xyp_touch_updated_at(), public.xyp_tracks_links(), public.xyp_audit(), public.xyp_audit_log_immutable()
  from public, anon, authenticated;

-- ─── rights_splits: always exactly 100 per track, checked at COMMIT ──────────────
-- Deferred: a split set is entered row by row; the total is judged once the transaction is done.
-- A track with no split rows is allowed (nothing entered yet); the scheduling gate refuses it.
create or replace function public.xyp_rights_splits_sum()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_track uuid;
  v_total numeric;
  v_n integer;
begin
  foreach v_track in array array_remove(array[
    case when tg_op <> 'DELETE' then new.track_id end,
    case when tg_op <> 'INSERT' then old.track_id end], null)
  loop
    select coalesce(sum(percentage), 0), count(*) into v_total, v_n from public.rights_splits where track_id = v_track;
    if v_n > 0 and v_total <> 100 then
      raise exception 'rights_splits_sum_not_100: track % totals %', v_track, v_total using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end;
$$;
-- A constraint trigger cannot be CREATE OR REPLACEd: drop + create keeps the migration idempotent.
drop trigger if exists trg_rights_splits_sum on public.rights_splits;
create constraint trigger trg_rights_splits_sum after insert or update or delete on public.rights_splits
  deferrable initially deferred for each row execute function public.xyp_rights_splits_sum();

-- ─── rights_splits: locked once the release leaves draft ────────────────────────
create or replace function public.xyp_rights_splits_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.release_status;
begin
  select r.status into v_status from public.tracks t join public.releases r on r.id = t.release_id
  where t.id = coalesce(new.track_id, old.track_id);
  if v_status in ('pending_schedule', 'scheduled', 'released') then
    raise exception 'splits_locked_after_schedule: the release is %', v_status using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end;
$$;
create or replace trigger trg_rights_splits_lock before insert or update or delete on public.rights_splits
  for each row execute function public.xyp_rights_splits_lock();
revoke execute on function public.xyp_rights_splits_sum(), public.xyp_rights_splits_lock() from public, anon, authenticated;

-- ─── releases: status path + scheduling gate + locks outside draft ──────────────
create or replace function public.xyp_releases_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_bad text;
begin
  if tg_op = 'UPDATE' and old.status <> 'draft'
     and (new.title, new.kind, new.release_date) is distinct from (old.title, old.kind, old.release_date) then
    raise exception 'release_locked: a % release may change only its status and UPC', old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('pending_schedule', 'cancelled'))
    or (old.status = 'pending_schedule' and new.status in ('scheduled', 'draft', 'cancelled'))
    or (old.status = 'scheduled' and new.status in ('released', 'cancelled'))) then
    raise exception 'release_status_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'release_status_transition: a release starts as draft' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.status in ('pending_schedule', 'scheduled') and new.status is distinct from old.status then
    if new.release_date is null then
      v_bad := 'no release_date';
    elsif not exists (select from public.tracks where release_id = new.id) then
      v_bad := 'no tracks';
    else
      select format('track %s has no splits', t.position) into v_bad from public.tracks t
      where t.release_id = new.id and not exists (select from public.rights_splits s where s.track_id = t.id)
      order by t.position limit 1;
      if v_bad is null then
        select format('track %s has UNASSIGNED %s', t.position, s.percentage) into v_bad
        from public.tracks t join public.rights_splits s on s.track_id = t.id
        where t.release_id = new.id and s.payee = 'UNASSIGNED' order by t.position limit 1;
      end if;
    end if;
    if v_bad is not null then
      raise exception 'release_not_schedulable: %', v_bad using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger trg_releases_guard before insert or update on public.releases
  for each row execute function public.xyp_releases_guard();

create or replace function public.xyp_tracks_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.release_status;
begin
  select status into v_status from public.releases where id = coalesce(new.release_id, old.release_id);
  if v_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['isrc', 'updated_at']) = (to_jsonb(old) - array['isrc', 'updated_at']) then
    return new;
  end if;
  raise exception 'track_locked: the release is %; only ISRC may change', v_status using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_tracks_lock before insert or update or delete on public.tracks
  for each row execute function public.xyp_tracks_lock();

-- ─── scheduling requests and approval (spec §3.5, amendment 1) ──────────────────
alter type public.approval_item_type add value if not exists 'release_schedule';

create table if not exists public.release_schedule_requests (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  release_date date not null,
  requested_at timestamptz not null default now(),
  applied_at   timestamptz
);
create index if not exists release_schedule_requests_release_id_idx on public.release_schedule_requests (release_id);

create table if not exists public.records_flags (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  report       jsonb not null,
  created_at   timestamptz not null default now(),
  constraint records_flags_report_check check (jsonb_typeof(report) = 'object')
);
create index if not exists records_flags_release_id_idx on public.records_flags (release_id);

create or replace function public.xyp_records_flags_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'records_flags is append-only' using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_records_flags_immutable before update or delete on public.records_flags
  for each row execute function public.xyp_records_flags_immutable();

create or replace function public.xyp_request_release_schedule(p_release uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_release public.releases;
  v_request uuid;
  v_approval uuid;
begin
  update public.releases set status = 'pending_schedule' where id = p_release and status = 'draft'
  returning * into v_release;
  if not found then
    raise exception 'release % is not a draft', p_release using errcode = 'object_not_in_prerequisite_state';
  end if;
  insert into public.release_schedule_requests (release_id, release_date) values (p_release, v_release.release_date)
  returning id into v_request;
  insert into public.approval_queue (item_type, item_id, request)
  values ('release_schedule', v_request, jsonb_build_object(
    'release_id', p_release, 'title', v_release.title, 'release_date', v_release.release_date,
    'tracks', (select jsonb_agg(jsonb_build_object('position', position, 'title', title) order by position)
               from public.tracks where release_id = p_release)))
  returning id into v_approval;
  return v_approval;
end;
$$;

create or replace function public.xyp_apply_release_decision(p_approval uuid)
returns public.release_status language plpgsql security definer set search_path = '' as $$
declare
  v_q public.approval_queue;
  v_req public.release_schedule_requests;
  v_status public.release_status;
begin
  select * into v_q from public.approval_queue where id = p_approval and item_type = 'release_schedule';
  if not found then
    raise exception 'no release_schedule approval %', p_approval using errcode = 'foreign_key_violation';
  end if;
  if v_q.status = 'pending' then
    raise exception 'approval % is still pending', p_approval using errcode = 'object_not_in_prerequisite_state';
  end if;
  update public.release_schedule_requests set applied_at = now() where id = v_q.item_id and applied_at is null
  returning * into v_req;
  if not found then
    raise exception 'approval % was already applied', p_approval using errcode = 'object_not_in_prerequisite_state';
  end if;
  update public.releases set status = (case v_q.status when 'approved' then 'scheduled' else 'draft' end)::public.release_status
  where id = v_req.release_id and status = 'pending_schedule'
  returning status into v_status;
  if not found then
    raise exception 'release % is no longer pending_schedule', v_req.release_id using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_status;
end;
$$;

-- ─── roles and grants ─────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_catalog') then create role xyp_catalog nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_rights') then create role xyp_rights nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_calendar') then create role xyp_calendar nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;

grant usage on schema public to xyp_catalog, xyp_rights, xyp_calendar;

do $$
declare
  t text;
begin
  foreach t in array array['releases', 'tracks', 'rights_splits', 'records_flags', 'release_schedule_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role, xyp_runtime, xyp_catalog, xyp_rights, xyp_calendar', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'records_select') then
      execute format('create policy records_select on public.%I for select to service_role, xyp_runtime, xyp_catalog, xyp_rights, xyp_calendar using (true)', t);
    end if;
  end loop;
end $$;

grant insert (title, kind, upc) on table public.releases to xyp_catalog;
grant update (title, kind, upc) on table public.releases to xyp_catalog;
grant insert (release_id, position, title, isrc, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
  on table public.tracks to xyp_catalog;
grant update (title, position, isrc, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
  on table public.tracks to xyp_catalog;
grant update (release_date) on table public.releases to xyp_calendar;
grant insert on table public.records_flags to xyp_rights;
grant insert, update, delete on table public.rights_splits to service_role;
grant insert, update on table public.releases, public.tracks to service_role;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'releases' and policyname = 'catalog_write') then
    create policy catalog_write on public.releases for all to xyp_catalog, xyp_calendar, service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'tracks' and policyname = 'catalog_write') then
    create policy catalog_write on public.tracks for all to xyp_catalog, service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'rights_splits' and policyname = 'operator_write') then
    create policy operator_write on public.rights_splits for all to service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'records_flags' and policyname = 'rights_insert') then
    create policy rights_insert on public.records_flags for insert to xyp_rights with check (true);
  end if;
end $$;

revoke execute on function
  public.xyp_releases_guard(), public.xyp_tracks_lock(), public.xyp_records_flags_immutable()
  from public, anon, authenticated;
revoke execute on function public.xyp_request_release_schedule(uuid) from public, anon, authenticated, service_role;
grant execute on function public.xyp_request_release_schedule(uuid) to xyp_calendar;
revoke execute on function public.xyp_apply_release_decision(uuid) from public, anon, authenticated;
grant execute on function public.xyp_apply_release_decision(uuid) to service_role;
