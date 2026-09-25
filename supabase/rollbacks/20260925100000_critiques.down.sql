-- Rollback for 20260925100000_critiques.sql. Idempotent. No CASCADE.
-- The xyp_critic and xyp_evaluation_loop roles stay (cluster-wide, like xyp_creative); their
-- privileges go with the objects dropped here.

do $$ begin
  if to_regclass('public.creative_artifacts') is not null then
    drop trigger if exists trg_creative_artifacts_critique on public.creative_artifacts;
  end if;
end $$;

alter table if exists public.creative_artifacts drop column if exists critique_id;
drop function if exists public.xyp_creative_artifacts_critique();
drop function if exists public.xyp_escalate_critique(uuid, jsonb);
drop table if exists public.critiques;
drop function if exists public.xyp_critiques_chain();
drop function if exists public.xyp_critiques_immutable();

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_critic') then
    revoke usage on schema public from xyp_critic;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_evaluation_loop') then
    revoke usage on schema public from xyp_evaluation_loop;
  end if;
end $$;
