-- Corrective review: serialize catalog/rights and close operator approval bypasses.
alter table public.releases add column if not exists integrity_version bigint not null default 0;
create schema if not exists xyp_meta;
create table if not exists xyp_meta.records_schedule_authorizations (
  transaction_id bigint not null,
  release_id uuid not null,
  target_status public.release_status not null,
  primary key(transaction_id, release_id)
);
revoke all on xyp_meta.records_schedule_authorizations from public, anon, authenticated, service_role;

-- Supabase defaults grant service_role more than explicitly requested in Phase 13.
revoke all on public.releases,public.tracks,public.rights_splits,public.records_flags,public.release_schedule_requests from service_role;
grant select on public.releases,public.tracks,public.rights_splits,public.records_flags,public.release_schedule_requests to service_role;
grant insert,update on public.releases,public.tracks to service_role;
grant insert,update,delete on public.rights_splits to service_role;
revoke update(integrity_version) on public.releases from xyp_catalog,xyp_calendar;
do $$ begin
  if not exists(select from pg_constraint where conrelid='public.rights_splits'::regclass and conname='rights_splits_unassigned_spelling') then
    alter table public.rights_splits add constraint rights_splits_unassigned_spelling
      check (upper(btrim(payee)) <> 'UNASSIGNED' or payee = 'UNASSIGNED');
  end if;
end $$;

create or replace function public.xyp_rights_splits_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare rid uuid; v_status public.release_status;
begin
  if tg_op='UPDATE' and new.track_id is distinct from old.track_id then
    raise exception 'splits_locked_after_schedule: split parent is immutable; replace draft allocations atomically' using errcode='55000';
  end if;
  -- Lock both OLD and NEW parents in deterministic order. UPDATE makes stale higher-isolation
  -- snapshots fail with 40001; SELECT FOR UPDATE alone would leave the aggregate snapshot stale.
  for rid in select distinct t.release_id from public.tracks t
    where t.id = any(array_remove(array[
      case when tg_op <> 'DELETE' then new.track_id end,
      case when tg_op <> 'INSERT' then old.track_id end],null)) order by t.release_id
  loop
    update public.releases set integrity_version=integrity_version+1 where id=rid returning status into v_status;
    if v_status in ('pending_schedule','scheduled','released') then
      raise exception 'splits_locked_after_schedule: the release is %',v_status using errcode='55000';
    end if;
  end loop;
  return coalesce(new,old);
end $$;

create or replace function public.xyp_tracks_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare rid uuid; v_status public.release_status;
begin
  if tg_op='UPDATE' and new.release_id is distinct from old.release_id then
    raise exception 'track_locked: catalog release parent is immutable' using errcode='55000';
  end if;
  for rid in select distinct x from unnest(array_remove(array[
      case when tg_op <> 'DELETE' then new.release_id end,
      case when tg_op <> 'INSERT' then old.release_id end],null)) x order by x
  loop
    update public.releases set integrity_version=integrity_version+1 where id=rid returning status into v_status;
    if v_status <> 'draft' then
      if tg_op = 'UPDATE'
        and (to_jsonb(new)-array['isrc','updated_at'])=(to_jsonb(old)-array['isrc','updated_at'])
        and (new.isrc is not distinct from old.isrc or old.isrc is null) then
        continue;
      end if;
      raise exception 'track_locked: the release is %; an unassigned ISRC may be assigned once',v_status using errcode='55000';
    end if;
  end loop;
  return coalesce(new,old);
end $$;

