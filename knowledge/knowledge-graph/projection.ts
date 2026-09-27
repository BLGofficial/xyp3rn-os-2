import type postgres from 'postgres';
import type { Domain } from '../../core/contracts/taxonomy.ts';
import { LYRICS_SCHEMA_ID, META_TAG_SET_SCHEMA_ID, STYLE_RECIPE_SCHEMA_ID } from '../../records/x3lius/creative/schemas.ts';

/**
 * The graph as the UI reads it (AOS-04 Plan C1 Task 5, design §13.2, §15–16): pages of nodes, one node with its
 * proven connections, one hop around a node, the index's coverage, and the Creative lens. Plain SQL over the
 * graph views; the caller supplies a read-only transaction (as xyp_web). Nothing here decides what is connected:
 * an edge is a row of graph_edges or it isn't shown.
 */

export type GraphNode = {
  readonly id: string; readonly kind: string; readonly title: string; readonly ownerDomain: Domain | null; readonly ownershipBasis: string;
  readonly backing: 'file' | 'record' | 'configuration'; readonly sourceRef: string; readonly revision: string | null;
  readonly availability: string; readonly asOf: string; readonly path: string | null;
  /** indexed_files.id for a repository file (the viewer's opaque id); null otherwise. */
  readonly fileId: string | null;
};
export type GraphEdge = {
  readonly id: string; readonly relation: string; readonly fromId: string; readonly toId: string; readonly provenance: string;
  readonly revision: string | null; readonly detail: string | null; readonly origin: 'index' | 'record';
};
export type Connection = GraphEdge & {
  readonly direction: 'out' | 'in'; readonly other: GraphNode;
  /** `earlier-revision`: a run or link names a workflow revision other than the one the index holds. */
  readonly verification: 'verified' | 'earlier-revision'; readonly note: string | null;
};
export type LinkHistory = {
  readonly linkTable: string; readonly linkId: string; readonly fromId: string; readonly toId: string; readonly role: string | null;
  readonly linkedAt: string; readonly reason: string; readonly retractedAt: string;
};
export type Diagnostic = { readonly id: string; readonly problem: string; readonly relation: string; readonly toId: string | null; readonly detail: string | null; readonly sourceRef: string };
export type NodeFilter = {
  /** A taxonomy domain, or `shared` for Shared/Unassigned. */
  readonly domain?: Domain | 'shared' | undefined; readonly kind?: string | undefined;
  readonly lens?: 'creative' | undefined; readonly group?: string | undefined;
  readonly page?: number | undefined; readonly perPage?: number | undefined;
};

export type NodeRow = {
  id: string; kind: string; title: string; owner_domain: string | null; ownership_basis: string; backing: string; source_ref: string;
  revision: string | null; availability: string; as_of: Date; path: string | null; file_id: string | null;
};
type EdgeRow = { id: string; relation: string; from_id: string; to_id: string; provenance: string; revision: string | null; detail: string | null; origin: string };

export const toNode = (r: NodeRow): GraphNode => ({
  id: r.id, kind: r.kind, title: r.title, ownerDomain: r.owner_domain as Domain | null, ownershipBasis: r.ownership_basis,
  backing: r.backing as GraphNode['backing'], sourceRef: r.source_ref, revision: r.revision, availability: r.availability,
  asOf: r.as_of.toISOString(), path: r.path, fileId: r.file_id,
});
const toEdge = (r: EdgeRow): GraphEdge => ({
  id: r.id, relation: r.relation, fromId: r.from_id, toId: r.to_id, provenance: r.provenance, revision: r.revision, detail: r.detail,
  origin: r.origin as GraphEdge['origin'],
});

// A file node carries its indexed_files id: the viewer takes that opaque id, never a path.
export const NODES = (tx: postgres.TransactionSql) => tx`
  select n.id, n.kind, n.title, n.owner_domain::text, n.ownership_basis, n.backing, n.source_ref, n.revision, n.availability, n.as_of, n.path,
         f.id as file_id
  from graph_nodes n
  left join indexed_files f on n.kind = 'file' and f.path = n.path and 'file:' || f.root || '/' || f.path = n.id`;

const nodesByIds = async (tx: postgres.TransactionSql, ids: readonly string[]): Promise<Map<string, GraphNode>> => {
  if (ids.length === 0) return new Map();
  const rows = await tx<NodeRow[]>`select * from (${NODES(tx)}) n where n.id = any(${[...ids]})`;
  return new Map(rows.map((r) => [r.id, toNode(r)]));
};

/**
 * The Creative lens (§13.2): six groups over the same entity ids, each with the filter it applies, under the
 * real X3LIUS Music System module when it exists (null otherwise: the lens never invents an anchor).
 * @param tx - a read-only transaction as xyp_web
 * @returns the anchor node (or null) and each group's members
 */
