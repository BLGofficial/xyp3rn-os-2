-- AOS-00 prerequisite G20 — service_role reads everything and writes nothing directly.
-- SCHEMA.md (Phase 1): service_role's full grants were "correct for Phase 1 only; from Phase 2 onward
-- each component connects as its own xyp_* role". Only the canonical tables were ever revoked (6D),
-- so service_role still held INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on ~28 relations —
-- TRUNCATE included, which skips the immutability triggers. Every write now goes through an xyp_*
-- role (and so through an agent run); the operator still reads, and still decides approvals through
-- xyp_decide_approval (SECURITY DEFINER, EXECUTE unchanged).
-- Default privileges are changed too, so a table a later migration creates is read-only for
-- service_role unless that migration grants more (tests/aos-00/prerequisites.test.ts).
-- Idempotent. Rollback: supabase/rollbacks/20260925130000_service_role_read_only.down.sql

do $$
declare
  v record;
begin
  for v in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from service_role', v.relname);
  end loop;
end $$;

alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from service_role;
