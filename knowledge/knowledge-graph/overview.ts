import type postgres from 'postgres';
import { DOMAIN_META, DOMAINS, type Domain } from '../../core/contracts/taxonomy.ts';
import { KIND_LABEL } from './search.ts';

/**
 * The bounded overview the sphere draws (Jarvis Prompt 01, F48): the graph at a glance, never a second graph.
 * Domains and the registered kinds (workflows, modules, agents, workflow steps) are drawn one by one; every other
 * kind is grouped per owner domain (or Shared) into a group that names its query and its real members. Edges are
 * graph_edges rows between drawn nodes, plus a group's `contains` link to its domain, marked as grouping. A demoted
 * node's edges are dropped, never re-pointed at its group: a group proves nothing about its members' connections.
 */

/** Kinds drawn one by one, in the order they give way to groups when the budget is short (least connected first). */
export const DEMOTION_ORDER = ['workflow_step', 'agent', 'module', 'workflow'] as const;
/** Member ids a group lists; `count` always has them all. */
export const MEMBER_LIMIT = 200;

export type OverviewNode = { readonly id: string; readonly kind: string; readonly title: string; readonly ownerDomain: Domain | null; readonly availability: string };
export type OverviewGroup = {
  readonly id: string; readonly kind: string; readonly domain: Domain | 'shared'; readonly label: string; readonly count: number;
  /** The filter that reads the members back (the list's kind and domain filters). */
  readonly query: string; readonly memberIds: readonly string[]; readonly membersTruncated: boolean;
};
export type OverviewEdge = { readonly id: string; readonly relation: string; readonly fromId: string; readonly toId: string; readonly provenance: string; readonly grouping: boolean };
export type Overview = {
  readonly nodes: readonly OverviewNode[]; readonly groups: readonly OverviewGroup[]; readonly edges: readonly OverviewEdge[];
  readonly edgesTotal: number; readonly edgesTruncated: boolean;
  /** Registered kinds grouped to fit the budget, in DEMOTION_ORDER. */
  readonly demoted: readonly string[];
  readonly counts: { readonly indexed: number; readonly drawn: number; readonly grouped: number };
  readonly budget: { readonly maxNodes: number; readonly maxEdges: number };
  readonly asOf: string;
};

const ownerRank = (o: string) => (o === 'shared' ? DOMAINS.length : DOMAINS.indexOf(o as Domain));
const ownerLabel = (o: string) => (o === 'shared' ? 'Shared/Unassigned' : DOMAIN_META[o as Domain].label);

/**
 * @param tx - a read-only transaction as xyp_web, repeatable read (the counts, members and edges come from one
 *   snapshot, so indexed = drawn + grouped holds while a scan commits)
 * @param o - maxNodes: drawn nodes plus groups (default 250; the six domains and the groups are the floor, drawn
 *   even when they alone exceed it); maxEdges (default 500)
 * @returns drawn nodes (kind, title, id order), groups (domain order, then kind), edges (graph_edges by relation and
 *   id, then contains links), and counts where indexed = drawn + grouped
 */
export const overview = async (tx: postgres.TransactionSql, o: { maxNodes?: number | undefined; maxEdges?: number | undefined } = {}): Promise<Overview> => {
  const maxNodes = o.maxNodes ?? 250;
  const maxEdges = o.maxEdges ?? 500;
  const tally = await tx<{ kind: string; owner: string; n: number }[]>`
    select kind, coalesce(owner_domain::text, 'shared') as owner, count(*)::int as n from graph_nodes group by 1, 2`;
  const drawnKinds = new Set<string>(['domain', ...DEMOTION_ORDER]);
  const slots = () => tally.reduce((s, t) => s + (drawnKinds.has(t.kind) ? t.n : 1), 0);
  const demoted: string[] = [];
  for (const kind of DEMOTION_ORDER) {
    if (slots() <= maxNodes) break;
    drawnKinds.delete(kind);
    demoted.push(kind);
  }
  const drawn = [...drawnKinds];

  const nodes: OverviewNode[] = (await tx<{ id: string; kind: string; title: string; owner_domain: Domain | null; availability: string }[]>`
    select id, kind, title, owner_domain::text, availability from graph_nodes where kind = any(${drawn}) order by kind, title, id`).map((r) => ({
    id: r.id, kind: r.kind, title: r.title, ownerDomain: r.owner_domain, availability: r.availability,
  }));

  // The members in the list's order (kind, title, id), so a group's first ids are the list's first page.
  const members = await tx<{ id: string; kind: string; owner: string }[]>`
    select id, kind, owner from (
      select id, kind, coalesce(owner_domain::text, 'shared') as owner,
             row_number() over (partition by kind, owner_domain order by title, id) as rn
      from graph_nodes where kind <> all(${drawn})
    ) m where rn <= ${MEMBER_LIMIT} order by kind, owner, rn`;
  const idsOf = new Map<string, string[]>();
  for (const m of members) {
    const k = `${m.owner}:${m.kind}`;
    idsOf.set(k, [...(idsOf.get(k) ?? []), m.id]);
  }
  const groups: OverviewGroup[] = tally
    .filter((t) => !drawnKinds.has(t.kind))
    .sort((a, b) => ownerRank(a.owner) - ownerRank(b.owner) || a.kind.localeCompare(b.kind))
    .map((t) => ({
      id: `group:${t.owner}:${t.kind}`, kind: t.kind, domain: t.owner as Domain | 'shared', label: `${ownerLabel(t.owner)} · ${KIND_LABEL[t.kind] ?? t.kind}`,
      count: t.n, query: `kind = ${t.kind} and owner ${t.owner === 'shared' ? 'is Shared/Unassigned' : `= ${t.owner}`}`,
      memberIds: idsOf.get(`${t.owner}:${t.kind}`) ?? [], membersTruncated: t.n > MEMBER_LIMIT,
    }));

  const ids = nodes.map((n) => n.id);
  const real: OverviewEdge[] = (await tx<{ id: string; relation: string; from_id: string; to_id: string; provenance: string }[]>`
    select id, relation, from_id, to_id, provenance from graph_edges where from_id = any(${ids}) and to_id = any(${ids}) order by relation, id`).map((e) => ({
    id: e.id, relation: e.relation, fromId: e.from_id, toId: e.to_id, provenance: e.provenance, grouping: false,
  }));
  const contains: OverviewEdge[] = groups.filter((g) => g.domain !== 'shared').map((g) => ({
    id: `contains:${g.id}`, relation: 'contains', fromId: g.id, toId: `domain:${g.domain}`, provenance: `grouping: ${g.query}`, grouping: true,
  }));
  const edges = [...real, ...contains];
  const [now] = await tx<{ now: Date }[]>`select now()`;
  const grouped = groups.reduce((s, g) => s + g.count, 0);
  return {
    nodes, groups, edges: edges.slice(0, maxEdges), edgesTotal: edges.length, edgesTruncated: edges.length > maxEdges, demoted,
    counts: { indexed: tally.reduce((s, t) => s + t.n, 0), drawn: nodes.length, grouped }, budget: { maxNodes, maxEdges }, asOf: now!.now.toISOString(),
  };
};