export const lensGroups = async (tx: postgres.TransactionSql) => {
  const lineages = async (like: string) =>
    (await tx<{ id: string }[]>`select distinct 'lineage:' || lineage_id as id from creative_artifacts where schema_id like ${like} order by 1`).map((r) => r.id);
  const nodesOf = async (where: postgres.PendingQuery<postgres.Row[]>) =>
    (await tx<{ id: string }[]>`select id from graph_nodes where ${where} order by title, id`).map((r) => r.id);
  const family = (schemaId: string) => `${schemaId.slice(0, schemaId.indexOf('/'))}/%`;
  const groups = [
    { key: 'songs', label: 'Songs', query: 'kind = song', memberIds: await nodesOf(tx`kind = 'song'`) },
    { key: 'lyrics', label: 'Lyrics', query: `lineages with schema ${family(LYRICS_SCHEMA_ID)}`, memberIds: await lineages(family(LYRICS_SCHEMA_ID)) },
    { key: 'styles', label: 'Styles', query: `lineages with schema ${family(STYLE_RECIPE_SCHEMA_ID)}`, memberIds: await lineages(family(STYLE_RECIPE_SCHEMA_ID)) },
    { key: 'meta-tags', label: 'Meta Tags', query: `lineages with schema ${family(META_TAG_SET_SCHEMA_ID)}`, memberIds: await lineages(family(META_TAG_SET_SCHEMA_ID)) },
    {
      key: 'research', label: 'Research', query: 'briefs with a song or lineage target',
      memberIds: (await tx<{ id: string }[]>`select distinct 'research_questions:' || question_id as id from research_targets where kind in ('song', 'lineage') order by 1`).map((r) => r.id),
    },
    { key: 'workflows', label: 'Workflows', query: 'workflows owned by RECORDS', memberIds: await nodesOf(tx`kind = 'workflow' and owner_domain = 'RECORDS'`) },
  ].map((g) => ({ ...g, count: g.memberIds.length }));
  const anchor = (await nodesByIds(tx, ['module:x3lius-music-system'])).get('module:x3lius-music-system') ?? null;
  return { anchor, groups };
};

/**
 * A page of nodes, ordered by kind, title and id. Filters narrow the list; they never remove a node from the graph.
 * @param tx - a read-only transaction as xyp_web
 * @param f - domain (or `shared`), kind, a Creative lens group, page (1-based), perPage (default 50)
 * @returns the page and the filtered total
 */
