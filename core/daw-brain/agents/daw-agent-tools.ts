import type { Os3ContextEngine } from '../../context-engine/os3-context-engine.ts';
import type { AgentClass } from '../../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../../sqlite/client.ts';
import {
  createOs3BuiltinToolSpecs,
  Os3ToolExecutionError,
  Os3ToolRegistry,
  type Os3ToolSpec,
} from '../../tool-registry/os3-tool-registry.ts';
import type { VaultEngine } from '../../vault-engine/vault-engine.ts';
import type { AudioBrain } from '../audio-brain/audio-brain.ts';
import type { DawCore } from '../daw-core.ts';
import type { PluginBrain } from '../plugin-brain/plugin-brain.ts';
import type { PluginWorkflowKind } from '../plugin-brain/types.ts';
import type { DawSessionIntelligence } from '../session-intelligence/session-intelligence.ts';
import { DawBrainError, type DawCommand, type DawHostKind } from '../types.ts';

export type DawBrainToolDependencies = {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly core?: DawCore | undefined;
  readonly sessionIntelligence?: DawSessionIntelligence | undefined;
  readonly pluginBrain?: PluginBrain | undefined;
  readonly audioBrain?: AudioBrain | undefined;
  readonly contextEngine?: Os3ContextEngine | undefined;
};

const ALL_CLASSES: readonly AgentClass[] = [
  'Research',
  'Knowledge',
  'Planning',
  'Creative',
  'Critic',
  'Revision',
  'Execution',
  'Governance',
];

const EXECUTION_ONLY: readonly AgentClass[] = ['Execution'];

export const DAW_AGENT_TOOL_NAMES = [
  'daw_session_analyze',
  'daw_plugin_brain_query',
  'daw_audio_brain_analyze',
  'daw_context_retrieve',
  'daw_host_compatibility_audit',
  'daw_gateway_dry_run',
  'daw_gateway_prepare',
  'daw_gateway_execute',
  'daw_gateway_rollback',
] as const;

