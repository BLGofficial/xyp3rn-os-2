-- Rollback for 20260924200000_artifact_warnings.sql. Idempotent. No CASCADE.
alter table if exists public.creative_artifacts drop constraint if exists creative_artifacts_warnings_check;
alter table if exists public.creative_artifacts drop column if exists warnings;
