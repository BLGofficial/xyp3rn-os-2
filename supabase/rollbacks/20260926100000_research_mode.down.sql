-- Rollback for 20260926100000_research_mode.sql. Idempotent. No CASCADE.
-- Refuses while the owner has decided a finding, linked a brief, or a specialist has written a quote or a
-- page's text: dropping them would lose the owner's data or the sources' proof, and a rollback never deletes data.
-- The enum value research_finding stays (Postgres can't drop one), as in the Phase 14 rollback.

-- Nested IFs: a table or column a second run already dropped must not be named in the condition testing for it.
do $$ begin
  if to_regclass('public.approval_queue') is not null then
    if exists (select from public.approval_queue where item_type::text = 'research_finding') then
      raise exception 'rollback 20260926100000: the owner has decided research findings; a rollback never deletes decisions';
    end if;
  end if;
  if to_regclass('public.research_links') is not null then
    if exists (select from public.research_links) then
      raise exception 'rollback 20260926100000: briefs have research links; retracting is not deleting';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_evidence' and column_name = 'quote') then
    if exists (select from public.research_evidence where quote is not null) then
      raise exception 'rollback 20260926100000: evidence carries quotes; dropping them would lose the claims'' proof';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_sources' and column_name = 'text') then
    if exists (select from public.research_sources where text is not null) then
      raise exception 'rollback 20260926100000: research sources keep page text; dropping it would lose the sources';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_questions' and column_name = 'intended_use') then
    if exists (select from public.research_questions where intended_use is not null or urls <> '{}' or specialists is not null) then
      raise exception 'rollback 20260926100000: briefs carry an intended use, urls or an owner selection';
    end if;
  end if;
end $$;

-- What the migration granted on tables older than it (the new tables take theirs with them).
do $$
declare
  t text;
begin
  foreach t in array array['song_links', 'song_link_retractions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists research_select on public.%I', t);
      execute format('revoke select on table public.%I from xyp_research', t);
    end if;
  end loop;
  foreach t in array array['research_finding_evidence', 'contradictions', 'knowledge_candidates'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists web_select on public.%I', t);
      execute format('revoke select on table public.%I from xyp_web', t);
    end if;
  end loop;
  if to_regclass('public.current_song_links') is not null then
    revoke select on table public.current_song_links from xyp_research;
  end if;
end $$;

drop view if exists public.findings_library;
drop view if exists public.current_finding_decisions;
drop function if exists public.xyp_decide_finding(uuid, text, text, text);
drop view if exists public.research_targets;
drop table if exists public.research_link_retractions;
drop table if exists public.research_links;
drop function if exists public.xyp_research_links_guard();

do $$ begin
  if to_regclass('public.research_evidence') is not null then
    drop trigger if exists trg_research_evidence_quote on public.research_evidence;
  end if;
end $$;
drop function if exists public.xyp_research_evidence_quote();

alter table if exists public.research_evidence drop constraint if exists research_evidence_quote_check;
alter table if exists public.research_evidence drop column if exists quote;
alter table if exists public.research_sources drop constraint if exists research_sources_text_check;
alter table if exists public.research_sources drop column if exists text;
do $$ begin
  if to_regclass('public.research_runs') is not null then
    revoke update (expires_at) on table public.research_runs from xyp_research;
  end if;
end $$;
alter table if exists public.research_runs drop column if exists expires_at;
alter table if exists public.research_questions drop constraint if exists research_questions_specialists_check;
alter table if exists public.research_questions drop constraint if exists research_questions_urls_check;
alter table if exists public.research_questions drop constraint if exists research_questions_intended_use_check;
alter table if exists public.research_questions drop column if exists specialists;
alter table if exists public.research_questions drop column if exists urls;
alter table if exists public.research_questions drop column if exists intended_use;
drop function if exists public.xyp_all_http(text[]);
drop function if exists public.xyp_squash(text);
