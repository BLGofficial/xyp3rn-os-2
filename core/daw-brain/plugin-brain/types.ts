import type { DawAvailability, DawHostKind } from '../types.ts';

export type PluginFormat = 'VST3' | 'VST2' | 'CLAP' | 'AU' | 'NATIVE' | 'UNKNOWN';

export type PluginCategory =
  | 'equalizer'
  | 'compressor'
  | 'limiter'
  | 'saturation'
  | 'reverb'
  | 'delay'
  | 'pitch_correction'
  | 'modulation'
  | 'stereo_imaging'
  | 'analyzer'
  | 'synth_generator'
  | 'utility'
  | 'other';

export type PluginType = 'effect' | 'instrument' | 'analyzer' | 'utility';

export type PluginProcessingRole =
  | 'subtractive_eq'
  | 'tonal_shaping'
  | 'surgical_resonance_control'
  | 'vocal_tuning'
  | 'dynamic_leveling'
  | 'transient_control'
  | 'bus_glue'
  | 'peak_limiting'
  | 'harmonic_saturation'
  | 'spatial_reverb'
  | 'tempo_delay'
  | 'width_imaging'
  | 'low_end_control'
  | 'metering_analysis'
  | 'sound_generation'
  | 'gain_utility'
  | 'creative_mfx'
  | 'unclassified';

export type PluginParameterSpec = {
  readonly index: number | null;
  readonly id: string;
  readonly name: string;
  readonly semanticKey: string;
  readonly min: number;
  readonly max: number;
  readonly unit: string | null;
  readonly defaultNormalized: number | null;
  readonly stepped: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly lastObservedNormalized: number | null;
  readonly lastObservedDisplay: string | null;
  readonly interpretation: string;
};

export type PluginPresetRef = {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly sourcePath: string | null;
};

export type PluginDocSource = {
  readonly sourceType: 'vault_canonical' | 'vault_approved' | 'user_catalog' | 'host_metadata' | 'daw_live';
  readonly refId: string;
  readonly vaultPath?: string | undefined;
  readonly filePath?: string | undefined;
  readonly approved: boolean;
};

export type PluginInstallationState = {
  readonly installedOnHost: 'verified_installed' | 'not_detected_on_host' | 'unknown';
  readonly discoverySources: ReadonlyArray<
    'daw_live_inventory' | 'local_host_scan' | 'user_catalog' | 'vault_knowledge_only'
  >;
  readonly hostPaths: readonly string[];
  readonly lastVerifiedAt: string | null;
};

export type PluginCompatibilityInfo = {
  readonly hosts: readonly DawHostKind[];
  readonly architectures: readonly string[];
  readonly editionRequirement: string;
  readonly supportVerdict:
    | 'verified_compatible'
    | 'excluded_by_edition'
    | 'third_party_host_dependent'
    | 'incompatible_host'
    | 'unknown';
  readonly reasons: readonly string[];
};

export type PluginRequirementsInfo = {
  readonly licenseModel: 'included_stock' | 'commercial_license' | 'freeware' | 'edition_upgrade_or_trial' | 'unknown';
  readonly dependencies: readonly string[];
};

export type PluginProfile = {
  readonly id: string;
  readonly identity: {
    readonly manufacturer: string | null;
    readonly productName: string;
    readonly normalizedKey: string;
    readonly version: string | null;
    readonly uid: string | null;
  };
  readonly format: PluginFormat;
  readonly category: PluginCategory;
  readonly pluginType: PluginType;
  readonly processingRoles: readonly PluginProcessingRole[];
  readonly io: {
    readonly inputLayout: 'mono' | 'stereo' | 'mono_to_stereo' | 'midi_in' | 'unknown';
    readonly outputLayout: 'mono' | 'stereo' | 'unknown';
    readonly supportsSidechain: boolean;
  };
  readonly parameters: readonly PluginParameterSpec[];
  readonly presets: DawAvailability<readonly PluginPresetRef[]>;
  readonly compatibility: PluginCompatibilityInfo;
  readonly requirements: PluginRequirementsInfo;
  readonly knownLimitations: readonly string[];
  readonly documentationSources: readonly PluginDocSource[];
  readonly installation: PluginInstallationState;
  readonly updatedAt: string;
};

