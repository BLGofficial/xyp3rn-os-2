import { basename } from 'node:path';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type {
  KnowledgeEntityKind,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphSummary,
  KnowledgeRelationType,
} from './types.ts';

const stripMd = (p: string): string => (p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p);

export const classifyKnowledgeEntityKind = (entry: IndexEntryRecord): KnowledgeEntityKind => {
  const rawType = (entry.docType ?? '').toLowerCase();
  const schema = (typeof entry.frontmatter.schema === 'string' ? entry.frontmatter.schema : '').toLowerCase();
  const path = entry.vaultPath.toLowerCase();

  if (schema.includes('.agent/') || rawType === 'agent' || path.startsWith('04_agents/')) return 'agent';
  if (schema.includes('.tool/') || schema.includes('.skill/') || rawType === 'tool' || rawType === 'skill') return 'tool';
  if (schema.includes('.workflow/') || schema.includes('.production-workflow/') || rawType === 'workflow' || rawType === 'production_workflow') {
    return 'workflow';
  }
  if (schema.includes('.production-session/') || schema.includes('.daw-session') || rawType === 'production_session' || rawType === 'daw_session_report') {
    return 'production_session';
  }
  if (schema.includes('.daw-adapter/') || schema.includes('.daw-capability/') || rawType === 'daw_adapter' || rawType === 'daw_capability') {
    return 'daw_adapter';
  }
  if (schema.includes('.daw-plugin') || rawType === 'plugin' || rawType === 'daw_plugin' || rawType === 'plugin_chain' || rawType === 'daw_plugin_chain') {
    return 'plugin';
  }
  if (schema.includes('.audio-analysis/') || rawType === 'audio_analysis') return 'audio_analysis';
  if (schema.includes('.dsp-concept/') || schema.includes('.mix-reference/') || rawType === 'dsp_concept' || rawType === 'mix_reference') {
    return 'dsp_concept';
  }
  if (schema.includes('.song/') || schema.includes('.lyric/') || rawType === 'song' || rawType === 'lyric') {
    return 'song';
  }
  if (schema.includes('.release/') || schema.includes('.track/') || schema.includes('.rights-split/') || rawType === 'release' || rawType === 'track' || rawType === 'rights_split') {
    return 'release';
  }
  if (
    schema.includes('.research-') ||
    schema.includes('.evidence/') ||
    schema.includes('.finding/') ||
    schema.includes('.contradiction/') ||
    schema.includes('.experiment/') ||
    ['research_project', 'research_question', 'evidence', 'finding', 'contradiction', 'experiment'].includes(rawType)
  ) {
    return 'research';
  }
  if (
    schema.includes('.knowledge/') ||
    schema.includes('.canonical-prompt/') ||
    schema.includes('.prompt-variant/') ||
    schema.includes('.source/') ||
    ['knowledge', 'canonical_prompt', 'prompt_variant', 'source'].includes(rawType)
  ) {
    return 'knowledge';
  }
  if (
    schema.includes('.policy/') ||
    schema.includes('.approval/') ||
    schema.includes('.decision-record/') ||
    ['policy', 'approval', 'decision_record'].includes(rawType) ||
    entry.sector === '08_GOVERNANCE' ||
    entry.sector === '06_GOVERNANCE'
  ) {
    return 'governance';
  }
  return 'entity';
};

const extractAliases = (entry: IndexEntryRecord): readonly string[] => {
  const fm = entry.frontmatter;
  const aliases = new Set<string>();
  const addStr = (val: unknown): void => {
    if (typeof val === 'string' && val.trim().length > 0) aliases.add(val.trim());
    else if (Array.isArray(val)) {
      for (const item of val) addStr(item);
    }
  };
  addStr(fm.aliases);
  addStr(fm.alias);
  addStr(fm.name);
  addStr(fm.slug);
  addStr(fm.decision_key);
  addStr(fm.capability_id);
  addStr(fm.adapter_id);
  addStr(fm.isrc);
  addStr(fm.upc);
  return [...aliases];
};

const deriveNodeId = (entry: IndexEntryRecord): string => {
  const fmId = entry.frontmatter.id;
  if (typeof fmId === 'string' && fmId.trim().length > 0) return fmId.trim();
  if (typeof fmId === 'number') return String(fmId);
  return `path:${stripMd(entry.vaultPath).toLowerCase().replace(/[^a-z0-9/_-]+/g, '-')}`;
};

