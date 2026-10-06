-- Rollback for 20261006100000_obsidian_sync.sql. Idempotent. No CASCADE.
-- The notes in the owner's vault and the Vault files imported from it stay; only the ledger goes.
drop view if exists public.current_obsidian_sync;
drop table if exists public.obsidian_sync_events;
