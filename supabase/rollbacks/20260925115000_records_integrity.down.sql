do $rollback$ begin
 if to_regclass('public.releases') is not null then
 execute $restore$
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

$restore$;
 end if;
end $rollback$;
alter table if exists public.rights_splits drop constraint if exists rights_splits_unassigned_spelling;
alter table if exists public.releases drop column if exists integrity_version;
drop table if exists xyp_meta.records_schedule_authorizations;

