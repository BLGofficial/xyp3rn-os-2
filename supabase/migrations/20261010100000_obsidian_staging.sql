-- Obsidian watcher staging (knowledge/obsidian/watcher.ts).
-- - obsidian_findings   one row per note the owner edited in obsidian/{inbox,research,creative}: the raw
--                       text, its hash, parsed frontmatter and wikilinks. Staging only: nothing here is
--                       canonical, and the only way out is the Promotion Gate (a reviewed candidate).
-- - xyp_obsidian_watch  the watcher's role. May read, insert and update THIS table, and only with status
--                       'pending_approval' (RLS check), so it cannot approve its own rows or touch any
--                       other table. A changed note resets to pending_approval; an unchanged one is skipped.
-- Not named `findings`: research_findings / findings_library already mean synthesized, evidenced claims.
-- Idempotent. Rollback: supabase/rollbacks/20261010100000_obsidian_staging.down.sql

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_obsidian_watch') then
    create role xyp_obsidian_watch nologin noinherit;
  end if;
end $$;

create table if not exists public.obsidian_findings (
  id              uuid primary key default gen_random_uuid(),
  domain          text not null,
  source_path     text not null,
  content_hash    text not null,
  raw_content     text not null,
  metadata        jsonb not null default '{}'::jsonb,
  extracted_links jsonb not null default '[]'::jsonb,
  status          text not null default 'pending_approval',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint obsidian_findings_source_path_key unique (source_path),
  constraint obsidian_findings_domain_check check (length(btrim(domain)) > 0),
  -- A vault-relative posix path to a note: never absolute, never climbing out of the vault.
  constraint obsidian_findings_source_path_check check (
    source_path ~ '\.md$' and source_path !~ '^[/\\]' and source_path !~ '^[A-Za-z]:' and source_path !~ '(^|/)\.\.(/|$)' and source_path !~ '\\'),
  constraint obsidian_findings_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  -- queued: the owner sent it to the Promotion Gate (approval_queue); approved/rejected: the operator's decision.
  constraint obsidian_findings_status_check check (status in ('pending_approval', 'queued', 'approved', 'rejected')),
  constraint obsidian_findings_extracted_links_check check (jsonb_typeof(extracted_links) = 'array'),
  constraint obsidian_findings_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists obsidian_findings_status_idx on public.obsidian_findings (status, updated_at desc);

alter table public.obsidian_findings enable row level security;
revoke all on table public.obsidian_findings from anon, authenticated, service_role;
grant select on table public.obsidian_findings to service_role, xyp_web;
grant select, insert, update on table public.obsidian_findings to xyp_obsidian_watch;

do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_findings' and policyname = 'watch_select') then
    create policy watch_select on public.obsidian_findings for select to xyp_obsidian_watch using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_findings' and policyname = 'watch_insert') then
    create policy watch_insert on public.obsidian_findings for insert to xyp_obsidian_watch with check (status = 'pending_approval');
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_findings' and policyname = 'watch_update') then
    create policy watch_update on public.obsidian_findings for update to xyp_obsidian_watch using (true) with check (status = 'pending_approval');
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_findings' and policyname = 'web_select') then
    create policy web_select on public.obsidian_findings for select to xyp_web using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'obsidian_findings' and policyname = 'operator_select') then
    create policy operator_select on public.obsidian_findings for select to service_role using (true);
  end if;
end $$;

-- ─── the owner's "approve to the Promotion Gate" ─────────────────────────────────────────────────
-- Queues one staged note as a first-party admission request. It does NOT admit anything: the operator decides
-- the queue item (pnpm gate decide), and only the gate writes canonical knowledge. One request per note
-- (approval_queue_item_key). EXECUTE: service_role only, like xyp_decide_artifact.
alter type public.approval_item_type add value if not exists 'obsidian_note';

create or replace function public.xyp_queue_obsidian_note(p_id uuid, p_approver text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n record;
  v_q uuid;
begin
  if coalesce(btrim(p_approver), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'a request needs an approver and a reason' using errcode = 'invalid_parameter_value';
  end if;
  select id, source_path, content_hash, domain, status into v_n from public.obsidian_findings where id = p_id for update;
  if not found then
    raise exception 'no staged note %', p_id using errcode = 'foreign_key_violation';
  end if;
  if v_n.status <> 'pending_approval' then
    raise exception 'note % is % (only a pending_approval note can be sent to the gate)', p_id, v_n.status using errcode = 'object_not_in_prerequisite_state';
  end if;
  insert into public.approval_queue (item_type, item_id, request)
  values ('obsidian_note', p_id,
          jsonb_build_object('reason', 'the owner sent a vault note to the Promotion Gate as first-party material',
                             'sourcePath', v_n.source_path, 'contentHash', v_n.content_hash, 'domain', v_n.domain,
                             'requestedBy', p_approver, 'ownerReason', p_reason))
  returning id into v_q;
  update public.obsidian_findings set status = 'queued', updated_at = now() where id = p_id;
  return v_q;
end;
$$;

-- anon/authenticated get EXECUTE from the project's default privileges, so name them: `public` alone is not enough.
revoke all on function public.xyp_queue_obsidian_note(uuid, text, text) from public, anon, authenticated;
grant execute on function public.xyp_queue_obsidian_note(uuid, text, text) to service_role;
