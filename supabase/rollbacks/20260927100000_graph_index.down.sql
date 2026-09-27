-- Rollback for 20260927100000_graph_index.sql. Idempotent. No CASCADE.
-- No refusal: every row it drops is derived (a scan rebuilds the index; the views hold no data), so no owner
-- data is lost. The xyp_indexer role stays (cluster-wide, as xyp_tasks); it loses the schema and its grants.

drop view if exists public.graph_link_history;
drop view if exists public.graph_diagnostics;
drop view if exists public.graph_edges;
drop view if exists public.graph_edge_candidates;
drop view if exists public.graph_nodes;

drop table if exists public.index_vault_status;
drop table if exists public.index_edges;
drop table if exists public.index_nodes;
drop table if exists public.indexed_files;
drop table if exists public.index_scans;
drop function if exists public.xyp_index_scans_sealed();

-- What the migration granted on tables older than it. Nested IFs: a later rollback in a full down may already
-- have dropped the table, and a second run must not name it.
do $$ begin
  if to_regclass('public.sources') is not null then
    if exists (select from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'indexer_select') then
      drop policy indexer_select on public.sources;
    end if;
    if exists (select from pg_roles where rolname = 'xyp_indexer') then
      revoke select (id, checksum_sha256, byte_size, storage) on table public.sources from xyp_indexer;
    end if;
  end if;
  if to_regclass('public.relations') is not null then
    if exists (select from pg_policies where schemaname = 'public' and tablename = 'relations' and policyname = 'web_select') then
      drop policy web_select on public.relations;
    end if;
    if exists (select from pg_roles where rolname = 'xyp_web') then
      revoke select on table public.relations from xyp_web;
    end if;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_indexer') then
    revoke usage on schema public from xyp_indexer;
  end if;
end $$;
