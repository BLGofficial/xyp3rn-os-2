-- Phase 6D — Knowledge Promotion Gate: the only canonical writer (F2), F1 closed.
-- xyp_promotion is the gate's service account: it may INSERT canonical rows and their
-- knowledge_versions history, never UPDATE or DELETE them. Every other role loses canonical
-- INSERT/UPDATE here, service_role included. Human approval goes through approval_queue
-- (Governance-owned, F8) and is decided only by the operator via xyp_decide_approval.
-- Idempotent. Rollback: supabase/rollbacks/20260924150000_promotion_gate.down.sql

-- ─── enums ────────────────────────────────────────────────────────────────────
-- ADD VALUE inside the migration transaction is fine as long as nothing below *uses* the new
-- value (Postgres forbids that until commit) — plpgsql bodies compare via ::text at run time.
alter type public.knowledge_candidate_status add value if not exists 'pending_approval';

do $$ begin create type public.approval_item_type as enum ('knowledge_candidate', 'critique_escalation');
exception when duplicate_object then null; end $$;
do $$ begin create type public.approval_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;
do $$ begin create type public.promotion_mode as enum ('candidate', 'first_party_ingest');
exception when duplicate_object then null; end $$;
do $$ begin create type public.promotion_outcome as enum ('blocked', 'rejected', 'pending_approval', 'promoted');
exception when duplicate_object then null; end $$;
do $$ begin create type public.regression_kind as enum ('retrieval', 'contradiction-guard');
exception when duplicate_object then null; end $$;
do $$ begin create type public.regression_status as enum ('pending', 'passed', 'failed');
exception when duplicate_object then null; end $$;

-- ─── tables ───────────────────────────────────────────────────────────────────
-- One queue for every human decision in the OS (F8); 6D is its first user. One row per item:
-- a decision is final (sealed below), and the gate reads it on its next run.
create table if not exists public.approval_queue (
  id              uuid primary key default gen_random_uuid(),
  item_type       public.approval_item_type not null,
  item_id         uuid not null,
  -- why a human is needed: the gate's reasons and the step record that produced them
  request         jsonb not null,
  status          public.approval_status not null default 'pending',
  requested_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      text,
  decision_reason text,
  constraint approval_queue_item_key unique (item_type, item_id),
  constraint approval_queue_decision_check check (
    (status = 'pending') = (decided_at is null)
    and (status = 'pending') = (decided_by is null)
    and (status = 'pending') = (decision_reason is null))
);

-- Append-only audit of every gate run: what was evaluated, in order, and the outcome.
create table if not exists public.promotion_runs (
  id                     uuid primary key default gen_random_uuid(),
  mode                   public.promotion_mode not null,
  candidate_id           uuid references public.knowledge_candidates (id) on delete restrict,
  source_id              uuid references public.sources (id) on delete restrict,
  ingestion_run_id       uuid references public.ingestion_runs (id) on delete restrict,
  outcome                public.promotion_outcome not null,
  steps                  jsonb not null,
  reasons                text[] not null default '{}',
  confidence             numeric(4, 3),
  auto_approve_threshold numeric(4, 3),
  approval_id            uuid references public.approval_queue (id) on delete restrict,
  created_at             timestamptz not null default now(),
  constraint promotion_runs_subject_check check (
    (mode = 'candidate' and candidate_id is not null and source_id is null)
    or (mode = 'first_party_ingest' and source_id is not null and ingestion_run_id is not null
        and candidate_id is null and outcome = 'promoted')),
  constraint promotion_runs_steps_check check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) > 0)
);

-- Propagation: regression checks owed by a promotion. Consumed by the regression runner (Phase 13);
-- until then the queue is the record of what must be re-verified.
create table if not exists public.regression_queue (
  id               uuid primary key default gen_random_uuid(),
  -- deferred like knowledge_versions' FK below: the run record is written last
  promotion_run_id uuid not null references public.promotion_runs (id) on delete restrict deferrable initially deferred,
  kind             public.regression_kind not null,
  payload          jsonb not null,
  status           public.regression_status not null default 'pending',
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint regression_queue_completion_check check ((status = 'pending') = (completed_at is null))
);

-- Every canonical version names the gate run that wrote it. Deferred: the gate writes the rows
-- first and the run record (every step, with the ids it produced) last, all in one transaction —
-- promotion_runs is append-only, so it can't be opened early and completed later.
alter table public.knowledge_versions
  add column if not exists promotion_run_id uuid;
do $$ begin
  if not exists (select from pg_constraint where conname = 'knowledge_versions_promotion_run_id_fkey') then
    alter table public.knowledge_versions add constraint knowledge_versions_promotion_run_id_fkey
      foreign key (promotion_run_id) references public.promotion_runs (id) on delete restrict
      deferrable initially deferred;
  end if;
end $$;