export const createDawBrainRuntimeToolSpecs = (deps: DawBrainToolDependencies): readonly Os3ToolSpec[] => {
  const err = (toolName: string, ctx: { agentName: string; runId: string }, message: string) =>
    new Os3ToolExecutionError({
      code: 'TOOL_EXECUTION_FAILED',
      toolName,
      agentName: ctx.agentName,
      runId: ctx.runId,
      attempts: 1,
      message,
    });

  const requireSession = (sessionId: string | undefined, toolName: string, ctx: { agentName: string; runId: string }) => {
    if (!deps.core) {
      throw err(toolName, ctx, 'DawCore instance not bound to DAW agent runtime tools');
    }
    const sess = sessionId
      ? deps.core.sessions.getSession(sessionId)
      : (deps.core.sessions.listSessions()[0] ?? null);
    if (!sess) {
      throw err(toolName, ctx, sessionId ? `DAW session "${sessionId}" not found` : 'No active DAW session found');
    }
    return sess;
  };

  return [
    {
      id: 'daw-runtime-session_analyze',
      name: 'daw_session_analyze',
      version: 1,
      description: 'Read-only Session Intelligence inspection: structure, track roles, routing graph, consistency, complexity, and snapshot diff.',
      capability: 'context.read',
      allowedClasses: ALL_CLASSES,
      vaultAccess: 'read',
      externalOperation: false,
      inputSchema: {
        properties: {
          sessionId: 'string',
          edition: 'string',
          projectVaultPath: 'string',
          queryHint: 'string',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'report'], properties: { ok: 'boolean', report: 'object' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ALL_CLASSES,
        vaultAccess: 'read',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
      },
      executionPolicy: {
        mode: 'local_pure',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 5_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: false },
      handler: async (ctx, input) => {
        if (!deps.sessionIntelligence) {
          throw err('daw_session_analyze', ctx, 'DawSessionIntelligence not bound');
        }
        const sess = requireSession(
          typeof input.sessionId === 'string' ? input.sessionId : undefined,
          'daw_session_analyze',
          ctx,
        );
        const report = await deps.sessionIntelligence.analyzeSession(sess, {
          edition: typeof input.edition === 'string' ? input.edition : undefined,
          projectVaultPath: typeof input.projectVaultPath === 'string' ? input.projectVaultPath : undefined,
          queryHint: typeof input.queryHint === 'string' ? input.queryHint : undefined,
          contextEngine: deps.contextEngine,
          actor: ctx.agentName,
        });
        return { ok: true, report };
      },
    },
    {
      id: 'daw-runtime-plugin_brain_query',
      name: 'daw_plugin_brain_query',
      version: 1,
      description: 'Query PluginBrain: ingest live snapshot plugins, audit compatibility, compare plugins, analyze actual chains, or suggest ordered recipes.',
      capability: 'context.read',
      allowedClasses: ALL_CLASSES,
      vaultAccess: 'read',
      externalOperation: false,
      inputSchema: {
        required: ['operation'],
        properties: {
          operation: { type: 'string', enum: ['recommend_role', 'suggest_chain', 'analyze_actual_chains', 'check_compat', 'compare'] },
          sessionId: 'string',
          role: 'string',
          workflowKind: 'string',
          pluginA: 'string',
          pluginB: 'string',
          hostKind: 'string',
          hostEdition: 'string',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok'], properties: { ok: 'boolean' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ALL_CLASSES,
        vaultAccess: 'read',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
      },
      executionPolicy: {
        mode: 'local_pure',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 4_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: false },
      handler: async (ctx, input) => {
        if (!deps.pluginBrain) throw err('daw_plugin_brain_query', ctx, 'PluginBrain not bound');
        const op = String(input.operation);
        const sess = deps.core?.sessions.listSessions()[0] ?? null;
        if (sess?.observed) {
          deps.pluginBrain.ingestDawSnapshot(
            sess.observed,
            (typeof input.hostKind === 'string' ? input.hostKind : 'fl_studio') as DawHostKind,
            typeof input.hostEdition === 'string' ? input.hostEdition : sess.project.editionRequirement ?? 'Producer Edition',
          );
        }
        if (deps.db?.isOpen) {
          deps.db.appendEvent({
            eventType: 'daw.plugin.analyzed',
            domain: 'TECH',
            actor: ctx.agentName,
            targetPath: sess ? `daw://session/${sess.sessionId}` : null,
            payload: { operation: op, pluginA: input.pluginA ?? null, pluginB: input.pluginB ?? null },
          });
        }

        if (op === 'analyze_actual_chains') {
          const targetSess = requireSession(
            typeof input.sessionId === 'string' ? input.sessionId : undefined,
            'daw_plugin_brain_query',
            ctx,
          );
          const snap = targetSess.observed ?? targetSess.cached;
          if (!snap) return { ok: true, chains: [], analyses: [] };
          const hostKind = (typeof input.hostKind === 'string' ? input.hostKind : 'fl_studio') as DawHostKind;
          const hostEdition = typeof input.hostEdition === 'string' ? input.hostEdition : 'Producer Edition';
          const chains = deps.pluginBrain.extractActualChains(snap, { hostKind, hostEdition });
          return { ok: true, chains, analyses: chains.map((c) => deps.pluginBrain!.analyzeChain(c)) };
        }
        if (op === 'check_compat') {
          const name = String(input.pluginA ?? '');
          return {
            ok: true,
            compatibility: deps.pluginBrain.checkCompatibility(name, {
              hostKind: (typeof input.hostKind === 'string' ? input.hostKind : undefined) as DawHostKind | undefined,
              hostEdition: typeof input.hostEdition === 'string' ? input.hostEdition : undefined,
            }),
          };
        }
        if (op === 'compare') {
          return {
            ok: true,
            comparison: deps.pluginBrain.compare(String(input.pluginA ?? ''), String(input.pluginB ?? '')),
          };
        }
        if (op === 'suggest_chain') {
          const wf = (typeof input.workflowKind === 'string' ? input.workflowKind : 'vocal_chain') as PluginWorkflowKind;
          return {
            ok: true,
            ...deps.pluginBrain.suggestChain({
              workflowKind: wf,
              hostKind: (typeof input.hostKind === 'string' ? input.hostKind : 'fl_studio') as DawHostKind,
              hostEdition: typeof input.hostEdition === 'string' ? input.hostEdition : 'Producer Edition',
            }),
          };
        }
        const recs = deps.pluginBrain.recommendForRole({
          role: (typeof input.role === 'string' ? input.role : 'subtractive_eq') as never,
          hostKind: (typeof input.hostKind === 'string' ? input.hostKind : 'fl_studio') as DawHostKind,
          hostEdition: typeof input.hostEdition === 'string' ? input.hostEdition : 'Producer Edition',
        });
        return { ok: true, recommendations: recs };
      },
    },
    {
      id: 'daw-runtime-audio_brain_analyze',
      name: 'daw_audio_brain_analyze',
      version: 1,
      description: 'Read-only AudioBrain DSP, LUFS, true peak, stereo/phase, rubric check, and probabilistic MIR evaluation on an exported WAV file or external trace.analysis/v1 payload.',
      capability: 'context.read',
      allowedClasses: ALL_CLASSES,
      vaultAccess: 'none',
      externalOperation: false,
      inputSchema: {
        properties: {
          filePath: { type: 'string', maxLength: 512, disallowUnsafePathsOrShell: true },
          traceAnalysis: 'object',
          stage: { type: 'string', enum: ['mix', 'master'] },
          sessionId: 'string',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'report'], properties: { ok: 'boolean', report: 'object' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ALL_CLASSES,
        vaultAccess: 'none',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
      },
      executionPolicy: {
        mode: 'local_pure',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 10_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: false },
      handler: async (ctx, input) => {
        if (!deps.audioBrain) throw err('daw_audio_brain_analyze', ctx, 'AudioBrain not bound');
        const stage = input.stage === 'mix' ? 'mix' : 'master';
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null;
        if (typeof input.filePath === 'string' && input.filePath.trim()) {
          const report = deps.audioBrain.analyzeAudioFile(input.filePath, {
            stage,
            sessionId,
            db: deps.db,
          });
          return { ok: true, report };
        }
        if (input.traceAnalysis && typeof input.traceAnalysis === 'object') {
          const report = deps.audioBrain.analyzeExternalTrace(input.traceAnalysis, {
            stage,
            sessionId,
            db: deps.db,
          });
          return { ok: true, report };
        }
        throw err('daw_audio_brain_analyze', ctx, 'Provide either filePath or traceAnalysis payload (no blind DAW RAM audio tap)');
      },
    },
    {
      id: 'daw-runtime-context_retrieve',
      name: 'daw_context_retrieve',
      version: 1,
      description: 'Retrieve epistemic DAW context bundle from Obsidian Vault + SQLite linking X3LIUS Music records, production knowledge, plugin docs, and strictly human-approved preferences.',
      capability: 'context.read',
      allowedClasses: ALL_CLASSES,
      vaultAccess: 'read',
      externalOperation: false,
      inputSchema: {
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1 },
          sessionId: 'string',
          projectVaultPath: 'string',
          activePlugins: { type: 'array', items: 'string' },
          tokenBudget: 'number',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'contextPackage'], properties: { ok: 'boolean', contextPackage: 'object' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ALL_CLASSES,
        vaultAccess: 'read',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
      },
      executionPolicy: {
        mode: 'vault_scoped',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 4_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: false },
      handler: async (ctx, input) => {
        if (!deps.contextEngine) throw err('daw_context_retrieve', ctx, 'Os3ContextEngine not bound');
        const pkg = await deps.contextEngine.retrieveDawContext({
          query: String(input.query),
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
          projectVaultPath: typeof input.projectVaultPath === 'string' ? input.projectVaultPath : undefined,
          activePlugins: Array.isArray(input.activePlugins) ? input.activePlugins.map(String) : undefined,
          tokenBudget: typeof input.tokenBudget === 'number' ? input.tokenBudget : undefined,
          actor: ctx.agentName,
        });
        return { ok: true, contextPackage: pkg };
      },
    },
    {
      id: 'daw-runtime-host_compatibility_audit',
      name: 'daw_host_compatibility_audit',
      version: 1,
      description: 'Audit DAW host version bounds, adapter capability support/unsupported gaps, and session health without mutating state.',
      capability: 'context.read',
      allowedClasses: ALL_CLASSES,
      vaultAccess: 'none',
      externalOperation: false,
      inputSchema: {
        properties: { sessionId: 'string', adapterId: 'string' },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'adapters'], properties: { ok: 'boolean', adapters: 'array' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ALL_CLASSES,
        vaultAccess: 'none',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
      },
      executionPolicy: {
        mode: 'local_pure',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 3_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: false },
      handler: async (ctx, input) => {
        if (!deps.core) throw err('daw_host_compatibility_audit', ctx, 'DawCore not bound');
        const adapters = deps.core.connections.listAdapters().map((a) => ({
          adapterId: a.manifest.adapterId,
          hostKind: a.manifest.hostKind,
          minSupportedHostVersion: a.manifest.minSupportedHostVersion,
          maxTestedHostVersion: a.manifest.maxTestedHostVersion,
          supportedCaps: a.getCapabilities().filter((c) => c.supportLevel !== 'UNSUPPORTED').map((c) => c.capabilityId),
          unsupportedCaps: a.getCapabilities().filter((c) => c.supportLevel === 'UNSUPPORTED').map((c) => c.capabilityId),
        }));
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
        const session = sessionId
          ? deps.core.sessions.getSession(sessionId)
          : (deps.core.sessions.listSessions()[0] ?? null);
        return {
          ok: true,
          adapters,
          activeSession: session
            ? {
                sessionId: session.sessionId,
                adapterId: session.adapterId,
                hostVersion: session.hostVersion,
                versionCompatibility: session.connection.versionCompatibility,
                status: session.connection.status,
              }
            : null,
        };
      },
    },
    {
      id: 'daw-runtime-gateway_dry_run',
      name: 'daw_gateway_dry_run',
      version: 1,
      description: 'Side-effect-free simulation & risk classification through DawCommandGateway without mutating DAW host state.',
      capability: 'context.read',
      allowedClasses: ['Planning', 'Execution', 'Governance'],
      vaultAccess: 'none',
      externalOperation: false,
      inputSchema: {
        required: ['command'],
        properties: {
          command: 'object',
          leaseId: 'string',
          maxStateAgeMs: 'number',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'dryRun'], properties: { ok: 'boolean', dryRun: 'object' } },
      permissions: {
        capability: 'context.read',
        allowedClasses: ['Planning', 'Execution', 'Governance'],
        vaultAccess: 'none',
        externalOperation: false,
        requiresHumanApproval: false,
        defaultDeny: true,
        dawPermissionTier: 'analyze',
        requiresActiveLease: false,
      },
      executionPolicy: {
        mode: 'external_bounded',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: true,
      },
      timeoutMs: 5_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: true },
      handler: async (ctx, input) => {
        if (!deps.core) throw err('daw_gateway_dry_run', ctx, 'DawCore not bound');
        try {
          const dryRun = await deps.core.dryRunCommand(input.command as DawCommand, {
            leaseId: typeof input.leaseId === 'string' ? input.leaseId : undefined,
            maxStateAgeMs: typeof input.maxStateAgeMs === 'number' ? input.maxStateAgeMs : undefined,
          });
          return { ok: true, dryRun };
        } catch (e) {
          const code = e instanceof DawBrainError ? e.code : 'DAW_ERROR';
          throw err('daw_gateway_dry_run', ctx, `${code}: ${(e as Error).message}`);
        }
      },
    },
    {
      id: 'daw-runtime-gateway_prepare',
      name: 'daw_gateway_prepare',
      version: 1,
      description: 'Execution-only: prepare a bounded DAW command through DawCommandGateway (enforces capabilities, lease, safety clamps & human approval queue).',
      capability: 'external.execute',
      allowedClasses: EXECUTION_ONLY,
      vaultAccess: 'none',
      externalOperation: true,
      inputSchema: {
        required: ['command'],
        properties: {
          command: 'object',
          leaseId: 'string',
          queueApproval: 'boolean',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'prepared'], properties: { ok: 'boolean', prepared: 'object' } },
      permissions: {
        capability: 'external.execute',
        allowedClasses: EXECUTION_ONLY,
        vaultAccess: 'none',
        externalOperation: true,
        requiresHumanApproval: false,
        defaultDeny: true,
        dawPermissionTier: 'prepare',
        requiresActiveLease: true,
      },
      executionPolicy: {
        mode: 'external_bounded',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: false,
      },
      timeoutMs: 5_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: true },
      handler: async (ctx, input) => {
        if (!deps.core) throw err('daw_gateway_prepare', ctx, 'DawCore not bound');
        try {
          const prepared = await deps.core.prepareCommand(input.command as DawCommand, {
            leaseId: typeof input.leaseId === 'string' ? input.leaseId : undefined,
            queueApproval: typeof input.queueApproval === 'boolean' ? input.queueApproval : true,
          });
          return { ok: true, prepared };
        } catch (e) {
          const code = e instanceof DawBrainError ? e.code : 'DAW_ERROR';
          throw err('daw_gateway_prepare', ctx, `${code}: ${(e as Error).message}`);
        }
      },
    },
    {
      id: 'daw-runtime-gateway_execute',
      name: 'daw_gateway_execute',
      version: 1,
      description: 'Execution-only: dispatch a prepared & human-approved DAW command exclusively through DawCommandGateway.',
      capability: 'external.execute',
      allowedClasses: EXECUTION_ONLY,
      vaultAccess: 'none',
      externalOperation: true,
      inputSchema: {
        required: ['prepareId', 'approvalId', 'leaseId'],
        properties: {
          prepareId: { type: 'string', minLength: 1 },
          approvalId: { type: 'string', minLength: 1 },
          leaseId: { type: 'string', minLength: 1 },
          strongApprovalConfirmed: 'boolean',
          timeoutMs: 'number',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'result'], properties: { ok: 'boolean', result: 'object' } },
      permissions: {
        capability: 'external.execute',
        allowedClasses: EXECUTION_ONLY,
        vaultAccess: 'none',
        externalOperation: true,
        requiresHumanApproval: true,
        defaultDeny: true,
        dawPermissionTier: 'execute',
        requiresActiveLease: true,
      },
      executionPolicy: {
        mode: 'external_bounded',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: false,
      },
      timeoutMs: 10_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: true },
      handler: async (ctx, input) => {
        if (!deps.core) throw err('daw_gateway_execute', ctx, 'DawCore not bound');
        const result = await deps.core.executeCommand(String(input.prepareId), {
          actor: ctx.agentName,
          approvalId: String(input.approvalId),
          leaseId: String(input.leaseId),
          strongApprovalConfirmed: typeof input.strongApprovalConfirmed === 'boolean' ? input.strongApprovalConfirmed : undefined,
          timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
        });
        return { ok: result.ok, result };
      },
    },
    {
      id: 'daw-runtime-gateway_rollback',
      name: 'daw_gateway_rollback',
      version: 1,
      description: 'Execution-only: rollback an executed DAW command receipt through DawCommandGateway.',
      capability: 'external.execute',
      allowedClasses: EXECUTION_ONLY,
      vaultAccess: 'none',
      externalOperation: true,
      inputSchema: {
        required: ['receiptId', 'leaseId'],
        properties: {
          receiptId: { type: 'string', minLength: 1 },
          leaseId: { type: 'string', minLength: 1 },
          approvalId: 'string',
        },
        additionalProperties: false,
      },
      outputSchema: { required: ['ok', 'result'], properties: { ok: 'boolean', result: 'object' } },
      permissions: {
        capability: 'external.execute',
        allowedClasses: EXECUTION_ONLY,
        vaultAccess: 'none',
        externalOperation: true,
        requiresHumanApproval: true,
        defaultDeny: true,
        dawPermissionTier: 'rollback',
        requiresActiveLease: true,
      },
      executionPolicy: {
        mode: 'external_bounded',
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: false,
      },
      timeoutMs: 10_000,
      retryPolicy: { maxRetries: 0, backoffMs: 0 },
      auditRequired: true,
      auditPolicy: { required: true, redactSecrets: true, recordInputs: true, recordOutputs: true },
      handler: async (ctx, input) => {
        if (!deps.core) throw err('daw_gateway_rollback', ctx, 'DawCore not bound');
        const result = await deps.core.rollbackCommand(String(input.receiptId), {
          actor: ctx.agentName,
          leaseId: String(input.leaseId),
          approvalId: typeof input.approvalId === 'string' ? input.approvalId : undefined,
        });
        return { ok: result.ok, result };
      },
    },
  ];
};

export const createDawBrainToolRegistry = (deps: DawBrainToolDependencies): Os3ToolRegistry =>
  new Os3ToolRegistry(
    [
      ...createOs3BuiltinToolSpecs({
        vault: deps.vault,
        db: deps.db,
        contextEngine: deps.contextEngine,
      }),
      ...createDawBrainRuntimeToolSpecs(deps),
    ],
    deps.db,
  );
