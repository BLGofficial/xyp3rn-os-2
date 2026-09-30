import type postgres from 'postgres';
import { DOMAINS, type Domain } from '../../core/contracts/taxonomy.ts';

/**
 * The HUD's sub-component layer (Mercury HUD, F52): every indexed file is matched to exactly one sub-component of
 * its domain by its repo path, and sub-component links are disclosed aggregates of graph_edges rows. The ids are the
 * reserved names of docs/ARCHITECTURE.md ("Sub-component taxonomy"), plus TRACE, which Tech built under its own name.
 * A component with no matched file is `reserved`: named, never drawn as built. The table is the one place the
 * matching lives; nothing here reads a file's contents.
 */

export type ComponentDef = {
  readonly slug: string;
  readonly domain: Domain;
  readonly label: string;
  /** Repo-relative path rules: `dir/` (a directory), `a/b.ts` (one file) or `agents/x-*.agent.md` (`*` = any name part). */
  readonly rules: readonly string[];
  /** For Records: which box it is drawn in. */
  readonly group?: 'x3lius' | 'ops';
};

const x3 = (slug: string, label: string, rules: readonly string[]): ComponentDef => ({ slug, domain: 'RECORDS', label, rules, group: 'x3lius' });
const ops = (slug: string, label: string, rules: readonly string[]): ComponentDef => ({ slug, domain: 'RECORDS', label, rules, group: 'ops' });