-- Gate rows trace to a candidate, or to first-party admission of an operator-authored source.
alter table public.knowledge_versions drop constraint if exists knowledge_versions_gate_candidate_check;
alter table public.knowledge_versions add constraint knowledge_versions_gate_candidate_check check (
  promoted_via <> 'gate'
  or (promotion_run_id is not null and (candidate_id is not null or approval->>'mode' = 'first-party-ingest')));

create index if not exists approval_queue_status_idx on public.approval_queue (status);
create index if not exists promotion_runs_candidate_id_idx on public.promotion_runs (candidate_id);
create index if not exists promotion_runs_source_id_idx on public.promotion_runs (source_id);
create index if not exists promotion_runs_ingestion_run_id_idx on public.promotion_runs (ingestion_run_id);
create index if not exists promotion_runs_approval_id_idx on public.promotion_runs (approval_id);
create index if not exists regression_queue_promotion_run_id_idx on public.regression_queue (promotion_run_id);
create index if not exists knowledge_versions_promotion_run_id_idx on public.knowledge_versions (promotion_run_id);

-- ─── state machine guards (hold for every role, definer functions included) ──
-- proposed -> pending_approval | promoted | rejected; pending_approval -> promoted | rejected.
-- promoted and rejected are terminal. A blocked candidate simply stays 'proposed'.
create or replace function public.xyp_knowledge_candidates_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not (
       (old.status::text = 'proposed' and new.status::text in ('pending_approval', 'promoted', 'rejected'))
    or (old.status::text = 'pending_approval' and new.status::text in ('promoted', 'rejected'))) then
    raise exception 'knowledge_candidates %: illegal transition % -> %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create or replace trigger trg_knowledge_candidates_transition before update on public.knowledge_candidates
  for each row execute function public.xyp_knowledge_candidates_transition();

create or replace function public.xyp_approval_queue_seal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending' then
    raise exception 'approval_queue % is sealed (status %)', old.id, old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.item_type <> old.item_type or new.item_id <> old.item_id or new.request <> old.request then
    raise exception 'approval_queue %: the request is immutable, only the decision is written', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;
create or replace trigger trg_approval_queue_seal before update on public.approval_queue
  for each row execute function public.xyp_approval_queue_seal();

-- History is not optional: a canonical row committed without its knowledge_versions row fails
-- the transaction — whoever inserts it, the gate's own role included. Deferred to commit because
-- the version row references the canonical id, so it is necessarily written after the row.
-- SECURITY DEFINER only to read knowledge_versions regardless of the inserting role's grants.
create or replace function public.xyp_canonical_requires_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.knowledge_versions kv
                 where kv.canonical_table::text = tg_table_name and kv.canonical_id = new.id) then
    raise exception '%.% (%, v%) committed without a knowledge_versions row', tg_table_name, new.id, new.slug, new.version
      using errcode = 'integrity_constraint_violation',
            hint = 'canonical knowledge is written only through the Promotion Gate (knowledge/promotion-gate)';
  end if;
  return null;
end;
$$;
do $$
declare
  t text;
begin
  foreach t in array array['modules', 'canonical_prompts'] loop
    if not exists (select from pg_trigger where tgname = 'trg_' || t || '_requires_history'
                   and tgrelid = format('public.%I', t)::regclass) then
      execute format('create constraint trigger %I after insert on public.%I deferrable initially deferred '
                     'for each row execute function public.xyp_canonical_requires_history()', 'trg_' || t || '_requires_history', t);
    end if;
  end loop;
end $$;

-- ─── operator decision ────────────────────────────────────────────────────────
-- SECURITY DEFINER so no role needs UPDATE on approval_queue: the decision columns are written
-- here and nowhere else. EXECUTE is the operator's (service_role) alone — an agent role can't
-- approve its own candidate.
create or replace function public.xyp_decide_approval(p_approval_id uuid, p_decision text, p_approver text, p_reason text)
returns public.approval_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.approval_status;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject, got %', p_decision using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_approver), '') = '' or coalesce(trim(p_reason), '') = '' then
    raise exception 'a decision needs an approver and a reason' using errcode = 'invalid_parameter_value';
  end if;
  update public.approval_queue
  set status = (case p_decision when 'approve' then 'approved' else 'rejected' end)::public.approval_status,
      decided_at = now(), decided_by = p_approver, decision_reason = p_reason
  where id = p_approval_id and status = 'pending'
  returning status into v_status;
  if v_status is null then
    raise exception 'approval % is not pending', p_approval_id using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_status;
end;
$$;

revoke execute on function
  public.xyp_canonical_requires_history(),
  public.xyp_knowledge_candidates_transition(),
  public.xyp_approval_queue_seal(),
  public.xyp_decide_approval(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.xyp_decide_approval(uuid, text, text, text) to service_role;

-- ─── F1 backfill: history for every canonical row written before the gate ────
-- Snapshot = the row as written, minus derived embedding columns (index data, not knowledge).
insert into public.knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot, approval)
select 'modules', m.id, m.version, 'bootstrap', to_jsonb(m),
       jsonb_build_object('mode', 'bootstrap', 'note', 'written by xyp_ingest_bootstrap before the gate existed (F1); backfilled by 6D')
