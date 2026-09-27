-- AOS-04 Plan C1: the graph and file index (docs/artist-os/AOS-04-plan-C1.md, design §15). What it adds:
-- - the file index        index_scans (one row per scan, sealed once it leaves running), indexed_files (one row per
--                         root + path; a rename is a new row, the old one goes missing), index_nodes and index_edges
--                         (what files declare: agents, workflows and steps, decisions; imports, links, step agents;
--                         an edge with no target is a diagnostic), index_vault_status (Vault bytes present or not)
-- - xyp_indexer           writes the index tables and nothing else; reads four columns of sources for the Vault check
-- - the graph (read model) graph_nodes, graph_edge_candidates, graph_edges, graph_diagnostics, graph_link_history:
--                         security_invoker views over the index and the live records. Every edge carries its proof (a
--                         file and line, or a row); an edge whose endpoint isn't a node is a diagnostic, never an edge.
-- Index rows are derived: a scan rebuilds them, so the rollback drops them without refusing. Nothing here writes
-- canonical knowledge, research or Records data. Idempotent. Rollback: supabase/rollbacks/20260927100000_graph_index.down.sql

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_indexer') then
    create role xyp_indexer nologin noinherit;
  end if;
end $$;
grant usage on schema public to xyp_indexer;

-- ─── the file index ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.index_scans (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null,
  roots       jsonb not null,
  status      text not null default 'running',
  counts      jsonb,
  error       text,
  started_at  timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  constraint index_scans_trigger_check check (trigger in ('cli', 'boot', 'owner')),
  constraint index_scans_status_check check (status in ('running', 'success', 'error')),
  constraint index_scans_finished_check check ((status = 'running') = (finished_at is null)),
  constraint index_scans_error_check check ((status = 'error') = (error is not null)),
  constraint index_scans_counts_check check (status <> 'success' or counts is not null)
);

-- A scan's counts are what /system reports; once sealed they are history.
create or replace function public.xyp_index_scans_sealed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'running' then
    raise exception 'index scan % is sealed (%)', old.id, old.status using errcode = '55000';
  end if;
  return new;
end $$;
revoke execute on function public.xyp_index_scans_sealed() from public, anon, authenticated;
drop trigger if exists index_scans_sealed on public.index_scans;
create trigger index_scans_sealed before update on public.index_scans
  for each row execute function public.xyp_index_scans_sealed();

create table if not exists public.indexed_files (
  id              uuid primary key default gen_random_uuid(),
  root            text not null,
  path            text not null,
  sha256          text,
  size_bytes      bigint not null,
  mime            text,
  mtime           timestamptz not null,
  text_indexed    boolean not null,
  owner_domain    public.xyp_domain,
  ownership_basis text not null,
  status          text not null,
  error           text,
  first_scan_id   uuid not null references public.index_scans (id) on delete restrict,
  last_scan_id    uuid not null references public.index_scans (id) on delete restrict,
  indexed_at      timestamptz not null,
  constraint indexed_files_root_path_key unique (root, path),
  constraint indexed_files_root_check check (root ~ '^[a-z][a-z0-9-]*$'),
  -- Relative, '/'-separated, inside its root: no leading '/', no '.' or '..' segment, no backslash, no drive
  -- letter, no empty segment, no control character. The viewer re-checks the real path; this is the first line.
  constraint indexed_files_path_check check (
    path <> '' and path !~ '^/' and strpos(path, E'\\') = 0 and path !~ '^[A-Za-z]:' and path !~ '(^|/)\.{1,2}(/|$)'
    and strpos(path, '//') = 0 and path !~ '/$' and path !~ '[[:cntrl:]]'),
  constraint indexed_files_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint indexed_files_size_check check (size_bytes >= 0),
  constraint indexed_files_basis_check check (ownership_basis in ('frontmatter', 'manifest', 'domain-path', 'shared')),
  constraint indexed_files_owner_check check ((ownership_basis = 'shared') = (owner_domain is null)),
  constraint indexed_files_status_check check (status in ('present', 'missing', 'unreadable')),
  constraint indexed_files_error_check check ((status = 'unreadable') = (error is not null)),
  constraint indexed_files_hash_check check (status = 'unreadable' or sha256 is not null)
);

