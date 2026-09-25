-- Phase 15. Authentication binds server-side sessions to explicit RBAC rows.
create table if not exists public.governance_roles (id text primary key, permissions text[] not null);
insert into public.governance_roles values
 ('viewer', array['system.read']), ('operator', array['system.read','runtime.execute','trace.write']),
 ('approver', array['system.read','governance.read','approval.decide']),
 ('admin', array['system.read','governance.read','approval.decide','runtime.execute','trace.write']) on conflict do nothing;
create table if not exists public.governance_users (
 id uuid primary key default gen_random_uuid(), name text not null unique check(length(trim(name))>0),
 role_id text not null references public.governance_roles(id), disabled boolean not null default false,
 created_at timestamptz not null default now()
);
create table if not exists public.governance_sessions (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'), user_id uuid not null references public.governance_users(id),
 expires_at timestamptz not null, revoked boolean not null default false
);
create table if not exists public.governance_flags (
 id uuid primary key default gen_random_uuid(), source_ref text not null, kind text not null check(kind in ('legal','rights')),
 agent_run_id uuid not null references public.agent_runs(id), result jsonb not null, created_at timestamptz not null default now()
);
alter table public.audit_log add column if not exists agent_run_id uuid references public.agent_runs(id);
alter table public.audit_log add column if not exists human_approver_id uuid references public.governance_users(id);
alter table public.approval_queue add column if not exists decided_by_user_id uuid references public.governance_users(id);
do $$ begin
 if not exists(select from pg_roles where rolname='xyp_governance') then create role xyp_governance nologin noinherit; end if;
 if not exists(select from pg_roles where rolname='xyp_web') then create role xyp_web nologin noinherit; end if;
 if not exists(select from pg_roles where rolname='xyp_readonly') then create role xyp_readonly nologin noinherit; end if;