const extractNodeProvenance = (entry: IndexEntryRecord): string | null => {
  const fm = entry.frontmatter;
  if (typeof fm.provenance === 'string' && fm.provenance.trim()) return fm.provenance.trim();
  if (fm.provenance && typeof fm.provenance === 'object') return JSON.stringify(fm.provenance);
  if (typeof fm.source_ref === 'string' && fm.source_ref.trim()) return fm.source_ref.trim();
  if (Array.isArray(fm.source_refs) && typeof fm.source_refs[0] === 'string') return fm.source_refs[0];
  if (typeof fm.origin === 'string' && fm.origin.trim()) return fm.origin.trim();
  return null;
};

type ExtractedRefSpec = {
  readonly target: string;
  readonly relation: KnowledgeRelationType;
  readonly fieldSource: string;
};

const extractTypedReferences = (entry: IndexEntryRecord): readonly ExtractedRefSpec[] => {
  const fm = entry.frontmatter;
  const specs: ExtractedRefSpec[] = [];

  const pushVals = (val: unknown, relation: KnowledgeRelationType, fieldSource: string): void => {
    if (typeof val === 'string' && val.trim().length > 0) {
      const clean = val.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]?.split('#')[0]?.trim();
      if (clean) specs.push({ target: clean, relation, fieldSource });
    } else if (Array.isArray(val)) {
      for (const item of val) pushVals(item, relation, fieldSource);
    }
  };

  pushVals(fm.source_ref, 'cites_source', 'source_ref');
  pushVals(fm.source_refs, 'cites_source', 'source_refs');
  pushVals(fm.evidence_ids, 'backed_by_evidence', 'evidence_ids');
  pushVals(fm.project_slug, 'belongs_to_project', 'project_slug');
  pushVals(fm.parent_prompt_id, 'variant_of', 'parent_prompt_id');
  pushVals(fm.tools, 'uses_tool', 'tools');
  pushVals(fm.allowed_tools, 'uses_tool', 'allowed_tools');
  pushVals(fm.capabilities, 'implements_capability', 'capabilities');
  pushVals(fm.supported_capabilities, 'implements_capability', 'supported_capabilities');
  pushVals(fm.capability_id, 'implements_capability', 'capability_id');
  pushVals(fm.adapter_id, 'targets_adapter', 'adapter_id');
  pushVals(fm.target_daw, 'targets_adapter', 'target_daw');
  pushVals(fm.plugins, 'uses_plugin', 'plugins');
  pushVals(fm.session_id, 'analyzes_session', 'session_id');
  pushVals(fm.analysis_id, 'backed_by_analysis', 'analysis_id');
  pushVals(fm.trace_analysis_id, 'backed_by_analysis', 'trace_analysis_id');
  pushVals(fm.dsp_concepts, 'references_dsp', 'dsp_concepts');
  pushVals(fm.release_id, 'part_of_release', 'release_id');
  pushVals(fm.tracks, 'part_of_release', 'tracks');
  pushVals(fm.song_id, 'targets_song', 'song_id');
  pushVals(fm.lineage_id, 'belongs_to_lineage', 'lineage_id');
  pushVals(fm.approval_id, 'approved_by', 'approval_id');
  pushVals(fm.item_id, 'governs_item', 'item_id');
  pushVals(fm.superseded_by, 'superseded_by', 'superseded_by');
  pushVals(fm.archived_from, 'archived_from', 'archived_from');
  pushVals(fm.depends_on, 'depends_on', 'depends_on');

  if (Array.isArray(fm.steps)) {
    for (const step of fm.steps) {
      if (step && typeof step === 'object') {
        const st = step as Record<string, unknown>;
        pushVals(st.agent, 'runs_agent', 'steps[].agent');
      }
    }
  }

  for (const w of entry.wikilinks) {
    const clean = w.target.trim();
    if (clean) specs.push({ target: clean, relation: 'wikilink', fieldSource: 'wikilink' });
  }

  return specs;
};

/**
 * Rebuildable in-memory Knowledge Graph derived from canonical Obsidian Vault index entries.
 * Covers all 12+ OS3 and DAW Brain entity domains and typed relationships.
 */