from public.modules m
where m.promoted_via = 'bootstrap'
on conflict on constraint knowledge_versions_canonical_key do nothing;

insert into public.knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot, approval)
select 'canonical_prompts', cp.id, cp.version, 'bootstrap',
       to_jsonb(cp) - array['embedding', 'embedding_model', 'embedding_input_sha256', 'embedding_truncated', 'embedded_at'],
       jsonb_build_object('mode', 'bootstrap', 'note', 'written by xyp_ingest_bootstrap before the gate existed (F1); backfilled by 6D')
from public.canonical_prompts cp
where cp.promoted_via = 'bootstrap'
on conflict on constraint knowledge_versions_canonical_key do nothing;

-- ─── RLS + grants on the new tables ───────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['approval_queue', 'promotion_runs', 'regression_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, service_role', t);
    -- The operator reads everything; decisions go through xyp_decide_approval only.
    execute format('grant select on table public.%I to service_role', t);
  end loop;
end $$;

-- ─── F1 closed: canonical writes revoked from everyone but the gate ───────────
-- The bootstrap role keeps what the Source Registry needs (sources + ingestion_runs); its
-- canonical and graph writes move to xyp_promotion (first-party admission, knowledge/promotion-gate).
revoke all on table
  public.modules, public.canonical_prompts, public.tags, public.prompt_tags, public.relations, public.quality_reports
  from xyp_ingest_bootstrap;
revoke execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text) from xyp_ingest_bootstrap;
do $$
declare
  t text;
begin
  foreach t in array array['modules', 'canonical_prompts', 'tags', 'prompt_tags', 'relations', 'quality_reports'] loop
    execute format('drop policy if exists ingest_bootstrap_select on public.%I', t);
    execute format('drop policy if exists ingest_bootstrap_insert on public.%I', t);
  end loop;
end $$;

-- service_role (the operator's key) reads canonical knowledge but can no longer write it.
revoke insert, update, delete, truncate on table
  public.modules, public.canonical_prompts, public.knowledge_versions
  from service_role;

-- ─── xyp_promotion: the gate's service account ────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_promotion') then
    create role xyp_promotion nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_promotion;

-- Reads: everything a gate decision is made from.
grant select on table
  public.sources, public.modules, public.canonical_prompts, public.prompt_variants, public.tags, public.prompt_tags,
  public.relations, public.quality_reports, public.knowledge_versions,
  public.research_runs, public.research_sources, public.research_evidence, public.research_findings,
  public.research_finding_evidence, public.knowledge_candidates, public.contradictions,
  public.experiments, public.experiment_runs,
  public.canonical_claims, public.knowledge_candidate_eligibility,
  public.approval_queue, public.promotion_runs, public.regression_queue
  to xyp_promotion;
-- Append: canonical rows, their history and graph, the run record, the queues.
grant insert on table
  public.modules, public.canonical_prompts, public.knowledge_versions, public.tags, public.prompt_tags,
  public.relations, public.quality_reports, public.promotion_runs, public.regression_queue, public.approval_queue
  to xyp_promotion;
-- The one UPDATE the gate holds: moving a candidate through the state machine (trigger-guarded).
grant update (status) on table public.knowledge_candidates to xyp_promotion;
grant execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text) to xyp_promotion;

do $$
declare
  t text;
begin
  foreach t in array array[
    'sources', 'modules', 'canonical_prompts', 'prompt_variants', 'tags', 'prompt_tags', 'relations', 'quality_reports',
    'knowledge_versions', 'research_runs', 'research_sources', 'research_evidence', 'research_findings',
    'research_finding_evidence', 'knowledge_candidates', 'contradictions', 'experiments', 'experiment_runs',
    'approval_queue', 'promotion_runs', 'regression_queue'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'promotion_select') then
      execute format('create policy promotion_select on public.%I for select to xyp_promotion using (true)', t);
    end if;
  end loop;
  foreach t in array array[
    'modules', 'canonical_prompts', 'knowledge_versions', 'tags', 'prompt_tags', 'relations', 'quality_reports',
    'promotion_runs', 'regression_queue'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'promotion_insert') then
      execute format('create policy promotion_insert on public.%I for insert to xyp_promotion with check (true)', t);
    end if;
  end loop;
  -- The gate opens approvals; it never decides them. A pre-decided insert fails the policy (42501).
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'approval_queue' and policyname = 'promotion_insert') then
    create policy promotion_insert on public.approval_queue for insert to xyp_promotion
      with check (status = 'pending' and decided_at is null);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'knowledge_candidates' and policyname = 'promotion_update') then
    create policy promotion_update on public.knowledge_candidates for update to xyp_promotion using (true) with check (true);
  end if;
end $$;
