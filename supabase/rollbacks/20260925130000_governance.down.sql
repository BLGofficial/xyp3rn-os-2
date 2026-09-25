do $$ declare t text; n text; begin
 foreach t in array array['governance_flags','knowledge_versions','agent_runs','approval_queue'] loop
  if to_regclass('public.'||t) is not null then
   n:=t||'_audit';
   execute format('drop trigger if exists %I on public.%I',n,t);
  end if;
 end loop;
end $$;
drop function if exists public.xyp_decide_authenticated_approval(text,uuid,text,text);
drop function if exists public.xyp_session_identity(text);
do $$ declare p record; begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and policyname in ('projection_read','governance_read') loop
 execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
end $$;
revoke all on all tables in schema public from xyp_readonly,xyp_governance;
alter table if exists public.audit_log drop column if exists human_approver_id;
alter table if exists public.audit_log drop column if exists agent_run_id;
alter table if exists public.approval_queue drop column if exists decided_by_user_id;
drop table if exists public.governance_flags,public.governance_sessions,public.governance_users,public.governance_roles;
create or replace function public.xyp_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_log(actor,table_name,row_id,op,old,new)
 values(coalesce(nullif(current_setting('role',true),'none'),session_user),tg_table_name,coalesce(new.id,old.id),lower(tg_op),
 case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end);
 return null;
end; $$;
