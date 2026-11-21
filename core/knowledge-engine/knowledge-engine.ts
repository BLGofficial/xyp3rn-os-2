import type { Os3SemanticIndex } from '../context-engine/semantic-index.ts';
import type { Os3StructuralIndex, StructuralEntityNode } from '../context-engine/structural-index.ts';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import { parseFrontmatterDocument, type ParsedFrontmatterDocument } from '../vault-engine/frontmatter.ts';
import type { PromoteToCanonicalRequest } from '../vault-engine/promotion-gate.ts';
import type { EntityValidationResult, ValidateEntityOptions } from '../vault-engine/schema-validator.ts';
import {
  archiveVaultNote,
  supersedeVaultNote,
  type ArchiveVaultNoteRequest,
  type SupersedeVaultNoteRequest,
} from '../vault-engine/vault-archive.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import type { WriteNoteResult } from '../vault-engine/writer.ts';
import { Os3KnowledgeGraph } from './knowledge-graph.ts';
import type {
  DuplicateDetectionReport,
  KnowledgeEntityKind,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  LifecycleTransitionResult,
  ProvenanceChain,
} from './types.ts';

export type EntityResolutionResult = {
  readonly query: string;
  readonly resolved: KnowledgeGraphNode | null;
  readonly structuralNode: StructuralEntityNode | null;
  readonly matchedBy: 'entity_id' | 'vault_path' | 'alias' | 'title' | 'none';
  readonly ambiguousMatches: readonly KnowledgeGraphNode[];
};

const VALID_LIFECYCLE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['open', 'active', 'pending', 'pending_approval', 'approved', 'live', 'archived', 'rejected'],
  open: ['active', 'resolved', 'answered', 'approved', 'archived', 'superseded'],
  active: ['live', 'approved', 'paused', 'completed', 'complete', 'archived', 'superseded'],
  pending: ['approved', 'rejected', 'active', 'archived'],
  pending_approval: ['approved', 'rejected', 'canonical'],
  approved: ['canonical', 'released', 'live', 'superseded', 'archived'],
  live: ['canonical', 'superseded', 'archived', 'retired', 'paused'],
  canonical: ['superseded', 'archived'],
  released: ['superseded', 'archived'],
  resolved: ['approved', 'canonical', 'superseded', 'archived'],
  superseded: ['archived'],
  archived: [],
};

/**
 * OS 3.0 Knowledge Engine (`OS3_MODULE_CONTRACTS.md` A3).
 * Unifies Markdown parsing, metadata validation, entity resolution, typed relationship extraction,
 * Knowledge Graph construction, duplicate detection, provenance resolution, lifecycle governance,
 * controlled promotion via Promotion Gate, and rebuildable indexing over the Obsidian Vault.
 */
export class Os3KnowledgeEngine {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;
  readonly #structural: Os3StructuralIndex;
  readonly #semantic: Os3SemanticIndex | null;
  #cachedGraph: { readonly fingerprint: string; readonly graph: Os3KnowledgeGraph } | null = null;