create or replace function public.xyp_releases_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bad text; authorized boolean;
begin
  if tg_op='UPDATE' and old.status<>'draft' and (
    (new.title,new.kind,new.release_date) is distinct from (old.title,old.kind,old.release_date)
    or (old.upc is not null and new.upc is distinct from old.upc)) then
    raise exception 'release_locked: a % release may change only status or assign its UPC once',old.status using errcode='55000';
  end if;
  if tg_op='UPDATE' and new.status is distinct from old.status and not (
       (old.status='draft' and new.status in ('pending_schedule','cancelled'))
    or (old.status='pending_schedule' and new.status in ('scheduled','draft','cancelled'))
    or (old.status='scheduled' and new.status in ('released','cancelled'))) then
    raise exception 'release_status_transition: % -> %',old.status,new.status using errcode='23514';
  end if;
  if tg_op='INSERT' and new.status<>'draft' then
    raise exception 'release_status_transition: a release starts as draft' using errcode='23514';
  end if;
  if tg_op='UPDATE' and old.status='pending_schedule' and new.status in ('scheduled','draft') then
    delete from xyp_meta.records_schedule_authorizations where transaction_id=txid_current()
      and release_id=new.id and target_status=new.status returning true into authorized;
    if authorized is distinct from true then
      raise exception 'release_status_transition: only through xyp_apply_release_decision' using errcode='23514';
    end if;
  end if;
  if tg_op='UPDATE' and new.status in ('pending_schedule','scheduled') and new.status is distinct from old.status then
    if new.release_date is null then v_bad:='no release_date';
    elsif not exists(select from public.tracks where release_id=new.id) then v_bad:='no tracks';
    else
      select format('track %s has no splits',t.position) into v_bad from public.tracks t
        where t.release_id=new.id and not exists(select from public.rights_splits s where s.track_id=t.id) order by t.position limit 1;
      if v_bad is null then
        select format('track %s has UNASSIGNED %s',t.position,s.percentage) into v_bad
          from public.tracks t join public.rights_splits s on s.track_id=t.id
          where t.release_id=new.id and s.payee='UNASSIGNED' order by t.position limit 1;
      end if;
      if v_bad is null then
        select format('track %s rights total %s',t.position,sum(s.percentage)) into v_bad
          from public.tracks t join public.rights_splits s on s.track_id=t.id
          where t.release_id=new.id group by t.id having sum(s.percentage)<>100 limit 1;
      end if;
    end if;
    if v_bad is not null then raise exception 'release_not_schedulable: %',v_bad using errcode='23514'; end if;
  end if;
  return new;
end $$;

create or replace function public.xyp_apply_release_decision(p_approval uuid)
returns public.release_status language plpgsql security definer set search_path = '' as $$
declare v_q public.approval_queue; v_req public.release_schedule_requests; v_release public.releases; v_status public.release_status;
begin
  select * into v_q from public.approval_queue where id=p_approval and item_type='release_schedule' for update;
  if not found then raise exception 'no release_schedule approval %',p_approval using errcode='23503'; end if;
  if v_q.status='pending' then raise exception 'approval % is still pending',p_approval using errcode='55000'; end if;
  select * into v_req from public.release_schedule_requests where id=v_q.item_id for update;
  if not found or v_req.applied_at is not null then raise exception 'approval % was already applied',p_approval using errcode='55000'; end if;
  select * into v_release from public.releases where id=v_req.release_id for update;
  if v_release.status='cancelled' and v_q.status='rejected' then
    update public.release_schedule_requests set applied_at=now() where id=v_req.id;
    return 'cancelled';
  end if;
  if v_release.status<>'pending_schedule' then
    raise exception 'release % is no longer pending_schedule',v_req.release_id using errcode='55000';
  end if;
  if v_req.release_date is distinct from v_release.release_date
    or v_q.request->>'release_id' is distinct from v_release.id::text
    or v_q.request->>'release_date' is distinct from v_release.release_date::text then
    raise exception 'release approval % is stale',p_approval using errcode='55000';
  end if;
  v_status:=case v_q.status when 'approved' then 'scheduled'::public.release_status else 'draft'::public.release_status end;
  insert into xyp_meta.records_schedule_authorizations values(txid_current(),v_release.id,v_status);
  update public.releases set status=v_status where id=v_release.id;
  update public.release_schedule_requests set applied_at=now() where id=v_req.id;
  return v_status;
end $$;

revoke execute on function public.xyp_rights_splits_lock(),public.xyp_tracks_lock(),public.xyp_releases_guard(),public.xyp_apply_release_decision(uuid) from public,anon,authenticated;
grant execute on function public.xyp_apply_release_decision(uuid) to service_role;
