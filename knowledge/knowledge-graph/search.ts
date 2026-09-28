import type postgres from 'postgres';
import { NODES, toNode, type GraphNode, type NodeRow } from './projection.ts';

/**
 * Global search (AOS-04 Plan C1 Task 6, design §16): every node in the index whose title or path contains the
 * query, case-insensitively and literally (`%`, `_` and `\` match themselves), grouped by kind with each group's
 * total. It searches the whole index, never a rendered page of it; excluded files were never indexed, so they
 * can't be found.
 */

/** Group order and labels: the things an owner opens most come first. */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  song: 'Songs', lineage: 'Lineages', artifact_version: 'Versions', vault_file: 'Vault files', research_brief: 'Research briefs',
  research_run: 'Research runs', finding: 'Findings', evidence: 'Evidence', research_source: 'Research sources', file: 'Files',
  agent: 'Agents', workflow: 'Workflows', workflow_step: 'Workflow steps', decision: 'Decisions', module: 'Components',
  canonical_prompt: 'Canonical prompts', source: 'Sources', take: 'Takes', track: 'Tracks', release: 'Releases',
  agent_run: 'Agent runs', workflow_run: 'Workflow runs', candidate: 'Candidates', approval: 'Approvals', domain: 'Domains',
};
const ORDER = Object.keys(KIND_LABEL);

export type SearchGroup = { readonly kind: string; readonly label: string; readonly total: number; readonly hits: readonly GraphNode[] };

/**
 * @param tx - a read-only transaction as xyp_web
 * @param q - the query (trimmed; blank finds nothing)
 * @param perGroup - hits kept per kind (the total counts them all)
 * @returns groups in a fixed kind order (none when nothing matches) and the time the index was read
 */
export const searchIndex = async (tx: postgres.TransactionSql, q: string, perGroup = 8): Promise<{ groups: SearchGroup[]; asOf: string }> => {
  const now = (await tx<{ now: Date }[]>`select now()`)[0]!.now;
  const term = q.trim();
  if (term === '') return { groups: [], asOf: now.toISOString() };
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // An exact title first, then earlier matches, then alphabetical.
  const rows = await tx<(NodeRow & { total: number; rank: number })[]>`
    select * from (
      select n.*, count(*) over (partition by n.kind)::int as total,
             row_number() over (partition by n.kind order by (lower(n.title) = lower(${term})) desc, position(lower(${term}) in lower(n.title)), n.title, n.id)::int as rank
      from (${NODES(tx)}) n
      where n.title ilike ${like} escape '\\' or coalesce(n.path, '') ilike ${like} escape '\\'
    ) r where r.rank <= ${perGroup} order by r.kind, r.rank`;
  const byKind = new Map<string, { total: number; hits: GraphNode[] }>();
  for (const r of rows) {
    const g = byKind.get(r.kind) ?? { total: r.total, hits: [] };
    g.hits.push(toNode(r));
    byKind.set(r.kind, g);
  }
  const groups = [...byKind.entries()]
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))
    .map(([kind, g]) => ({ kind, label: KIND_LABEL[kind] ?? kind, total: g.total, hits: g.hits }));
  return { groups, asOf: now.toISOString() };
};
