-- AOS-03: Studio mode and Suno-ready workflows (docs/artist-os/AOS-03-design.md §4.2). What it adds:
-- - the package writer guard   a x3lius.suno-package/v1 is written by x3lius-suno-package only, never revised
-- - suno_takes.source_id       a take is a Vault audio file or an https URL, exactly one (S3)
-- - xyp_suno_package_ready     the reasons a package can't be submitted: not a package, a source that doesn't
--                              match, a source version not approved, not built in a successful workflow run
-- - the submission gate        a submission names a ready package and records its own prompt and model (S4)
-- - take_ratings               the owner's rating of a take (1–5, keep/change notes); the latest is current
-- - generation_attempts,       the trace the gate asks for: per attempt the exact lyric, style recipe and tag set
--   generation_takes           versions, the workflow and its spec sha256; per take its Vault file and rating
-- Rows written before AOS-03 stay as they are: the gate runs on insert only.
-- Idempotent. Rollback: supabase/rollbacks/20260925160000_studio.down.sql

-- ─── the package writer guard ──────────────────────────────────────────────────────────────────
-- A package is built by code from the versions it names, so its trace is only as good as its writer:
-- any other Creative or Revision agent writing this schema would forge one. A package is never revised
-- either; a new lyric, style or tag version is a new package.
create or replace function public.xyp_creative_artifacts_package_writer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.schema_id = 'x3lius.suno-package/v1' then
    if new.agent_name <> 'x3lius-suno-package' then
      raise exception 'creative_artifacts: a x3lius.suno-package/v1 is written by x3lius-suno-package only, not %', new.agent_name
        using errcode = 'check_violation';
    end if;
    if new.parent_id is not null then
      raise exception 'creative_artifacts: a x3lius.suno-package/v1 is never revised; build a new package'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_creative_artifacts_package_writer before insert on public.creative_artifacts
  for each row execute function public.xyp_creative_artifacts_package_writer();

-- ─── takes from Vault audio (S3) ───────────────────────────────────────────────────────────────
alter table public.suno_takes alter column audio_url drop not null;
alter table public.suno_takes add column if not exists source_id uuid references public.sources (id) on delete restrict;

do $$ begin
  if not exists (select from pg_constraint where conname = 'suno_takes_audio_check') then
    alter table public.suno_takes add constraint suno_takes_audio_check check (num_nonnulls(audio_url, source_id) = 1);
  end if;
  if not exists (select from pg_constraint where conname = 'suno_takes_submission_source_key') then
    alter table public.suno_takes add constraint suno_takes_submission_source_key unique (submission_id, source_id);
  end if;
end $$;

create index if not exists suno_takes_source_id_idx on public.suno_takes (source_id);

-- SECURITY DEFINER: xyp_execution writes takes but does not read sources.
create or replace function public.xyp_suno_takes_vault_audio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_id is not null
     and not exists (select from public.sources s where s.id = new.source_id and s.storage is not null and s.media_class = 'audio') then
    raise exception 'suno_takes: source % is not a Vault audio file', new.source_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_suno_takes_vault_audio before insert on public.suno_takes
  for each row execute function public.xyp_suno_takes_vault_audio();

