import type { AgentClass } from '../contracts/taxonomy.ts';
import type { DawToolCategory, DawPermissionTier } from '../tool-registry/daw-tool-contracts.ts';

export type DawHostKind = 'simulated' | 'fl_studio' | 'reaper' | 'generic_daw';

export type DawCapabilitySupportLevel =
  | 'SUPPORTED'
  | 'TEMPLATE_SCOPED'
  | 'READ_ONLY'
  | 'UNSUPPORTED';

export type DawStateFreshness =
  | 'observed'
  | 'cached'
  | 'stale'
  | 'proposed'
  | 'applied'
  | 'saved'
  | 'unknown';

export type DawConnectionStatus =
  | 'disconnected'
  | 'probing'
  | 'connected_read_only'
  | 'leased_mutable'
  | 'degraded_cached'
  | 'closed';

/**
 * Explicit container preventing missing/unsupported DAW entities from being
 * silently faked as empty arrays or plausible placeholder values.
 */
export type DawAvailability<T> =
  | {
      readonly status: 'available';
      readonly value: T;
    }
  | {
      readonly status: 'unavailable' | 'unsupported' | 'unknown';
      readonly reason: string;
    };

/**
 * Mandatory provenance attached to every DAW state observation, snapshot, or health reading.
 */
export type DawObservationProvenance = {
  readonly observedAt: string;
  readonly dawId: string;
  readonly adapterId: string;
  readonly hostVersion: string;
  readonly sourceEvidence: string;
  readonly freshness: DawStateFreshness;
};

export type DawErrorCode =
  | 'DAW_CAPABILITY_UNSUPPORTED'
  | 'DAW_PERMISSION_DENIED'
  | 'DAW_LEASE_REQUIRED'
  | 'DAW_APPROVAL_REQUIRED'
  | 'DAW_ACTION_NOT_ALLOWLISTED'
  | 'DAW_SAFETY_VIOLATION'
  | 'DAW_TARGET_DRIFT'
  | 'DAW_STALE_STATE'
  | 'DAW_PROJECT_MISMATCH'
  | 'DAW_DUPLICATE_COMMAND'
  | 'DAW_CANCELLED'
  | 'DAW_POSTCONDITION_FAILED'
  | 'DAW_ROLLBACK_UNSUPPORTED'
  | 'DAW_ROLLBACK_FAILED'
  | 'DAW_HOST_OFFLINE'
  | 'DAW_ADAPTER_NOT_FOUND'
  | 'DAW_SESSION_NOT_FOUND'
  | 'DAW_INVALID_COMMAND'
  | 'DAW_UNSUPPORTED_HOST_VERSION'
  | 'DAW_TIMEOUT';

export class DawBrainError extends Error {
  readonly code: DawErrorCode;
  readonly details?: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DawErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'DawBrainError';
    this.code = code;
    this.details = details;
  }
}

// ─── Universal DAW Domain Model (23 Core Entities) ──────────────────────────

export type DawCapability = {
  readonly capabilityId: string;
  readonly category: DawToolCategory | string;
  readonly requiredTier: DawPermissionTier;
  readonly supportLevel: DawCapabilitySupportLevel;
  readonly rollbackSupported: boolean;
  readonly limitations?: readonly string[] | undefined;
  readonly notes?: string | undefined;
};

export type DawInstance = {
  readonly id: string;
  readonly adapterId: string;
  readonly hostKind: DawHostKind;
  readonly hostName: string;
  readonly edition: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly processId: number | null;
  readonly transportKind: 'simulated' | 'midi_sysex' | 'osc_udp' | 'http_ipc' | 'socket_ipc';
  readonly reachable: boolean;
  readonly isSimulated: boolean;
  readonly discoveredAt: string;
};

export type DawConnection = {
  readonly connectionId: string;
  readonly instanceId: string;
  readonly adapterId: string;
  readonly sessionId: string;
  readonly status: DawConnectionStatus;
  readonly activePermissionTier: DawPermissionTier;
  readonly versionCompatibility: 'compatible' | 'degraded_read_only' | 'incompatible';
  readonly connectedAt: string;
  readonly lastHeartbeatAt: string | null;
  readonly lastRttMs: number | null;
  readonly consecutiveFailures: number;
};

