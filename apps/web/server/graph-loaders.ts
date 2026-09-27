import type { Sql } from '../../../core/db/client.ts';
import * as p from '../../../knowledge/knowledge-graph/projection.ts';
import { searchIndex } from '../../../knowledge/knowledge-graph/search.ts';
import { asWeb } from './loaders.ts';

/**
 * What the Graph list, the inspector and the System page read (AOS-04 Plan C1 Task 5), as xyp_web in read-only
 * transactions, with each node's destination: its own page where the app has one, else the node page.
 */

export type GraphNode = p.GraphNode & { readonly href: string };

const uuidOf = (id: string) => id.slice(id.indexOf(':') + 1);

/**
 * @param n - a node
 * @returns the page that opens it: a repository file by its opaque index id, a record by its existing route
 */
export const hrefOf = (n: p.GraphNode): string => {
  switch (n.kind) {
    case 'domain': return `/?domain=${uuidOf(n.id)}`;
    case 'file': return n.fileId ? `/index/files/${n.fileId}` : `/node?id=${encodeURIComponent(n.id)}`;
    case 'vault_file': return `/vault/files/${uuidOf(n.id)}`;
    case 'lineage': return `/vault/lineages/${uuidOf(n.id)}`;
    case 'song': return `/songs/${uuidOf(n.id)}`;
    case 'release': return `/releases/${uuidOf(n.id)}`;
    case 'research_run': return `/research/runs/${uuidOf(n.id)}`;
    default: return `/node?id=${encodeURIComponent(n.id)}`;
  }
};
const withHref = (n: p.GraphNode): GraphNode => ({ ...n, href: hrefOf(n) });

/** A page of nodes (see projection.listNodes), each with its href. */
export const listNodes = (sql: Sql, f: p.NodeFilter) =>
  asWeb(sql, async (tx) => {
    const r = await p.listNodes(tx, f);
    return { ...r, nodes: r.nodes.map(withHref) };
  });

/** One node with its connections, inherited targets, history and diagnostics (see projection.nodeDetail). */
export const nodeDetail = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    const d = await p.nodeDetail(tx, id);
    if (!d) return null;
    return {
      ...d,
      node: withHref(d.node),
      outgoing: d.outgoing.map((c) => ({ ...c, other: withHref(c.other) })),
      incoming: d.incoming.map((c) => ({ ...c, other: withHref(c.other) })),
      inherited: d.inherited.map((i) => ({ ...i, brief: withHref(i.brief), target: i.target ? withHref(i.target) : null })),
    };
  });

/** One hop around a node (see projection.neighbourhood). */
export const neighbourhood = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    const n = await p.neighbourhood(tx, id);
    return { center: n.center ? withHref(n.center) : null, nodes: n.nodes.map(withHref), edges: n.edges };
  });

/** The index's scope and freshness (see projection.coverage). */
export const coverage = (sql: Sql) => asWeb(sql, (tx) => p.coverage(tx));

/** The Creative lens's groups (see projection.lensGroups). */
export const lensGroups = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const l = await p.lensGroups(tx);
    return { anchor: l.anchor ? withHref(l.anchor) : null, groups: l.groups };
  });

/**
 * Global search (§16): groups by kind with totals. A hit's `href` focuses it on the graph (its neighbourhood loads
 * first); `destination` opens its own page.
 */
export const search = (sql: Sql, q: string) =>
  asWeb(sql, async (tx) => {
    const r = await searchIndex(tx, q);
    return {
      ...r,
      groups: r.groups.map((g) => ({
        ...g,
        hits: g.hits.map((n) => ({ ...n, domain: n.ownerDomain, href: `/?node=${encodeURIComponent(n.id)}`, destination: hrefOf(n) })),
      })),
    };
  });
