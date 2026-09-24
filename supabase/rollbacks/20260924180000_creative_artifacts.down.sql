-- Rollback for 20260924180000_creative_artifacts.sql. Idempotent. No CASCADE.
-- The xyp_creative role stays (cluster-wide, like xyp_research); its privileges go with the table.

do $$ begin
  if to_regclass('public.canonical_claims') is not null and exists (select from pg_roles where rolname = 'xyp_runtime') then
    revoke select on table public.canonical_claims from xyp_runtime;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_creative') then
    revoke usage on schema public from xyp_creative;
  end if;
end $$;

drop table if exists public.creative_artifacts;
drop function if exists public.xyp_creative_artifacts_version();
drop function if exists public.xyp_creative_artifacts_immutable();