export const COMPONENTS: readonly ComponentDef[] = [
  { slug: 'orchestrator', domain: 'CORE', label: 'Orchestrator', rules: ['core/orchestrator/'] },
  { slug: 'agent-registry', domain: 'CORE', label: 'Agent Registry', rules: ['core/agent-registry/'] },
  { slug: 'tool-registry', domain: 'CORE', label: 'Tool Registry', rules: ['core/tool-registry/'] },
  { slug: 'workflow-engine', domain: 'CORE', label: 'Workflow Engine', rules: ['core/workflow-engine/', 'core/workflows/'] },
  { slug: 'context-engine', domain: 'CORE', label: 'Context Engine', rules: ['core/context-engine/', 'agents/context-retriever.agent.md'] },
  { slug: 'memory', domain: 'CORE', label: 'Memory', rules: ['core/memory/'] },
  { slug: 'evaluation-observability', domain: 'CORE', label: 'Evaluation & Observability', rules: ['core/evaluation-observability/'] },

  { slug: 'canonical-knowledge', domain: 'KNOWLEDGE', label: 'Canonical Knowledge', rules: ['knowledge/canonical-knowledge/'] },
  { slug: 'source-registry', domain: 'KNOWLEDGE', label: 'Source Registry', rules: ['knowledge/source-registry/'] },
  { slug: 'prompt-library', domain: 'KNOWLEDGE', label: 'Prompt Library', rules: ['knowledge/prompt-library/'] },
  { slug: 'vector-retrieval', domain: 'KNOWLEDGE', label: 'Vector Retrieval', rules: ['knowledge/vector-retrieval/'] },
  { slug: 'knowledge-graph', domain: 'KNOWLEDGE', label: 'Knowledge Graph', rules: ['knowledge/knowledge-graph/'] },
  { slug: 'versioning-provenance', domain: 'KNOWLEDGE', label: 'Versioning & Provenance', rules: ['knowledge/versioning-provenance/'] },
  { slug: 'promotion-gate', domain: 'KNOWLEDGE', label: 'Promotion Gate', rules: ['knowledge/promotion-gate/'] },

  { slug: 'research-orchestrator', domain: 'RESEARCH_INTELLIGENCE', label: 'Research Orchestrator', rules: ['research-intelligence/orchestrator/', 'agents/research-orchestrator.agent.md'] },
  { slug: 'specialists', domain: 'RESEARCH_INTELLIGENCE', label: 'Specialists', rules: ['research-intelligence/specialists/', 'agents/*-researcher.agent.md'] },
  { slug: 'evidence-engine', domain: 'RESEARCH_INTELLIGENCE', label: 'Evidence Engine', rules: ['research-intelligence/evidence/'] },
  { slug: 'source-verification', domain: 'RESEARCH_INTELLIGENCE', label: 'Source Verification', rules: ['research-intelligence/sources/'] },
  { slug: 'contradiction-engine', domain: 'RESEARCH_INTELLIGENCE', label: 'Contradiction Engine', rules: ['research-intelligence/contradictions/'] },
  { slug: 'experiment-engine', domain: 'RESEARCH_INTELLIGENCE', label: 'Experiment Engine', rules: ['research-intelligence/experiments/'] },
  { slug: 'synthesis', domain: 'RESEARCH_INTELLIGENCE', label: 'Synthesis', rules: ['research-intelligence/synthesis/'] },

  x3('songwriting', 'Songwriting', ['records/x3lius/songwriting/', 'agents/x3lius-songwriting.agent.md']),
  x3('lyrics', 'Lyrics', ['records/x3lius/lyrics/', 'agents/x3lius-lyrics.agent.md', 'agents/x3lius-lyric-editor.agent.md']),
  x3('vocal-dna', 'Vocal DNA', ['records/x3lius/vocal-dna/', 'records/x3lius/vocal-dna.yaml', 'agents/x3lius-vocal-dna.agent.md']),
  x3('composition', 'Composition', ['records/x3lius/composition/', 'agents/x3lius-composition.agent.md']),
  x3('arrangement', 'Arrangement', ['records/x3lius/arrangement/', 'agents/x3lius-arrangement.agent.md']),
  x3('genre-style', 'Genre / Style', ['records/x3lius/genre-style/', 'agents/x3lius-genre-style.agent.md']),
  x3('suno', 'Suno', ['records/x3lius/suno/', 'records/x3lius/song-to-suno.workflow.yaml', 'agents/x3lius-suno*.agent.md', 'agents/suno-submitter.agent.md']),
  x3('production', 'Production', ['records/x3lius/production/', 'agents/x3lius-production.agent.md', 'agents/x3lius-rvc-post.agent.md']),
  x3('mix-master', 'Mix / Master', ['records/x3lius/mix-master/', 'records/x3lius/mix-rubric.yaml', 'agents/x3lius-mix-master.agent.md']),
  x3('evaluation', 'Evaluation', ['records/x3lius/evaluation/', 'agents/x3lius-evaluation.agent.md', 'agents/x3lius-revision.agent.md']),
  ops('catalog', 'Catalog', ['records/ops/catalog/', 'agents/records-catalog*.agent.md', 'agents/records-songs.agent.md']),
  ops('rights-splits', 'Rights & Splits', ['records/ops/rights-splits/', 'agents/records-rights-splits.agent.md']),
  ops('release-calendar', 'Release Calendar', ['records/ops/release-calendar/', 'agents/records-release-calendar.agent.md']),
  ops('tasks', 'Tasks', ['records/ops/tasks/', 'agents/records-tasks.agent.md']),

  { slug: 'trace', domain: 'TECH', label: 'TRACE', rules: ['tech/trace/'] },
  { slug: 'products', domain: 'TECH', label: 'Products', rules: ['tech/products/', 'agents/tech-products.agent.md'] },
  { slug: 'audio-tools', domain: 'TECH', label: 'Audio Tools', rules: ['tech/audio-tools/', 'agents/tech-audio-tools.agent.md'] },
  { slug: 'ai-systems', domain: 'TECH', label: 'AI Systems', rules: ['tech/ai-systems/', 'agents/tech-ai-systems.agent.md'] },
  { slug: 'r-and-d', domain: 'TECH', label: 'R&D', rules: ['tech/r-and-d/', 'agents/tech-r-and-d.agent.md'] },

  { slug: 'legal', domain: 'GOVERNANCE', label: 'Legal', rules: ['governance/legal/'] },
  { slug: 'rights-conflict', domain: 'GOVERNANCE', label: 'Rights Conflict', rules: ['governance/rights-conflict/'] },
  { slug: 'permissions-rbac', domain: 'GOVERNANCE', label: 'Permissions & RBAC', rules: ['governance/permissions-rbac/'] },
  { slug: 'human-approval', domain: 'GOVERNANCE', label: 'Human Approval', rules: ['governance/human-approval/', 'governance/approvals.ts'] },
  { slug: 'audit-provenance', domain: 'GOVERNANCE', label: 'Audit & Provenance', rules: ['governance/audit-provenance/'] },
];

