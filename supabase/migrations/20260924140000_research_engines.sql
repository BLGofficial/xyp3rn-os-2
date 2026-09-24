-- Phase 6C — structured claims, Contradiction Engine (in-DB, not bypassable), eligibility,
-- and the xyp_verifier role (resolves contradictions, runs experiments).
-- Claim shape (user decision): { topic, value, model_scope }. A conflict = same topic,
-- overlapping model scope, different value. Different model versions never conflict — that is
-- what keeps a suno-v5 finding from silently overriding a valid suno-v4.5 rule.
-- Idempotent. Rollback: supabase/rollbacks/20260924140000_research_engines.down.sql

-- ─── structured claim columns ────────────────────────────────────────────────
alter table public.research_findings
  add column if not exists claim_topic text,
  add column if not exists claim_value jsonb;
alter table public.research_findings alter column claim_topic set not null, alter column claim_value set not null;

alter table public.knowledge_candidates
  add column if not exists claim_topic text,
  add column if not exists claim_value jsonb;
alter table public.knowledge_candidates alter column claim_topic set not null, alter column claim_value set not null;

-- Evidence may carry a claim; if it does, both halves are required.
alter table public.research_evidence
  add column if not exists claim_topic text,
  add column if not exists claim_value jsonb;

do $$
declare
  t text;
begin
  foreach t in array array['research_findings', 'knowledge_candidates', 'research_evidence'] loop
    if not exists (select from pg_constraint where conname = t || '_claim_topic_check') then
      -- dotted kebab: <namespace>.<key>[.<key>…], e.g. suno.vocal-descriptor-position
      execute format('alter table public.%I add constraint %I check (claim_topic is null or claim_topic ~ %L)',
        t, t || '_claim_topic_check', '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$');
    end if;
  end loop;
  if not exists (select from pg_constraint where conname = 'research_evidence_claim_pair_check') then
    alter table public.research_evidence add constraint research_evidence_claim_pair_check
      check ((claim_topic is null) = (claim_value is null));
  end if;
end $$;

create index if not exists research_findings_claim_topic_idx on public.research_findings (claim_topic);
create index if not exists knowledge_candidates_claim_topic_idx on public.knowledge_candidates (claim_topic);

-- ─── claim semantics ─────────────────────────────────────────────────────────
create or replace function public.xyp_model_scopes_overlap(a text, b text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select a = b or a = 'model-agnostic' or b = 'model-agnostic' $$;

-- Live canonical claims: latest version of each slug, one row per structured claim.
create or replace view public.canonical_claims with (security_invoker = true) as
  select cp.id as canonical_prompt_id, cp.slug, cp.version,
         c->>'topic' as topic, c->'value' as value,
         coalesce(c->>'model_scope', cp.model_tag, 'model-agnostic') as model_scope
  from public.canonical_prompts cp
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(cp.structured->'claims') = 'array' then cp.structured->'claims' else '[]'::jsonb end) c
  where cp.version = (select max(x.version) from public.canonical_prompts x where x.slug = cp.slug);