-- ─── readiness (S4) ────────────────────────────────────────────────────────────────────────────
-- Every reason, not the first, so the owner sees all that blocks a handoff at once. Approval is of the
-- exact version named: an approved later version of the same lineage does not count.
create or replace function public.xyp_suno_package_ready(p_artifact_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_a record;
  v_wf record;
  v_reasons text[] := '{}';
  v_role text;
  v_expected text;
  v_srcs jsonb[];
  v_src jsonb;
  v_id uuid;
  v_row record;
  v_status text;
begin
  select a.id, a.schema_id, a.body, a.agent_run_id into v_a from public.creative_artifacts a where a.id = p_artifact_id;
  if not found then
    return array[format('no artifact %s', p_artifact_id)];
  end if;
  if v_a.schema_id <> 'x3lius.suno-package/v1' then
    return array[format('artifact %s is a %s, not a x3lius.suno-package/v1: build a package with build-suno-package', p_artifact_id, v_a.schema_id)];
  end if;

  foreach v_role in array array['lyrics', 'style-recipe', 'meta-tag-set'] loop
    v_expected := case v_role when 'lyrics' then 'x3lius.lyrics/v2' when 'style-recipe' then 'x3lius.style-recipe/v1' else 'x3lius.meta-tag-set/v1' end;
    select coalesce(array_agg(x), '{}') into v_srcs
    from jsonb_array_elements(case when jsonb_typeof(v_a.body->'sources') = 'array' then v_a.body->'sources' else '[]' end) x
    where x->>'role' = v_role;
    if cardinality(v_srcs) = 0 then
      v_reasons := v_reasons || format('no %s source', v_role);
      continue;
    elsif cardinality(v_srcs) > 1 then
      v_reasons := v_reasons || format('%s %s sources; a package names exactly one', cardinality(v_srcs), v_role);
      continue;
    end if;
    v_src := v_srcs[1];
    if coalesce(v_src->>'artifactId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_reasons := v_reasons || format('the %s source has no artifact id', v_role);
      continue;
    end if;
    v_id := (v_src->>'artifactId')::uuid;
    select a.schema_id, a.version into v_row from public.creative_artifacts a where a.id = v_id;
    if not found then
      v_reasons := v_reasons || format('%s %s: no such artifact', v_role, v_id);
    elsif v_row.schema_id <> v_expected then
      v_reasons := v_reasons || format('%s %s is a %s, not a %s', v_role, v_id, v_row.schema_id, v_expected);
    elsif v_src->'version' is distinct from to_jsonb(v_row.version) then
      v_reasons := v_reasons || format('%s %s is v%s, not v%s', v_role, v_id, v_row.version, coalesce(v_src->>'version', '?'));
    else
      v_status := coalesce((select q.status::text from public.approval_queue q
                            where q.item_type = 'artifact_version' and q.item_id = v_id), 'draft');
      if v_status <> 'approved' then
        v_reasons := v_reasons || format('%s %s v%s is %s: the owner approves it first', v_role, v_id, v_row.version, v_status);
      end if;
    end if;
  end loop;

  select w.id, w.workflow_name, w.status::text as status into v_wf
  from public.agent_runs r join public.workflow_runs w on w.id = r.workflow_run_id
  where r.id = v_a.agent_run_id;
  if not found then
    v_reasons := v_reasons || format('package %s was not built in a workflow run: build it with build-suno-package', p_artifact_id);
  elsif v_wf.status <> 'success' then
    v_reasons := v_reasons || format('package %s was built by workflow run %s (%s), which %s', p_artifact_id, v_wf.id, v_wf.workflow_name,
                                     case v_wf.status when 'running' then 'is still running' else 'ended ' || v_wf.status end);
  end if;
  return v_reasons;
end;
$$;

-- ─── the submission gate (S4) ──────────────────────────────────────────────────────────────────
-- A BEFORE trigger runs before the CHECK constraints, so a malformed prompt reads as "not the package's
-- own" (23514) here; a missing artifact is left to the FK.
create or replace function public.xyp_suno_submissions_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reasons text[];
  v_body jsonb;
begin
  select a.body into v_body from public.creative_artifacts a where a.id = new.formula_artifact_id;
  if not found then
    return new;
  end if;
  v_reasons := public.xyp_suno_package_ready(new.formula_artifact_id);
  if cardinality(v_reasons) > 0 then
    raise exception 'suno_submissions: % is not ready to hand off: %', new.formula_artifact_id, array_to_string(v_reasons, '; ')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.prompt is distinct from jsonb_build_object('title', v_body->'title', 'style', v_body->'style',
                                                    'excludeStyles', v_body->'excludeStyles', 'lyrics', v_body->'lyrics') then
    raise exception 'suno_submissions: the prompt is not package %''s own title, style, exclusions and lyrics', new.formula_artifact_id
      using errcode = 'check_violation';
  end if;
  if new.suno_model is distinct from v_body->>'sunoModel' then
    raise exception 'suno_submissions: package % targets Suno %, not %', new.formula_artifact_id, v_body->>'sunoModel', new.suno_model
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_suno_submissions_gate before insert on public.suno_submissions
  for each row execute function public.xyp_suno_submissions_gate();

-- ─── take_ratings ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.take_ratings (
  id           uuid primary key default gen_random_uuid(),
  take_id      uuid not null references public.suno_takes (id) on delete restrict,
  rating       integer not null,
  -- What to reuse and what to change next time (PLAN §3F); either may be left out.
  keep         text,
  change       text,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  created_at   timestamptz not null default now(),
  constraint take_ratings_rating_check check (rating between 1 and 5),
  constraint take_ratings_keep_check check (keep is null or length(btrim(keep)) > 0),
  constraint take_ratings_change_check check (change is null or length(btrim(change)) > 0)
);

create index if not exists take_ratings_take_id_idx on public.take_ratings (take_id);
create index if not exists take_ratings_agent_run_id_idx on public.take_ratings (agent_run_id);

create or replace trigger trg_take_ratings_immutable before update or delete on public.take_ratings
  for each row execute function public.xyp_suno_trail_immutable();

create or replace view public.current_take_ratings with (security_invoker = true) as
  select distinct on (r.take_id) r.take_id, r.id, r.rating, r.keep, r.change, r.agent_run_id, r.created_at
  from public.take_ratings r
  order by r.take_id, r.created_at desc, r.id desc;

-- ─── the trace (the gate's data) ───────────────────────────────────────────────────────────────
-- Only a package's sources are read as its trace: a Phase 9 formula lists sources too, but nothing
-- checked them, so a submission from before AOS-03 is listed with is_traced false.
create or replace view public.generation_attempts with (security_invoker = true) as
  select s.id as submission_id, s.created_at, s.adapter, s.suno_model,
         a.id as package_id, a.version as package_version, a.schema_id as package_schema_id, a.body->>'title' as title,
         (select l.song_id from public.song_links l
          where l.artifact_lineage_id = a.lineage_id and l.role = 'suno-package'
            and not exists (select from public.song_link_retractions x where x.song_link_id = l.id)
          order by l.created_at limit 1) as song_id,
         src.lyrics_id, src.lyrics_version, src.style_recipe_id, src.style_recipe_version, src.meta_tag_set_id, src.meta_tag_set_version,
         w.id as workflow_run_id, w.workflow_name, w.spec_sha256 as workflow_sha256,
         (select count(*) from public.suno_takes t where t.submission_id = s.id)::integer as take_count,
         (a.schema_id = 'x3lius.suno-package/v1' and w.id is not null
          and src.lyrics_id is not null and src.style_recipe_id is not null and src.meta_tag_set_id is not null) as is_traced
  from public.suno_submissions s
  join public.creative_artifacts a on a.id = s.formula_artifact_id
  left join public.agent_runs r on r.id = a.agent_run_id
  left join public.workflow_runs w on w.id = r.workflow_run_id
  left join lateral (
    select (max(x->>'artifactId') filter (where x->>'role' = 'lyrics'))::uuid as lyrics_id,
           max((x->>'version')::integer) filter (where x->>'role' = 'lyrics') as lyrics_version,
           (max(x->>'artifactId') filter (where x->>'role' = 'style-recipe'))::uuid as style_recipe_id,
           max((x->>'version')::integer) filter (where x->>'role' = 'style-recipe') as style_recipe_version,
           (max(x->>'artifactId') filter (where x->>'role' = 'meta-tag-set'))::uuid as meta_tag_set_id,
           max((x->>'version')::integer) filter (where x->>'role' = 'meta-tag-set') as meta_tag_set_version
    from jsonb_array_elements(case when a.schema_id = 'x3lius.suno-package/v1' then a.body->'sources' else '[]'::jsonb end) x
  ) src on true;

create or replace view public.generation_takes with (security_invoker = true) as
  select t.id as take_id, t.submission_id, t.created_at, t.title, t.duration_seconds,
         t.source_id, f.title as file_title, f.checksum_sha256 as audio_sha256, t.audio_url,
         r.rating, r.keep, r.change, r.created_at as rated_at
  from public.suno_takes t
  left join public.sources f on f.id = t.source_id
  left join public.current_take_ratings r on r.take_id = t.id;

-- ─── grants, RLS ────────────────────────────────────────────────────────────────────────────────
alter table public.take_ratings enable row level security;

revoke all on table public.take_ratings, public.current_take_ratings, public.generation_attempts, public.generation_takes
  from anon, authenticated, service_role;

-- service_role reads everything new (G20: reads only).
grant select on table public.take_ratings, public.current_take_ratings, public.generation_attempts, public.generation_takes to service_role;
-- xyp_execution: the owner's ratings through suno-submitter (feedback.write).
grant select, insert on table public.take_ratings to xyp_execution;
grant select on table public.current_take_ratings to xyp_execution;
-- xyp_web: the Studio screens read the ratings and the trace.
grant select on table public.take_ratings, public.current_take_ratings, public.generation_attempts, public.generation_takes to xyp_web;

do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'take_ratings' and policyname = 'execution_select') then
    create policy execution_select on public.take_ratings for select to xyp_execution using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'take_ratings' and policyname = 'execution_insert') then
    create policy execution_insert on public.take_ratings for insert to xyp_execution with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'take_ratings' and policyname = 'service_select') then
    create policy service_select on public.take_ratings for select to service_role using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'take_ratings' and policyname = 'web_select') then
    create policy web_select on public.take_ratings for select to xyp_web using (true);
  end if;
end $$;

revoke execute on function
  public.xyp_creative_artifacts_package_writer(), public.xyp_suno_takes_vault_audio(), public.xyp_suno_submissions_gate()
  from public, anon, authenticated;
-- Readiness: the submitter asks before any adapter call, and the UI shows what blocks a handoff.
revoke execute on function public.xyp_suno_package_ready(uuid) from public, anon, authenticated, service_role;
grant execute on function public.xyp_suno_package_ready(uuid) to xyp_execution, xyp_web;
