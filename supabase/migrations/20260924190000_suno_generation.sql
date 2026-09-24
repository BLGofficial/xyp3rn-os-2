-- Phase 9 — the Suno audit trail: what was sent, what came back, and the scoring hook.
-- suno_submissions  one row per accepted submission: the exact prompt (copied from the formula
--                   artifact), the adapter (manual | sunoapi), the Suno model, the provider task.
-- suno_takes        the takes captured for a submission (operator-registered or provider-polled).
-- take_scores       the scoring hook: STUB rows (is_stub, no score) until the Phase 12 Critic writes
--                   real ones. A stub row never carries a number: no fabricated scores.
-- All three are insert-only for every role (trigger), written by the Execution role xyp_execution.
-- Reads: xyp_execution and xyp_runtime (read_artifact, capability artifact.read) may SELECT
-- creative_artifacts; neither may write it.
-- Idempotent. Rollback: supabase/rollbacks/20260924190000_suno_generation.down.sql

create table if not exists public.suno_submissions (
  id                  uuid primary key default gen_random_uuid(),
  formula_artifact_id uuid not null references public.creative_artifacts (id) on delete restrict,
  agent_run_id        uuid not null references public.agent_runs (id) on delete restrict,
  adapter             text not null,
  suno_model          text not null,
  -- The exact prompt submitted: {title, style, excludeStyles, lyrics}.
  prompt              jsonb not null,
  provider_task_id    text,
  provider_response   jsonb,
  created_at          timestamptz not null default now(),
  constraint suno_submissions_adapter_check check (adapter in ('manual', 'sunoapi')),
  -- manual has no provider task; an API submission always has one.
  constraint suno_submissions_provider_task_check check ((adapter = 'manual') = (provider_task_id is null)),
  constraint suno_submissions_model_check check (length(suno_model) > 0),
  constraint suno_submissions_prompt_check check (
    jsonb_typeof(prompt) = 'object' and prompt ?& array['title', 'style', 'excludeStyles', 'lyrics'])
);

create table if not exists public.suno_takes (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid not null references public.suno_submissions (id) on delete restrict,
  agent_run_id     uuid not null references public.agent_runs (id) on delete restrict,
  provider_take_id text,
  audio_url        text not null,
  title            text,
  duration_seconds numeric,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  constraint suno_takes_submission_audio_key unique (submission_id, audio_url),
  constraint suno_takes_audio_url_check check (audio_url ~ '^https://[^\s/]+/'),
  constraint suno_takes_duration_check check (duration_seconds is null or duration_seconds > 0),
  constraint suno_takes_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.take_scores (
  id           uuid primary key default gen_random_uuid(),
  take_id      uuid not null references public.suno_takes (id) on delete restrict,
  agent_run_id uuid references public.agent_runs (id) on delete restrict,
  scorer       text not null,
  is_stub      boolean not null,
  score        numeric,
  detail       jsonb not null,
  created_at   timestamptz not null default now(),
  -- A stub marks the hook and carries no number; a real score always does.
  constraint take_scores_stub_check check (is_stub = (score is null)),
  constraint take_scores_scorer_check check (length(scorer) > 0),
  constraint take_scores_detail_check check (jsonb_typeof(detail) = 'object')
);

create index if not exists suno_submissions_formula_artifact_id_idx on public.suno_submissions (formula_artifact_id);
create index if not exists suno_submissions_agent_run_id_idx on public.suno_submissions (agent_run_id);
create index if not exists suno_takes_agent_run_id_idx on public.suno_takes (agent_run_id);
create index if not exists take_scores_take_id_idx on public.take_scores (take_id);
create index if not exists take_scores_agent_run_id_idx on public.take_scores (agent_run_id);

-- Append-only for every role, the owner included.
create or replace function public.xyp_suno_trail_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% % is append-only', tg_table_name, old.id
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['suno_submissions', 'suno_takes', 'take_scores'] loop
    execute format('create or replace trigger trg_%s_immutable before update or delete on public.%I
                    for each row execute function public.xyp_suno_trail_immutable()', t, t);
  end loop;
end $$;

revoke execute on function public.xyp_suno_trail_immutable() from public, anon, authenticated;

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_execution') then
    create role xyp_execution nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_execution;

do $$
declare
  t text;
begin
  foreach t in array array['suno_submissions', 'suno_takes', 'take_scores'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role', t);
    execute format('grant select, insert on table public.%I to xyp_execution', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'execution_select') then
      execute format('create policy execution_select on public.%I for select to xyp_execution using (true)', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'execution_insert') then
      execute format('create policy execution_insert on public.%I for insert to xyp_execution with check (true)', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'service_select') then
      execute format('create policy service_select on public.%I for select to service_role using (true)', t);
    end if;
  end loop;
end $$;

-- artifact.read: the submitter reads the formula artifact it submits; read_artifact reads as xyp_runtime.
grant select on table public.creative_artifacts to xyp_execution, xyp_runtime;
do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'creative_artifacts' and policyname = 'execution_select') then
    create policy execution_select on public.creative_artifacts for select to xyp_execution using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'creative_artifacts' and policyname = 'runtime_select') then
    create policy runtime_select on public.creative_artifacts for select to xyp_runtime using (true);
  end if;
end $$;
