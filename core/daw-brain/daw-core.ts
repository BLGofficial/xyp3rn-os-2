import { randomUUID } from 'node:crypto';
import type {
  DawBrainDelegate,
  DawDelegationAction,
  DawDelegationEvidence,
  DawDelegationRequest,
  DawDelegationResult,
} from '../orchestrator/daw-delegation-contract.ts';
import { resolveActionContract } from '../orchestrator/daw-delegation-contract.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { DawCommandPolicyConfig } from './command-policy.ts';
import type { DawAdapter, DawHealthReport } from './daw-adapter-sdk.ts';
import { DawCapabilityRegistry } from './daw-capability-registry.ts';
import { DawConnectionManager } from './daw-connection-manager.ts';
import {
  DawCommandGateway,
  type DawCommandExecuteOptions,
  type DawCommandPrepareOptions,
  type PreparedDawCommand,
} from './daw-command-gateway.ts';
import { DawEventBus } from './daw-event-bus.ts';
import { DawHealthMonitor } from './daw-health-monitor.ts';
import { DawSessionModel } from './daw-session-model.ts';
import { DawStateObserver } from './daw-state-observer.ts';
import { DawVersionManager } from './daw-version-manager.ts';
import {
  DawBrainError,
  type DawCommand,
  type DawCommandResult,
  type DawDryRunResult,
  type DawExecutionReceipt,
  type DawInstance,
  type DawProject,
  type DawSession,
  type DawStateSnapshot,
} from './types.ts';

/**
 * Top-level vendor-agnostic Universal DAW Brain coordinator (`Phase 10`).
 * Composes connection lifecycle, version checks, capability enforcement,
 * 7-state session modeling, read-only observation, health monitoring, event telemetry,
 * and command gating, while implementing Phase 08 `DawBrainDelegate` for JARVIS.
 */
export class DawCore implements DawBrainDelegate {
  readonly delegateName = 'os3-universal-daw-core';
  readonly #events: DawEventBus;
  readonly #versions: DawVersionManager;
  readonly #capabilities: DawCapabilityRegistry;
  readonly #sessions: DawSessionModel;
  readonly #connections: DawConnectionManager;
  readonly #health: DawHealthMonitor;
  readonly #observer: DawStateObserver;
  readonly #gateway: DawCommandGateway;