  constructor(options: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly structural: Os3StructuralIndex;
    readonly semantic?: Os3SemanticIndex | null | undefined;
  }) {
    this.#vault = options.vault;
    this.#db = options.db;
    this.#structural = options.structural;
    this.#semantic = options.semantic ?? null;
  }

  get structural(): Os3StructuralIndex {
    return this.#structural;
  }

  get semantic(): Os3SemanticIndex | null {
    return this.#semantic;
  }

  // ─── 1. Markdown Parsing & Metadata Validation ──────────────────────────────

  parseMarkdown(rawContent: string, vaultPath?: string): ParsedFrontmatterDocument {
    return parseFrontmatterDocument(rawContent, { strict: false, vaultPath });
  }

  async validateDocument(
    vaultPath: string,
    options: ValidateEntityOptions & { readonly actor?: string | undefined; readonly content?: string | undefined } = {},
  ): Promise<EntityValidationResult> {
    return this.#vault.validate(vaultPath, options);
  }

  // ─── 2. Knowledge Graph & Entity Resolution ─────────────────────────────────

  getGraph(forceRebuild = false): Os3KnowledgeGraph {
    const entries = this.#db.isOpen ? this.#db.listIndexEntries(undefined, 50_000) : [];
    const fingerprint = entries.map((e) => `${e.vaultPath}:${e.sha256}`).join('|');
    if (!forceRebuild && this.#cachedGraph && this.#cachedGraph.fingerprint === fingerprint) {
      return this.#cachedGraph.graph;
    }
    const graph = Os3KnowledgeGraph.buildFromEntries(entries);
    this.#cachedGraph = { fingerprint, graph };
    return graph;
  }

  resolveEntity(idOrPathOrAlias: string): EntityResolutionResult {
    const query = idOrPathOrAlias.trim();
    const qLower = query.toLowerCase();
    const graph = this.getGraph();
    const allNodes = graph.listNodes();

    const byIdMatches = allNodes.filter((n) => n.id.toLowerCase() === qLower);
    if (byIdMatches.length > 0) {
      const winner = byIdMatches[0]!;
      return {
        query,
        resolved: winner,
        structuralNode: this.#structural.lookupByPath(winner.vaultPath),
        matchedBy: 'entity_id',
        ambiguousMatches: byIdMatches.length > 1 ? byIdMatches : [],
      };
    }

    const stripMd = (p: string) => (p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p);
    const byPath = allNodes.find(
      (n) => n.vaultPath.toLowerCase() === qLower || stripMd(n.vaultPath).toLowerCase() === stripMd(qLower),
    );
    if (byPath) {
      return {
        query,
        resolved: byPath,
        structuralNode: this.#structural.lookupByPath(byPath.vaultPath),
        matchedBy: 'vault_path',
        ambiguousMatches: [],
      };
    }

    const byAlias = allNodes.filter((n) => n.aliases.some((a) => a.toLowerCase() === qLower));
    if (byAlias.length > 0) {
      const winner = byAlias[0]!;
      return {
        query,
        resolved: winner,
        structuralNode: this.#structural.lookupByPath(winner.vaultPath),
        matchedBy: 'alias',
        ambiguousMatches: byAlias.length > 1 ? byAlias : [],
      };
    }

    const byTitle = allNodes.filter((n) => n.title.toLowerCase() === qLower);
    if (byTitle.length > 0) {
      const winner = byTitle[0]!;
      return {
        query,
        resolved: winner,
        structuralNode: this.#structural.lookupByPath(winner.vaultPath),
        matchedBy: 'title',
        ambiguousMatches: byTitle.length > 1 ? byTitle : [],
      };
    }

    return {
      query,
      resolved: null,
      structuralNode: null,
      matchedBy: 'none',
      ambiguousMatches: [],
    };
  }

  // ─── 3. Relationships & Backlinks ───────────────────────────────────────────

  extractRelationships(idOrPath: string): {
    readonly node: KnowledgeGraphNode | null;
    readonly outgoing: readonly KnowledgeGraphEdge[];
    readonly incoming: readonly KnowledgeGraphEdge[];
    readonly unresolved: readonly KnowledgeGraphEdge[];
  } {
    const graph = this.getGraph();
    const node = graph.getNode(idOrPath);
    if (!node) {
      return { node: null, outgoing: [], incoming: [], unresolved: [] };
    }
    const allOut = graph.getOutgoingEdges(node.vaultPath);
    return {
      node,
      outgoing: allOut.filter((e) => e.resolved),
      incoming: graph.getIncomingEdges(node.vaultPath),
      unresolved: allOut.filter((e) => !e.resolved),
    };
  }

  getBacklinks(vaultPath: string): readonly string[] {
    return this.#structural.getBacklinks(vaultPath);
  }

  // ─── 4. Full-Text, Structural & Time-Based Search ───────────────────────────

  async search(
    query: string,
    options: {
      readonly domain?: string | undefined;
      readonly sector?: string | undefined;
      readonly docType?: string | undefined;
      readonly entityKind?: KnowledgeEntityKind | undefined;
      readonly status?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly updatedAfter?: string | undefined;
      readonly updatedBefore?: string | undefined;
      readonly createdAfter?: string | undefined;
      readonly createdBefore?: string | undefined;
      readonly sortBy?: 'relevance' | 'recency' | undefined;
      readonly limit?: number | undefined;
    } = {},
  ) {
    const graph = this.getGraph();
    const rawHits = await this.#structural.fullTextSearch(query, {
      domain: options.domain,
      sector: options.sector,
      docType: options.docType,
      status: options.status,
      tags: options.tags,
      updatedAfter: options.updatedAfter,
      updatedBefore: options.updatedBefore,
      createdAfter: options.createdAfter,
      createdBefore: options.createdBefore,
      sortBy: options.sortBy,
      limit: (options.limit ?? 20) * (options.entityKind ? 3 : 1),
    });

    if (!options.entityKind) {
      return rawHits.slice(0, options.limit ?? 20);
    }

    return rawHits
      .filter((h) => graph.getNode(h.node.vaultPath)?.kind === options.entityKind)
      .slice(0, options.limit ?? 20);
  }

  // ─── 5. Duplicate Detection ─────────────────────────────────────────────────

  detectDuplicates(sector?: string): DuplicateDetectionReport {
    const entries: readonly IndexEntryRecord[] = this.#db.isOpen
      ? this.#db.listIndexEntries(sector, 50_000)
      : [];

    const idToPaths = new Map<string, string[]>();
    const shaToPaths = new Map<string, string[]>();
    const titleTypeToPaths = new Map<string, { readonly docType: string | null; readonly title: string; readonly paths: string[] }>();

    for (const entry of entries) {
      const rawId = entry.frontmatter.id;
      if (typeof rawId === 'string' && rawId.trim().length > 0) {
        const key = rawId.trim().toLowerCase();
        const list = idToPaths.get(key) ?? [];
        list.push(entry.vaultPath);
        idToPaths.set(key, list);
      }

      if (entry.fileExt === '.md') {
        const shaList = shaToPaths.get(entry.sha256) ?? [];
        shaList.push(entry.vaultPath);
        shaToPaths.set(entry.sha256, shaList);

        const normTitle = entry.title.trim().toLowerCase();
        if (normTitle.length > 0) {
          const ttKey = `${entry.docType ?? 'unknown'}::${normTitle}`;
          const existing = titleTypeToPaths.get(ttKey) ?? {
            docType: entry.docType,
            title: normTitle,
            paths: [],
          };
          existing.paths.push(entry.vaultPath);
          titleTypeToPaths.set(ttKey, existing);
        }
      }
    }

    const duplicateEntityIds = [...idToPaths.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([entityId, paths]) => ({ entityId, paths: paths.sort() }));

    const exactContentDuplicates = [...shaToPaths.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([sha256, paths]) => ({ sha256, paths: paths.sort() }));

    const titleCollisions = [...titleTypeToPaths.values()]
      .filter((v) => v.paths.length > 1)
      .map((v) => ({
        normalizedTitle: v.title,
        docType: v.docType,
        paths: v.paths.sort(),
      }));

    return {
      duplicateEntityIds,
      exactContentDuplicates,
      titleCollisions,
      totalIssues: duplicateEntityIds.length + exactContentDuplicates.length + titleCollisions.length,
    };
  }

  // ─── 6. Provenance, Lifecycle & Controlled Promotion ────────────────────────

  getProvenance(idOrPath: string): ProvenanceChain | null {
    const resolved = this.resolveEntity(idOrPath);
    if (!resolved.resolved) return null;

    const graph = this.getGraph();
    const node = resolved.resolved;
    const entry = this.#db.isOpen ? this.#db.getIndexEntry(node.vaultPath) : null;
    const fm = entry?.frontmatter ?? {};

    const sourceRefs: string[] = [];
    if (typeof fm.source_ref === 'string' && fm.source_ref.trim()) sourceRefs.push(fm.source_ref.trim());
    if (Array.isArray(fm.source_refs)) {
      for (const r of fm.source_refs) {
        if (typeof r === 'string' && r.trim() && !sourceRefs.includes(r.trim())) {
          sourceRefs.push(r.trim());
        }
      }
    }

    const evidenceIds: string[] = [];
    if (Array.isArray(fm.evidence_ids)) {
      for (const e of fm.evidence_ids) {
        if (typeof e === 'string' && e.trim()) evidenceIds.push(e.trim());
      }
    }

    const neighborhood = graph.getNeighborhood(node.vaultPath, {
      depth: 2,
      direction: 'out',
      relations: ['cites_source', 'backed_by_evidence', 'approved_by', 'variant_of'],
    });

    return {
      entityId: node.id,
      vaultPath: node.vaultPath,
      schema: node.schema,
      status: node.status,
      version: node.version,
      checksum: node.checksum,
      origin: typeof fm.origin === 'string' ? fm.origin : `vault://${node.vaultPath}`,
      provenance: node.provenance,
      sourceRefs,
      evidenceIds,
      approvalId: typeof fm.approval_id === 'string' ? fm.approval_id : null,
      approvedBy: typeof fm.approved_by === 'string' ? fm.approved_by : null,
      approvedAt: typeof fm.approved_at === 'string' ? fm.approved_at : null,
      promotedVia: typeof fm.promoted_via === 'string' ? fm.promoted_via : null,
      supersededBy: typeof fm.superseded_by === 'string' ? fm.superseded_by : null,
      archivedFrom: typeof fm.archived_from === 'string' ? fm.archived_from : null,
      upstreamNodes: neighborhood.nodes,
    };
  }

  validateLifecycleTransition(fromStatus: string | null, toStatus: string): LifecycleTransitionResult {
    const target = toStatus.trim().toLowerCase();
    const current = fromStatus?.trim().toLowerCase() ?? null;
    const requiresPromotionGate = target === 'canonical';
    const requiresExplicitArchiveOrSupersede = target === 'archived' || target === 'superseded';

    if (!current) {
      return {
        valid: true,
        fromStatus: null,
        toStatus: target,
        requiresPromotionGate,
        requiresExplicitArchiveOrSupersede,
        reason: 'Initial lifecycle assignment permitted',
      };
    }

    const allowed = VALID_LIFECYCLE_TRANSITIONS[current] ?? ['approved', 'superseded', 'archived'];
    const valid = current === target || allowed.includes(target);
    return {
      valid,
      fromStatus: current,
      toStatus: target,
      requiresPromotionGate,
      requiresExplicitArchiveOrSupersede,
      reason: valid
        ? `Transition "${current}" -> "${target}" allowed${requiresPromotionGate ? ' (must pass Promotion Gate)' : ''}`
        : `Transition "${current}" -> "${target}" violates document lifecycle rules`,
    };
  }

  async archiveDocument(req: ArchiveVaultNoteRequest) {
    return archiveVaultNote(this.#vault, req);
  }

  async supersedeDocument(req: SupersedeVaultNoteRequest) {
    return supersedeVaultNote(this.#vault, req);
  }

  /**
   * Sole authorized canonical promotion path — delegates strictly to `VaultEngine.promote()` (`VaultPromotionGate`).
   */
  async promoteCandidate(req: PromoteToCanonicalRequest): Promise<WriteNoteResult> {
    return this.#vault.promote(req);
  }

  // ─── 7. Full Index Rebuild From Canonical Vault Sources ─────────────────────

  async rebuildIndexes(options: { readonly rebuildSemantic?: boolean | undefined } = {}): Promise<{
    readonly structuralTotalIndexed: number;
    readonly semanticIndexedCount: number;
    readonly graphNodes: number;
    readonly graphEdges: number;
  }> {
    const structuralRes = await this.#structural.rebuildFromScratch();
    let semanticCount = 0;
    if ((options.rebuildSemantic ?? true) && this.#semantic) {
      const semRes = await this.#semantic.rebuild();
      semanticCount = semRes.indexedCount;
    }
    const graph = this.getGraph(true);
    const summary = graph.getSummary();

    return {
      structuralTotalIndexed: structuralRes.totalIndexed,
      semanticIndexedCount: semanticCount,
      graphNodes: summary.nodeCount,
      graphEdges: summary.edgeCount,
    };
  }
}
