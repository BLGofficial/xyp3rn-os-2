-- AOS-04: Research mode (docs/artist-os/AOS-04-design.md §4). What it adds:
-- - the brief                 research_questions.intended_use, urls, specialists; set at insert (xyp_research may
--                             update status only, as before)
-- - the run deadline          research_runs.expires_at; the sweep seals a running run past it as abandoned
-- - research_links (R2)       a brief's typed targets: an artifact lineage root, a workflow (name + spec sha256) or
--                             an ARCHITECTURE decision (F<n>); research_link_retractions unlink; research_targets
--                             adds the songs that link the brief (song_links, A1)
-- - kept sources              research_sources.text (what a fetch read) and research_evidence.quote (the passage behind
--                             a claim), checked verbatim against its source on insert
-- - the Findings Library (R3) xyp_decide_finding: the owner's accept/reject, one per finding, recorded decided in
--                             approval_queue; current_finding_decisions; findings_library
-- Rows written before AOS-04 stay as they are. Idempotent. Rollback: supabase/rollbacks/20260926100000_research_mode.down.sql

alter type public.approval_item_type add value if not exists 'research_finding';

-- ─── helpers ────────────────────────────────────────────────────────────────────────────────────
-- The whitespace squash a quote is compared under (page text keeps line breaks; a quote may not).
create or replace function public.xyp_squash(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select btrim(regexp_replace(p, '[[:space:]]+', ' ', 'g')) $$;

create or replace function public.xyp_all_http(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$ select coalesce(bool_and(u is not null and u ~ '^https?://[^[:space:]]+$'), true) from unnest(p) u $$;

-- ─── the brief ──────────────────────────────────────────────────────────────────────────────────
alter table public.research_questions add column if not exists intended_use text;
alter table public.research_questions add column if not exists urls text[] not null default '{}';
alter table public.research_questions add column if not exists specialists text[];

do $$ begin
  if not exists (select from pg_constraint where conname = 'research_questions_intended_use_check') then
    alter table public.research_questions add constraint research_questions_intended_use_check
      check (intended_use is null or length(btrim(intended_use)) > 0);
  end if;
  if not exists (select from pg_constraint where conname = 'research_questions_urls_check') then
    alter table public.research_questions add constraint research_questions_urls_check check (public.xyp_all_http(urls));
  end if;
  if not exists (select from pg_constraint where conname = 'research_questions_specialists_check') then
    alter table public.research_questions add constraint research_questions_specialists_check
      check (specialists is null or cardinality(specialists) > 0);
  end if;
end $$;

-- ─── the run deadline ───────────────────────────────────────────────────────────────────────────
-- A non-volatile default fills existing rows at ALTER time without an UPDATE (sealed runs refuse updates).
alter table public.research_runs add column if not exists expires_at timestamptz not null default (now() + interval '10 minutes');
grant update (expires_at) on table public.research_runs to xyp_research;

-- ─── kept sources and quotes ────────────────────────────────────────────────────────────────────
alter table public.research_sources add column if not exists text text;
alter table public.research_evidence add column if not exists quote text;

do $$ begin
  if not exists (select from pg_constraint where conname = 'research_sources_text_check') then
    alter table public.research_sources add constraint research_sources_text_check check (text is null or length(text) <= 20000);
  end if;
  if not exists (select from pg_constraint where conname = 'research_evidence_quote_check') then
    alter table public.research_evidence add constraint research_evidence_quote_check check (quote is null or length(btrim(quote)) > 0);
  end if;
end $$;

-- SECURITY DEFINER: reads the source's stored text and the canonical bodies quoting an ingested source.
-- Verbatim means verbatim after the whitespace squash: a curly quote, an ellipsis or an NBSP the source
-- doesn't have is a different quote (Review Focus 1).
create or replace function public.xyp_research_evidence_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text;
  v_source uuid;
  v_q text;
begin
  if new.quote is null then
    return new;
  end if;
  v_q := public.xyp_squash(new.quote);
  select s.text, s.source_id into v_text, v_source from public.research_sources s where s.id = new.research_source_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  if v_text is not null and position(v_q in public.xyp_squash(v_text)) > 0 then
    return new;
  end if;
  if v_source is not null and exists (
    select from public.canonical_prompts c where c.source_id = v_source and position(v_q in public.xyp_squash(c.body)) > 0
  ) then
    return new;
  end if;
  raise exception 'research_evidence: quote not found verbatim in research source %: "%"', new.research_source_id, left(v_q, 120)
    using errcode = 'check_violation';
end;
$$;

create or replace trigger trg_research_evidence_quote before insert on public.research_evidence
  for each row execute function public.xyp_research_evidence_quote();
revoke execute on function public.xyp_research_evidence_quote() from public, anon, authenticated;

-- ─── research_links (R2) ────────────────────────────────────────────────────────────────────────
create table if not exists public.research_links (
  id                  uuid primary key default gen_random_uuid(),
  question_id         uuid not null references public.research_questions (id) on delete restrict,
  role                text,
  artifact_lineage_id uuid references public.creative_artifacts (id) on delete restrict,
  workflow_name       text,
  workflow_sha256     text,
  decision_key        text,
  created_at          timestamptz not null default now(),
  -- A song target is song_links.research_question_id (A1), never a column here.
  constraint research_links_target_check check (num_nonnulls(artifact_lineage_id, workflow_name, decision_key) = 1),
  constraint research_links_workflow_check check ((workflow_name is null) = (workflow_sha256 is null)),
  constraint research_links_workflow_name_check check (workflow_name is null or workflow_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint research_links_workflow_sha256_check check (workflow_sha256 is null or workflow_sha256 ~ '^[0-9a-f]{64}$'),
  constraint research_links_decision_key_check check (decision_key is null or decision_key ~ '^F[0-9]+$'),
  constraint research_links_role_check check (role is null or length(btrim(role)) > 0)
);

create table if not exists public.research_link_retractions (
  research_link_id uuid primary key references public.research_links (id) on delete restrict,
  reason           text not null,
  created_at       timestamptz not null default now(),
  constraint research_link_retractions_reason_check check (length(btrim(reason)) > 0)
);

create index if not exists research_links_question_id_idx on public.research_links (question_id);
create index if not exists research_links_artifact_lineage_id_idx on public.research_links (artifact_lineage_id);

-- SECURITY DEFINER: reads creative_artifacts (the root check) and every link of the brief.
-- The advisory lock serializes two writers linking the same brief, so the live-duplicate check can't race.
create or replace function public.xyp_research_links_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('xyp:research_links:' || new.question_id::text));
  if new.artifact_lineage_id is not null
     and not exists (select from public.creative_artifacts a where a.id = new.artifact_lineage_id and a.lineage_id = a.id) then
    raise exception 'research_links: artifact % is not a lineage root; link the lineage''s first version', new.artifact_lineage_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select from public.research_links l
    where l.question_id = new.question_id
      and l.artifact_lineage_id is not distinct from new.artifact_lineage_id
      and l.workflow_name is not distinct from new.workflow_name
      and l.workflow_sha256 is not distinct from new.workflow_sha256
      and l.decision_key is not distinct from new.decision_key
      and not exists (select from public.research_link_retractions r where r.research_link_id = l.id)
  ) then
    raise exception 'research_links: brief % already has a live link to this target', new.question_id using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_research_links_guard before insert on public.research_links
  for each row execute function public.xyp_research_links_guard();
revoke execute on function public.xyp_research_links_guard() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['research_links', 'research_link_retractions'] loop
    execute format('create or replace trigger %I before update or delete on public.%I for each row execute function public.xyp_vault_immutable()',
      'trg_' || t || '_immutable', t);
  end loop;
end $$;

create or replace view public.research_targets with (security_invoker = true) as
  select l.research_question_id as question_id, 'song'::text as kind, l.song_id::text as target, l.role, l.id as link_id,
         'song_links'::text as via, l.created_at
  from public.current_song_links l
  where l.research_question_id is not null
  union all
  select r.question_id,
         case when r.artifact_lineage_id is not null then 'lineage' when r.workflow_name is not null then 'workflow' else 'decision' end,
         coalesce(r.artifact_lineage_id::text, r.workflow_name || '@' || r.workflow_sha256, r.decision_key),
         r.role, r.id, 'research_links', r.created_at
  from public.research_links r
  where not exists (select from public.research_link_retractions x where x.research_link_id = r.id);

-- ─── the owner's finding decisions (R3) ─────────────────────────────────────────────────────────
-- Recorded already decided, like xyp_decide_artifact: one decision per finding (approval_queue_item_key).
-- 'accept' puts the finding in the Findings Library; neither decision touches a canonical table.
create or replace function public.xyp_decide_finding(p_finding_id uuid, p_decision text, p_approver text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f record;
  v_id uuid;
begin
  if p_decision is null or p_decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject, got %', p_decision using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_approver), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'a decision needs an approver and a reason' using errcode = 'invalid_parameter_value';
  end if;
  select f.id, f.research_run_id, f.claim, f.claim_topic into v_f from public.research_findings f where f.id = p_finding_id;
  if not found then
    raise exception 'no finding %', p_finding_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.approval_queue (item_type, item_id, request, status, decided_at, decided_by, decision_reason)
  values ('research_finding', p_finding_id,
          jsonb_build_object('reason', 'the owner''s decision on a research finding (the Findings Library; not canonical)',
                             'findingId', v_f.id, 'researchRunId', v_f.research_run_id, 'claimTopic', v_f.claim_topic, 'claim', v_f.claim),
          (case p_decision when 'accept' then 'approved' else 'rejected' end)::public.approval_status,
          now(), p_approver, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.xyp_decide_finding(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.xyp_decide_finding(uuid, text, text, text) to service_role;

create or replace view public.current_finding_decisions with (security_invoker = true) as
  select q.item_id as finding_id, case q.status::text when 'approved' then 'accept' else 'reject' end as decision,
         q.id as approval_id, q.decided_by, q.decided_at, q.decision_reason
  from public.approval_queue q
  where q.item_type::text = 'research_finding';

create or replace view public.findings_library with (security_invoker = true) as
  select f.id as finding_id, f.claim, f.claim_topic, f.claim_value, f.model_tag, f.confidence, f.created_at,
         f.research_run_id, rr.question_id, q.question, q.intended_use, d.decided_by, d.decided_at, d.decision_reason,
         (select count(*)::int from public.research_finding_evidence fe where fe.finding_id = f.id) as evidence_count,
         coalesce((select case when bool_or(k.status::text = 'promoted') then 'promoted'
                               when bool_or(k.status::text in ('proposed', 'pending_approval')) then 'candidate'
                               else 'rejected' end
                   from public.knowledge_candidates k where k.finding_id = f.id having count(*) > 0), 'none') as canonical_status
  from public.research_findings f
  join public.current_finding_decisions d on d.finding_id = f.id and d.decision = 'accept'
  join public.research_runs rr on rr.id = f.research_run_id
  join public.research_questions q on q.id = rr.question_id;

-- ─── RLS + grants ───────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['research_links', 'research_link_retractions'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_insert') then
      execute format('create policy research_insert on public.%I for insert to xyp_research with check (true)', t);
    end if;
  end loop;
  -- research_targets is security_invoker: its song half reads song_links as the caller.
  foreach t in array array['research_links', 'research_link_retractions', 'song_links', 'song_link_retractions'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_select') then
      execute format('create policy research_select on public.%I for select to xyp_research using (true)', t);
    end if;
  end loop;
  foreach t in array array['research_links', 'research_link_retractions', 'research_finding_evidence', 'contradictions', 'knowledge_candidates'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'web_select') then
      execute format('create policy web_select on public.%I for select to xyp_web using (true)', t);
    end if;
  end loop;
end $$;

revoke all on table public.research_links, public.research_link_retractions, public.research_targets, public.current_finding_decisions,
  public.findings_library from anon, authenticated, service_role;
-- service_role reads everything new (G20: reads only); the owner's decisions go through xyp_decide_finding.
grant select on table public.research_links, public.research_link_retractions, public.research_targets, public.current_finding_decisions,
  public.findings_library to service_role;
-- The brief's url check runs as whoever inserts the brief.
revoke execute on function public.xyp_squash(text), public.xyp_all_http(text[]) from public, anon, authenticated;
grant execute on function public.xyp_all_http(text[]) to xyp_research;
grant select, insert on table public.research_links, public.research_link_retractions to xyp_research;
grant select on table public.research_targets, public.song_links, public.song_link_retractions, public.current_song_links to xyp_research;
grant select on table public.research_links, public.research_link_retractions, public.research_targets, public.research_finding_evidence,
  public.contradictions, public.knowledge_candidates, public.current_finding_decisions, public.findings_library to xyp_web;
