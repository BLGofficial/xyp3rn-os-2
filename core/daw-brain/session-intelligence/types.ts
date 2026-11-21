import type { DawContextPackage, Os3RetrievedContextItem } from '../../context-engine/os3-context-engine.ts';
import type { DawAudioAnalysisRecord, DawCommandJournalRecord } from '../../sqlite/client.ts';
import type {
  DawAvailability,
  DawHostKind,
  DawProject,
  DawSession,
  DawStateFreshness,
  DawStateSnapshot,
  DawTimeSignature,
} from '../types.ts';

export type DawConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

export type DawAnalysisConfidence = {
  readonly level: DawConfidenceLevel;
  readonly score: number;
  readonly rationale: string;
};

export type DawTrackRole =
  | 'master'
  | 'vocal'
  | 'drums_percussion'
  | 'bass_sub'
  | 'melodic_synth'
  | 'fx_return'
  | 'submix_bus'
  | 'reference'
  | 'unclassified';

export type DawClassifiedTrack = {
  readonly refId: string;
  readonly entityKind: 'mixer_channel' | 'channel' | 'track' | 'bus';
  readonly name: string;
  readonly index: number;
  readonly role: DawTrackRole;
  readonly roleConfidence: DawConfidenceLevel;
  readonly evidence: readonly string[];
  readonly routedToRef: string | null;
  readonly pluginNames: readonly string[];
  readonly genericName: boolean;
};

export type DawRoutingGraphNode = {
  readonly id: string;
  readonly nodeKind: 'master' | 'mixer_channel' | 'channel' | 'bus' | 'track' | 'unknown_target';
  readonly label: string;
  readonly role: DawTrackRole;
  readonly isMaster: boolean;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly pluginNames: readonly string[];
  readonly inDegree: number;
  readonly outDegree: number;
};

export type DawRoutingGraphEdge = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly edgeKind: 'channel_to_mixer' | 'mixer_send' | 'bus_feed';
  readonly enabled: boolean;
  readonly sendNormalized: number;
  readonly preFader: boolean;
  readonly sidechain: boolean;
  readonly evidence: string;
};

export type DawRoutingGraph = {
  readonly observabilityStatus: 'complete' | 'partial' | 'unavailable';
  readonly observabilityReason: string;
  readonly nodes: readonly DawRoutingGraphNode[];
  readonly edges: readonly DawRoutingGraphEdge[];
  readonly signalFlowChains: ReadonlyArray<readonly string[]>;
  readonly masterSinkIds: readonly string[];
  readonly orphanNodeIds: readonly string[];
  readonly disconnectedSourceIds: readonly string[];
  readonly cyclePaths: ReadonlyArray<readonly string[]>;
};

export type DawSessionInventory = {
  readonly tempoBpm: DawAvailability<number>;
  readonly timeSignature: DawAvailability<DawTimeSignature>;
  readonly projectMetadataPresent: boolean;
  readonly domainAvailability: {
    readonly tracks: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly channels: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly mixerChannels: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly buses: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly routing: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly plugins: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly automationLanes: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly audioClips: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly midiClips: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly markers: 'available' | 'unavailable' | 'unsupported' | 'unknown';
    readonly regions: 'available' | 'unavailable' | 'unsupported' | 'unknown';
  };
  readonly counts: {
    readonly tracks: number | null;
    readonly channels: number | null;
    readonly mixerChannels: number | null;
    readonly buses: number | null;
    readonly routingEdges: number | null;
    readonly plugins: number | null;
    readonly pluginParametersInspected: number | null;
    readonly automationLanes: number | null;
    readonly audioClips: number | null;
    readonly midiClips: number | null;
    readonly markers: number | null;
    readonly regions: number | null;
  };
  readonly accessibleDomains: readonly string[];
  readonly inaccessibleDomains: ReadonlyArray<{ readonly domain: string; readonly status: string; readonly reason: string }>;
};

export type DawNamingOrganizationReport = {
  readonly totalNamedEntities: number;
  readonly genericOrDefaultCount: number;
  readonly genericExamples: readonly string[];
  readonly duplicateNames: ReadonlyArray<{ readonly name: string; readonly refIds: readonly string[] }>;
  readonly organizationScore: number;
  readonly summary: string;
};

export type DawComplexityReport = {
  readonly tier: 'minimal' | 'moderate' | 'dense' | 'heavy' | 'undetermined';
  readonly score: number;
  readonly observableFactors: {
    readonly activeChannels: number | null;
    readonly populatedMixerInserts: number | null;
    readonly loadedPlugins: number | null;
    readonly routingEdges: number | null;
    readonly inspectedParameters: number | null;
  };
  readonly excludedInaccessibleFactors: readonly string[];
  readonly rationale: string;
};

export type DawConsistencyIssue = {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly code:
    | 'LIVE_VS_SAVED_DRIFT'
    | 'STALE_OR_CACHED_TELEMETRY'
    | 'DEGRADED_HOST_VERSION'
    | 'DISCONNECTED_OR_ORPHAN_ROUTING'
    | 'MUTED_ROUTED_BUS'
    | 'EDITION_INCOMPATIBLE_PLUGIN'
    | 'HEADROOM_OR_CLIP_RISK'
    | 'DUPLICATE_LABELS'
    | 'GENERIC_NAMING';
  readonly summary: string;
  readonly affectedRefs: readonly string[];
  readonly evidence: readonly string[];
};

export type DawConsistencyReport = {
  readonly ok: boolean;
  readonly issueCount: number;
  readonly issues: readonly DawConsistencyIssue[];
};