export const listNodes = async (tx: postgres.TransactionSql, f: NodeFilter) => {
  const perPage = Math.min(Math.max(f.perPage ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const members = f.lens === 'creative' && f.group ? (await lensGroups(tx)).groups.find((g) => g.key === f.group)?.memberIds ?? [] : null;
  const where = tx`
    ${f.domain === 'shared' ? tx`n.owner_domain is null` : f.domain ? tx`n.owner_domain = ${f.domain}` : tx`true`}
    and ${f.kind ? tx`n.kind = ${f.kind}` : tx`true`}
    and ${members ? tx`n.id = any(${members})` : tx`true`}`;
  const [c] = await tx<{ n: number }[]>`select count(*)::int as n from (${NODES(tx)}) n where ${where}`;
  const rows = await tx<NodeRow[]>`select * from (${NODES(tx)}) n where ${where} order by n.kind, n.title, n.id limit ${perPage} offset ${(page - 1) * perPage}`;
  return { nodes: rows.map(toNode), total: c!.n, page, perPage };
};

// A run or a link that names a workflow revision: compare it with the revision the index holds.
const verify = (e: GraphEdge, workflow: GraphNode | undefined): Pick<Connection, 'verification' | 'note'> => {
  if (!workflow || workflow.kind !== 'workflow' || !e.revision || !workflow.revision) return { verification: 'verified', note: null };
  const verb = e.relation === 'run_of' ? 'ran' : 'linked';
  return e.revision === workflow.revision
    ? { verification: 'verified', note: `${verb} this revision` }
    : { verification: 'earlier-revision', note: `${verb} an earlier revision (${e.revision.slice(0, 12)}…), not the scanned ${workflow.revision.slice(0, 12)}…` };
};

const TARGET_ID: Readonly<Record<string, (t: string) => string>> = {
  song: (t) => `songs:${t}`, lineage: (t) => `lineage:${t}`, workflow: (t) => `workflow:${t.split('@')[0]}`, decision: (t) => `decision:${t}`,
};

/**
 * One node with everything the inspector shows: its proven connections both ways (each with its provenance and,
 * for workflow revisions, whether it matches), a finding's targets inherited from its brief (never direct edges),
 * retracted links, and the diagnostics it raised.
 * @param tx - a read-only transaction as xyp_web
 * @param id - a node id
 * @returns the detail, or null when no node has that id
 */
export const nodeDetail = async (tx: postgres.TransactionSql, id: string) => {
  const node = (await nodesByIds(tx, [id])).get(id);
  if (!node) return null;
  const out = (await tx<EdgeRow[]>`select * from graph_edges where from_id = ${id} order by relation, to_id`).map(toEdge);
  const inc = (await tx<EdgeRow[]>`select * from graph_edges where to_id = ${id} order by relation, from_id`).map(toEdge);
  const others = await nodesByIds(tx, [...out.map((e) => e.toId), ...inc.map((e) => e.fromId)]);
  const outgoing: Connection[] = out.map((e) => ({ ...e, direction: 'out', other: others.get(e.toId)!, ...verify(e, others.get(e.toId)) }));
  const incoming: Connection[] = inc.map((e) => ({ ...e, direction: 'in', other: others.get(e.fromId)!, ...verify(e, node) }));

  let inherited: { label: 'Inherited from brief'; brief: GraphNode; targetId: string; target: GraphNode | null }[] = [];
  if (node.kind === 'finding') {
    const rows = await tx<{ brief: string; kind: string; target: string }[]>`
      select r.question_id as brief, t.kind, t.target
      from research_findings f join research_runs r on r.id = f.research_run_id join research_targets t on t.question_id = r.question_id
      where f.id::text = ${id.slice('research_findings:'.length)} order by t.kind, t.target`;
    const ids = rows.filter((r) => TARGET_ID[r.kind]).map((r) => TARGET_ID[r.kind]!(r.target));
    const found = await nodesByIds(tx, [...ids, ...rows.map((r) => `research_questions:${r.brief}`)]);
    inherited = rows.filter((r) => TARGET_ID[r.kind]).map((r) => {
      const targetId = TARGET_ID[r.kind]!(r.target);
      return { label: 'Inherited from brief' as const, brief: found.get(`research_questions:${r.brief}`)!, targetId, target: found.get(targetId) ?? null };
    });
  }
  const history: LinkHistory[] = (await tx<{ link_table: string; link_id: string; from_id: string; to_id: string; role: string | null; linked_at: Date; reason: string; retracted_at: Date }[]>`
    select * from graph_link_history where from_id = ${id} or to_id = ${id} order by retracted_at desc`).map((h) => ({
    linkTable: h.link_table, linkId: h.link_id, fromId: h.from_id, toId: h.to_id, role: h.role, linkedAt: h.linked_at.toISOString(), reason: h.reason,
    retractedAt: h.retracted_at.toISOString(),
  }));
  const diagnostics: Diagnostic[] = (await tx<{ id: string; problem: string; relation: string; to_id: string | null; detail: string | null; source_ref: string }[]>`
    select id, problem, relation, to_id, detail, source_ref from graph_diagnostics where from_id = ${id} order by source_ref`).map((d) => ({
    id: d.id, problem: d.problem, relation: d.relation, toId: d.to_id, detail: d.detail, sourceRef: d.source_ref,
  }));
  return { node, outgoing, incoming, inherited, history, diagnostics };
};

/**
 * One hop around a node: its actual edges and the nodes at their other ends.
 * @param tx - a read-only transaction as xyp_web
 * @param id - the centre node's id
 * @returns centre, neighbours and edges (empty when the node has none; the centre is null for an unknown id)
 */
export const neighbourhood = async (tx: postgres.TransactionSql, id: string) => {
  const edges = (await tx<EdgeRow[]>`select * from graph_edges where from_id = ${id} or to_id = ${id} order by relation, id`).map(toEdge);
  const nodes = await nodesByIds(tx, [id, ...edges.map((e) => (e.fromId === id ? e.toId : e.fromId))]);
  const center = nodes.get(id) ?? null;
  nodes.delete(id);
  return { center, nodes: [...nodes.values()], edges };
};

/**
 * The index's scope and freshness (§15.2 item 1): roots, the last scan and its counts, files by status,
 * diagnostics, and how many nodes the graph holds, each read, none estimated.
 * @param tx - a read-only transaction as xyp_web
 */
export const coverage = async (tx: postgres.TransactionSql) => {
  const [s] = await tx<{ id: string; trigger: string; status: string; roots: { id: string; dir: string }[]; counts: unknown; error: string | null; started_at: Date; finished_at: Date | null }[]>`
    select id, trigger, status, roots, counts, error, started_at, finished_at from index_scans order by started_at desc, id limit 1`;
  const [f] = await tx<{ present: number; missing: number; unreadable: number }[]>`
    select count(*) filter (where status = 'present')::int as present, count(*) filter (where status = 'missing')::int as missing,
           count(*) filter (where status = 'unreadable')::int as unreadable from indexed_files`;
  const [d] = await tx<{ unresolved: number; dangling: number }[]>`
    select count(*) filter (where problem = 'unresolved')::int as unresolved, count(*) filter (where problem = 'dangling')::int as dangling from graph_diagnostics`;
  const [n] = await tx<{ n: number; asof: Date }[]>`select count(*)::int as n, now() as asof from graph_nodes`;
  return {
    roots: s?.roots ?? [],
    lastScan: s ? { id: s.id, trigger: s.trigger, status: s.status, counts: s.counts, error: s.error, startedAt: s.started_at.toISOString(), finishedAt: s.finished_at?.toISOString() ?? null } : null,
    files: f!, diagnostics: d!, nodes: n!.n, asOf: n!.asof.toISOString(),
  };
};
