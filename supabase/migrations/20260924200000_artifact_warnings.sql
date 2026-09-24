-- creative_artifacts.warnings: defects the writing agent found in its own output but that did not
-- block the write (first use: a word mixing Latin and Cyrillic letters outside the text Suno
-- receives verbatim, ARCHITECTURE F22). One JSON object per warning, e.g.
-- {"kind":"mixed-script","word":"Лieux","path":"$.sections[0].devices[0].note"}. Set once at
-- insert like every other column (the immutable trigger covers it). Existing rows read as [].
-- Table-level grants from 20260924180000 cover the new column.
-- Idempotent. Rollback: supabase/rollbacks/20260924200000_artifact_warnings.down.sql

alter table public.creative_artifacts add column if not exists warnings jsonb not null default '[]';

do $$ begin
  if not exists (select from pg_constraint where conname = 'creative_artifacts_warnings_check') then
    alter table public.creative_artifacts
      add constraint creative_artifacts_warnings_check check (jsonb_typeof(warnings) = 'array');
  end if;
end $$;
