import type { Os3ContextEngine } from '../context-engine/os3-context-engine.ts';
import type { AgentClass } from '../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import {
  createOs3BuiltinToolSpecs,
  Os3ToolExecutionError,
  Os3ToolRegistry,
  type Os3ToolSpec,
} from './os3-tool-registry.ts';

/**
 * All 9 canonical DAW Brain tool categories specified for Phase 07.
 * These define strict metadata, permission, schema, timeout, retry, and audit contracts ONLY;
 * no live DAW command implementations are registered in Phase 07.
 */
export const DAW_TOOL_CATEGORIES = [
  'daw_observation',
  'session_inspection',
  'track_inspection',
  'routing_inspection',
  'plugin_discovery',
  'parameter_inspection',
  'audio_analysis',
  'daw_command_execution',
  'project_validation',
] as const;

export type DawToolCategory = (typeof DAW_TOOL_CATEGORIES)[number];

export type DawPermissionTier =
  | 'observe'
  | 'analyze'
  | 'propose'
  | 'prepare'
  | 'execute'
  | 'approve'
  | 'rollback';

export type DawHostSupport = 'SUPPORTED' | 'TEMPLATE_SCOPED' | 'READ_ONLY' | 'UNSUPPORTED';

export type DawToolContractSpec = Os3ToolSpec & {
  readonly category: DawToolCategory;
  readonly dawPermissionTier: DawPermissionTier;
  readonly requiresHumanApproval: boolean;
  readonly requiresActiveLease: boolean;
  readonly hostSupport: Readonly<{
    readonly flStudio2025: DawHostSupport;
    readonly reaper: DawHostSupport;
  }>;
  readonly rollbackSupported: boolean;
};

const READ_CLASSES: readonly AgentClass[] = [
  'Research',
  'Knowledge',
  'Planning',
  'Creative',
  'Critic',
  'Revision',
  'Execution',
  'Governance',
];

const contractOnlyHandler =
  (toolName: string, category: DawToolCategory): Os3ToolSpec['handler'] =>
  async (ctx) => {
    throw new Os3ToolExecutionError({
      code: 'NOT_IMPLEMENTED',
      toolName,
      agentName: ctx.agentName,
      runId: ctx.runId,
      attempts: 0,
      message: `DAW tool contract "${toolName}" (${category}) is contract-only in Phase 07; execution is intentionally unimplemented.`,
    });
  };

const makeContract = (
  input: Omit<
    DawToolContractSpec,
    'version' | 'permissions' | 'executionPolicy' | 'auditRequired' | 'auditPolicy' | 'handler'
  > & {
    readonly idempotent: boolean;
  },
): DawToolContractSpec => {
  const { idempotent, ...rest } = input;
  return {
    ...rest,
    version: 1,
    permissions: {
      capability: rest.capability,
      allowedClasses: rest.allowedClasses,
      vaultAccess: rest.vaultAccess,
      externalOperation: rest.externalOperation,
      requiresHumanApproval: rest.requiresHumanApproval,
      defaultDeny: true,
      dawPermissionTier: rest.dawPermissionTier,
      requiresActiveLease: rest.requiresActiveLease,
    },
    executionPolicy: {
      mode: 'contract_only',
      implemented: false,
      allowShell: false,
      allowUnrestrictedFs: false,
      allowDirectDaw: false,
      idempotent,
    },
    auditRequired: true,
    auditPolicy: {
      required: true,
      redactSecrets: true,
      recordInputs: true,
      recordOutputs: true,
    },
    handler: contractOnlyHandler(rest.name, rest.category),
  };
};

/**
 * Complete catalog of Phase 07 future DAW tool contracts covering all 9 mandatory categories.
 * Zero DAW commands execute in Phase 07 (`executionPolicy.mode = 'contract_only'`, `implemented: false`).
 */