create table if not exists public.index_nodes (
  id              text primary key,
  kind            text not null,
  title           text not null,
  owner_domain    public.xyp_domain,
  ownership_basis text not null,
  file_id         uuid not null references public.indexed_files (id) on delete restrict,
  line            integer not null,
  revision        text not null,
  scan_id         uuid not null references public.index_scans (id) on delete restrict,
  detail          jsonb not null default '{}',
  constraint index_nodes_kind_check check (kind in ('agent', 'workflow', 'workflow_step', 'decision')),
  constraint index_nodes_id_check check (split_part(id, ':', 1) = kind and length(id) > length(kind) + 1),
  constraint index_nodes_basis_check check (ownership_basis in ('frontmatter', 'manifest', 'domain-path', 'shared')),
  constraint index_nodes_owner_check check ((ownership_basis = 'shared') = (owner_domain is null)),
  constraint index_nodes_line_check check (line >= 1)
);
create index if not exists index_nodes_file_id_idx on public.index_nodes (file_id);

create table if not exists public.index_edges (
  id       uuid primary key default gen_random_uuid(),
  relation text not null,
  from_id  text not null,
  -- null: the reference names nothing the index knows (a diagnostic, never drawn)
  to_id    text,
  file_id  uuid not null references public.indexed_files (id) on delete restrict,
  line     integer not null,
  -- the reference as written (a specifier, a link target, a step's agent)
  detail   text not null,
  revision text not null,
  scan_id  uuid not null references public.index_scans (id) on delete restrict,
  constraint index_edges_relation_check check (relation ~ '^[a-z][a-z_]*$'),
  constraint index_edges_line_check check (line >= 1)
);
create index if not exists index_edges_file_id_idx on public.index_edges (file_id);
create index if not exists index_edges_from_id_idx on public.index_edges (from_id);
create index if not exists index_edges_to_id_idx on public.index_edges (to_id);

create table if not exists public.index_vault_status (
  source_id  uuid primary key references public.sources (id) on delete restrict,
  status     text not null,
  checked_at timestamptz not null,
  scan_id    uuid not null references public.index_scans (id) on delete restrict,
  constraint index_vault_status_status_check check (status in ('present', 'missing', 'size-mismatch'))
);

-- ─── the graph (read model) ─────────────────────────────────────────────────────────────────────
-- Node ids: domain:<D>, module:<slug>, agent:<name>, workflow:<name>, workflow_step:<name>#<step>, decision:F<n>,
-- file:<root>/<path>, lineage:<uuid>, and <table>:<uuid> for every other record. Records are 'record'; only
-- stored bytes (an indexed file, a Vault source) are 'file'; the taxonomy's domains are 'configuration'.
create or replace view public.graph_nodes with (security_invoker = true) as
select 'domain:' || d::text as id, 'domain' as kind, d::text as title, d as owner_domain, 'taxonomy' as ownership_basis,
       'configuration' as backing, 'core/contracts/taxonomy.ts' as source_ref,
       (select f.sha256 from public.indexed_files f where f.root = 'repo' and f.path = 'core/contracts/taxonomy.ts' and f.status = 'present') as revision,
       'present' as availability, now() as as_of, null::text as path
from unnest(enum_range(null::public.xyp_domain)) d
union all
select n.id, n.kind, n.title, n.owner_domain, n.ownership_basis, 'file', f.path || ':' || n.line, n.revision,
       case f.status when 'present' then 'present' when 'missing' then 'missing' else 'unavailable' end, f.indexed_at, f.path
from public.index_nodes n join public.indexed_files f on f.id = n.file_id
union all
select 'file:' || f.root || '/' || f.path, 'file', f.path, f.owner_domain, f.ownership_basis, 'file', f.path, f.sha256,
       case f.status when 'present' then 'present' when 'missing' then 'missing' else 'unavailable' end, f.indexed_at, f.path
from public.indexed_files f
union all
select 'module:' || m.slug, 'module', m.title, m.domain, 'record', 'record', 'modules:' || m.id, 'v' || m.version, 'present', m.updated_at, null
from (select distinct on (slug) * from public.modules order by slug, version desc) m
union all
select 'canonical_prompts:' || c.id, 'canonical_prompt', c.title, m.domain, 'record', 'record', 'canonical_prompts:' || c.id, 'v' || c.version, 'present',
       c.updated_at, null
from public.canonical_prompts c join public.modules m on m.id = c.module_id
union all
-- A Vault file's bytes are checked by the scan: 'unchecked' until one has.
select 'sources:' || s.id, case when s.storage is null then 'source' else 'vault_file' end, coalesce(s.metadata->>'filename', s.title, s.uri),
       'KNOWLEDGE', 'owner-table', case when s.storage is null then 'record' else 'file' end, 'sources:' || s.id, s.checksum_sha256,
       case when s.storage is null then 'present'
            else coalesce(case v.status when 'present' then 'present' when 'missing' then 'missing' when 'size-mismatch' then 'unavailable' end, 'unchecked') end,
       coalesce(v.checked_at, s.created_at), null
from public.sources s left join public.index_vault_status v on v.source_id = s.id
union all
select 'lineage:' || l.lineage_id, 'lineage', l.schema_id || ' · ' || coalesce(l.body->>'name', l.body->>'title', l.brief), 'RECORDS', 'owner-table',
       'record', 'creative_artifacts:' || l.lineage_id, 'v' || l.version, 'present', l.created_at, null
from (select distinct on (lineage_id) * from public.creative_artifacts order by lineage_id, version desc) l
union all
select 'creative_artifacts:' || a.id, 'artifact_version', a.schema_id || ' v' || a.version, 'RECORDS', 'owner-table', 'record',
       'creative_artifacts:' || a.id, 'v' || a.version, 'present', a.created_at, null
from public.creative_artifacts a
union all
select 'songs:' || s.id, 'song', s.title, 'RECORDS', 'owner-table', 'record', 'songs:' || s.id, 'r' || s.revision, 'present', s.revised_at, null
from public.current_songs s
union all
select 'suno_takes:' || t.id, 'take', coalesce(t.title, t.provider_take_id, 'take'), 'RECORDS', 'owner-table', 'record', 'suno_takes:' || t.id, null,
       'present', t.created_at, null
from public.suno_takes t
union all
select 'tracks:' || t.id, 'track', t.title, 'RECORDS', 'owner-table', 'record', 'tracks:' || t.id, null, 'present', t.updated_at, null
from public.tracks t
union all
select 'releases:' || r.id, 'release', r.title, 'RECORDS', 'owner-table', 'record', 'releases:' || r.id, r.status::text, 'present', r.updated_at, null
from public.releases r
union all
select 'agent_runs:' || a.id, 'agent_run', a.agent_name || ' run', a.domain, 'record', 'record', 'agent_runs:' || a.id, a.status::text, 'present',
       coalesce(a.completed_at, a.created_at), null
from public.agent_runs a
union all
select 'workflow_runs:' || w.id, 'workflow_run', w.workflow_name || ' run', n.owner_domain, coalesce(n.ownership_basis, 'shared'), 'record',
       'workflow_runs:' || w.id, w.status::text, 'present', coalesce(w.completed_at, w.created_at), null
from public.workflow_runs w left join public.index_nodes n on n.id = 'workflow:' || w.workflow_name
union all
select 'research_questions:' || q.id, 'research_brief', q.question, 'RESEARCH_INTELLIGENCE', 'owner-table', 'record', 'research_questions:' || q.id,
       q.status::text, 'present', q.updated_at, null
from public.research_questions q
union all
select 'research_runs:' || r.id, 'research_run', q.question || ' · run', 'RESEARCH_INTELLIGENCE', 'owner-table', 'record', 'research_runs:' || r.id,
       r.status::text, 'present', coalesce(r.completed_at, r.created_at), null
from public.research_runs r join public.research_questions q on q.id = r.question_id
union all
select 'research_sources:' || s.id, 'research_source', coalesce(s.title, s.uri), 'RESEARCH_INTELLIGENCE', 'owner-table', 'record',
       'research_sources:' || s.id, s.content_sha256, 'present', s.created_at, null
from public.research_sources s
union all
select 'research_evidence:' || e.id, 'evidence', e.claim, 'RESEARCH_INTELLIGENCE', 'owner-table', 'record', 'research_evidence:' || e.id, null,
       'present', e.created_at, null
from public.research_evidence e
union all
select 'research_findings:' || f.id, 'finding', f.claim, 'RESEARCH_INTELLIGENCE', 'owner-table', 'record', 'research_findings:' || f.id, null,
       'present', f.created_at, null
from public.research_findings f
union all
select 'knowledge_candidates:' || k.id, 'candidate', k.title, 'KNOWLEDGE', 'owner-table', 'record', 'knowledge_candidates:' || k.id,
       k.status::text, 'present', k.updated_at, null
from public.knowledge_candidates k
union all
select 'approval_queue:' || a.id, 'approval', replace(a.item_type::text, '_', ' ') || ' · ' || a.status::text, 'GOVERNANCE', 'owner-table', 'record',
       'approval_queue:' || a.id, a.status::text, 'present', coalesce(a.decided_at, a.requested_at), null
from public.approval_queue a;

-- Every relation the index or the records prove, before its endpoints are checked. provenance: '<path>:<line>' for
-- a file, '<table>:<uuid>' for a row, '<table>:<uuid>#<column>' for a foreign key, 'ownership:<basis>:<path>'.
create or replace view public.graph_edge_candidates with (security_invoker = true) as
select e.relation || ':' || f.path || '@' || left(e.revision, 12) || ':L' || e.line || '>' || coalesce(e.to_id, e.detail) as id,
       e.relation, e.from_id, e.to_id, f.path || ':' || e.line as provenance, e.revision, e.detail, 'index' as origin
from public.index_edges e join public.indexed_files f on f.id = e.file_id
union all
select 'owned_by:' || f.root || '/' || f.path, 'owned_by', 'file:' || f.root || '/' || f.path, 'domain:' || f.owner_domain::text,
       'ownership:' || f.ownership_basis || ':' || f.path, f.sha256, f.ownership_basis, 'index'
from public.indexed_files f where f.owner_domain is not null and f.status <> 'missing'
union all
select 'owned_by:modules:' || m.id, 'owned_by', 'module:' || m.slug, 'domain:' || m.domain::text, 'modules:' || m.id || '#domain', 'v' || m.version,
       null, 'record'
from (select distinct on (slug) * from public.modules order by slug, version desc) m
union all
select r.predicate || ':relations:' || r.id, r.predicate,
       case r.subject_type::text
         when 'module' then (select 'module:' || m.slug from public.modules m where m.id::text = r.subject_id)
         when 'source' then 'sources:' || r.subject_id when 'canonical_prompt' then 'canonical_prompts:' || r.subject_id
         when 'agent' then 'agent:' || r.subject_id when 'workflow' then 'workflow:' || r.subject_id end,
       case r.object_type::text
         when 'module' then (select 'module:' || m.slug from public.modules m where m.id::text = r.object_id)
         when 'source' then 'sources:' || r.object_id when 'canonical_prompt' then 'canonical_prompts:' || r.object_id
         when 'agent' then 'agent:' || r.object_id when 'workflow' then 'workflow:' || r.object_id end,
       'relations:' || r.id, null, r.subject_type::text || ' ' || r.predicate || ' ' || r.object_type::text, 'record'
from public.relations r
union all
select 'linked_to:song_links:' || l.id, 'linked_to', 'songs:' || l.song_id,
       case l.kind when 'artifact_lineage' then 'lineage:' || l.target_id
         when 'source' then 'sources:' || l.target_id when 'take' then 'suno_takes:' || l.target_id when 'track' then 'tracks:' || l.target_id
         when 'research_question' then 'research_questions:' || l.target_id end,
       'song_links:' || l.id, null, l.role, 'record'
from public.current_song_links l
union all
select 'linked_to:research_links:' || l.id, 'linked_to', 'research_questions:' || l.question_id,
       case when l.artifact_lineage_id is not null then 'lineage:' || l.artifact_lineage_id
            when l.workflow_name is not null then 'workflow:' || l.workflow_name else 'decision:' || l.decision_key end,
       'research_links:' || l.id, l.workflow_sha256, l.role, 'record'
from public.research_links l
where not exists (select from public.research_link_retractions x where x.research_link_id = l.id)
union all
select 'run_of:agent_runs:' || a.id, 'run_of', 'agent_runs:' || a.id, 'agent:' || a.agent_name, 'agent_runs:' || a.id || '#agent_name', null, null, 'record'
from public.agent_runs a
union all
select 'part_of:agent_runs:' || a.id || '#workflow_run_id', 'part_of', 'agent_runs:' || a.id, 'workflow_runs:' || a.workflow_run_id,
       'agent_runs:' || a.id || '#workflow_run_id', null, a.step_id, 'record'
from public.agent_runs a where a.workflow_run_id is not null
union all
select 'part_of:agent_runs:' || a.id || '#research_run_id', 'part_of', 'agent_runs:' || a.id, 'research_runs:' || a.research_run_id,
       'agent_runs:' || a.id || '#research_run_id', null, null, 'record'
from public.agent_runs a where a.research_run_id is not null
union all
-- A run records the spec hash it ran; the projection compares it with the scanned definition.
select 'run_of:workflow_runs:' || w.id, 'run_of', 'workflow_runs:' || w.id, 'workflow:' || w.workflow_name, 'workflow_runs:' || w.id || '#workflow_name',
       w.spec_sha256, null, 'record'
from public.workflow_runs w
union all
select 'run_of:research_runs:' || r.id, 'run_of', 'research_runs:' || r.id, 'research_questions:' || r.question_id,
       'research_runs:' || r.id || '#question_id', null, null, 'record'
from public.research_runs r
union all
select 'part_of:tracks:' || t.id, 'part_of', 'tracks:' || t.id, 'releases:' || t.release_id, 'tracks:' || t.id || '#release_id', null, null, 'record'
from public.tracks t
union all
select 'produced_by:creative_artifacts:' || a.id, 'produced_by', 'creative_artifacts:' || a.id, 'agent_runs:' || a.agent_run_id,
       'creative_artifacts:' || a.id || '#agent_run_id', null, null, 'record'
from public.creative_artifacts a
union all
select 'version_of:creative_artifacts:' || a.id, 'version_of', 'creative_artifacts:' || a.id, 'lineage:' || a.lineage_id,
       'creative_artifacts:' || a.id || '#lineage_id', 'v' || a.version, null, 'record'
from public.creative_artifacts a
union all
select 'produced_by:sources:' || s.id, 'produced_by', 'sources:' || s.id, 'agent_runs:' || s.agent_run_id, 'sources:' || s.id || '#agent_run_id',
       null, null, 'record'
from public.sources s where s.agent_run_id is not null
union all
select 'produced_by:research_sources:' || s.id, 'produced_by', 'research_sources:' || s.id, 'research_runs:' || s.research_run_id,
       'research_sources:' || s.id || '#research_run_id', null, null, 'record'
from public.research_sources s
union all
select 'derived_from:research_sources:' || s.id, 'derived_from', 'research_sources:' || s.id, 'sources:' || s.source_id,
       'research_sources:' || s.id || '#source_id', null, null, 'record'
from public.research_sources s where s.source_id is not null
union all
select 'produced_by:research_evidence:' || e.id, 'produced_by', 'research_evidence:' || e.id, 'research_runs:' || e.research_run_id,
       'research_evidence:' || e.id || '#research_run_id', null, null, 'record'
from public.research_evidence e
union all
select 'quotes:research_evidence:' || e.id, 'quotes', 'research_evidence:' || e.id, 'research_sources:' || e.research_source_id,
       'research_evidence:' || e.id || '#research_source_id', null, e.quote, 'record'
from public.research_evidence e
union all
select 'produced_by:research_findings:' || f.id, 'produced_by', 'research_findings:' || f.id, 'research_runs:' || f.research_run_id,
       'research_findings:' || f.id || '#research_run_id', null, null, 'record'
from public.research_findings f
union all
select 'supported_by:research_finding_evidence:' || fe.finding_id || '/' || fe.evidence_id, 'supported_by', 'research_findings:' || fe.finding_id,
       'research_evidence:' || fe.evidence_id, 'research_finding_evidence:' || fe.finding_id || '/' || fe.evidence_id, null, null, 'record'
from public.research_finding_evidence fe
union all
select 'proposed_as:knowledge_candidates:' || k.id, 'proposed_as', 'research_findings:' || k.finding_id, 'knowledge_candidates:' || k.id,
       'knowledge_candidates:' || k.id || '#finding_id', null, null, 'record'
from public.knowledge_candidates k where k.finding_id is not null
union all
select 'approved_by:approval_queue:' || a.id, 'approved_by', 'knowledge_candidates:' || a.item_id, 'approval_queue:' || a.id, 'approval_queue:' || a.id,
       a.status::text, a.decision_reason, 'record'
from public.approval_queue a where a.item_type::text = 'knowledge_candidate'
union all
select 'promoted_to:knowledge_versions:' || v.id, 'promoted_to', 'knowledge_candidates:' || v.candidate_id,
       case v.canonical_table::text when 'canonical_prompts' then 'canonical_prompts:' || v.canonical_id
         when 'modules' then (select 'module:' || m.slug from public.modules m where m.id = v.canonical_id) end,
       'knowledge_versions:' || v.id, 'v' || v.version, null, 'record'
from public.knowledge_versions v where v.candidate_id is not null
union all
select 'decides:approval_queue:' || a.id, 'decides', 'approval_queue:' || a.id,
       case a.item_type::text when 'research_finding' then 'research_findings:' || a.item_id else 'creative_artifacts:' || a.item_id end,
       'approval_queue:' || a.id, a.status::text, a.decision_reason, 'record'
from public.approval_queue a where a.item_type::text in ('research_finding', 'artifact_version');

-- The graph draws only what it can prove end to end.
create or replace view public.graph_edges with (security_invoker = true) as
select c.id, c.relation, c.from_id, c.to_id, c.provenance, c.revision, c.detail, c.origin
from public.graph_edge_candidates c
where c.from_id is not null and c.to_id is not null
  and exists (select from public.graph_nodes n where n.id = c.from_id)
  and exists (select from public.graph_nodes n where n.id = c.to_id);

-- What it can't: a reference to nothing (unresolved) or to something not in the graph (dangling).
create or replace view public.graph_diagnostics with (security_invoker = true) as
select c.id, case when c.to_id is null and c.origin = 'index' then 'unresolved' else 'dangling' end as problem,
       c.relation, c.from_id, c.to_id, c.detail, c.provenance as source_ref, c.revision
from public.graph_edge_candidates c
where c.from_id is null or c.to_id is null
   or not exists (select from public.graph_nodes n where n.id = c.from_id)
   or not exists (select from public.graph_nodes n where n.id = c.to_id);

-- Retracted links: gone from the graph, kept here with the reason.
create or replace view public.graph_link_history with (security_invoker = true) as
select 'song_links' as link_table, l.id as link_id, 'songs:' || l.song_id as from_id,
       case when l.artifact_lineage_id is not null then 'lineage:' || l.artifact_lineage_id when l.source_id is not null then 'sources:' || l.source_id
            when l.take_id is not null then 'suno_takes:' || l.take_id when l.track_id is not null then 'tracks:' || l.track_id
            else 'research_questions:' || l.research_question_id end as to_id,
       l.role, l.created_at as linked_at, x.reason, x.created_at as retracted_at
from public.song_links l join public.song_link_retractions x on x.song_link_id = l.id
union all
select 'research_links', l.id, 'research_questions:' || l.question_id,
       case when l.artifact_lineage_id is not null then 'lineage:' || l.artifact_lineage_id
            when l.workflow_name is not null then 'workflow:' || l.workflow_name else 'decision:' || l.decision_key end,
       l.role, l.created_at, x.reason, x.created_at
from public.research_links l join public.research_link_retractions x on x.research_link_id = l.id;

-- ─── RLS + grants ───────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['index_scans', 'indexed_files', 'index_nodes', 'index_edges', 'index_vault_status'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'indexer_all') then
      execute format('create policy indexer_all on public.%I for all to xyp_indexer using (true) with check (true)', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'web_select') then
      execute format('create policy web_select on public.%I for select to xyp_web using (true)', t);
    end if;
  end loop;
  -- The Vault check reads four columns of sources (column grant below); the graph reads relations.
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'sources' and policyname = 'indexer_select') then
    create policy indexer_select on public.sources for select to xyp_indexer using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'relations' and policyname = 'web_select') then
    create policy web_select on public.relations for select to xyp_web using (true);
  end if;
end $$;

revoke all on table public.index_scans, public.indexed_files, public.index_nodes, public.index_edges, public.index_vault_status,
  public.graph_nodes, public.graph_edge_candidates, public.graph_edges, public.graph_diagnostics, public.graph_link_history
  from anon, authenticated, service_role;
-- service_role reads (G20); xyp_web reads what the UI renders.
grant select on table public.index_scans, public.indexed_files, public.index_nodes, public.index_edges, public.index_vault_status,
  public.graph_nodes, public.graph_edge_candidates, public.graph_edges, public.graph_diagnostics, public.graph_link_history
  to service_role, xyp_web;
grant select on table public.relations to xyp_web;
-- xyp_indexer: scans and files are updated in place (sealed scans refuse; files go missing, never away);
-- a changed file's declared nodes and edges are replaced.
grant select, insert, update on table public.index_scans, public.indexed_files, public.index_vault_status to xyp_indexer;
grant select, insert, delete on table public.index_nodes, public.index_edges to xyp_indexer;
grant select (id, checksum_sha256, byte_size, storage) on table public.sources to xyp_indexer;
