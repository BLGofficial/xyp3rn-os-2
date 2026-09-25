-- Rollback for 20260925150000_command_center.sql. Idempotent. No CASCADE.
-- The xyp_tasks role stays (cluster-wide); its privileges go with the objects dropped here.
-- Refuses (fails loudly) while any track's recording is a Vault file: restoring take_id NOT NULL
-- would otherwise need those tracks deleted, and a rollback never deletes data.

drop view if exists public.catalog_checks;
drop view if exists public.current_tasks;
drop view if exists public.current_deliveries;
drop view if exists public.current_release_artwork;
drop view if exists public.current_platform_links;
drop view if exists public.current_credits;

drop table if exists public.task_events;
drop table if exists public.tasks;
drop table if exists public.release_deliveries;
drop table if exists public.release_artwork;
drop table if exists public.platform_link_retractions;
drop table if exists public.platform_links;
drop table if exists public.credit_retractions;
drop table if exists public.credits;
drop table if exists public.person_aliases;
drop table if exists public.people;

drop function if exists public.xyp_release_artwork_guard();
drop function if exists public.xyp_platform_links_guard();
drop function if exists public.xyp_platform_url_ok(text, text);
drop function if exists public.xyp_credits_guard();
drop function if exists public.xyp_person_name_free();

do $$ begin
  if to_regclass('public.tracks') is not null then
    if exists (select from public.tracks where source_id is not null) then
      raise exception 'rollback 20260925150000: tracks whose recording is a Vault file exist; remove them before rolling back';
    end if;
    alter table public.tracks drop constraint if exists tracks_release_id_source_id_key;
    alter table public.tracks drop constraint if exists tracks_recording_check;
    drop index if exists public.tracks_source_id_idx;
    alter table public.tracks drop column if exists source_id;
    alter table public.tracks alter column take_id set not null;
  end if;
end $$;

-- Phase 13's tracks guard, restored verbatim (20260925110000_records_ops.sql), while tracks exist: a second
-- run (idempotency) finds them dropped by that migration's own rollback, and the body names its type.
do $do$ begin
  if to_regclass('public.tracks') is not null and to_regtype('public.release_status') is not null then
    execute $ddl$
create or replace function public.xyp_tracks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
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
$fn$
    $ddl$;
  end if;
end $do$;

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_tasks') then
    revoke usage on schema public from xyp_tasks;
  end if;
end $$;