export const DAW_TOOL_CONTRACTS: readonly DawToolContractSpec[] = [
  // 1. DAW observation
  makeContract({
    id: 'daw-tool-daw_observe_health',
    name: 'daw_observe_health',
    category: 'daw_observation',
    capability: 'context.read',
    description: 'Contract: probe DAW adapter connectivity, host edition, and SysEx/OSC heartbeat read-only.',
    inputSchema: {
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        adapterId: 'string',
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'reachable', 'hostVersion', 'observedAt'],
      properties: {
        ok: 'boolean',
        reachable: 'boolean',
        hostVersion: 'string',
        observedAt: 'string',
      },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'none',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 2_500,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),
  makeContract({
    id: 'daw-tool-daw_observe_transport',
    name: 'daw_observe_transport',
    category: 'daw_observation',
    capability: 'context.read',
    description: 'Contract: read ephemeral transport state (playing/stopped/recording, BPM, time signature, song position).',
    inputSchema: {
      required: ['sessionId'],
      properties: { sessionId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'stateTier', 'playing', 'bpm', 'observedAt'],
      properties: {
        ok: 'boolean',
        stateTier: { type: 'string', enum: ['liveObserved', 'cached'] },
        playing: 'boolean',
        bpm: { type: 'number', minimum: 10, maximum: 500 },
        observedAt: 'string',
      },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'none',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 2_500,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 2. Session inspection
  makeContract({
    id: 'daw-tool-daw_inspect_session_state',
    name: 'daw_inspect_session_state',
    category: 'session_inspection',
    capability: 'context.read',
    description: 'Contract: compare liveObserved vs cached vs savedProject state tiers and report unsaved divergence.',
    inputSchema: {
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        includePendingProposals: 'boolean',
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'sessionId', 'hasUnsavedLiveChanges', 'savedSha256'],
      properties: {
        ok: 'boolean',
        sessionId: 'string',
        hasUnsavedLiveChanges: 'boolean',
        savedSha256: 'string',
      },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'read',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 3. Track inspection
  makeContract({
    id: 'daw-tool-daw_inspect_mixer_tracks',
    name: 'daw_inspect_mixer_tracks',
    category: 'track_inspection',
    capability: 'context.read',
    description: 'Contract: inspect canonical track/mixer inserts, normalized gain/pan, mute/solo state, and meter telemetry.',
    inputSchema: {
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        trackRangeStart: { type: 'number', minimum: 0, maximum: 512 },
        trackRangeEnd: { type: 'number', minimum: 0, maximum: 512 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'tracks'],
      properties: { ok: 'boolean', tracks: 'array' },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'none',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 4. Routing inspection
  makeContract({
    id: 'daw-tool-daw_inspect_routing_graph',
    name: 'daw_inspect_routing_graph',
    category: 'routing_inspection',
    capability: 'context.read',
    description: 'Contract: inspect mixer bus send topology, sidechain assignments, and master output routing graph.',
    inputSchema: {
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        sourceTrackRef: 'string',
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'nodes', 'edges'],
      properties: { ok: 'boolean', nodes: 'array', edges: 'array' },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'none',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 5. Plugin discovery
  makeContract({
    id: 'daw-tool-daw_discover_plugins',
    name: 'daw_discover_plugins',
    category: 'plugin_discovery',
    capability: 'context.read',
    description: 'Contract: inspect loaded FX/generator slots and cross-check FL Studio edition/VST3 availability.',
    inputSchema: {
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        includeSystemVst3Inventory: 'boolean',
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'loadedSlots', 'editionWarnings'],
      properties: { ok: 'boolean', loadedSlots: 'array', editionWarnings: 'array' },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'read',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 7_500,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 6. Parameter inspection
  makeContract({
    id: 'daw-tool-daw_inspect_plugin_parameters',
    name: 'daw_inspect_plugin_parameters',
    category: 'parameter_inspection',
    capability: 'context.read',
    description: 'Contract: read normalized [0..1] plugin parameters and host labels for an addressed track/slot.',
    inputSchema: {
      required: ['sessionId', 'targetRef'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        targetRef: { type: 'string', minLength: 1 },
        parameterIndexes: { type: 'array', items: 'number' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'targetRef', 'parameters'],
      properties: { ok: 'boolean', targetRef: 'string', parameters: 'array' },
    },
    allowedClasses: READ_CLASSES,
    vaultAccess: 'none',
    externalOperation: false,
    dawPermissionTier: 'observe',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),

  // 7. Audio analysis
  makeContract({
    id: 'daw-tool-daw_analyze_audio_buffer',
    name: 'daw_analyze_audio_buffer',
    category: 'audio_analysis',
    capability: 'vault.read',
    description: 'Contract: compute non-mutating TRACE loudness (LUFS), true-peak (dBTP), stereo correlation, and spectral diagnostics.',
    inputSchema: {
      required: ['sourcePath'],
      properties: {
        sessionId: 'string',
        sourcePath: { type: 'string', minLength: 1, disallowUnsafePathsOrShell: true },
        profile: { type: 'string', enum: ['mix', 'master', 'stem'] },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'integratedLufs', 'truePeakDbtp', 'sourceSha256'],
      properties: {
        ok: 'boolean',
        integratedLufs: { type: 'number', minimum: -120, maximum: 6 },
        truePeakDbtp: { type: 'number', minimum: -120, maximum: 24 },
        sourceSha256: 'string',
      },
    },
    allowedClasses: ['Knowledge', 'Creative', 'Execution'],
    vaultAccess: 'read',
    externalOperation: false,
    dawPermissionTier: 'analyze',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 15_000,
    retryPolicy: { maxRetries: 1, backoffMs: 100 },
  }),

  // 8. DAW command execution (prepare, execute, rollback — Execution class ONLY + lease + approval)
  makeContract({
    id: 'daw-tool-daw_prepare_command_patch',
    name: 'daw_prepare_command_patch',
    category: 'daw_command_execution',
    capability: 'external.execute',
    description: 'Contract: validate target slot IDs, enforce delta safety clamps, capture beforeState, and stage a PreparedDawPatch without execution.',
    inputSchema: {
      required: ['sessionId', 'capabilityId', 'targetRef', 'command'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        capabilityId: { type: 'string', minLength: 1 },
        targetRef: { type: 'string', minLength: 1 },
        command: 'object',
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'preparedPatchId', 'beforeState', 'requiresHumanApproval'],
      properties: {
        ok: 'boolean',
        preparedPatchId: 'string',
        beforeState: 'object',
        requiresHumanApproval: 'boolean',
      },
    },
    allowedClasses: ['Execution'],
    vaultAccess: 'none',
    externalOperation: true,
    dawPermissionTier: 'prepare',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 0, backoffMs: 0 },
  }),
  makeContract({
    id: 'daw-tool-daw_execute_command_patch',
    name: 'daw_execute_command_patch',
    category: 'daw_command_execution',
    capability: 'external.execute',
    description: 'Contract: transmit an approved, bounded PreparedDawPatch under an active TTL lease and verify afterState readback.',
    inputSchema: {
      required: ['sessionId', 'preparedPatchId', 'approvalId', 'leaseId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        preparedPatchId: { type: 'string', minLength: 1 },
        approvalId: { type: 'string', minLength: 1 },
        leaseId: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'journalReceiptId', 'applied', 'afterState'],
      properties: {
        ok: 'boolean',
        journalReceiptId: 'string',
        applied: 'boolean',
        afterState: 'object',
      },
    },
    allowedClasses: ['Execution'],
    vaultAccess: 'none',
    externalOperation: true,
    dawPermissionTier: 'execute',
    requiresHumanApproval: true,
    requiresActiveLease: true,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: true,
    idempotent: false,
    timeoutMs: 10_000,
    retryPolicy: { maxRetries: 0, backoffMs: 0 },
  }),
  makeContract({
    id: 'daw-tool-daw_rollback_command_patch',
    name: 'daw_rollback_command_patch',
    category: 'daw_command_execution',
    capability: 'external.execute',
    description: 'Contract: restore captured beforeState values from an immutable daw_command_journal receipt.',
    inputSchema: {
      required: ['sessionId', 'journalReceiptId', 'approvalId'],
      properties: {
        sessionId: { type: 'string', minLength: 1 },
        journalReceiptId: { type: 'string', minLength: 1 },
        approvalId: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'rolledBack', 'restoredState'],
      properties: {
        ok: 'boolean',
        rolledBack: 'boolean',
        restoredState: 'object',
      },
    },
    allowedClasses: ['Execution'],
    vaultAccess: 'none',
    externalOperation: true,
    dawPermissionTier: 'rollback',
    requiresHumanApproval: true,
    requiresActiveLease: true,
    hostSupport: { flStudio2025: 'SUPPORTED', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: false,
    timeoutMs: 10_000,
    retryPolicy: { maxRetries: 0, backoffMs: 0 },
  }),

  // 9. Project validation
  makeContract({
    id: 'daw-tool-daw_validate_project_file',
    name: 'daw_validate_project_file',
    category: 'project_validation',
    capability: 'vault.read',
    description: 'Contract: parse saved project file (.flp read-only / .rpp text) to verify checksum, edition compatibility, and routing invariants.',
    inputSchema: {
      required: ['projectPath'],
      properties: {
        projectPath: { type: 'string', minLength: 1, disallowUnsafePathsOrShell: true },
        targetEdition: { type: 'string', enum: ['Producer Edition', 'Signature Bundle', 'All Plugins Edition', 'REAPER'] },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok', 'valid', 'savedSha256', 'issues'],
      properties: {
        ok: 'boolean',
        valid: 'boolean',
        savedSha256: 'string',
        issues: 'array',
      },
    },
    allowedClasses: ['Knowledge', 'Creative', 'Execution'],
    vaultAccess: 'read',
    externalOperation: false,
    dawPermissionTier: 'analyze',
    requiresHumanApproval: false,
    requiresActiveLease: false,
    hostSupport: { flStudio2025: 'READ_ONLY', reaper: 'SUPPORTED' },
    rollbackSupported: false,
    idempotent: true,
    timeoutMs: 10_000,
    retryPolicy: { maxRetries: 1, backoffMs: 50 },
  }),
];

/**
 * Validates that all 9 DAW tool categories are represented with explicit non-implemented contracts
 * and zero unrestricted shell/filesystem/DAW policies.
 */
export const validateDawToolContractCoverage = (
  specs: readonly DawToolContractSpec[] = DAW_TOOL_CONTRACTS,
): {
  readonly ok: boolean;
  readonly coveredCategories: readonly DawToolCategory[];
  readonly missingCategories: readonly DawToolCategory[];
  readonly violations: readonly string[];
} => {
  const present = new Set<DawToolCategory>(specs.map((s) => s.category));
  const missingCategories = DAW_TOOL_CATEGORIES.filter((cat) => !present.has(cat));
  const violations: string[] = [];

  for (const spec of specs) {
    if (!spec.executionPolicy || spec.executionPolicy.implemented || spec.executionPolicy.mode !== 'contract_only') {
      violations.push(`${spec.name}: must remain contract_only (implemented: false) in Phase 07`);
    }
    if (
      spec.executionPolicy?.allowShell ||
      spec.executionPolicy?.allowUnrestrictedFs ||
      spec.executionPolicy?.allowDirectDaw
    ) {
      violations.push(`${spec.name}: unrestricted shell/FS/DAW flag must be false`);
    }
    if (!spec.auditRequired) {
      violations.push(`${spec.name}: auditRequired must be true`);
    }
  }

  return {
    ok: missingCategories.length === 0 && violations.length === 0,
    coveredCategories: [...present],
    missingCategories,
    violations,
  };
};

/**
 * Creates an `Os3ToolRegistry` seeded with both the 39 active canonical tools AND
 * all 12 Phase 07 contract-only DAW tool definitions across the 9 DAW tool categories.
 */
export const createOs3ToolRegistryWithDawContracts = (options: {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly contextEngine?: Os3ContextEngine | undefined;
}): Os3ToolRegistry =>
  new Os3ToolRegistry([...createOs3BuiltinToolSpecs(options), ...DAW_TOOL_CONTRACTS], options.db);
