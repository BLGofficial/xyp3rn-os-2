-- Phase 6A — Research Intelligence schema (the 11 tables stubbed in Phase 1, plus one join).
-- Chain, as FKs: sources -> research_sources -> research_evidence -> research_findings
--   -> knowledge_candidates -> [gate: 6D] -> canonical_prompts/modules + knowledge_versions -> relations
-- Research agents (xyp_research) are INSERT-only on evidence/findings and may only *propose*
-- candidates; every status move after 'proposed' belongs to the Promotion Gate (6D, F2).
-- Idempotent. Rollback: supabase/rollbacks/20260924130000_research_schema.down.sql

-- ─── enums ────────────────────────────────────────────────────────────────────
do $$ begin create type public.research_project_status as enum ('open', 'closed');
exception when duplicate_object then null; end $$;
do $$ begin create type public.research_question_status as enum ('open', 'answered', 'abandoned');
exception when duplicate_object then null; end $$;
do $$ begin create type public.research_run_status as enum ('running', 'success', 'error');
exception when duplicate_object then null; end $$;
do $$ begin create type public.research_source_kind as enum ('web', 'doc', 'changelog', 'observation', 'ingested');
exception when duplicate_object then null; end $$;
do $$ begin create type public.knowledge_candidate_kind as enum ('canonical_prompt', 'module');
exception when duplicate_object then null; end $$;
-- 6D extends this with its state-machine states (ALTER TYPE ... ADD VALUE).
do $$ begin create type public.knowledge_candidate_status as enum ('proposed', 'promoted', 'rejected');
exception when duplicate_object then null; end $$;
do $$ begin create type public.contradiction_target as enum ('knowledge_candidate', 'canonical_prompt');
exception when duplicate_object then null; end $$;
do $$ begin create type public.contradiction_status as enum ('open', 'resolved_manual', 'resolved_experiment');
exception when duplicate_object then null; end $$;
do $$ begin create type public.experiment_status as enum ('planned', 'running', 'complete', 'error');
exception when duplicate_object then null; end $$;
do $$ begin create type public.experiment_variant as enum ('a', 'b');
exception when duplicate_object then null; end $$;
do $$ begin create type public.canonical_table as enum ('canonical_prompts', 'modules');
exception when duplicate_object then null; end $$;

-- ─── tables ───────────────────────────────────────────────────────────────────
create table if not exists public.research_projects (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null,
  title       text not null,
  description text,
  status      public.research_project_status not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint research_projects_slug_key unique (slug),
  constraint research_projects_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table if not exists public.research_questions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.research_projects (id) on delete restrict,
  question   text not null,
  status     public.research_question_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_questions_question_check check (length(trim(question)) > 0)
);

create table if not exists public.research_runs (
  id                   uuid primary key default gen_random_uuid(),
  question_id          uuid not null references public.research_questions (id) on delete restrict,
  status               public.research_run_status not null default 'running',
  -- Which specialists the Research Orchestrator activated, and the evidence for each choice.
  selected_specialists text[] not null default '{}',
  selection            jsonb not null default '{}'::jsonb,
  workflow_run_id      uuid references public.workflow_runs (id) on delete restrict,
  error_detail         text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  constraint research_runs_completion_check check ((status = 'running') = (completed_at is null)),
  constraint research_runs_error_detail_check check (status <> 'error' or error_detail is not null)
);

-- Cited origins of evidence (F9). Content-addressed like `sources`; nullable link to an
-- ingested `sources` row. Reliability is assigned by Source Verification (6C) at insert time.
create table if not exists public.research_sources (
  id                 uuid primary key default gen_random_uuid(),
  research_run_id    uuid not null references public.research_runs (id) on delete restrict,
  source_id          uuid references public.sources (id) on delete restrict,
  kind               public.research_source_kind not null,
  uri                text not null,
  title              text not null,
  content_sha256     text not null,
  excerpt            text,
  reliability        numeric(4, 3),
  reliability_inputs jsonb,
  retrieved_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  constraint research_sources_content_sha256_key unique (content_sha256),
  constraint research_sources_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint research_sources_reliability_check
    check ((reliability is null) = (reliability_inputs is null) and (reliability is null or reliability between 0 and 1))
);