end $$;
grant usage on schema public to xyp_governance, xyp_web, xyp_readonly;
do $$ declare t text; begin
 foreach t in array array['governance_roles','governance_users','governance_sessions','governance_flags'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
grant select, insert on public.governance_flags to xyp_governance;
drop policy if exists governance_flag on public.governance_flags;
create policy governance_flag on public.governance_flags for all to xyp_governance using(true) with check(true);
do $$ declare t text; begin
 foreach t in array array['sources','creative_artifacts','tracks','rights_splits','records_flags','audit_log'] loop
 execute format('grant select on public.%I to xyp_governance',t);
 execute format('drop policy if exists governance_read on public.%I',t);
 execute format('create policy governance_read on public.%I for select to xyp_governance using(true)',t);
 end loop;
end $$;

create or replace function public.xyp_session_identity(p_hash text)
returns table(id uuid, name text, role text, permissions text[])
language sql security definer set search_path='' as $$
 select u.id,u.name,u.role_id,r.permissions from public.governance_sessions s
 join public.governance_users u on u.id=s.user_id join public.governance_roles r on r.id=u.role_id
 where s.token_hash=p_hash and not s.revoked and s.expires_at>now() and not u.disabled;
$$;
create or replace function public.xyp_decide_authenticated_approval(p_hash text,p_id uuid,p_decision text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user record; v_item record; v_status text; v_release text;
begin
 select * into v_user from public.xyp_session_identity(p_hash);
 if not found or not ('approval.decide'=any(v_user.permissions)) then raise exception 'Forbidden' using errcode='insufficient_privilege'; end if;
 select * into v_item from public.approval_queue where id=p_id for update;
 if not found or v_item.status<>'pending' then raise exception 'Approval is not pending' using errcode='object_not_in_prerequisite_state'; end if;
 -- Bind the actor before the sealed final decision; the entire operation is atomic.
 update public.approval_queue set decided_by_user_id=v_user.id where id=p_id;
 v_status := public.xyp_decide_approval(p_id,p_decision,v_user.name,p_reason)::text;
 if v_item.item_type::text='release_schedule' then v_release := public.xyp_apply_release_decision(p_id)::text; end if;
 return jsonb_build_object('status',v_status,'itemType',v_item.item_type,'releaseStatus',v_release,'decidedBy',v_user.id,
 'nextAction',case when v_item.item_type::text='knowledge_candidate' then 'Run the existing promotion gate to apply the decision' when v_item.item_type::text='critique_escalation' then 'Human studio work or a new bounded revision run is required' else null end);
end;
$$;
revoke execute on function public.xyp_session_identity(text),public.xyp_decide_authenticated_approval(text,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.xyp_session_identity(text),public.xyp_decide_authenticated_approval(text,uuid,text,text) to xyp_web;

create or replace function public.xyp_audit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_run uuid; v_human uuid;
begin
 v_run := nullif(to_jsonb(new)->>'agent_run_id','')::uuid;
 v_human := nullif(to_jsonb(new)->>'decided_by_user_id','')::uuid;
 if tg_table_name='agent_runs' then v_run:=new.id; end if;
 if tg_table_name='knowledge_versions' then
  select f.agent_run_id,q.decided_by_user_id into v_run,v_human from public.knowledge_candidates c
  join public.research_findings f on f.id=c.finding_id
  left join public.approval_queue q on q.item_id=c.id and q.item_type::text='knowledge_candidate'
  where c.id=(to_jsonb(new)->>'candidate_id')::uuid;
 end if;
 insert into public.audit_log(actor,table_name,row_id,op,old,new,agent_run_id,human_approver_id)
 values(coalesce(nullif(current_setting('role',true),'none'),session_user),tg_table_name,coalesce(new.id,old.id),lower(tg_op),
 case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end,v_run,v_human);
 return null;
end;
$$;
create or replace trigger governance_flags_immutable before update or delete on public.governance_flags for each row execute function public.xyp_audit_log_immutable();
create or replace trigger governance_flags_audit after insert on public.governance_flags for each row execute function public.xyp_audit();
create or replace trigger knowledge_versions_audit after insert on public.knowledge_versions for each row execute function public.xyp_audit();
create or replace trigger agent_runs_audit after insert or update on public.agent_runs for each row execute function public.xyp_audit();
create or replace trigger approval_queue_audit after insert or update on public.approval_queue for each row execute function public.xyp_audit();
-- Historical canonical mutations retain their true timestamp and available provenance. Null means unavailable, never invented.
insert into public.audit_log(at,actor,table_name,row_id,op,new,agent_run_id,human_approver_id)
select v.created_at,'historical-provenance','knowledge_versions',v.id,'insert',to_jsonb(v),f.agent_run_id,q.decided_by_user_id
from public.knowledge_versions v left join public.knowledge_candidates c on c.id=v.candidate_id
left join public.research_findings f on f.id=c.finding_id
left join public.approval_queue q on q.item_id=c.id and q.item_type::text='knowledge_candidate'
where not exists(select from public.audit_log a where a.table_name='knowledge_versions' and a.row_id=v.id);

-- One read-only projection role, never auth credentials. API filters per authenticated RBAC permissions.
do $$ declare t text; begin
 foreach t in array array['agent_runs','workflow_runs','sources','modules','canonical_prompts','relations','knowledge_versions','research_projects','research_runs','research_findings','research_sources','knowledge_candidates','contradictions','experiments','releases','tracks','rights_splits','records_flags','rd_backlog','trace_analyses','approval_queue','audit_log','governance_flags','creative_artifacts','critiques'] loop
 execute format('grant select on public.%I to xyp_readonly',t);
 execute format('drop policy if exists projection_read on public.%I',t);
 execute format('create policy projection_read on public.%I for select to xyp_readonly using(true)',t);
 end loop;
end $$;
revoke all on public.audit_log from xyp_governance,xyp_web,xyp_readonly;
grant select on public.audit_log to xyp_governance,xyp_readonly;