export type DawSnapshotComparison = {
  readonly beforeSnapshotId: string;
  readonly afterSnapshotId: string;
  readonly beforeObservedAt: string;
  readonly afterObservedAt: string;
  readonly freshnessTransition: `${DawStateFreshness}->${DawStateFreshness}`;
  readonly stateDigestChanged: boolean;
  readonly tempoDeltaBpm: number | null;
  readonly timeSignatureChanged: boolean;
  readonly transportChanges: readonly string[];
  readonly addedTracks: readonly string[];
  readonly removedTracks: readonly string[];
  readonly addedMixerChannels: readonly string[];
  readonly removedMixerChannels: readonly string[];
  readonly mixerChanges: ReadonlyArray<{
    readonly mixerChannelId: string;
    readonly name: string;
    readonly field: 'volumeNormalized' | 'panNormalized' | 'muted' | 'soloed';
    readonly before: string | number | boolean;
    readonly after: string | number | boolean;
  }>;
  readonly addedRouting: readonly string[];
  readonly removedRouting: readonly string[];
  readonly addedPlugins: readonly string[];
  readonly removedPlugins: readonly string[];
  readonly changedPluginParameters: ReadonlyArray<{
    readonly pluginId: string;
    readonly pluginName: string;
    readonly paramId: string;
    readonly paramName: string;
    readonly beforeValue: number;
    readonly afterValue: number;
  }>;
  readonly summary: string;
};

export type DawKnowledgeIntegrationReport = {
  readonly query: string;
  readonly contextAssembledAt: string;
  readonly epistemicSeparationNotice: string;
  readonly x3liusMusicRecords: readonly Os3RetrievedContextItem[];
  readonly productionKnowledge: readonly Os3RetrievedContextItem[];
  readonly pluginKnowledge: readonly Os3RetrievedContextItem[];
  readonly userApprovedPreferences: readonly Os3RetrievedContextItem[];
  readonly historicalVaultRecords: readonly Os3RetrievedContextItem[];
  readonly recentCommands: readonly DawCommandJournalRecord[];
  readonly recentAudioAnalyses: readonly DawAudioAnalysisRecord[];
  readonly loadedPluginsMatched: readonly string[];
  readonly loadedPluginsMissingKnowledge: readonly string[];
  readonly historicalSessionDeltas: readonly string[];
  readonly contextPackage: DawContextPackage;
};

export type DawSessionFinding = {
  readonly id: string;
  readonly category:
    | 'structure'
    | 'classification'
    | 'routing'
    | 'naming'
    | 'complexity'
    | 'consistency'
    | 'knowledge'
    | 'freshness';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly confidence: DawConfidenceLevel;
  readonly affectedRefs: readonly string[];
};

export type DawRecommendedAction = {
  readonly priority: 'high' | 'medium' | 'low';
  readonly actionType:
    | 'refresh_live_connection'
    | 'save_project_before_render'
    | 'inspect_routing_or_gain'
    | 'replace_excluded_plugin'
    | 'organize_naming'
    | 'record_knowledge_or_preference'
    | 'manual_daw_adjustment'
    | 'audio_brain_render_check';
  readonly title: string;
  readonly rationale: string;
  readonly targetRefs: readonly string[];
  readonly requiresApproval: boolean;
  readonly blockedByLimitation?: string | undefined;
};

export type DawSessionAnalysisMetadata = {
  readonly sessionId: string;
  readonly project: DawProject;
  readonly adapterId: string;
  readonly hostKind: DawHostKind;
  readonly hostName: string;
  readonly hostVersion: string;
  readonly edition: string;
  readonly versionCompatibility: 'compatible' | 'degraded_read_only' | 'incompatible';
  readonly hasUnsavedLiveChanges: boolean;
  readonly stale: boolean;
  readonly unknownFields: readonly string[];
};

export type DawSessionAnalysisReport = {
  readonly reportId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly sessionId: string;
  readonly daw: {
    readonly adapterId: string;
    readonly hostKind: DawHostKind;
    readonly hostName: string;
    readonly version: string;
    readonly edition: string;
  };
  readonly observationTimestamp: string;
  readonly dataFreshness: {
    readonly stateFreshness: DawStateFreshness;
    readonly isLive: boolean;
    readonly isStale: boolean;
    readonly hasUnsavedLiveChanges: boolean;
    readonly authoritativeSource: string;
  };
  readonly evidence: readonly string[];
  readonly inventory: DawSessionInventory;
  readonly trackClassification: readonly DawClassifiedTrack[];
  readonly routingGraph: DawRoutingGraph;
  readonly namingOrganization: DawNamingOrganizationReport;
  readonly complexity: DawComplexityReport;
  readonly consistency: DawConsistencyReport;
  readonly knowledgeContext: DawKnowledgeIntegrationReport | null;
  readonly stateDiffFromPrevious: DawSnapshotComparison | null;
  readonly findings: readonly DawSessionFinding[];
  readonly confidence: DawAnalysisConfidence;
  readonly limitations: readonly string[];
  readonly recommendedNextActions: readonly DawRecommendedAction[];
};

export type AnalyzeDawSessionOptions = {
  readonly hostKind?: DawHostKind | undefined;
  readonly hostName?: string | undefined;
  readonly edition?: string | undefined;
  readonly previousSnapshot?: DawStateSnapshot | undefined;
  readonly previousReport?: DawSessionAnalysisReport | undefined;
  readonly contextEngine?: import('../../context-engine/os3-context-engine.ts').Os3ContextEngine | undefined;
  readonly projectVaultPath?: string | undefined;
  readonly actor?: string | undefined;
  readonly tokenBudget?: number | undefined;
  readonly queryHint?: string | undefined;
};

export type SessionAnalysisSource =
  | { readonly kind: 'session'; readonly session: DawSession }
  | { readonly kind: 'snapshot'; readonly snapshot: DawStateSnapshot; readonly meta: DawSessionAnalysisMetadata };
