-- Rollback for 20260925110000_records_ops.sql. Idempotent. No CASCADE.
-- The xyp_catalog and xyp_release_calendar roles stay (cluster-wide, like xyp_critic); their
-- privileges go with the objects dropped here.

drop function if exists public.xyp_resolve_take(uuid);
drop view if exists public.current_rights_splits;
drop table if exists public.rights_splits;
drop table if exists public.tracks;
drop table if exists public.releases;
drop function if exists public.xyp_rights_splits_guard();
drop function if exists public.xyp_rights_splits_sum();
drop function if exists public.xyp_rights_splits_immutable();
drop function if exists public.xyp_tracks_guard();
drop function if exists public.xyp_releases_guard();
drop function if exists public.xyp_is_valid_gs1(text);
drop type if exists public.release_status;

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_catalog') then
    revoke usage on schema public from xyp_catalog;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_release_calendar') then
    revoke usage on schema public from xyp_release_calendar;
  end if;
end $$;
