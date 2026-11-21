import path from 'node:path';
import type {
  DawApprovalRequirement,
  DawCapability,
  DawCommand,
  DawCommandClass,
  DawCommandKind,
  DawErrorCode,
  DawProjectIdentityCheck,
  DawRiskLevel,
  DawSession,
  DawStateSnapshot,
} from './types.ts';

/**
 * Initial strict Phase 16 permitted low-risk actions.
 * Explicitly excludes unrestricted project modifications, plugin automation,
 * plugin load/remove, track creation/deletion, destructive processing, and distribution.
 */
export const INITIAL_PERMITTED_DAW_CAPABILITIES = [
  'daw.transport.control',
  'daw.mixer.fader_pan_mute',
  'daw.plugin.bypass',
] as const;

export const ALWAYS_PROHIBITED_COMMAND_KINDS = new Set<DawCommandKind>([
  'automation.edit',
  'track.create_delete',
  'plugin.load_remove',
  'audio.destructive_process',
  'distribution.publish',
]);

const KIND_EXPECTED_CAPABILITIES: Readonly<Record<DawCommandKind, readonly string[]>> = {
  'session.observe': [
    'daw.health.probe',
    'daw.version.inspect',
    'daw.session.inspect',
    'daw.transport.read',
    'daw.mixer.read',
    'daw.routing.read',
    'daw.plugin.inventory_live',
    'daw.plugin.param_read',
    'daw.plugin.params_read',
  ],
  'transport.control': ['daw.transport.control'],
  'mixer.volume_pan_mute': ['daw.mixer.fader_pan_mute'],
  'mixer.routing_write': ['daw.mixer.routing_write'],
  'plugin.param_write': ['daw.plugin.param_write'],
  'plugin.bypass': ['daw.plugin.bypass'],
  'plugin.load_remove': ['daw.plugin.load_remove'],
  'track.create_delete': ['daw.track.create_delete'],
  'project.save': ['daw.project.save'],
  'render.master': ['daw.render.master'],
  'automation.edit': ['daw.automation.edit'],
  'audio.destructive_process': ['daw.audio.destructive_process'],
  'distribution.publish': ['daw.distribution.publish'],
};

const NON_ROLLBACKABLE_KINDS = new Set<DawCommandKind>([
  'project.save',
  'render.master',
  'track.create_delete',
  'plugin.load_remove',
  'automation.edit',
  'audio.destructive_process',
  'distribution.publish',
]);

export type DawCommandPolicyConfig = {
  readonly defaultDeny: true;
  readonly permittedCapabilities: readonly string[];
  readonly readOnlyCapabilities?: readonly string[] | undefined;
  readonly allowTransportRecording?: boolean | undefined;
  readonly allowMasterBusMutation?: boolean | undefined;
  readonly allowStructuralOps?: boolean | undefined;
  readonly maxGainDeltaDb?: number | undefined;
  readonly minGainDeltaDb?: number | undefined;
  readonly minBpm?: number | undefined;
  readonly maxBpm?: number | undefined;
  readonly defaultMaxStateAgeMs?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
};

export const DEFAULT_COMMAND_EXECUTION_POLICY: DawCommandPolicyConfig = {
  defaultDeny: true,
  permittedCapabilities: [...INITIAL_PERMITTED_DAW_CAPABILITIES],
  readOnlyCapabilities: KIND_EXPECTED_CAPABILITIES['session.observe'],
  allowTransportRecording: false,
  allowMasterBusMutation: true,
  allowStructuralOps: false,
  maxGainDeltaDb: 3.0,
  minGainDeltaDb: -60.0,
  minBpm: 20,
  maxBpm: 300,
  defaultMaxStateAgeMs: 15_000,
  defaultTimeoutMs: 5_000,
};

export type DawCommandRiskAssessment = {
  readonly commandClass: DawCommandClass;
  readonly riskLevel: DawRiskLevel;
  readonly rollbackSupported: boolean;
  readonly rollbackStrategy: 'exact_before_state' | 'none';
  readonly approvalRequirement: DawApprovalRequirement;
  readonly isMasterTarget: boolean;
  readonly warnings: readonly string[];
};

