-- Rollback for 20260925110000_records.sql. Idempotent. No CASCADE.
drop function if exists public.xyp_apply_release_decision(uuid);
drop function if exists public.xyp_request_release_schedule(uuid);
drop table if exists public.records_flags;
drop table if exists public.release_schedule_requests;
drop function if exists public.xyp_records_flags_immutable();
do $$ begin
  if to_regclass('public.tracks') is not null then drop trigger if exists trg_tracks_lock on public.tracks; end if;
  if to_regclass('public.releases') is not null then drop trigger if exists trg_releases_guard on public.releases; end if;
end $$;
drop function if exists public.xyp_tracks_lock();
drop function if exists public.xyp_releases_guard();
-- approval_item_type keeps 'release_schedule': Postgres cannot drop an enum value; with no table
-- left to point at, the value is inert. Roles xyp_catalog / xyp_rights / xyp_calendar stay (cluster-wide).
do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_catalog') then revoke usage on schema public from xyp_catalog; end if;
  if exists (select from pg_roles where rolname = 'xyp_rights') then revoke usage on schema public from xyp_rights; end if;
  if exists (select from pg_roles where rolname = 'xyp_calendar') then revoke usage on schema public from xyp_calendar; end if;
end $$;
do $$ begin
  if to_regclass('public.rights_splits') is not null then
    drop trigger if exists trg_rights_splits_sum on public.rights_splits;
    drop trigger if exists trg_rights_splits_lock on public.rights_splits;
  end if;
end $$;
drop function if exists public.xyp_rights_splits_sum();
drop function if exists public.xyp_rights_splits_lock();
drop table if exists public.rights_splits;
drop table if exists public.tracks;
drop table if exists public.releases;
drop table if exists public.audit_log;
drop function if exists public.xyp_audit();
drop function if exists public.xyp_audit_log_immutable();
drop function if exists public.xyp_tracks_links();
drop function if exists public.xyp_touch_updated_at();
drop type if exists public.split_role;
drop type if exists public.release_status;
drop type if exists public.release_kind;