export type PluginUserCatalogEntry = {
  readonly id?: string | undefined;
  readonly manufacturer?: string | null | undefined;
  readonly productName: string;
  readonly version?: string | null | undefined;
  readonly format?: PluginFormat | undefined;
  readonly category?: PluginCategory | undefined;
  readonly pluginType?: PluginType | undefined;
  readonly processingRoles?: readonly PluginProcessingRole[] | undefined;
  readonly supportsSidechain?: boolean | undefined;
  readonly editionRequirement?: string | undefined;
  readonly licenseModel?: PluginRequirementsInfo['licenseModel'] | undefined;
  readonly parameters?: ReadonlyArray<{
    readonly name: string;
    readonly semanticKey?: string | undefined;
    readonly min?: number | undefined;
    readonly max?: number | undefined;
    readonly unit?: string | null | undefined;
  }> | undefined;
  readonly presets?: readonly PluginPresetRef[] | undefined;
  readonly knownLimitations?: readonly string[] | undefined;
  readonly sourceRef?: string | undefined;
};

export type HostScannedPluginInput = {
  readonly name: string;
  readonly format: 'VST3' | 'VST2' | 'CLAP' | 'AU' | 'NATIVE' | 'UNKNOWN';
  readonly path: string;
  readonly manufacturer?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly editionStatus?: 'included_stock' | 'excluded_by_edition_unless_purchased' | 'third_party_compatible' | 'unknown' | undefined;
};

export type PluginWorkflowKind =
  | 'vocal_chain'
  | 'instrument_chain'
  | 'drum_processing'
  | 'bass_processing'
  | 'mix_bus'
  | 'master_bus'
  | 'creative_fx'
  | 'parallel_processing'
  | 'sidechain_workflow';

export type PluginChainSourceKind = 'actual_daw_chain' | 'suggested_recipe';

export type PluginChainNode = {
  readonly nodeId: string;
  readonly orderIndex: number;
  readonly containerId: string;
  readonly pluginName: string;
  readonly profileId: string | null;
  readonly category: PluginCategory;
  readonly role: PluginProcessingRole;
  readonly slotType: 'insert' | 'parallel_send' | 'sidechain_key' | 'return';
  readonly bypassed: boolean;
  readonly mixNormalized: number | null;
  readonly sidechainSourceRef: string | null;
  readonly installedVerified: boolean;
  readonly compatibilityStatus: PluginCompatibilityInfo['supportVerdict'];
};

export type PluginChainEdge = {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly signalMode: 'serial' | 'parallel_wet' | 'sidechain_key';
};

export type PluginChainGraph = {
  readonly chainId: string;
  readonly label: string;
  readonly sourceKind: PluginChainSourceKind;
  readonly workflowKind: PluginWorkflowKind;
  readonly containerId: string;
  readonly nodes: readonly PluginChainNode[];
  readonly edges: readonly PluginChainEdge[];
  readonly missingRoles: readonly PluginProcessingRole[];
  readonly provenanceEvidence: string;
};

export type PluginRedundancyFinding = {
  readonly code: 'DUPLICATE_PROCESSOR_ROLE' | 'CONSECUTIVE_SAME_PLUGIN' | 'BYPASSED_DEAD_WEIGHT' | 'EDITION_BLOCKED_IN_CHAIN' | 'UNINSTALLED_PLUGIN_IN_RECIPE';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly summary: string;
  readonly nodeIds: readonly string[];
};

export type PluginSignalFlowIssue = {
  readonly code: 'LIMITER_NOT_FINAL' | 'REVERB_BEFORE_HEAVY_DYNAMICS' | 'MISSING_SIDECHAIN_KEY' | 'PARALLEL_NO_DRY_WET_SPLIT' | 'EXCLUDED_PLUGIN_USED';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly summary: string;
  readonly nodeIds: readonly string[];
};

export type PluginChainAnalysisReport = {
  readonly chainId: string;
  readonly sourceKind: PluginChainSourceKind;
  readonly workflowKind: PluginWorkflowKind;
  readonly compatibleForHost: boolean;
  readonly installedCoverageRatio: number;
  readonly redundancies: readonly PluginRedundancyFinding[];
  readonly signalFlowIssues: readonly PluginSignalFlowIssue[];
  readonly orderedRoles: readonly PluginProcessingRole[];
  readonly summary: string;
};

export type PluginComparisonResult = {
  readonly pluginA: { readonly id: string; readonly name: string; readonly installed: boolean };
  readonly pluginB: { readonly id: string; readonly name: string; readonly installed: boolean };
  readonly sharedCategory: boolean;
  readonly sharedRoles: readonly PluginProcessingRole[];
  readonly sameFormat: boolean;
  readonly parameterCountDelta: number;
  readonly recommendation: string;
  readonly tradeoffs: readonly string[];
};

export type PluginRecommendation = {
  readonly pluginId: string | null;
  readonly pluginName: string;
  readonly category: PluginCategory;
  readonly role: PluginProcessingRole;
  readonly installedOnHost: PluginInstallationState['installedOnHost'];
  readonly compatible: boolean;
  readonly score: number;
  readonly rationale: string;
  readonly limitations: readonly string[];
};