export type DawTempo = {
  readonly bpm: number;
  readonly freshness: DawStateFreshness;
};

export type DawTimeSignature = {
  readonly numerator: number;
  readonly denominator: number;
  readonly ppq?: number | undefined;
};

export type DawTransport = {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly recording: boolean;
  readonly loopEnabled: boolean;
  readonly songPositionBeats: number;
  readonly songPositionSeconds: number;
  readonly tempo: DawTempo;
  readonly timeSignature: DawTimeSignature;
  readonly provenance: DawObservationProvenance;
};

export type DawProject = {
  readonly projectId: string;
  readonly name: string;
  readonly format: '.flp' | '.rpp' | '.sim' | 'unknown';
  readonly projectPath: string | null;
  readonly savedSha256: string | null;
  readonly lastSavedAt: string | null;
  readonly editionRequirement: string | null;
  readonly tempo: DawTempo | null;
  readonly timeSignature: DawTimeSignature | null;
};

export type DawTrack = {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly kind: 'audio' | 'midi' | 'instrument' | 'folder' | 'master' | 'bus';
  readonly color: string | null;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly armed: boolean;
  readonly mixerChannelId: string | null;
};

export type DawChannel = {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly kind: 'generator' | 'sampler' | 'audio_clip' | 'automation' | 'layer';
  readonly targetMixerChannelId: string | null;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly volumeNormalized: number;
  readonly panNormalized: number;
};

export type DawPluginParameter = {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly valueNormalized: number;
  readonly displayValue: string;
  readonly defaultNormalized: number | null;
  readonly unit: string | null;
  readonly readable: boolean;
  readonly writable: boolean;
};

export type DawPluginInstance = {
  readonly id: string;
  readonly slotIndex: number;
  readonly containerId: string;
  readonly name: string;
  readonly vendor: string | null;
  readonly format: 'VST3' | 'VST2' | 'CLAP' | 'AU' | 'NATIVE' | 'UNKNOWN';
  readonly bypassed: boolean;
  readonly mixLevel: number | null;
  readonly editionCompatible: 'verified' | 'excluded_by_edition' | 'unknown';
  readonly parameterCount: number;
  readonly parameters: DawAvailability<readonly DawPluginParameter[]>;
};

export type DawMixerChannel = {
  readonly id: string;
  readonly index: number;
  readonly name: string;
  readonly isMaster: boolean;
  readonly volumeNormalized: number;
  readonly volumeDb: number | null;
  readonly panNormalized: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly stereoSeparation: number | null;
  readonly peakDb: number | null;
  readonly pluginSlots: readonly DawPluginInstance[];
};

export type DawBus = {
  readonly id: string;
  readonly mixerChannelId: string;
  readonly name: string;
  readonly role: 'master' | 'submix' | 'send' | 'aux';
  readonly sourceIds: readonly string[];
  readonly destinationId: string | null;
};

export type DawRoutingConnection = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly sendNormalized: number;
  readonly sendDb: number | null;
  readonly enabled: boolean;
  readonly preFader: boolean;
  readonly sidechain: boolean;
};

export type DawAutomationPoint = {
  readonly positionBeats: number;
  readonly valueNormalized: number;
  readonly curve: 'linear' | 'smooth' | 'step' | 'unknown';
};

export type DawAutomationLane = {
  readonly id: string;
  readonly targetRef: string;
  readonly parameterName: string;
  readonly enabled: boolean;
  readonly points: DawAvailability<readonly DawAutomationPoint[]>;
};

export type DawAudioClip = {
  readonly id: string;
  readonly name: string;
  readonly trackId: string;
  readonly sourcePath: string | null;
  readonly startBeats: number;
  readonly lengthBeats: number;
  readonly gainDb: number | null;
  readonly muted: boolean;
};

export type DawMidiClip = {
  readonly id: string;
  readonly name: string;
  readonly trackId: string;
  readonly channelId: string | null;
  readonly patternId: string | null;
  readonly startBeats: number;
  readonly lengthBeats: number;
  readonly noteCount: number | null;
};

export type DawMarker = {
  readonly id: string;
  readonly name: string;
  readonly positionBeats: number;
  readonly kind: 'marker' | 'loop_start' | 'loop_end' | 'section';
};