/** `CORE:orchestrator`, `CORE:other` (the domain's unmatched files), or `shared` (no owner domain). */
export const componentId = (domain: Domain, slug: string) => `${domain}:${slug}`;
export const OTHER = 'other';
export const SHARED = 'shared';

type Compiled = { readonly id: string; readonly test: (path: string) => boolean; readonly specificity: number };
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const compile = (rule: string, id: string): Compiled => {
  const specificity = rule.replaceAll('*', '').length;
  if (rule.includes('*')) {
    const re = new RegExp(`^${rule.split('*').map(escape).join('[^/]*')}$`);
    return { id, test: (p) => re.test(p), specificity };
  }
  return rule.endsWith('/') ? { id, test: (p) => p.startsWith(rule), specificity } : { id, test: (p) => p === rule, specificity };
};
const RULES: readonly Compiled[] = COMPONENTS.flatMap((c) => c.rules.map((r) => compile(r, componentId(c.domain, c.slug))));

/**
 * The one sub-component a repo file belongs to: the most specific matching rule; else its owner domain's `other`;
 * else `shared`.
 * @param path - repo-relative path (index root `repo`), or null for a node with no file
 * @param ownerDomain - the index's owner for the file (frontmatter, manifest or domain path)
 */
export const matchComponent = (path: string | null, ownerDomain: Domain | null): string => {
  let best: Compiled | undefined;
  if (path !== null) for (const r of RULES) if ((!best || r.specificity > best.specificity) && r.test(path)) best = r;
  return best?.id ?? (ownerDomain ? componentId(ownerDomain, OTHER) : SHARED);
};

export const FILE_ID_LIMIT = 200;
const TOP_FILES = 5;

export type ComponentRow = {
  readonly id: string;
  readonly domain: Domain | 'shared';
  readonly slug: string;
  readonly label: string;
  readonly group: 'x3lius' | 'ops' | null;
  readonly status: 'built' | 'reserved';
  readonly rules: readonly string[];
  readonly fileCount: number;
  /** The first FILE_ID_LIMIT files, path order: graph node id, indexed_files id (the file viewer's), path, sha256 prefix. */
  readonly files: readonly ComponentFile[];
  /** Up to five files by edge count (edges touching the file or a node it declares). */
  readonly topFiles: readonly { readonly id: string; readonly path: string; readonly edges: number }[];
  /** graph_diagnostics rows (unresolved or dangling) raised from this component's nodes. */
  readonly diagnostics: number;
};
export type ComponentFile = { readonly nodeId: string; readonly fileId: string; readonly path: string; readonly sha: string | null };
export type ComponentLink = { readonly from: string; readonly to: string; readonly relation: string; readonly count: number };
export type Components = {
  readonly components: readonly ComponentRow[];
  readonly links: readonly ComponentLink[];
  readonly totals: {
    /** Indexed files (graph_nodes of kind file); equals the sum of fileCount. */
    readonly files: number;
    /** graph_edges rows; equals aggregated + internal + unmapped. */
    readonly edges: number;
    readonly aggregated: number;
    /** Edges whose two ends are in the same component (not drawn as links). */
    readonly internal: number;
    /** Edges with an end that has no file (a record such as a song or a release). */
    readonly unmapped: number;
  };
  readonly asOf: string;
};

/**
 * @param tx - a read-only transaction as xyp_web, repeatable read (files, edges and diagnostics from one snapshot)
 */
