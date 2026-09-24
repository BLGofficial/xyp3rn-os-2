-- Phase 1 — canonical base schema (Knowledge Layer).
-- Idempotent: every statement is safe to re-run. Rollback: supabase/rollbacks/20260924080000_canonical_base.down.sql
-- Contract: docs/ARCHITECTURE.md (KNOWLEDGE, F1, F7, F9) · ERD: docs/SCHEMA.md

-- ─── enums ────────────────────────────────────────────────────────────────────
-- xyp_domain mirrors core/contracts/taxonomy.ts DOMAINS; tests/phase-01 fails on drift.
do $$ begin
  create type public.xyp_domain as enum
    ('CORE', 'KNOWLEDGE', 'RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH', 'GOVERNANCE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.source_kind as enum ('url', 'file', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  -- noop = re-ingest of an unchanged checksum (Phase 2): recorded, zero side effects.
  create type public.ingestion_run_status as enum ('running', 'success', 'noop', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  -- bootstrap = written by Phase 2 ingestion before the gate exists (F1); gate = Phase 6D+.
  create type public.canonical_provenance as enum ('bootstrap', 'gate');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Table-backed types are existence-checked by trigger; agent/skill/workflow are file-backed
  -- (Agent Registry checks existence). Later phases extend with ALTER TYPE ... ADD VALUE.
  create type public.relation_entity_type as enum
    ('source', 'module', 'canonical_prompt', 'prompt_variant', 'tag', 'agent', 'skill', 'workflow');
exception when duplicate_object then null; end $$;

-- ─── shared trigger function ──────────────────────────────────────────────────
-- clock_timestamp(), not now(): now() is frozen per transaction, so an insert+update in one
-- transaction would otherwise leave updated_at unchanged.
create or replace function public.xyp_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- ─── tables ───────────────────────────────────────────────────────────────────
-- Content-addressed: unique checksum is what makes concurrent Phase 2 ingestions of the
-- same bytes collapse to one row (ON CONFLICT), instead of relying on app-level checks.
create table if not exists public.sources (
  id              uuid primary key default gen_random_uuid(),
  kind            public.source_kind not null,
  uri             text not null,
  title           text not null,
  checksum_sha256 text not null,
  mime_type       text,
  byte_size       bigint,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint sources_checksum_sha256_key unique (checksum_sha256),
  constraint sources_checksum_sha256_check check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sources_byte_size_check check (byte_size is null or byte_size >= 0)
);

create table if not exists public.ingestion_runs (
  id              uuid primary key default gen_random_uuid(),
  -- null until the source is registered; a run can fail before that point
  source_id       uuid references public.sources (id) on delete restrict,
  requested_uri   text not null,
  checksum_sha256 text,
  status          public.ingestion_run_status not null default 'running',
  stats           jsonb not null default '{}'::jsonb,
  error_detail    text,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ingestion_runs_completion_check check ((status = 'running') = (completed_at is null)),
  constraint ingestion_runs_error_detail_check check (status <> 'error' or error_detail is not null),
  constraint ingestion_runs_source_resolved_check check (status not in ('success', 'noop') or source_id is not null)
);

-- Canonical rows are versioned by (slug, version); Phase 6D appends new versions instead of
-- overwriting. source_id is required for bootstrap rows (must trace to an ingested source);
-- gate rows trace through knowledge_versions -> knowledge_candidates instead (F1, F9).
create table if not exists public.modules (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null,
  version      integer not null default 1,
  title        text not null,
  description  text,
  domain       public.xyp_domain not null,
  source_id    uuid references public.sources (id) on delete restrict,
  promoted_via public.canonical_provenance not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint modules_slug_version_key unique (slug, version),
  constraint modules_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint modules_version_check check (version >= 1),
  constraint modules_bootstrap_source_check check (promoted_via <> 'bootstrap' or source_id is not null)
);

create table if not exists public.canonical_prompts (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references public.modules (id) on delete restrict,
  slug         text not null,
  version      integer not null default 1,
  title        text not null,
  body         text not null,
  -- structured payload for rule-shaped entries (Vocal DNA, rubrics) — Phases 10–12
  structured   jsonb,
  -- model/version the rule applies to (e.g. suno-v4.5); 6D asserts it on gate promotions
  model_tag    text,
  source_id    uuid references public.sources (id) on delete restrict,
  promoted_via public.canonical_provenance not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint canonical_prompts_slug_version_key unique (slug, version),
  constraint canonical_prompts_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint canonical_prompts_version_check check (version >= 1),
  constraint canonical_prompts_bootstrap_source_check check (promoted_via <> 'bootstrap' or source_id is not null)
);

create table if not exists public.prompt_variants (
  id                  uuid primary key default gen_random_uuid(),
  canonical_prompt_id uuid not null references public.canonical_prompts (id) on delete restrict,
  label               text not null,
  body                text not null,
  model_tag           text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint prompt_variants_canonical_prompt_id_label_key unique (canonical_prompt_id, label)
);

create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  label      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tags_slug_key unique (slug),
  constraint tags_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

-- Join rows only: cascade is safe here, nothing else hangs off them.
create table if not exists public.prompt_tags (
  canonical_prompt_id uuid not null references public.canonical_prompts (id) on delete cascade,
  tag_id              uuid not null references public.tags (id) on delete cascade,
  created_at          timestamptz not null default now(),
  primary key (canonical_prompt_id, tag_id)
);

-- Generic graph edge. Ids are text so file-backed entities (agents by name) fit alongside uuids.
create table if not exists public.relations (
  id           uuid primary key default gen_random_uuid(),
  subject_type public.relation_entity_type not null,
  subject_id   text not null,
  predicate    text not null,
  object_type  public.relation_entity_type not null,
  object_id    text not null,
  created_at   timestamptz not null default now(),
  constraint relations_edge_key unique (subject_type, subject_id, predicate, object_type, object_id),
  constraint relations_predicate_check check (predicate ~ '^[a-z]+(_[a-z]+)*$')
);

create index if not exists relations_subject_type_subject_id_idx on public.relations (subject_type, subject_id);
create index if not exists relations_object_type_object_id_idx on public.relations (object_type, object_id);

-- Immutable report: scores always ship with the inputs that produced them (criteria).
create table if not exists public.quality_reports (
  id                  uuid primary key default gen_random_uuid(),
  ingestion_run_id    uuid references public.ingestion_runs (id) on delete restrict,
  source_id           uuid references public.sources (id) on delete restrict,
  canonical_prompt_id uuid references public.canonical_prompts (id) on delete restrict,
  rubric_version      text not null,
  criteria            jsonb not null,
  overall             numeric(5, 4) not null,
  created_at          timestamptz not null default now(),
  constraint quality_reports_target_check check (num_nonnulls(source_id, canonical_prompt_id) = 1),
  constraint quality_reports_overall_check check (overall between 0 and 1),
  constraint quality_reports_criteria_check
    check (jsonb_typeof(criteria) = 'array' and jsonb_array_length(criteria) > 0)
);

-- FK lookups (Postgres does not index the referencing side automatically).
create index if not exists ingestion_runs_source_id_idx on public.ingestion_runs (source_id);
create index if not exists modules_source_id_idx on public.modules (source_id);
create index if not exists canonical_prompts_module_id_idx on public.canonical_prompts (module_id);
create index if not exists canonical_prompts_source_id_idx on public.canonical_prompts (source_id);
create index if not exists prompt_tags_tag_id_idx on public.prompt_tags (tag_id);
create index if not exists quality_reports_ingestion_run_id_idx on public.quality_reports (ingestion_run_id);
create index if not exists quality_reports_source_id_idx on public.quality_reports (source_id);
create index if not exists quality_reports_canonical_prompt_id_idx on public.quality_reports (canonical_prompt_id);

-- ─── updated_at triggers (mutable tables only) ────────────────────────────────
create or replace trigger trg_sources_updated_at before update on public.sources
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_ingestion_runs_updated_at before update on public.ingestion_runs
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_modules_updated_at before update on public.modules
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_canonical_prompts_updated_at before update on public.canonical_prompts
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_prompt_variants_updated_at before update on public.prompt_variants
  for each row execute function public.xyp_set_updated_at();
create or replace trigger trg_tags_updated_at before update on public.tags
  for each row execute function public.xyp_set_updated_at();

-- ─── relations integrity (polymorphic, so no plain FK) ────────────────────────
-- Deny by default: an entity type added to the enum but not handled here resolves to false.
create or replace function public.xyp_relation_endpoint_exists(p_type public.relation_entity_type, p_id text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_type in ('agent', 'skill', 'workflow') then
    return p_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$';
  end if;
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return coalesce(case p_type
    when 'source'           then exists (select 1 from public.sources where id = p_id::uuid)
    when 'module'           then exists (select 1 from public.modules where id = p_id::uuid)
    when 'canonical_prompt' then exists (select 1 from public.canonical_prompts where id = p_id::uuid)
    when 'prompt_variant'   then exists (select 1 from public.prompt_variants where id = p_id::uuid)
    when 'tag'              then exists (select 1 from public.tags where id = p_id::uuid)
  end, false);
end;
$$;

create or replace function public.xyp_relations_validate_endpoints()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.xyp_relation_endpoint_exists(new.subject_type, new.subject_id) then
    raise exception 'relations.subject % "%" does not exist', new.subject_type, new.subject_id
      using errcode = 'foreign_key_violation';
  end if;
  if not public.xyp_relation_endpoint_exists(new.object_type, new.object_id) then
    raise exception 'relations.object % "%" does not exist', new.object_type, new.object_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_relations_validate_endpoints before insert or update on public.relations
  for each row execute function public.xyp_relations_validate_endpoints();

-- Deletes don't cascade into relations; edges orphaned later surface here instead of vanishing.
create or replace view public.relations_dangling with (security_invoker = true) as
  select r.*,
         not public.xyp_relation_endpoint_exists(r.subject_type, r.subject_id) as subject_missing,
         not public.xyp_relation_endpoint_exists(r.object_type, r.object_id) as object_missing
  from public.relations r
  where not public.xyp_relation_endpoint_exists(r.subject_type, r.subject_id)
     or not public.xyp_relation_endpoint_exists(r.object_type, r.object_id);

-- ─── RLS + grants: single-tenant, default deny, service_role bypass ───────────
-- Supabase grants anon/authenticated ALL on new public tables by default; revoke explicitly
-- (RLS alone would still leave TRUNCATE/REFERENCES/TRIGGER open). No policies = deny.
alter table public.sources           enable row level security;
alter table public.ingestion_runs    enable row level security;
alter table public.modules           enable row level security;
alter table public.canonical_prompts enable row level security;
alter table public.prompt_variants   enable row level security;
alter table public.tags              enable row level security;
alter table public.prompt_tags       enable row level security;
alter table public.relations         enable row level security;
alter table public.quality_reports   enable row level security;

revoke all on table
  public.sources, public.ingestion_runs, public.modules, public.canonical_prompts, public.prompt_variants,
  public.tags, public.prompt_tags, public.relations, public.quality_reports, public.relations_dangling
  from anon, authenticated;

grant all on table
  public.sources, public.ingestion_runs, public.modules, public.canonical_prompts, public.prompt_variants,
  public.tags, public.prompt_tags, public.relations, public.quality_reports, public.relations_dangling
  to service_role;

revoke execute on function
  public.xyp_set_updated_at(),
  public.xyp_relation_endpoint_exists(public.relation_entity_type, text),
  public.xyp_relations_validate_endpoints()
  from public, anon, authenticated;

-- The endpoint check runs as the inserting role (security invoker), so writers need EXECUTE.
grant execute on function public.xyp_relation_endpoint_exists(public.relation_entity_type, text) to service_role;