export type DawRegion = {
  readonly id: string;
  readonly name: string;
  readonly startBeats: number;
  readonly endBeats: number;
  readonly color: string | null;
};

export type DawStateSnapshot = {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly freshness: DawStateFreshness;
  readonly provenance: DawObservationProvenance;
  readonly transport: DawTransport;
  readonly tracks: DawAvailability<readonly DawTrack[]>;
  readonly channels: DawAvailability<readonly DawChannel[]>;
  readonly mixerChannels: DawAvailability<readonly DawMixerChannel[]>;
  readonly buses: DawAvailability<readonly DawBus[]>;
  readonly routing: DawAvailability<readonly DawRoutingConnection[]>;
  readonly plugins: DawAvailability<readonly DawPluginInstance[]>;
  readonly automationLanes: DawAvailability<readonly DawAutomationLane[]>;
  readonly audioClips: DawAvailability<readonly DawAudioClip[]>;
  readonly midiClips: DawAvailability<readonly DawMidiClip[]>;
  readonly markers: DawAvailability<readonly DawMarker[]>;
  readonly regions: DawAvailability<readonly DawRegion[]>;
  readonly stateDigest: string;
};

export type DawCommandClass =
  | 'read_only'
  | 'reversible'
  | 'potentially_destructive'
  | 'irreversible'
  | 'unsupported';

export type DawRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type DawApprovalRequirement = 'none' | 'human_standard' | 'human_strong';

export type DawCommandLifecycleStage =
  | 'request'
  | 'capability_verification'
  | 'input_validation'
  | 'permission_check'
  | 'risk_classification'
  | 'dry_run'
  | 'approval'
  | 'execution'
  | 'postcondition_verification'
  | 'audit'
  | 'recovery_or_rollback';

export type DawCommandKind =
  | 'session.observe'
  | 'transport.control'
  | 'mixer.volume_pan_mute'
  | 'mixer.routing_write'
  | 'plugin.param_write'
  | 'plugin.bypass'
  | 'plugin.load_remove'
  | 'track.create_delete'
  | 'project.save'
  | 'render.master'
  | 'automation.edit'
  | 'audio.destructive_process'
  | 'distribution.publish';

export type DawCommand = {
  readonly commandId: string;
  readonly sessionId: string;
  readonly kind: DawCommandKind;
  readonly capabilityId: string;
  readonly targetRef: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly expectedBeforeDigest?: string | undefined;
  readonly expectedDawId?: string | undefined;
  readonly expectedAdapterId?: string | undefined;
  readonly expectedProjectId?: string | undefined;
  readonly expectedProjectPath?: string | undefined;
  readonly expectedProjectSha256?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxStateAgeMs?: number | undefined;
  readonly strongApprovalReason?: string | undefined;
  readonly requestedBy: string;
  readonly requestedClass: AgentClass;
  readonly correlationId: string;
  readonly createdAt: string;
};

export type DawStateDiffEntry = {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly unit?: string | undefined;
};

export type DawProjectIdentityCheck = {
  readonly verified: boolean;
  readonly sessionProjectId: string;
  readonly sessionProjectPath: string | null;
  readonly sessionSavedSha256: string | null;
  readonly expectedProjectId?: string | undefined;
  readonly expectedProjectPath?: string | undefined;
  readonly expectedProjectSha256?: string | undefined;
  readonly mismatchReason?: string | undefined;
};

export type DawDryRunResult = {
  readonly ok: boolean;
  readonly commandId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly capabilityId: string;
  readonly commandKind: DawCommandKind;
  readonly commandClass: DawCommandClass;
  readonly riskLevel: DawRiskLevel;
  readonly approvalRequirement: DawApprovalRequirement;
  readonly rollbackSupported: boolean;
  readonly rollbackStrategy: 'exact_before_state' | 'none';
  readonly wouldSucceed: boolean;
  readonly targetRef: string;
  readonly beforeState: Readonly<Record<string, unknown>> | null;
  readonly predictedAfterState: Readonly<Record<string, unknown>> | null;
  readonly diff: readonly DawStateDiffEntry[];
  readonly postconditionExpectations: readonly string[];
  readonly warnings: readonly string[];
  readonly projectIdentity: DawProjectIdentityCheck;
  readonly stateFreshnessCheck: {
    readonly freshness: DawStateFreshness;
    readonly observedAt: string | null;
    readonly ageMs: number | null;
    readonly maxAllowedAgeMs: number;
    readonly fresh: boolean;
  };
  readonly lifecycleStages: readonly DawCommandLifecycleStage[];
  readonly error?: { readonly code: DawErrorCode; readonly message: string } | undefined;
};