-- Every claim carries source, model/version tag, confidence (with its inputs) and text — the
-- tag is what stops a v6 finding from silently overwriting a valid v4.5 rule.
create table if not exists public.research_evidence (
  id                 uuid primary key default gen_random_uuid(),
  research_run_id    uuid not null references public.research_runs (id) on delete restrict,
  research_source_id uuid not null references public.research_sources (id) on delete restrict,
  agent_run_id       uuid references public.agent_runs (id) on delete restrict,
  specialist         text not null,
  claim              text not null,
  model_tag          text not null,
  confidence         numeric(4, 3) not null,
  confidence_inputs  jsonb not null,
  created_at         timestamptz not null default now(),
  constraint research_evidence_claim_check check (length(trim(claim)) > 0),
  constraint research_evidence_model_tag_check check (length(trim(model_tag)) > 0),
  constraint research_evidence_confidence_check check (confidence between 0 and 1)
);

create table if not exists public.research_findings (
  id                uuid primary key default gen_random_uuid(),
  research_run_id   uuid not null references public.research_runs (id) on delete restrict,
  agent_run_id      uuid references public.agent_runs (id) on delete restrict,
  claim             text not null,
  model_tag         text not null,
  confidence        numeric(4, 3) not null,
  confidence_inputs jsonb not null,
  created_at        timestamptz not null default now(),
  constraint research_findings_claim_check check (length(trim(claim)) > 0),
  constraint research_findings_model_tag_check check (length(trim(model_tag)) > 0),
  constraint research_findings_confidence_check check (confidence between 0 and 1)
);

