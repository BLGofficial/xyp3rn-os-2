-- Rollback for 20261011110000_split_proposals.sql. Idempotent. No CASCADE.
-- The 'split_proposal' value stays in approval_item_type (Postgres cannot drop an enum value); queue rows that name
-- it stay as the audit of what was proposed and what the owner decided.
drop function if exists public.xyp_queue_split_proposal(uuid, jsonb, text, text);
