export type KnowledgeEntityKind =
  | 'knowledge'
  | 'research'
  | 'agent'
  | 'tool'
  | 'workflow'
  | 'song'
  | 'release'
  | 'production_session'
  | 'daw_adapter'
  | 'plugin'
  | 'audio_analysis'
  | 'dsp_concept'
  | 'governance'
  | 'entity';

export type KnowledgeRelationType =
  | 'wikilink'
  | 'cites_source'
  | 'backed_by_evidence'
  | 'belongs_to_project'
  | 'variant_of'
  | 'uses_tool'
  | 'runs_agent'
  | 'implements_capability'
  | 'targets_adapter'
  | 'uses_plugin'
  | 'analyzes_session'
  | 'backed_by_analysis'
  | 'references_dsp'
  | 'part_of_release'
  | 'targets_song'
  | 'belongs_to_lineage'
  | 'approved_by'
  | 'governs_item'
  | 'superseded_by'
  | 'archived_from'
  | 'depends_on';

export type KnowledgeGraphNode = {
  readonly id: string;
  readonly vaultPath: string;
  readonly kind: KnowledgeEntityKind;
  readonly rawType: string | null;
  readonly schema: string | null;
  readonly title: string;
  readonly domain: string;
  readonly sector: string;
  readonly status: string | null;
  readonly version: number | null;
  readonly checksum: string;
  readonly provenance: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly inDegree: number;
  readonly outDegree: number;
};

export type KnowledgeGraphEdge = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourcePath: string;
  readonly targetPath: string | null;
  readonly relation: KnowledgeRelationType;
  readonly provenance: string;
  readonly resolved: boolean;
};

export type KnowledgeGraphSummary = {
  readonly generatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly unresolvedEdgeCount: number;
  readonly byKind: Readonly<Record<KnowledgeEntityKind, number>>;
  readonly byRelation: Readonly<Record<string, number>>;
};

export type DuplicateDetectionReport = {
  readonly duplicateEntityIds: ReadonlyArray<{
    readonly entityId: string;
    readonly paths: readonly string[];
  }>;
  readonly exactContentDuplicates: ReadonlyArray<{
    readonly sha256: string;
    readonly paths: readonly string[];
  }>;
  readonly titleCollisions: ReadonlyArray<{
    readonly normalizedTitle: string;
    readonly docType: string | null;
    readonly paths: readonly string[];
  }>;
  readonly totalIssues: number;
};

export type ProvenanceChain = {
  readonly entityId: string;
  readonly vaultPath: string;
  readonly schema: string | null;
  readonly status: string | null;
  readonly version: number | null;
  readonly checksum: string;
  readonly origin: string;
  readonly provenance: string | null;
  readonly sourceRefs: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly approvalId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly promotedVia: string | null;
  readonly supersededBy: string | null;
  readonly archivedFrom: string | null;
  readonly upstreamNodes: readonly KnowledgeGraphNode[];
};

export type LifecycleTransitionResult = {
  readonly valid: boolean;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly requiresPromotionGate: boolean;
  readonly requiresExplicitArchiveOrSupersede: boolean;
  readonly reason: string;
};
