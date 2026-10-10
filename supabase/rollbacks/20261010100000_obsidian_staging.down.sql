-- Rollback for 20261010100000_obsidian_staging.sql. Idempotent. No CASCADE.
-- Notes in the owner's vault stay; only the staging rows go.
-- The 'obsidian_note' value stays in approval_item_type (Postgres cannot drop an enum value); queue rows that
-- name it stay as the audit of what the owner sent to the gate.
drop function if exists public.xyp_queue_obsidian_note(uuid, text, text);
drop table if exists public.obsidian_findings;
-- The role xyp_obsidian_watch stays: roles are cluster-wide, so Postgres refuses to drop one while another
-- database still holds grants for it, and the other rollbacks leave their roles too. It owns nothing and, with the
-- table gone, holds nothing here.