export const components = async (tx: postgres.TransactionSql): Promise<Components> => {
  const nodes = await tx<{ id: string; kind: string; owner_domain: Domain | null; path: string | null }[]>`
    select id, kind, owner_domain, path from graph_nodes where kind <> 'domain'`;
  const edges = await tx<{ relation: string; from_id: string; to_id: string }[]>`select relation, from_id, to_id from graph_edges`;
  const diags = await tx<{ from_id: string | null }[]>`select from_id from graph_diagnostics`;
  const indexed = await tx<{ id: string; root: string; path: string; sha256: string | null }[]>`select id, root, path, sha256 from indexed_files`;
  const fileRow = new Map(indexed.map((f) => [`file:${f.root}/${f.path}`, f]));
  const now = (await tx<{ now: string }[]>`select now()::text as now`)[0]!.now;

  // A node's component; its file is the one at its path (agents, workflows and steps are declared in a file).
  const compOf = new Map<string, string>();
  const pathOf = new Map<string, string>();
  const files = new Map<string, string[]>(); // component → file node ids
  const fileIdByPath = new Map<string, string>();
  for (const n of nodes) {
    const repoPath = n.path !== null && (n.kind !== 'file' || n.id.startsWith('file:repo/')) ? n.path : null;
    if (n.path === null) continue; // a record (song, release, …): no file, no component
    const c = matchComponent(repoPath, n.owner_domain);
    compOf.set(n.id, c);
    pathOf.set(n.id, n.path);
    if (n.kind === 'file') {
      (files.get(c) ?? files.set(c, []).get(c)!).push(n.id);
      fileIdByPath.set(n.path, n.id);
    }
  }

  const degree = new Map<string, number>(); // file path → edges touching it or its declared nodes
  const agg = new Map<string, ComponentLink>();
  let internal = 0, unmapped = 0;
  for (const e of edges) {
    for (const end of [e.from_id, e.to_id]) {
      const p = pathOf.get(end);
      if (p !== undefined) degree.set(p, (degree.get(p) ?? 0) + 1);
    }
    const a = compOf.get(e.from_id), b = compOf.get(e.to_id);
    if (a === undefined || b === undefined) { unmapped++; continue; }
    if (a === b) { internal++; continue; }
    const key = `${a}\n${b}\n${e.relation}`;
    const l = agg.get(key);
    agg.set(key, { from: a, to: b, relation: e.relation, count: (l?.count ?? 0) + 1 });
  }
  const diagCount = new Map<string, number>();
  for (const d of diags) {
    const c = d.from_id === null ? undefined : compOf.get(d.from_id);
    if (c !== undefined) diagCount.set(c, (diagCount.get(c) ?? 0) + 1);
  }

  const row = (id: string, domain: Domain | 'shared', slug: string, label: string, group: ComponentRow['group'], rules: readonly string[]): ComponentRow => {
    const ids = [...(files.get(id) ?? [])].sort();
    const topFiles = ids.map((fid) => ({ id: fid, path: pathOf.get(fid)!, edges: degree.get(pathOf.get(fid)!) ?? 0 }))
      .filter((f) => f.edges > 0).sort((x, y) => y.edges - x.edges || x.path.localeCompare(y.path)).slice(0, TOP_FILES);
    const listed = ids.slice(0, FILE_ID_LIMIT).map((nodeId): ComponentFile => {
      const f = fileRow.get(nodeId);
      return { nodeId, fileId: f?.id ?? '', path: pathOf.get(nodeId)!, sha: f?.sha256?.slice(0, 12) ?? null };
    });
    return { id, domain, slug, label, group, status: ids.length > 0 ? 'built' : 'reserved', rules, fileCount: ids.length, files: listed, topFiles, diagnostics: diagCount.get(id) ?? 0 };
  };
  const rows: ComponentRow[] = [
    ...COMPONENTS.map((c) => row(componentId(c.domain, c.slug), c.domain, c.slug, c.label, c.group ?? null, c.rules)),
    ...DOMAINS.map((d) => row(componentId(d, OTHER), d, OTHER, 'Other', null, [])),
    row(SHARED, 'shared', SHARED, 'Shared / Unassigned', null, []),
  ];
  const links = [...agg.values()].sort((x, y) => y.count - x.count || x.from.localeCompare(y.from) || x.to.localeCompare(y.to) || x.relation.localeCompare(y.relation));
  const fileTotal = nodes.filter((n) => n.kind === 'file').length;
  return {
    components: rows, links,
    totals: { files: fileTotal, edges: edges.length, aggregated: links.reduce((s, l) => s + l.count, 0), internal, unmapped },
    asOf: now,
  };
};