export class Os3KnowledgeGraph {
  readonly #nodesByPath = new Map<string, KnowledgeGraphNode>();
  readonly #nodesById = new Map<string, KnowledgeGraphNode>();
  readonly #lookupIndex = new Map<string, KnowledgeGraphNode>();
  readonly #edges: KnowledgeGraphEdge[] = [];
  readonly #outEdges = new Map<string, KnowledgeGraphEdge[]>();
  readonly #inEdges = new Map<string, KnowledgeGraphEdge[]>();
  readonly #generatedAt: string;

  private constructor(
    nodes: readonly KnowledgeGraphNode[],
    edges: readonly KnowledgeGraphEdge[],
    lookupIndex: Map<string, KnowledgeGraphNode>,
    generatedAt: string,
  ) {
    this.#generatedAt = generatedAt;
    for (const n of nodes) {
      this.#nodesByPath.set(n.vaultPath, n);
      if (!this.#nodesById.has(n.id.toLowerCase())) {
        this.#nodesById.set(n.id.toLowerCase(), n);
      }
    }
    for (const [k, v] of lookupIndex.entries()) {
      this.#lookupIndex.set(k, v);
    }
    for (const e of edges) {
      this.#edges.push(e);
      const out = this.#outEdges.get(e.sourcePath) ?? [];
      out.push(e);
      this.#outEdges.set(e.sourcePath, out);
      if (e.targetPath) {
        const inc = this.#inEdges.get(e.targetPath) ?? [];
        inc.push(e);
        this.#inEdges.set(e.targetPath, inc);
      }
    }
  }

  static buildFromDb(db: SqliteRuntimeDb): Os3KnowledgeGraph {
    const entries = db.isOpen ? db.listIndexEntries(undefined, 50_000) : [];
    return Os3KnowledgeGraph.buildFromEntries(entries);
  }

  static buildFromEntries(entries: readonly IndexEntryRecord[]): Os3KnowledgeGraph {
    const lookupIndex = new Map<string, KnowledgeGraphNode>();
    const rawNodes: Omit<KnowledgeGraphNode, 'inDegree' | 'outDegree'>[] = entries.map((entry) => {
      const fm = entry.frontmatter;
      const schema = typeof fm.schema === 'string' && fm.schema.trim() ? fm.schema.trim() : null;
      return {
        id: deriveNodeId(entry),
        vaultPath: entry.vaultPath,
        kind: classifyKnowledgeEntityKind(entry),
        rawType: entry.docType,
        schema,
        title: entry.title,
        domain: entry.domain ?? entry.sector,
        sector: entry.sector,
        status: entry.status,
        version: typeof fm.version === 'number' && Number.isInteger(fm.version) ? fm.version : null,
        checksum: entry.sha256,
        provenance: extractNodeProvenance(entry),
        createdAt: typeof fm.created_at === 'string' ? fm.created_at : null,
        updatedAt: typeof fm.updated_at === 'string' ? fm.updated_at : null,
        tags: entry.tags,
        aliases: extractAliases(entry),
      };
    });

    const tempNodesByPath = new Map<string, KnowledgeGraphNode>();
    for (const rn of rawNodes) {
      const node: KnowledgeGraphNode = { ...rn, inDegree: 0, outDegree: 0 };
      tempNodesByPath.set(node.vaultPath, node);

      const addKey = (key: string): void => {
        const k = key.trim().toLowerCase();
        if (k && !lookupIndex.has(k)) lookupIndex.set(k, node);
      };
      addKey(node.id);
      addKey(node.vaultPath);
      addKey(stripMd(node.vaultPath));
      addKey(basename(stripMd(node.vaultPath)));
      addKey(node.title);
      for (const alias of node.aliases) {
        addKey(alias);
      }
    }

    const resolveTarget = (rawTarget: string, selfPath: string): KnowledgeGraphNode | null => {
      const clean = stripMd(rawTarget.trim()).toLowerCase();
      if (!clean) return null;
      const exact = lookupIndex.get(clean) ?? lookupIndex.get(`${clean}.md`) ?? lookupIndex.get(basename(clean));
      if (!exact || exact.vaultPath === selfPath) return null;
      return exact;
    };

    const dedupeEdgeKeys = new Set<string>();
    const rawEdges: KnowledgeGraphEdge[] = [];
    const outCounts = new Map<string, number>();
    const inCounts = new Map<string, number>();

    for (const entry of entries) {
      const sourceNode = tempNodesByPath.get(entry.vaultPath);
      if (!sourceNode) continue;

      const refs = extractTypedReferences(entry);
      for (const ref of refs) {
        const targetNode = resolveTarget(ref.target, entry.vaultPath);
        const targetId = targetNode ? targetNode.id : `unresolved:${ref.target.toLowerCase()}`;
        const targetPath = targetNode ? targetNode.vaultPath : null;
        const edgeKey = `${sourceNode.vaultPath}|${ref.relation}|${targetId}`;
        if (dedupeEdgeKeys.has(edgeKey)) continue;
        dedupeEdgeKeys.add(edgeKey);

        rawEdges.push({
          id: `${sourceNode.id}:${ref.relation}:${targetId}`,
          sourceId: sourceNode.id,
          targetId,
          sourcePath: sourceNode.vaultPath,
          targetPath,
          relation: ref.relation,
          provenance: `vault://${sourceNode.vaultPath}#${ref.fieldSource}`,
          resolved: targetNode !== null,
        });

        outCounts.set(sourceNode.vaultPath, (outCounts.get(sourceNode.vaultPath) ?? 0) + 1);
        if (targetPath) {
          inCounts.set(targetPath, (inCounts.get(targetPath) ?? 0) + 1);
        }
      }
    }

    const finalizedNodes: KnowledgeGraphNode[] = rawNodes.map((rn) => ({
      ...rn,
      outDegree: outCounts.get(rn.vaultPath) ?? 0,
      inDegree: inCounts.get(rn.vaultPath) ?? 0,
    }));

    const finalizedLookup = new Map<string, KnowledgeGraphNode>();
    const finalizedByPath = new Map<string, KnowledgeGraphNode>(finalizedNodes.map((n) => [n.vaultPath, n]));
    for (const [k, v] of lookupIndex.entries()) {
      finalizedLookup.set(k, finalizedByPath.get(v.vaultPath) ?? v);
    }

    return new Os3KnowledgeGraph(finalizedNodes, rawEdges, finalizedLookup, new Date().toISOString());
  }