export type DawRecoveryOutcome = {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly strategy: 'rollback_restored' | 'marked_stale_reobserve' | 'manual_intervention_required' | 'none';
  readonly rollbackReceiptId?: string | undefined;
  readonly message: string;
};

export type DawExecutionReceipt = {
  readonly receiptId: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly capabilityId: string;
  readonly commandKind: DawCommandKind;
  readonly commandClass: DawCommandClass;
  readonly riskLevel: DawRiskLevel;
  readonly approvalRequirement: DawApprovalRequirement;
  readonly approvalId: string | null;
  readonly leaseId: string | null;
  readonly projectIdentity: DawProjectIdentityCheck;
  readonly requestedBy: string;
  readonly executedBy: string;
  readonly lifecycleStages: readonly DawCommandLifecycleStage[];
  readonly beforeState: Readonly<Record<string, unknown>> | null;
  readonly afterState: Readonly<Record<string, unknown>> | null;
  readonly dryRunDiff: readonly DawStateDiffEntry[];
  readonly verifiedByReadback: boolean;
  readonly postconditionVerified: boolean;
  readonly rollbackSupported: boolean;
  readonly rollbackStatus: 'available' | 'unavailable' | 'rolled_back' | 'rollback_failed';
  readonly rollbackReceiptId?: string | undefined;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly recovery: DawRecoveryOutcome;
  readonly status:
    | 'dry_run'
    | 'prepared'
    | 'succeeded'
    | 'denied'
    | 'unsupported'
    | 'cancelled'
    | 'timed_out'
    | 'failed'
    | 'rolled_back';
  readonly error?: { readonly code: DawErrorCode; readonly message: string } | undefined;
  readonly createdAt: string;
  readonly completedAt: string;
};

export type DawCommandResult = {
  readonly commandId: string;
  readonly sessionId: string;
  readonly ok: boolean;
  readonly status:
    | 'prepared'
    | 'succeeded'
    | 'denied'
    | 'unsupported'
    | 'failed'
    | 'rolled_back'
    | 'cancelled'
    | 'timed_out';
  readonly stateFreshness: 'proposed' | 'applied' | 'unknown';
  readonly capabilityId: string;
  readonly beforeState: Readonly<Record<string, unknown>> | null;
  readonly afterState: Readonly<Record<string, unknown>> | null;
  readonly verifiedByReadback: boolean;
  readonly rollbackSupported: boolean;
  readonly provenance: DawObservationProvenance;
  readonly evidence: readonly string[];
  readonly receiptId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly commandClass?: DawCommandClass | undefined;
  readonly lifecycleStages?: readonly DawCommandLifecycleStage[] | undefined;
  readonly postconditionVerified?: boolean | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly cancelled?: boolean | undefined;
  readonly timedOut?: boolean | undefined;
  readonly recovery?: DawRecoveryOutcome | undefined;
  readonly receipt?: DawExecutionReceipt | undefined;
  readonly error?: { readonly code: DawErrorCode; readonly message: string } | undefined;
};

export type DawSession = {
  readonly sessionId: string;
  readonly adapterId: string;
  readonly dawId: string;
  readonly hostVersion: string;
  readonly project: DawProject;
  readonly connection: DawConnection;
  readonly stateFreshness: DawStateFreshness;
  readonly observed: DawStateSnapshot | null;
  readonly cached: DawStateSnapshot | null;
  readonly stale: boolean;
  readonly saved: DawProject | null;
  readonly proposed: readonly DawCommand[];
  readonly applied: readonly DawCommandResult[];
  readonly unknownFields: readonly string[];
  readonly hasUnsavedLiveChanges: boolean;
  readonly updatedAt: string;
};
