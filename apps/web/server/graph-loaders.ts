import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from '../../../core/db/client.ts';
import * as ov from '../../../knowledge/knowledge-graph/overview.ts';
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

/**
 * @param sql - the app's pool
 * @param limit - how many
 * @returns the references that prove nothing (unresolved) or point at no node (dangling), by where they are
 */
export const diagnostics = (sql: Sql, limit = 200) =>
  asWeb(sql, async (tx) => (await tx<{ id: string; problem: string; relation: string; from_id: string | null; to_id: string | null; detail: string | null; source_ref: string }[]>`
    select id, problem, relation, from_id, to_id, detail, source_ref from graph_diagnostics order by source_ref, id limit ${limit}`).map((d) => ({
    id: d.id, problem: d.problem, relation: d.relation, fromId: d.from_id, toId: d.to_id, detail: d.detail, sourceRef: d.source_ref,
  })));

/** @returns indexed files the last scans could not read, with the error each one gave */
export const unreadableFiles = (sql: Sql) =>
  asWeb(sql, async (tx) => (await tx<{ id: string; path: string; error: string; indexed_at: Date }[]>`
    select id, path, error, indexed_at from indexed_files where status = 'unreadable' order by path`).map((f) => ({ id: f.id, path: f.path, error: f.error, indexedAt: f.indexed_at.toISOString() })));

export type OverviewGroup = ov.OverviewGroup & { readonly href: string };
export type Hub = { readonly id: string; readonly title: string; readonly version: string; readonly sourceRef: 'package.json'; readonly backing: 'configuration' };

// The hub is the application's identity from its configuration: not an agent, a server or a row.
const PACKAGE_JSON = join(import.meta.dirname, '..', '..', '..', 'package.json');
const hub = async (): Promise<Hub> => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { name: string; version: string };
  return { id: `app:${pkg.name}`, title: pkg.name, version: pkg.version, sourceRef: 'package.json', backing: 'configuration' };
};

/**
 * The sphere's bounded overview (see overview.overview) with the configured hub, each node's inspector link and each
 * group's list filter.
 * @param sql - the app's pool
 * @param o - the node and edge budget
 */
export const overview = async (sql: Sql, o: { maxNodes?: number; maxEdges?: number } = {}) => {
  const [h, r] = await Promise.all([
    hub(),
    asWeb(sql, async (tx) => {
      // One snapshot for the counts, the members and the edges (the default, read committed, gives each its own).
      await tx.unsafe('set transaction isolation level repeatable read');
      return ov.overview(tx, o);
    }),
  ]);
  return {
    ...r, hub: h,
    nodes: r.nodes.map((n) => ({ ...n, href: `/?node=${encodeURIComponent(n.id)}` })),
    groups: r.groups.map((g): OverviewGroup => ({ ...g, href: `/?kind=${encodeURIComponent(g.kind)}&domain=${g.domain}` })),
  };
};

/** What GET /api/graph/overview answers (the sphere's data). */
export type OverviewData = Awaited<ReturnType<typeof overview>>;
