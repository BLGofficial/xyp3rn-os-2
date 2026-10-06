-- F54 — two-way sync with the owner's Obsidian vault (knowledge/obsidian/).
-- - obsidian_sync_events   the sync ledger, append-only: one row per note imported into the Creative
--                          Vault (with the Vault file it became) or exported by the OS (with the bytes it
--                          wrote). The planner compares the vault on disk to the latest row per path and
--                          direction, so the OS overwrites only a note it wrote and nobody changed since.
-- - current_obsidian_sync  the latest row per (vault, note, direction).
-- Written as xyp_vault through obsidian-sync (Execution); read by xyp_web. Every row names the plan the
-- owner previewed (plan_hash) and the agent run that wrote it.
-- Idempotent. Rollback: supabase/rollbacks/20261006100000_obsidian_sync.down.sql

create table if not exists public.obsidian_sync_events (
  id           uuid primary key default gen_random_uuid(),
  vault_root   text not null,
  note_path    text not null,
  direction    text not null,
  sha256       text not null,
  -- The Vault file an imported note became; an export names none.
  source_id    uuid references public.sources (id) on delete restrict,
  plan_hash    text not null,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint obsidian_sync_events_vault_root_check check (length(btrim(vault_root)) > 0),
  -- A vault-relative posix path to a note: never absolute, never climbing out of the vault.
  constraint obsidian_sync_events_note_path_check check (
    note_path ~ '\.md$' and note_path !~ '^[/\\]' and note_path !~ '^[A-Za-z]:' and note_path !~ '(^|/)\.\.(/|$)' and note_path !~ '\\'),
  constraint obsidian_sync_events_direction_check check (direction in ('import', 'export')),
  constraint obsidian_sync_events_sha256_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint obsidian_sync_events_plan_hash_check check (plan_hash ~ '^[0-9a-f]{64}$'),
  constraint obsidian_sync_events_source_check check ((direction = 'import') = (source_id is not null))
);

create index if not exists obsidian_sync_events_latest_idx on public.obsidian_sync_events (vault_root, note_path, direction, created_at desc);
create index if not exists obsidian_sync_events_agent_run_id_idx on public.obsidian_sync_events (agent_run_id);
create index if not exists obsidian_sync_events_source_id_idx on public.obsidian_sync_events (source_id);

create or replace trigger trg_obsidian_sync_events_immutable before update or delete on public.obsidian_sync_events
  for each row execute function public.xyp_vault_immutable();

create or replace view public.current_obsidian_sync with (security_invoker = true) as
  select distinct on (e.vault_root, e.note_path, e.direction)
         e.id, e.vault_root, e.note_path, e.direction, e.sha256, e.source_id, e.plan_hash, e.agent_run_id, e.created_at
  from public.obsidian_sync_events e
  order by e.vault_root, e.note_path, e.direction, e.created_at desc, e.id desc;

alter table public.obsidian_sync_events enable row level security;
revoke all on table public.obsidian_sync_events, public.current_obsidian_sync from anon, authenticated, service_role;
-- service_role reads (G20: reads only).
grant select on table public.obsidian_sync_events, public.current_obsidian_sync to service_role;
grant select, insert on table public.obsidian_sync_events to xyp_vault;
grant select on table public.current_obsidian_sync to xyp_vault;
grant select on table public.obsidian_sync_events, public.current_obsidian_sync to xyp_web;

do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_sync_events' and policyname = 'vault_select') then
    create policy vault_select on public.obsidian_sync_events for select to xyp_vault using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_sync_events' and policyname = 'vault_insert') then
    create policy vault_insert on public.obsidian_sync_events for insert to xyp_vault with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_sync_events' and policyname = 'web_select') then
    create policy web_select on public.obsidian_sync_events for select to xyp_web using (true);
  end if;
end $$;