  getNode(idOrPathOrAlias: string): KnowledgeGraphNode | null {
    const clean = stripMd(idOrPathOrAlias.trim()).toLowerCase();
    return (
      this.#nodesByPath.get(idOrPathOrAlias.trim()) ??
      this.#nodesById.get(idOrPathOrAlias.trim().toLowerCase()) ??
      this.#lookupIndex.get(clean) ??
      this.#lookupIndex.get(`${clean}.md`) ??
      null
    );
  }

  listNodes(): readonly KnowledgeGraphNode[] {
    return [...this.#nodesByPath.values()];
  }

  listEdges(options: { readonly includeUnresolved?: boolean | undefined } = {}): readonly KnowledgeGraphEdge[] {
    if (options.includeUnresolved ?? false) return this.#edges;
    return this.#edges.filter((e) => e.resolved);
  }

  getOutgoingEdges(idOrPath: string): readonly KnowledgeGraphEdge[] {
    const node = this.getNode(idOrPath);
    if (!node) return [];
    return this.#outEdges.get(node.vaultPath) ?? [];
  }

  getIncomingEdges(idOrPath: string): readonly KnowledgeGraphEdge[] {
    const node = this.getNode(idOrPath);
    if (!node) return [];
    return this.#inEdges.get(node.vaultPath) ?? [];
  }

  queryNodes(filter: {
    readonly kind?: KnowledgeEntityKind | undefined;
    readonly domain?: string | undefined;
    readonly sector?: string | undefined;
    readonly status?: string | undefined;
    readonly tag?: string | undefined;
    readonly updatedAfter?: string | undefined;
    readonly updatedBefore?: string | undefined;
    readonly createdAfter?: string | undefined;
    readonly createdBefore?: string | undefined;
  } = {}): readonly KnowledgeGraphNode[] {
    const uAfter = filter.updatedAfter ? Date.parse(filter.updatedAfter) : null;
    const uBefore = filter.updatedBefore ? Date.parse(filter.updatedBefore) : null;
    const cAfter = filter.createdAfter ? Date.parse(filter.createdAfter) : null;
    const cBefore = filter.createdBefore ? Date.parse(filter.createdBefore) : null;

    return this.listNodes().filter((n) => {
      if (filter.kind && n.kind !== filter.kind) return false;
      if (filter.domain && n.domain.toUpperCase() !== filter.domain.toUpperCase()) return false;
      if (filter.sector && n.sector !== filter.sector) return false;
      if (filter.status && n.status !== filter.status) return false;
      if (filter.tag && !n.tags.some((t) => t.toLowerCase() === filter.tag!.toLowerCase())) return false;

      if (uAfter !== null || uBefore !== null) {
        const ts = n.updatedAt ? Date.parse(n.updatedAt) : Number.NaN;
        if (Number.isNaN(ts)) return false;
        if (uAfter !== null && ts < uAfter) return false;
        if (uBefore !== null && ts > uBefore) return false;
      }
      if (cAfter !== null || cBefore !== null) {
        const ts = n.createdAt ? Date.parse(n.createdAt) : Number.NaN;
        if (Number.isNaN(ts)) return false;
        if (cAfter !== null && ts < cAfter) return false;
        if (cBefore !== null && ts > cBefore) return false;
      }
      return true;
    });
  }

  getNeighborhood(
    startIdOrPath: string,
    options: {
      readonly depth?: number | undefined;
      readonly direction?: 'out' | 'in' | 'both' | undefined;
      readonly relations?: readonly KnowledgeRelationType[] | undefined;
    } = {},
  ): {
    readonly root: KnowledgeGraphNode | null;
    readonly nodes: readonly KnowledgeGraphNode[];
    readonly edges: readonly KnowledgeGraphEdge[];
  } {
    const root = this.getNode(startIdOrPath);
    if (!root) return { root: null, nodes: [], edges: [] };

    const maxDepth = Math.max(1, options.depth ?? 2);
    const dir = options.direction ?? 'both';
    const relFilter = options.relations ? new Set<KnowledgeRelationType>(options.relations) : null;

    const visited = new Set<string>([root.vaultPath]);
    const collectedNodes: KnowledgeGraphNode[] = [];
    const collectedEdges: KnowledgeGraphEdge[] = [];
    const seenEdges = new Set<string>();
    const queue: Array<{ readonly node: KnowledgeGraphNode; readonly depth: number }> = [{ node: root, depth: 0 }];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr.depth >= maxDepth) continue;

      const candidateEdges: KnowledgeGraphEdge[] = [];
      if (dir === 'out' || dir === 'both') candidateEdges.push(...(this.#outEdges.get(curr.node.vaultPath) ?? []));
      if (dir === 'in' || dir === 'both') candidateEdges.push(...(this.#inEdges.get(curr.node.vaultPath) ?? []));

      for (const edge of candidateEdges) {
        if (!edge.resolved || !edge.targetPath) continue;
        if (relFilter && !relFilter.has(edge.relation)) continue;
        const nextPath = edge.sourcePath === curr.node.vaultPath ? edge.targetPath : edge.sourcePath;
        const nextNode = this.#nodesByPath.get(nextPath);
        if (!nextNode) continue;

        if (!seenEdges.has(edge.id)) {
          seenEdges.add(edge.id);
          collectedEdges.push(edge);
        }
        if (!visited.has(nextNode.vaultPath)) {
          visited.add(nextNode.vaultPath);
          collectedNodes.push(nextNode);
          queue.push({ node: nextNode, depth: curr.depth + 1 });
        }
      }
    }

    return { root, nodes: collectedNodes, edges: collectedEdges };
  }

  getSummary(): KnowledgeGraphSummary {
    const byKind = {
      knowledge: 0,
      research: 0,
      agent: 0,
      tool: 0,
      workflow: 0,
      song: 0,
      release: 0,
      production_session: 0,
      daw_adapter: 0,
      plugin: 0,
      audio_analysis: 0,
      dsp_concept: 0,
      governance: 0,
      entity: 0,
    } satisfies Record<KnowledgeEntityKind, number>;

    for (const n of this.#nodesByPath.values()) {
      byKind[n.kind] += 1;
    }

    const byRelation: Record<string, number> = {};
    let resolvedCount = 0;
    let unresolvedCount = 0;
    for (const e of this.#edges) {
      byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;
      if (e.resolved) resolvedCount += 1;
      else unresolvedCount += 1;
    }

    return {
      generatedAt: this.#generatedAt,
      nodeCount: this.#nodesByPath.size,
      edgeCount: resolvedCount,
      unresolvedEdgeCount: unresolvedCount,
      byKind,
      byRelation,
    };
  }
}
