-- Rollback for 20260924190000_suno_generation.sql. Idempotent. No CASCADE.
-- The xyp_execution role stays (cluster-wide, like the other xyp_* roles); its privileges go.

do $$ begin
  if to_regclass('public.creative_artifacts') is not null then
    drop policy if exists execution_select on public.creative_artifacts;
    drop policy if exists runtime_select on public.creative_artifacts;
    if exists (select from pg_roles where rolname = 'xyp_execution') then
      revoke select on table public.creative_artifacts from xyp_execution;
    end if;
    if exists (select from pg_roles where rolname = 'xyp_runtime') then
      revoke select on table public.creative_artifacts from xyp_runtime;
    end if;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_execution') then
    revoke usage on schema public from xyp_execution;
  end if;
end $$;

drop table if exists public.take_scores;
drop table if exists public.suno_takes;
drop table if exists public.suno_submissions;
drop function if exists public.xyp_suno_trail_immutable();