export type DawValidationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DawErrorCode; readonly reason: string };

const normalizeFsPath = (p: string | null | undefined): string =>
  (p ?? '').trim().replace(/\//g, '\\').toLowerCase();

const isTargetMaster = (targetRef: string, snapshot?: DawStateSnapshot | null): boolean => {
  const lower = targetRef.toLowerCase();
  if (lower.includes('master') || lower === 'mixer:insert:0') return true;
  if (snapshot && snapshot.mixerChannels.status === 'available') {
    const ch = snapshot.mixerChannels.value.find((m) => m.id === targetRef);
    if (ch?.isMaster || ch?.name.toLowerCase() === 'master') return true;
  }
  return false;
};

/**
 * Verifies live state freshness before allowing preparation, dry-run diff trust, or live execution.
 */
export const verifyStateFreshness = (
  session: DawSession,
  command?: Pick<DawCommand, 'maxStateAgeMs'>,
  defaultMaxAgeMs = DEFAULT_COMMAND_EXECUTION_POLICY.defaultMaxStateAgeMs ?? 15_000,
): {
  readonly ok: boolean;
  readonly code?: 'DAW_HOST_OFFLINE' | 'DAW_STALE_STATE';
  readonly reason: string;
  readonly freshness: DawSession['stateFreshness'];
  readonly observedAt: string | null;
  readonly ageMs: number | null;
  readonly maxAllowedAgeMs: number;
} => {
  const maxAllowedAgeMs = Math.max(1, command?.maxStateAgeMs ?? defaultMaxAgeMs);

  if (
    session.connection.status === 'disconnected' ||
    session.connection.status === 'closed' ||
    session.connection.status === 'degraded_cached'
  ) {
    return {
      ok: false,
      code: 'DAW_HOST_OFFLINE',
      reason: `Session "${session.sessionId}" connection status is "${session.connection.status}"`,
      freshness: session.stateFreshness,
      observedAt: session.observed?.provenance.observedAt ?? session.cached?.provenance.observedAt ?? null,
      ageMs: null,
      maxAllowedAgeMs,
    };
  }

  if (session.stale || !session.observed) {
    return {
      ok: false,
      code: 'DAW_STALE_STATE',
      reason: `Session "${session.sessionId}" observation state is "${session.stateFreshness}" (live snapshot required)`,
      freshness: session.stateFreshness,
      observedAt: session.cached?.provenance.observedAt ?? null,
      ageMs: null,
      maxAllowedAgeMs,
    };
  }

  const obsAt = session.observed.provenance.observedAt;
  const obsMs = Date.parse(obsAt);
  if (Number.isNaN(obsMs)) {
    return {
      ok: false,
      code: 'DAW_STALE_STATE',
      reason: `Session "${session.sessionId}" snapshot has invalid observedAt timestamp "${obsAt}"`,
      freshness: session.stateFreshness,
      observedAt: obsAt,
      ageMs: null,
      maxAllowedAgeMs,
    };
  }

  const ageMs = Math.max(0, Date.now() - obsMs);
  if (ageMs > maxAllowedAgeMs) {
    return {
      ok: false,
      code: 'DAW_STALE_STATE',
      reason: `Observed snapshot age (${ageMs} ms) exceeds maxStateAgeMs (${maxAllowedAgeMs} ms)`,
      freshness: 'stale',
      observedAt: obsAt,
      ageMs,
      maxAllowedAgeMs,
    };
  }

  return {
    ok: true,
    reason: 'Live snapshot verified fresh',
    freshness: session.stateFreshness,
    observedAt: obsAt,
    ageMs,
    maxAllowedAgeMs,
  };
};

/**
 * Verifies DAW instance & adapter provenance identity against the active connected session
 * and latest live observed snapshot before permitting preparation or execution.
 */
export const verifyDawInstanceIdentity = (
  session: DawSession,
  command: Pick<DawCommand, 'expectedDawId' | 'expectedAdapterId'>,
  snapshot?: DawStateSnapshot | null,
): { readonly verified: boolean; readonly mismatchReason?: string } => {
  if (command.expectedDawId !== undefined && command.expectedDawId !== session.dawId) {
    return {
      verified: false,
      mismatchReason: `DAW instance identity mismatch: expected "${command.expectedDawId}", active "${session.dawId}"`,
    };
  }
  if (command.expectedAdapterId !== undefined && command.expectedAdapterId !== session.adapterId) {
    return {
      verified: false,
      mismatchReason: `DAW adapter identity mismatch: expected "${command.expectedAdapterId}", active "${session.adapterId}"`,
    };
  }
  if (snapshot && snapshot.provenance.dawId !== session.dawId) {
    return {
      verified: false,
      mismatchReason: `Observed snapshot DAW identity drift: session="${session.dawId}", snapshot="${snapshot.provenance.dawId}"`,
    };
  }
  if (snapshot && snapshot.provenance.adapterId !== session.adapterId) {
    return {
      verified: false,
      mismatchReason: `Observed snapshot adapter identity drift: session="${session.adapterId}", snapshot="${snapshot.provenance.adapterId}"`,
    };
  }
  return { verified: true };
};

/**
 * Verifies that expected project identity fields match the active DAW session project metadata.
 */
export const verifyProjectIdentity = (
  session: DawSession,
  command: Pick<DawCommand, 'expectedProjectId' | 'expectedProjectPath' | 'expectedProjectSha256'>,
): DawProjectIdentityCheck => {
  const actualPath = session.project.projectPath ?? session.saved?.projectPath ?? null;
  const actualSha = session.saved?.savedSha256 ?? session.project.savedSha256 ?? null;

  if (command.expectedProjectId !== undefined && command.expectedProjectId !== session.project.projectId) {
    return {
      verified: false,
      sessionProjectId: session.project.projectId,
      sessionProjectPath: actualPath,
      sessionSavedSha256: actualSha,
      expectedProjectId: command.expectedProjectId,
      mismatchReason: `Project ID mismatch: expected "${command.expectedProjectId}", active "${session.project.projectId}"`,
    };
  }

  if (command.expectedProjectPath !== undefined) {
    const expNorm = path.normalize(normalizeFsPath(command.expectedProjectPath));
    const actNorm = actualPath ? path.normalize(normalizeFsPath(actualPath)) : '';
    if (!actNorm || expNorm !== actNorm) {
      return {
        verified: false,
        sessionProjectId: session.project.projectId,
        sessionProjectPath: actualPath,
        sessionSavedSha256: actualSha,
        expectedProjectPath: command.expectedProjectPath,
        mismatchReason: `Project path mismatch: expected "${command.expectedProjectPath}", active "${actualPath ?? 'none'}"`,
      };
    }
  }

  if (command.expectedProjectSha256 !== undefined) {
    if (!actualSha || command.expectedProjectSha256.toLowerCase() !== actualSha.toLowerCase()) {
      return {
        verified: false,
        sessionProjectId: session.project.projectId,
        sessionProjectPath: actualPath,
        sessionSavedSha256: actualSha,
        expectedProjectSha256: command.expectedProjectSha256,
        mismatchReason: `Project SHA-256 mismatch: expected "${command.expectedProjectSha256}", active "${actualSha ?? 'none'}"`,
      };
    }
  }

  return {
    verified: true,
    sessionProjectId: session.project.projectId,
    sessionProjectPath: actualPath,
    sessionSavedSha256: actualSha,
    expectedProjectId: command.expectedProjectId,
    expectedProjectPath: command.expectedProjectPath,
    expectedProjectSha256: command.expectedProjectSha256,
  };
};

/**
 * Policy engine for Phase 16 DAW Command Gateway:
 * - Default deny allowlists
 * - Strict input & safety range checks
 * - 5-class risk classification
 * - Truthful rollback & stronger-approval requirements
 */
export class DawCommandPolicyEngine {
  readonly config: DawCommandPolicyConfig;

  constructor(config: Partial<DawCommandPolicyConfig> = {}) {
    this.config = {
      ...DEFAULT_COMMAND_EXECUTION_POLICY,
      ...config,
      defaultDeny: true,
      permittedCapabilities: config.permittedCapabilities
        ? [...config.permittedCapabilities]
        : [...INITIAL_PERMITTED_DAW_CAPABILITIES],
      readOnlyCapabilities: config.readOnlyCapabilities
        ? [...config.readOnlyCapabilities]
        : [...(DEFAULT_COMMAND_EXECUTION_POLICY.readOnlyCapabilities ?? [])],
    };
  }

  validateInputAndSafety(command: DawCommand, snapshot: DawStateSnapshot | null): DawValidationVerdict {
    if (!command.commandId || !command.commandId.trim()) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'commandId must be a non-empty string' };
    }
    if (!command.correlationId || !command.correlationId.trim()) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'correlationId must be a non-empty string' };
    }
    if (!command.sessionId || !command.sessionId.trim()) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'sessionId must be a non-empty string' };
    }
    if (!command.targetRef || !command.targetRef.trim()) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'targetRef must be a non-empty string' };
    }
    if (!command.requestedBy || !command.requestedBy.trim()) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'requestedBy must be a non-empty string' };
    }
    if (!command.params || typeof command.params !== 'object' || Array.isArray(command.params)) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'params must be a plain key-value object' };
    }

    const expectedCaps = KIND_EXPECTED_CAPABILITIES[command.kind];
    if (!expectedCaps) {
      return {
        ok: false,
        code: 'DAW_INVALID_COMMAND',
        reason: `Unknown DAW command kind "${String(command.kind)}"`,
      };
    }
    if (!expectedCaps.includes(command.capabilityId)) {
      return {
        ok: false,
        code: 'DAW_INVALID_COMMAND',
        reason: `Mismatched command kind "${command.kind}" and capabilityId "${command.capabilityId}"`,
      };
    }

    const params = command.params;
    const minDelta = this.config.minGainDeltaDb ?? -60;
    const maxDelta = this.config.maxGainDeltaDb ?? 3.0;
    const minBpm = this.config.minBpm ?? 20;
    const maxBpm = this.config.maxBpm ?? 300;

    if (typeof params.valueNormalized === 'number') {
      if (!Number.isFinite(params.valueNormalized) || params.valueNormalized < 0 || params.valueNormalized > 1) {
        return {
          ok: false,
          code: 'DAW_SAFETY_VIOLATION',
          reason: `Normalized parameter must be in [0.0, 1.0] (got ${String(params.valueNormalized)})`,
        };
      }
    } else if (params.valueNormalized !== undefined && params.valueNormalized !== null) {
      return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'valueNormalized must be a finite number' };
    }

    if (command.kind === 'mixer.volume_pan_mute') {
      const hasAnyField =
        params.deltaDb !== undefined ||
        params.volumeNormalized !== undefined ||
        params.volumeDb !== undefined ||
        params.panNormalized !== undefined ||
        params.muted !== undefined ||
        params.soloed !== undefined;
      if (!hasAnyField) {
        return {
          ok: false,
          code: 'DAW_INVALID_COMMAND',
          reason: 'mixer.volume_pan_mute requires at least one parameter (deltaDb, volumeNormalized, volumeDb, panNormalized, muted, soloed)',
        };
      }

      if (params.deltaDb !== undefined) {
        if (typeof params.deltaDb !== 'number' || !Number.isFinite(params.deltaDb)) {
          return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'deltaDb must be a finite number' };
        }
        if (params.deltaDb > maxDelta || params.deltaDb < minDelta) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `Gain delta (${params.deltaDb} dB) violates max step safety clamp [+${maxDelta} dB, ${minDelta} dB]`,
          };
        }
      }

      if (params.volumeNormalized !== undefined) {
        if (
          typeof params.volumeNormalized !== 'number' ||
          !Number.isFinite(params.volumeNormalized) ||
          params.volumeNormalized < 0 ||
          params.volumeNormalized > 1
        ) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `volumeNormalized must be within [0.0, 1.0] (got ${String(params.volumeNormalized)})`,
          };
        }
      }

      if (params.volumeDb !== undefined) {
        if (
          typeof params.volumeDb !== 'number' ||
          !Number.isFinite(params.volumeDb) ||
          params.volumeDb < -120 ||
          params.volumeDb > 6
        ) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `volumeDb (${String(params.volumeDb)}) outside safe range [-120, +6.0] dBFS`,
          };
        }
      }

      if (params.panNormalized !== undefined) {
        if (
          typeof params.panNormalized !== 'number' ||
          !Number.isFinite(params.panNormalized) ||
          params.panNormalized < -1 ||
          params.panNormalized > 1
        ) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `panNormalized (${String(params.panNormalized)}) outside [-1.0, 1.0]`,
          };
        }
      }

      if (params.muted !== undefined && typeof params.muted !== 'boolean') {
        return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'muted must be a boolean' };
      }
      if (params.soloed !== undefined && typeof params.soloed !== 'boolean') {
        return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'soloed must be a boolean' };
      }

      if (isTargetMaster(command.targetRef, snapshot)) {
        const targetMixer =
          snapshot && snapshot.mixerChannels.status === 'available'
            ? snapshot.mixerChannels.value.find((ch) => ch.id === command.targetRef)
            : undefined;
        if (typeof params.volumeDb === 'number' && params.volumeDb > 0) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `Master bus boost above 0.0 dBFS is blocked (${params.volumeDb} dBFS)`,
          };
        }
        if (
          typeof params.deltaDb === 'number' &&
          targetMixer?.volumeDb !== null &&
          targetMixer?.volumeDb !== undefined &&
          targetMixer.volumeDb + params.deltaDb > 0
        ) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `Master bus boost above 0.0 dBFS is blocked (would reach ${(targetMixer.volumeDb + params.deltaDb).toFixed(2)} dBFS)`,
          };
        }
        if (typeof params.volumeNormalized === 'number') {
          const hostUnityNorm =
            targetMixer?.volumeDb !== null &&
            targetMixer?.volumeDb !== undefined &&
            Math.abs(targetMixer.volumeDb) < 0.05 &&
            targetMixer.volumeNormalized > 0 &&
            targetMixer.volumeNormalized <= 1
              ? targetMixer.volumeNormalized
              : 1.0;
          if (params.volumeNormalized > hostUnityNorm + 1e-6) {
            return {
              ok: false,
              code: 'DAW_SAFETY_VIOLATION',
              reason: `Master bus normalized volume > ${hostUnityNorm} (0.0 dBFS host unity) is blocked (got ${params.volumeNormalized})`,
            };
          }
        }
      }
    }

    if (command.kind === 'transport.control') {
      const hasTransportField =
        params.playing !== undefined ||
        params.paused !== undefined ||
        params.recording !== undefined ||
        params.loopEnabled !== undefined ||
        params.bpm !== undefined ||
        params.songPositionBeats !== undefined;
      if (!hasTransportField) {
        return {
          ok: false,
          code: 'DAW_INVALID_COMMAND',
          reason: 'transport.control requires playing, paused, recording, loopEnabled, bpm, or songPositionBeats',
        };
      }
      for (const boolKey of ['playing', 'paused', 'recording', 'loopEnabled'] as const) {
        if (params[boolKey] !== undefined && typeof params[boolKey] !== 'boolean') {
          return { ok: false, code: 'DAW_INVALID_COMMAND', reason: `${boolKey} must be a boolean` };
        }
      }
      if (params.bpm !== undefined) {
        if (typeof params.bpm !== 'number' || !Number.isFinite(params.bpm) || params.bpm < minBpm || params.bpm > maxBpm) {
          return {
            ok: false,
            code: 'DAW_SAFETY_VIOLATION',
            reason: `Tempo ${String(params.bpm)} BPM outside safe bounds [${minBpm}, ${maxBpm}]`,
          };
        }
      }
      if (
        params.songPositionBeats !== undefined &&
        (typeof params.songPositionBeats !== 'number' || !Number.isFinite(params.songPositionBeats) || params.songPositionBeats < 0)
      ) {
        return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'songPositionBeats must be a non-negative finite number' };
      }
    }

    if (command.kind === 'plugin.bypass') {
      if (typeof params.bypassed !== 'boolean') {
        return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'plugin.bypass requires boolean params.bypassed' };
      }
    }

    if (command.kind === 'plugin.param_write') {
      if (
        typeof params.valueNormalized !== 'number' ||
        !Number.isFinite(params.valueNormalized) ||
        params.valueNormalized < 0 ||
        params.valueNormalized > 1
      ) {
        return {
          ok: false,
          code: 'DAW_SAFETY_VIOLATION',
          reason: 'plugin.param_write requires finite valueNormalized inside [0.0, 1.0]',
        };
      }
      if (
        params.paramIndex !== undefined &&
        (typeof params.paramIndex !== 'number' || !Number.isInteger(params.paramIndex) || params.paramIndex < 0)
      ) {
        return { ok: false, code: 'DAW_INVALID_COMMAND', reason: 'paramIndex must be a non-negative integer' };
      }
    }

    if (command.expectedBeforeDigest && snapshot && command.expectedBeforeDigest !== snapshot.stateDigest) {
      return {
        ok: false,
        code: 'DAW_TARGET_DRIFT',
        reason: `Target snapshot drifted since prepare (expected "${command.expectedBeforeDigest}", current "${snapshot.stateDigest}")`,
      };
    }

    return { ok: true };
  }

  classifyCommand(
    command: DawCommand,
    capability: DawCapability | null,
    snapshot?: DawStateSnapshot | null,
  ): DawCommandRiskAssessment {
    const masterTarget = isTargetMaster(command.targetRef, snapshot);

    if (!capability || capability.supportLevel === 'UNSUPPORTED') {
      return {
        commandClass: 'unsupported',
        riskLevel: 'high',
        rollbackSupported: false,
        rollbackStrategy: 'none',
        approvalRequirement: 'human_strong',
        isMasterTarget: masterTarget,
        warnings: [
          `Capability "${command.capabilityId}" is unsupported by the target DAW adapter.`,
        ],
      };
    }

    if (command.kind === 'session.observe' || capability.requiredTier === 'observe' || capability.requiredTier === 'analyze') {
      return {
        commandClass: 'read_only',
        riskLevel: 'none',
        rollbackSupported: false,
        rollbackStrategy: 'none',
        approvalRequirement: 'none',
        isMasterTarget: masterTarget,
        warnings: [],
      };
    }

    if (capability.supportLevel === 'READ_ONLY') {
      return {
        commandClass: 'unsupported',
        riskLevel: 'high',
        rollbackSupported: false,
        rollbackStrategy: 'none',
        approvalRequirement: 'human_strong',
        isMasterTarget: masterTarget,
        warnings: [`Capability "${command.capabilityId}" is READ_ONLY and cannot accept mutating commands.`],
      };
    }

    // Irreversible command classes (deletion, plugin unload, destructive audio processing, publication)
    if (ALWAYS_PROHIBITED_COMMAND_KINDS.has(command.kind)) {
      return {
        commandClass: 'irreversible',
        riskLevel: 'critical',
        rollbackSupported: false,
        rollbackStrategy: 'none',
        approvalRequirement: 'human_strong',
        isMasterTarget: masterTarget,
        warnings: [
          `IRREVERSIBLE_OPERATION: "${command.kind}" cannot be reliably undone by DAW Brain and is disallowed under safe execution policy.`,
        ],
      };
    }

    // Potentially destructive operations:
    // - Master bus edits or mute/solo changes
    // - Arming transport record
    // - Routing writes, project save, master render, or any operation where adapter cannot guarantee rollback
    const genuinelyRollbackable =
      capability.rollbackSupported && !NON_ROLLBACKABLE_KINDS.has(command.kind);

    const warnings: string[] = [];
    const isDestructiveRisk =
      command.kind === 'mixer.routing_write' ||
      command.kind === 'project.save' ||
      command.kind === 'render.master' ||
      (command.kind === 'transport.control' && command.params.recording === true) ||
      (command.kind === 'mixer.volume_pan_mute' && masterTarget) ||
      !genuinelyRollbackable;

    if (!genuinelyRollbackable) {
      warnings.push(
        `NO_RELIABLE_ROLLBACK: "${command.capabilityId}" lacks reliable DAW rollback; stronger human approval and pre-action snapshot review required.`,
      );
    }
    if (masterTarget && command.kind === 'mixer.volume_pan_mute') {
      warnings.push('MASTER_BUS_TARGET: Command targets Master Bus; loudness/headroom impact verified and strong approval required.');
    }
    if (command.kind === 'transport.control' && command.params.recording === true) {
      warnings.push('TRANSPORT_RECORD_ARM: Live recording capture may overwrite audio/takes without undo.');
    }

    if (isDestructiveRisk) {
      return {
        commandClass: 'potentially_destructive',
        riskLevel: genuinelyRollbackable ? 'medium' : 'high',
        rollbackSupported: genuinelyRollbackable,
        rollbackStrategy: genuinelyRollbackable ? 'exact_before_state' : 'none',
        approvalRequirement: 'human_strong',
        isMasterTarget: masterTarget,
        warnings,
      };
    }

    return {
      commandClass: 'reversible',
      riskLevel: 'low',
      rollbackSupported: true,
      rollbackStrategy: 'exact_before_state',
      approvalRequirement: 'human_standard',
      isMasterTarget: masterTarget,
      warnings,
    };
  }

  checkAllowlistPolicy(
    command: DawCommand,
    assessment: DawCommandRiskAssessment,
  ): DawValidationVerdict {
    if (assessment.commandClass === 'unsupported') {
      return {
        ok: false,
        code: 'DAW_CAPABILITY_UNSUPPORTED',
        reason: assessment.warnings[0] ?? `Capability "${command.capabilityId}" is unsupported`,
      };
    }

    if (assessment.commandClass === 'read_only') {
      const readAllowed = this.config.readOnlyCapabilities ?? [];
      if (!readAllowed.includes(command.capabilityId)) {
        return {
          ok: false,
          code: 'DAW_ACTION_NOT_ALLOWLISTED',
          reason: `Default-deny policy blocked non-allowlisted read capability "${command.capabilityId}"`,
        };
      }
      return { ok: true };
    }

    const isHardProhibited =
      command.kind === 'automation.edit' ||
      command.kind === 'audio.destructive_process' ||
      command.kind === 'distribution.publish' ||
      ((command.kind === 'track.create_delete' || command.kind === 'plugin.load_remove') &&
        (!this.config.allowStructuralOps || command.params.action === 'delete' || command.params.action === 'remove'));

    if (assessment.commandClass === 'irreversible' && isHardProhibited) {
      return {
        ok: false,
        code: 'DAW_ACTION_NOT_ALLOWLISTED',
        reason: `Irreversible / prohibited DAW operation "${command.kind}" (${command.capabilityId}) is denied under safe execution policy`,
      };
    }

    if (!this.config.permittedCapabilities.includes(command.capabilityId)) {
      return {
        ok: false,
        code: 'DAW_ACTION_NOT_ALLOWLISTED',
        reason: `Default-deny policy rejected capability "${command.capabilityId}" (not in permitted initial allowlist [${this.config.permittedCapabilities.join(', ')}])`,
      };
    }

    if (command.kind === 'transport.control' && command.params.recording === true && !this.config.allowTransportRecording) {
      return {
        ok: false,
        code: 'DAW_ACTION_NOT_ALLOWLISTED',
        reason: 'Transport recording capture ("params.recording = true") is disabled under initial low-risk policy',
      };
    }

    if (assessment.isMasterTarget && command.kind === 'mixer.volume_pan_mute' && !this.config.allowMasterBusMutation) {
      return {
        ok: false,
        code: 'DAW_ACTION_NOT_ALLOWLISTED',
        reason: 'Master bus mutation is disabled by active gateway execution policy',
      };
    }

    return { ok: true };
  }
}
