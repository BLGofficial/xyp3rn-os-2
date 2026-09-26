-- Rollback for 20260925160000_studio.sql. Idempotent. No CASCADE.
-- Refuses (fails loudly) while any take is a Vault file or any take is rated: restoring
-- suno_takes.audio_url NOT NULL, or dropping the ratings, would lose the owner's data, and a rollback
-- never deletes data.

-- Nested IFs: an IF condition is planned as one expression, so a table a second run already dropped
-- must not be named in the same condition that tests for it.
do $$ begin
  if to_regclass('public.take_ratings') is not null then
    if exists (select from public.take_ratings) then
      raise exception 'rollback 20260925160000: take ratings exist; a rollback never deletes the owner''s ratings';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'suno_takes' and column_name = 'source_id') then
    if exists (select from public.suno_takes where source_id is not null) then
      raise exception 'rollback 20260925160000: takes whose audio is a Vault file exist; remove them before rolling back';
    end if;
  end if;
end $$;

drop view if exists public.generation_takes;
drop view if exists public.generation_attempts;
drop view if exists public.current_take_ratings;
drop table if exists public.take_ratings;

do $$ begin
  if to_regclass('public.suno_submissions') is not null then
    drop trigger if exists trg_suno_submissions_gate on public.suno_submissions;
  end if;
  if to_regclass('public.suno_takes') is not null then
    drop trigger if exists trg_suno_takes_vault_audio on public.suno_takes;
    alter table public.suno_takes drop constraint if exists suno_takes_submission_source_key;
    alter table public.suno_takes drop constraint if exists suno_takes_audio_check;
    drop index if exists public.suno_takes_source_id_idx;
    alter table public.suno_takes drop column if exists source_id;
    alter table public.suno_takes alter column audio_url set not null;
  end if;
  if to_regclass('public.creative_artifacts') is not null then
    drop trigger if exists trg_creative_artifacts_package_writer on public.creative_artifacts;
  end if;
end $$;

drop function if exists public.xyp_suno_submissions_gate();
drop function if exists public.xyp_suno_package_ready(uuid);
drop function if exists public.xyp_suno_takes_vault_audio();
drop function if exists public.xyp_creative_artifacts_package_writer();