  constructor(options: {
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly coalesceEventsMs?: number | undefined;
    readonly staleThresholdMs?: number | undefined;
    readonly maxConsecutiveHealthFailures?: number | undefined;
    readonly executionPolicy?: Partial<DawCommandPolicyConfig> | undefined;
  } = {}) {
    const db = options.db ?? null;
    this.#events = new DawEventBus({
      db,
      coalesceWindowMs: options.coalesceEventsMs,
    });
    this.#versions = new DawVersionManager();
    this.#capabilities = new DawCapabilityRegistry({ db, events: this.#events });
    this.#sessions = new DawSessionModel({
      db,
      events: this.#events,
      staleThresholdMs: options.staleThresholdMs,
    });
    this.#connections = new DawConnectionManager({
      capabilities: this.#capabilities,
      versions: this.#versions,
      sessions: this.#sessions,
      events: this.#events,
    });
    this.#health = new DawHealthMonitor({
      connections: this.#connections,
      sessions: this.#sessions,
      events: this.#events,
      maxConsecutiveFailures: options.maxConsecutiveHealthFailures,
    });
    this.#observer = new DawStateObserver({
      connections: this.#connections,
      sessions: this.#sessions,
    });
    this.#gateway = new DawCommandGateway({
      connections: this.#connections,
      capabilities: this.#capabilities,
      sessions: this.#sessions,
      events: this.#events,
      db,
      executionPolicy: options.executionPolicy,
    });
  }

  get events(): DawEventBus {
    return this.#events;
  }

  get versions(): DawVersionManager {
    return this.#versions;
  }

  get capabilities(): DawCapabilityRegistry {
    return this.#capabilities;
  }

  get sessions(): DawSessionModel {
    return this.#sessions;
  }

  get connections(): DawConnectionManager {
    return this.#connections;
  }

  get health(): DawHealthMonitor {
    return this.#health;
  }

  get observer(): DawStateObserver {
    return this.#observer;
  }

  get gateway(): DawCommandGateway {
    return this.#gateway;
  }

  registerAdapter(adapter: DawAdapter): void {
    this.#connections.registerAdapter(adapter);
  }

  async discoverInstances(): Promise<readonly DawInstance[]> {
    return this.#connections.discoverAll();
  }

  async connectSession(
    adapterId: string,
    options?: { readonly instanceId?: string | undefined; readonly projectPath?: string | undefined; readonly actor?: string | undefined },
  ): Promise<DawSession> {
    return this.#connections.connect(adapterId, options);
  }

  async disconnectSession(sessionId: string, actor?: string): Promise<DawSession> {
    this.#observer.stopObserving(sessionId);
    this.#health.stopMonitoring(sessionId);
    return this.#connections.disconnect(sessionId, actor);
  }

  async refreshSession(sessionId: string): Promise<DawStateSnapshot | null> {
    return this.#observer.pollOnce(sessionId);
  }

  async checkHealth(sessionId: string): Promise<DawHealthReport> {
    return this.#health.checkNow(sessionId);
  }

  setSavedProject(sessionId: string, savedProject: DawProject): DawSession {
    return this.#sessions.setSavedProject(sessionId, savedProject);
  }

  grantSessionLease(input: Parameters<DawCapabilityRegistry['grantLease']>[0]) {
    const lease = this.#capabilities.grantLease(input);
    const sess = this.#sessions.getSession(input.sessionId);
    if (sess && (input.maxPermission === 'prepare' || input.maxPermission === 'execute' || input.maxPermission === 'rollback')) {
      this.#connections.transitionConnection(input.sessionId, {
        status: 'leased_mutable',
        activePermissionTier: input.maxPermission,
      });
    }
    return lease;
  }

  revokeSessionLease(leaseId: string, sessionId: string | null, actor?: string): boolean {
    const ok = this.#capabilities.revokeLease(leaseId, sessionId, actor);
    if (ok && sessionId) {
      const stillActive = this.#capabilities.getActiveLease(sessionId);
      if (!stillActive) {
        this.#connections.transitionConnection(sessionId, {
          status: 'connected_read_only',
          activePermissionTier: 'observe',
        });
      }
    }
    return ok;
  }

  async dryRunCommand(
    command: DawCommand,
    options?: Pick<DawCommandPrepareOptions, 'leaseId' | 'maxStateAgeMs' | 'signal'>,
  ): Promise<DawDryRunResult> {
    return this.#gateway.dryRun(command, options);
  }

  classifyCommand(command: DawCommand) {
    return this.#gateway.classify(command);
  }

  cancelCommand(prepareId: string, actor: string, reason?: string): boolean {
    return this.#gateway.cancelPrepared(prepareId, actor, reason);
  }

  getCommandReceipt(receiptId: string): DawExecutionReceipt | null {
    return this.#gateway.getReceipt(receiptId);
  }

  listCommandReceipts(sessionId?: string): readonly DawExecutionReceipt[] {
    return this.#gateway.listReceipts(sessionId);
  }

  async prepareCommand(
    command: DawCommand,
    options?: DawCommandPrepareOptions,
  ): Promise<PreparedDawCommand> {
    return this.#gateway.prepare(command, options);
  }

  async executeCommand(
    commandOrPrepareId: DawCommand | string,
    options: DawCommandExecuteOptions,
  ): Promise<DawCommandResult> {
    return this.#gateway.execute(commandOrPrepareId, options);
  }

  async rollbackCommand(
    receiptId: string,
    options: { readonly actor: string; readonly approvalId?: string | undefined; readonly leaseId?: string | undefined },
  ): Promise<DawCommandResult> {
    return this.#gateway.rollback(receiptId, options);
  }

  dispose(): void {
    this.#observer.disposeAll();
    this.#health.disposeAll();
  }

  // ─── Phase 08 DawBrainDelegate Bridge for JARVIS Core ──────────────────────

  async executeDelegation(req: DawDelegationRequest): Promise<DawDelegationResult> {
    const { mapping } = resolveActionContract(req.action);
    const targetSession = req.sessionId
      ? this.#sessions.getSession(req.sessionId)
      : (this.#sessions.listSessions()[0] ?? null);

    if (!targetSession) {
      return {
        ok: false,
        correlationId: req.correlationId,
        action: req.action,
        sessionId: req.sessionId ?? null,
        executionStatus: 'failed',
        stateTier: 'none',
        capabilityInfo: {
          capabilityId: mapping.capabilityId,
          dawToolContract: mapping.contractName,
          requiredTier: mapping.tier,
          hostAdapterId: null,
          hostVersion: null,
          supportStatus: 'UNSUPPORTED',
          reason: 'No active DAW session connected in DawCore',
        },
        result: null,
        evidence: [],
        error: { code: 'DAW_SESSION_NOT_FOUND', message: 'No active DAW session found in DawCore' },
      };
    }

    const capId =
      typeof req.payload.capabilityId === 'string' && req.payload.capabilityId.trim()
        ? req.payload.capabilityId.trim()
        : mapping.capabilityId;
    const capCheck = this.#capabilities.checkCapability({
      adapterId: targetSession.adapterId,
      sessionId: targetSession.sessionId,
      capabilityId: capId,
      requestedTier: mapping.tier,
      targetRef: typeof req.payload.targetRef === 'string' ? req.payload.targetRef : undefined,
      actor: req.actor,
      actorClass: req.actorClass,
      leaseId: req.leaseId,
      allowMutationsByVersion: targetSession.connection.versionCompatibility === 'compatible',
    });

    if (!capCheck.allowed) {
      const isUnsupported = capCheck.code === 'DAW_CAPABILITY_UNSUPPORTED';
      return {
        ok: false,
        correlationId: req.correlationId,
        action: req.action,
        sessionId: targetSession.sessionId,
        executionStatus: isUnsupported ? 'unsupported' : 'denied',
        stateTier: 'none',
        capabilityInfo: {
          capabilityId: capId,
          dawToolContract: mapping.contractName,
          requiredTier: mapping.tier,
          hostAdapterId: targetSession.adapterId,
          hostVersion: targetSession.hostVersion,
          supportStatus: isUnsupported ? 'UNSUPPORTED' : 'SUPPORTED',
          reason: capCheck.reason,
        },
        result: null,
        evidence: [
          {
            kind: 'policy_check',
            refId: `cap:${targetSession.sessionId}:${capId}`,
            summary: capCheck.reason,
            timestamp: new Date().toISOString(),
          },
        ],
        error: { code: capCheck.code, message: capCheck.reason },
      };
    }

    const cap = capCheck.capability;

    // Read-only / inspection delegation paths
    const readActions = new Set<DawDelegationAction>([
      'observe',
      'inspect_session',
      'inspect_tracks',
      'inspect_routing',
      'discover_plugins',
      'inspect_parameters',
    ]);

    if (readActions.has(req.action)) {
      const snap = await this.refreshSession(targetSession.sessionId);
      const updated = this.#sessions.requireSession(targetSession.sessionId);
      const useSnap = updated.observed ?? updated.cached ?? snap;
      const isLive = updated.observed !== null && !updated.stale;

      const slice =
        !useSnap
          ? null
          : req.action === 'observe'
            ? { transport: useSnap.transport, freshness: updated.stateFreshness }
            : req.action === 'inspect_session'
              ? {
                  stateFreshness: updated.stateFreshness,
                  stale: updated.stale,
                  hasUnsavedLiveChanges: updated.hasUnsavedLiveChanges,
                  unknownFields: updated.unknownFields,
                  saved: updated.saved,
                }
              : req.action === 'inspect_tracks'
                ? { tracks: useSnap.tracks, mixerChannels: useSnap.mixerChannels }
                : req.action === 'inspect_routing'
                  ? { buses: useSnap.buses, routing: useSnap.routing }
                  : req.action === 'discover_plugins'
                    ? { plugins: useSnap.plugins }
                    : { plugins: useSnap.plugins };

      const evidence: DawDelegationEvidence[] = useSnap
        ? [
            {
              kind: 'observation',
              refId: useSnap.snapshotId,
              summary: `${isLive ? 'Live observed' : 'Cached/stale'} snapshot from "${targetSession.adapterId}" (${useSnap.provenance.sourceEvidence})`,
              sha256: useSnap.stateDigest,
              timestamp: useSnap.provenance.observedAt,
            },
          ]
        : [];

      return {
        ok: useSnap !== null,
        correlationId: req.correlationId,
        action: req.action,
        sessionId: targetSession.sessionId,
        executionStatus: useSnap ? 'succeeded' : 'failed',
        stateTier: isLive ? 'liveObserved' : useSnap ? 'cached' : 'none',
        capabilityInfo: {
          capabilityId: cap.capabilityId,
          dawToolContract: mapping.contractName,
          requiredTier: mapping.tier,
          hostAdapterId: targetSession.adapterId,
          hostVersion: targetSession.hostVersion,
          supportStatus: cap.supportLevel,
        },
        result: slice,
        evidence,
      };
    }

    // Mutating / command delegation path via DawCommandGateway
    if (req.action === 'execute_patch' || req.action === 'prepare_patch') {
      const cmd: DawCommand = {
        commandId: typeof req.payload.commandId === 'string' ? req.payload.commandId : `cmd-${randomUUID()}`,
        sessionId: targetSession.sessionId,
        kind: (typeof req.payload.kind === 'string' ? req.payload.kind : 'mixer.volume_pan_mute') as DawCommand['kind'],
        capabilityId: cap.capabilityId,
        targetRef: typeof req.payload.targetRef === 'string' ? req.payload.targetRef : 'mixer:insert:0',
        params:
          req.payload.params && typeof req.payload.params === 'object' && !Array.isArray(req.payload.params)
            ? (req.payload.params as Record<string, unknown>)
            : req.payload,
        requestedBy: req.actor,
        requestedClass: req.actorClass,
        correlationId: req.correlationId,
        createdAt: new Date().toISOString(),
      };

      try {
        if (req.action === 'prepare_patch') {
          const prep = await this.prepareCommand(cmd, { leaseId: req.leaseId });
          return {
            ok: true,
            correlationId: req.correlationId,
            action: req.action,
            sessionId: targetSession.sessionId,
            executionStatus: 'succeeded',
            stateTier: 'proposedModifications',
            capabilityInfo: {
              capabilityId: cap.capabilityId,
              dawToolContract: mapping.contractName,
              requiredTier: mapping.tier,
              hostAdapterId: targetSession.adapterId,
              hostVersion: targetSession.hostVersion,
              supportStatus: cap.supportLevel,
            },
            result: { prepareId: prep.prepareId, beforeState: prep.beforeState },
            evidence: [
              {
                kind: 'checksum',
                refId: prep.prepareId,
                summary: `Prepared command "${cmd.commandId}" with beforeState snapshot`,
                sha256: prep.expectedBeforeDigest,
                timestamp: new Date().toISOString(),
              },
            ],
          };
        }

        const execRes = await this.executeCommand(cmd, {
          actor: req.actor,
          approvalId: req.approvalId,
          leaseId: req.leaseId,
        });
        return {
          ok: execRes.ok,
          correlationId: req.correlationId,
          action: req.action,
          sessionId: targetSession.sessionId,
          executionStatus: execRes.ok
            ? 'succeeded'
            : execRes.status === 'unsupported'
              ? 'unsupported'
              : execRes.status === 'denied'
                ? 'denied'
                : 'failed',
          stateTier: execRes.ok ? 'appliedModifications' : 'none',
          capabilityInfo: {
            capabilityId: cap.capabilityId,
            dawToolContract: mapping.contractName,
            requiredTier: mapping.tier,
            hostAdapterId: targetSession.adapterId,
            hostVersion: targetSession.hostVersion,
            supportStatus: cap.supportLevel,
          },
          result: execRes.ok ? { receiptId: execRes.receiptId, afterState: execRes.afterState, verifiedByReadback: execRes.verifiedByReadback } : null,
          evidence: execRes.evidence.map((msg, idx) => ({
            kind: 'command_receipt' as const,
            refId: execRes.receiptId ?? `${cmd.commandId}:${idx}`,
            summary: msg,
            timestamp: execRes.provenance.observedAt,
          })),
          approvalId: req.approvalId ?? null,
          error: execRes.error,
        };
      } catch (err) {
        const dErr = err instanceof DawBrainError ? err : new DawBrainError('DAW_INVALID_COMMAND', (err as Error).message);
        return {
          ok: false,
          correlationId: req.correlationId,
          action: req.action,
          sessionId: targetSession.sessionId,
          executionStatus: dErr.code === 'DAW_CAPABILITY_UNSUPPORTED' ? 'unsupported' : 'failed',
          stateTier: 'none',
          capabilityInfo: {
            capabilityId: cap.capabilityId,
            dawToolContract: mapping.contractName,
            requiredTier: mapping.tier,
            hostAdapterId: targetSession.adapterId,
            hostVersion: targetSession.hostVersion,
            supportStatus: cap.supportLevel,
            reason: dErr.message,
          },
          result: null,
          evidence: [],
          error: { code: dErr.code, message: dErr.message },
        };
      }
    }

    return {
      ok: false,
      correlationId: req.correlationId,
      action: req.action,
      sessionId: targetSession.sessionId,
      executionStatus: 'unimplemented',
      stateTier: 'none',
      capabilityInfo: {
        capabilityId: cap.capabilityId,
        dawToolContract: mapping.contractName,
        requiredTier: mapping.tier,
        hostAdapterId: targetSession.adapterId,
        hostVersion: targetSession.hostVersion,
        supportStatus: cap.supportLevel,
        reason: `Delegation action "${req.action}" contract validated; adapter execution reserved for Phase 11+`,
      },
      result: null,
      evidence: [],
    };
  }
}