-- ─── detection ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER: contradictions are written by the engine only. Research roles have no
-- INSERT on contradictions, so they can neither fabricate nor suppress one.
create or replace function public.xyp_detect_contradictions(
  p_finding_id uuid, p_topic text, p_value jsonb, p_model_tag text, p_self_candidate uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  insert into public.contradictions (finding_id, target_type, target_id, detail)
  select p_finding_id, 'canonical_prompt', cc.canonical_prompt_id,
         jsonb_build_object('topic', p_topic, 'finding_value', p_value, 'finding_model_tag', p_model_tag,
                            'target_value', cc.value, 'target_model_scope', cc.model_scope,
                            'target_slug', cc.slug, 'target_version', cc.version)
  from public.canonical_claims cc
  where cc.topic = p_topic
    and public.xyp_model_scopes_overlap(cc.model_scope, p_model_tag)
    and cc.value is distinct from p_value
    and not exists (select 1 from public.contradictions x where x.finding_id = p_finding_id
                    and x.target_type = 'canonical_prompt' and x.target_id = cc.canonical_prompt_id);
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  insert into public.contradictions (finding_id, target_type, target_id, detail)
  select p_finding_id, 'knowledge_candidate', kc.id,
         jsonb_build_object('topic', p_topic, 'finding_value', p_value, 'finding_model_tag', p_model_tag,
                            'target_value', kc.claim_value, 'target_model_scope', kc.model_tag,
                            'target_slug', kc.target_slug)
  from public.knowledge_candidates kc
  where kc.claim_topic = p_topic
    and public.xyp_model_scopes_overlap(kc.model_tag, p_model_tag)
    and kc.claim_value is distinct from p_value
    and kc.status <> 'rejected'
    and kc.finding_id <> p_finding_id
    and (p_self_candidate is null or kc.id <> p_self_candidate)
    and not exists (select 1 from public.contradictions x where x.finding_id = p_finding_id
                    and x.target_type = 'knowledge_candidate' and x.target_id = kc.id);
  get diagnostics v_n = row_count;
  return v_total + v_n;
end;
$$;

create or replace function public.xyp_research_findings_detect()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.xyp_detect_contradictions(new.id, new.claim_topic, new.claim_value, new.model_tag, null);
  return null;
end;
$$;

create or replace function public.xyp_knowledge_candidates_detect()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.xyp_detect_contradictions(new.finding_id, new.claim_topic, new.claim_value, new.model_tag, new.id);
  return null;
end;
$$;

-- Every new finding and every new candidate is checked — no code path can skip it.
create or replace trigger trg_research_findings_detect after insert on public.research_findings
  for each row execute function public.xyp_research_findings_detect();
create or replace trigger trg_knowledge_candidates_detect after insert on public.knowledge_candidates
  for each row execute function public.xyp_knowledge_candidates_detect();

revoke execute on function
  public.xyp_model_scopes_overlap(text, text),
  public.xyp_detect_contradictions(uuid, text, jsonb, text, uuid),
  public.xyp_research_findings_detect(),
  public.xyp_knowledge_candidates_detect()
  from public, anon, authenticated;

-- A candidate is blocked while any open contradiction touches it: raised by its own finding,
-- or naming it as the conflicting target. The Promotion Gate (6D) refuses blocked candidates.
create or replace view public.knowledge_candidate_eligibility with (security_invoker = true) as
  select kc.id as candidate_id, kc.finding_id, kc.status,
         (select count(*)::int from public.contradictions c
          where c.status = 'open'
            and (c.finding_id = kc.finding_id or (c.target_type = 'knowledge_candidate' and c.target_id = kc.id))) as open_contradictions
  from public.knowledge_candidates kc;

revoke all on table public.canonical_claims, public.knowledge_candidate_eligibility from anon, authenticated;
grant select on table public.canonical_claims, public.knowledge_candidate_eligibility to service_role, xyp_research;

-- ─── xyp_verifier ─────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_verifier') then
    create role xyp_verifier nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_verifier;
grant select on table
  public.research_projects, public.research_questions, public.research_runs, public.research_sources,
  public.research_evidence, public.research_findings, public.research_finding_evidence,
  public.knowledge_candidates, public.contradictions, public.experiments, public.experiment_runs,
  public.canonical_prompts, public.canonical_claims, public.knowledge_candidate_eligibility
  to xyp_verifier;
-- Resolve, never create or delete: contradictions come only from the engine.
grant update (status, resolution, resolved_at) on table public.contradictions to xyp_verifier;
grant insert on table public.experiments, public.experiment_runs to xyp_verifier;
grant update (status, completed_at) on table public.experiments to xyp_verifier;

do $$
declare
  t text;
begin
  foreach t in array array[
    'research_projects', 'research_questions', 'research_runs', 'research_sources', 'research_evidence',
    'research_findings', 'research_finding_evidence', 'knowledge_candidates', 'contradictions',
    'experiments', 'experiment_runs', 'canonical_prompts'
  ] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'verifier_select') then
      execute format('create policy verifier_select on public.%I for select to xyp_verifier using (true)', t);
    end if;
  end loop;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'contradictions' and policyname = 'verifier_update') then
    create policy verifier_update on public.contradictions for update to xyp_verifier using (true) with check (true);
  end if;
  foreach t in array array['experiments', 'experiment_runs'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'verifier_insert') then
      execute format('create policy verifier_insert on public.%I for insert to xyp_verifier with check (true)', t);
    end if;
  end loop;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'experiments' and policyname = 'verifier_update') then
    create policy verifier_update on public.experiments for update to xyp_verifier using (true) with check (true);
  end if;
end $$;