-- Evidence exists before the finding that synthesizes it, and both are insert-only, so the
-- evidence -> finding edge is its own insert-only join (a 12th table beyond the guide's 11).
create table if not exists public.research_finding_evidence (
  finding_id  uuid not null references public.research_findings (id) on delete restrict,
  evidence_id uuid not null references public.research_evidence (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (finding_id, evidence_id)
);

create table if not exists public.knowledge_candidates (
  id            uuid primary key default gen_random_uuid(),
  finding_id    uuid not null references public.research_findings (id) on delete restrict,
  proposed_kind public.knowledge_candidate_kind not null,
  target_slug   text not null,
  title         text not null,
  body          text not null,
  structured    jsonb,
  model_tag     text not null,
  domain        public.xyp_domain not null,
  tags          text[] not null default '{}',
  status        public.knowledge_candidate_status not null default 'proposed',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint knowledge_candidates_target_slug_check check (target_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint knowledge_candidates_model_tag_check check (length(trim(model_tag)) > 0)
);

-- A finding that conflicts with a candidate or live canonical rule. An open row blocks the
-- finding's candidates from the gate (6C/6D) until resolved manually or by experiment.
create table if not exists public.contradictions (
  id          uuid primary key default gen_random_uuid(),
  finding_id  uuid not null references public.research_findings (id) on delete restrict,
  target_type public.contradiction_target not null,
  target_id   uuid not null,
  detail      jsonb not null,
  status      public.contradiction_status not null default 'open',
  resolution  jsonb,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  constraint contradictions_resolution_check
    check ((status = 'open') = (resolved_at is null) and (status = 'open') = (resolution is null))
);

create table if not exists public.experiments (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references public.knowledge_candidates (id) on delete restrict,
  hypothesis     text not null,
  variant_a      jsonb not null,
  variant_b      jsonb not null,
  n_per_variant  integer not null,
  scoring_method text not null,
  status         public.experiment_status not null default 'planned',
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  constraint experiments_n_per_variant_check check (n_per_variant > 0)
);

create table if not exists public.experiment_runs (
  id            uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.experiments (id) on delete restrict,
  variant       public.experiment_variant not null,
  trial         integer not null,
  output        jsonb,
  score         numeric(5, 4),
  score_inputs  jsonb not null,
  -- Names the scorer. Until Phase 12's Critic exists this says so explicitly (never a fake score).
  scored_by     text not null,
  created_at    timestamptz not null default now(),
  constraint experiment_runs_trial_key unique (experiment_id, variant, trial),
  constraint experiment_runs_score_check check (score is null or score between 0 and 1)
);

-- Permanent canonical history. Written only by the Promotion Gate (6D). canonical_id points at
-- a canonical_prompts or modules row (polymorphic, so no FK; the gate writes both in one txn).
create table if not exists public.knowledge_versions (
  id              uuid primary key default gen_random_uuid(),
  canonical_table public.canonical_table not null,
  canonical_id    uuid not null,
  version         integer not null,
  candidate_id    uuid references public.knowledge_candidates (id) on delete restrict,
  promoted_via    public.canonical_provenance not null,
  snapshot        jsonb not null,
  approval        jsonb,
  created_at      timestamptz not null default now(),
  constraint knowledge_versions_canonical_key unique (canonical_table, canonical_id),
  constraint knowledge_versions_gate_candidate_check check (promoted_via <> 'gate' or candidate_id is not null)
);

alter table public.agent_runs
  add column if not exists research_run_id uuid references public.research_runs (id) on delete restrict;

-- FK lookups
create index if not exists research_questions_project_id_idx on public.research_questions (project_id);
create index if not exists research_runs_question_id_idx on public.research_runs (question_id);
create index if not exists research_sources_research_run_id_idx on public.research_sources (research_run_id);
create index if not exists research_evidence_research_run_id_idx on public.research_evidence (research_run_id);
create index if not exists research_evidence_research_source_id_idx on public.research_evidence (research_source_id);
create index if not exists research_findings_research_run_id_idx on public.research_findings (research_run_id);
create index if not exists research_finding_evidence_evidence_id_idx on public.research_finding_evidence (evidence_id);
create index if not exists knowledge_candidates_finding_id_idx on public.knowledge_candidates (finding_id);
create index if not exists contradictions_finding_id_idx on public.contradictions (finding_id);
create index if not exists contradictions_target_type_target_id_idx on public.contradictions (target_type, target_id);
create index if not exists experiments_candidate_id_idx on public.experiments (candidate_id);
create index if not exists knowledge_versions_candidate_id_idx on public.knowledge_versions (candidate_id);
create index if not exists agent_runs_research_run_id_idx on public.agent_runs (research_run_id);

-- ─── triggers ─────────────────────────────────────────────────────────────────
create or replace trigger trg_research_projects_updated_at before update on public.research_projects
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_research_questions_updated_at before update on public.research_questions
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_knowledge_candidates_updated_at before update on public.knowledge_candidates
  for each row execute function public.xyp_set_updated_at();

create or replace function public.xyp_research_runs_seal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'running' then
    raise exception 'research_runs % is sealed (status %)', old.id, old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;
create or replace trigger trg_research_runs_seal before update on public.research_runs
  for each row execute function public.xyp_research_runs_seal();
revoke execute on function public.xyp_research_runs_seal() from public, anon, authenticated;

-- ─── RLS + grants ─────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'research_projects', 'research_questions', 'research_runs', 'research_sources', 'research_evidence',
    'research_findings', 'research_finding_evidence', 'knowledge_candidates', 'contradictions',
    'experiments', 'experiment_runs', 'knowledge_versions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_research') then
    create role xyp_research nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_research;

-- Append: the research chain up to a proposed candidate. No UPDATE, no DELETE on any of these.
grant select, insert on table
  public.research_projects, public.research_questions, public.research_runs, public.research_sources,
  public.research_evidence, public.research_findings, public.research_finding_evidence, public.knowledge_candidates
  to xyp_research;
-- Lifecycle columns only: runs open and close; questions/projects get answered/closed.
grant update (status, selected_specialists, selection, workflow_run_id, error_detail, completed_at)
  on table public.research_runs to xyp_research;
grant update (status) on table public.research_questions, public.research_projects to xyp_research;
-- Read-only visibility of what 6C/6D decide and of canonical state.
grant select on table
  public.contradictions, public.experiments, public.experiment_runs, public.knowledge_versions,
  public.sources, public.modules, public.canonical_prompts
  to xyp_research;

do $$
declare
  t text;
begin
  foreach t in array array[
    'research_projects', 'research_questions', 'research_runs', 'research_sources', 'research_evidence',
    'research_findings', 'research_finding_evidence', 'knowledge_candidates', 'contradictions',
    'experiments', 'experiment_runs', 'knowledge_versions', 'sources', 'modules', 'canonical_prompts'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_select') then
      execute format('create policy research_select on public.%I for select to xyp_research using (true)', t);
    end if;
  end loop;
  foreach t in array array[
    'research_projects', 'research_questions', 'research_runs', 'research_sources', 'research_evidence',
    'research_findings', 'research_finding_evidence'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_insert') then
      execute format('create policy research_insert on public.%I for insert to xyp_research with check (true)', t);
    end if;
  end loop;
  foreach t in array array['research_projects', 'research_questions', 'research_runs'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_update') then
      execute format('create policy research_update on public.%I for update to xyp_research using (true) with check (true)', t);
    end if;
  end loop;
  -- Research may only propose. Any other status on insert fails the policy (42501).
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'knowledge_candidates' and policyname = 'research_insert') then
    create policy research_insert on public.knowledge_candidates for insert to xyp_research
      with check (status = 'proposed');
  end if;
end $$;
