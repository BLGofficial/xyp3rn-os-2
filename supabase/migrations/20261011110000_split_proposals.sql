-- Approval-gated rights-split fixes (Jarvis roadmap item 3).
-- A split change is never an edit: splits are append-only and every version sums to 100. Jarvis may only PROPOSE the
-- next full version. This queues the proposal for the owner; nothing is written to rights_splits here. After the
-- owner approves (pnpm gate decide), the write goes through the records-catalog agent's write_splits tool, which
-- carries the agent run rights_splits requires and the DB's own guards (sum = 100, no unassigned share once the
-- release is scheduled, one writer per track).
-- Idempotent. Rollback: supabase/rollbacks/20261011110000_split_proposals.down.sql

alter type public.approval_item_type add value if not exists 'split_proposal';

-- One request per proposal (approval_queue_item_key is unique per item_type, item_id), so each proposal gets its own
-- id. current_version pins the set the proposal was made against: applying it after any other change is refused.
create or replace function public.xyp_queue_split_proposal(p_track uuid, p_splits jsonb, p_proposer text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric;
  v_version integer;
  v_q uuid;
begin
  if coalesce(btrim(p_proposer), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'a proposal needs a proposer and a reason' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select from public.tracks where id = p_track) then
    raise exception 'no track %', p_track using errcode = 'foreign_key_violation';
  end if;
  if jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'splits must be a non-empty array' using errcode = 'invalid_parameter_value';
  end if;
  if exists (
    select from jsonb_array_elements(p_splits) e
    where jsonb_typeof(e -> 'percentage') <> 'number' or (e ->> 'percentage')::numeric <= 0 or (e ->> 'percentage')::numeric > 100
       or (e -> 'payee') is null or (jsonb_typeof(e -> 'payee') not in ('string', 'null'))
       or (jsonb_typeof(e -> 'payee') = 'string' and btrim(e ->> 'payee') = '')
  ) then
    raise exception 'each split needs a payee (string or null) and a percentage in (0, 100]' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(*) from jsonb_array_elements(p_splits) e where e ->> 'payee' is null) > 1
     or (select count(*) - count(distinct e ->> 'payee') from jsonb_array_elements(p_splits) e where e ->> 'payee' is not null) > 0 then
    raise exception 'a payee may appear once per set (one unassigned share at most)' using errcode = 'invalid_parameter_value';
  end if;
  select sum((e ->> 'percentage')::numeric) into v_total from jsonb_array_elements(p_splits) e;
  if v_total <> 100 then
    raise exception 'the proposed set sums to %, not 100', v_total using errcode = 'check_violation';
  end if;
  select coalesce(max(version), 0) into v_version from public.rights_splits where track_id = p_track;
  insert into public.approval_queue (item_type, item_id, request)
  values ('split_proposal', gen_random_uuid(),
          jsonb_build_object('reason', 'Jarvis proposed the next rights split set; nothing is written until the owner approves',
                             'trackId', p_track, 'splits', p_splits, 'currentVersion', v_version,
                             'requestedBy', p_proposer, 'ownerReason', p_reason))
  returning id into v_q;
  return v_q;
end;
$$;

-- EXECUTE: service_role only. Name anon and authenticated too: the project's default privileges grant them EXECUTE.
revoke all on function public.xyp_queue_split_proposal(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.xyp_queue_split_proposal(uuid, jsonb, text, text) to service_role;
