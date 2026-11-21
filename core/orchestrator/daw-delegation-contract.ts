import type { DawContextPackage } from '../context-engine/daw-context.ts';
import type { AgentClass } from '../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import {
  DAW_TOOL_CONTRACTS,
  type DawPermissionTier,
  type DawToolContractSpec,
} from '../tool-registry/daw-tool-contracts.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';

export type DawDelegationAction =
  | 'observe'
  | 'inspect_session'
  | 'inspect_tracks'
  | 'inspect_routing'
  | 'discover_plugins'
  | 'inspect_parameters'
  | 'analyze_audio'
  | 'validate_project'
  | 'propose_patch'
  | 'prepare_patch'
  | 'execute_patch'
  | 'rollback_patch';

export type DawDelegationEvidence = {
  readonly kind:
    | 'observation'
    | 'audio_analysis'
    | 'command_receipt'
    | 'approval'
    | 'checksum'
    | 'vault_note'
    | 'policy_check';
  readonly refId: string;
  readonly summary: string;
  readonly sha256?: string | undefined;
  readonly timestamp: string;
};

export type DawDelegationCapabilityInfo = {
  readonly capabilityId: string;
  readonly dawToolContract: string;
  readonly requiredTier: DawPermissionTier;
  readonly hostAdapterId: string | null;
  readonly hostVersion: string | null;
  readonly supportStatus: 'SUPPORTED' | 'TEMPLATE_SCOPED' | 'READ_ONLY' | 'UNSUPPORTED';
  readonly reason?: string | undefined;
};

export type DawDelegationRequest = {
  readonly correlationId: string;
  readonly actor: string;
  readonly actorClass: AgentClass;
  readonly action: DawDelegationAction;
  readonly sessionId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly leaseId?: string | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly context?: DawContextPackage | undefined;
};

export type DawDelegationResult = {
  readonly ok: boolean;
  readonly correlationId: string;
  readonly action: DawDelegationAction;
  readonly sessionId: string | null;
  readonly executionStatus:
    | 'succeeded'
    | 'awaiting_approval'
    | 'denied'
    | 'unsupported'
    | 'unimplemented'
    | 'failed';
  readonly stateTier:
    | 'liveObserved'
    | 'cached'
    | 'savedProject'
    | 'proposedModifications'
    | 'appliedModifications'
    | 'none';
  readonly capabilityInfo: DawDelegationCapabilityInfo;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly evidence: readonly DawDelegationEvidence[];
  readonly approvalId?: string | null | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
};

/**
 * Pure vendor-agnostic delegation boundary through which JARVIS / OS3 Orchestrator
 * routes tasks to DAW Brain without ever touching vendor-specific FL Studio / REAPER APIs.
 */
export interface DawBrainDelegate {
  readonly delegateName: string;
  executeDelegation(req: DawDelegationRequest): Promise<DawDelegationResult>;
}

const ACTION_CONTRACT_MAP: Readonly<
  Record<
    DawDelegationAction,
    { readonly contractName: string; readonly capabilityId: string; readonly tier: DawPermissionTier }
  >
> = {
  observe: { contractName: 'daw_observe_transport', capabilityId: 'daw.transport.read', tier: 'observe' },
  inspect_session: { contractName: 'daw_inspect_session_state', capabilityId: 'daw.session.inspect', tier: 'observe' },
  inspect_tracks: { contractName: 'daw_inspect_mixer_tracks', capabilityId: 'daw.mixer.read', tier: 'observe' },
  inspect_routing: { contractName: 'daw_inspect_routing_graph', capabilityId: 'daw.routing.read', tier: 'observe' },
  discover_plugins: { contractName: 'daw_discover_plugins', capabilityId: 'daw.plugin.inventory_live', tier: 'observe' },
  inspect_parameters: { contractName: 'daw_inspect_plugin_parameters', capabilityId: 'daw.plugin.param_read', tier: 'observe' },
  analyze_audio: { contractName: 'daw_analyze_audio_buffer', capabilityId: 'daw.audio.analyze', tier: 'analyze' },
  validate_project: { contractName: 'daw_validate_project_file', capabilityId: 'daw.project.parse_file', tier: 'analyze' },
  propose_patch: { contractName: 'daw_prepare_command_patch', capabilityId: 'daw.patch.propose', tier: 'propose' },
  prepare_patch: { contractName: 'daw_prepare_command_patch', capabilityId: 'daw.patch.prepare', tier: 'prepare' },
  execute_patch: { contractName: 'daw_execute_command_patch', capabilityId: 'daw.patch.execute', tier: 'execute' },
  rollback_patch: { contractName: 'daw_rollback_command_patch', capabilityId: 'daw.action.rollback', tier: 'rollback' },
};

const VENDOR_API_FORBIDDEN_KEYS = new Set([
  'flstudiorawsysex',
  'rawmidiport',
  'directmidisend',
  'reaperrawreascript',
  'directhostbinaryexec',
  'rawshellcommand',
  'directflpwrite',
  'vendorrawapi',
]);

const LEASE_TIER_ORDER: Readonly<Record<string, number>> = {
  observe: 0,
  analyze: 1,
  propose: 2,
  prepare: 3,
  execute: 4,
  rollback: 5,
};

const AGENT_OR_SYSTEM_ACTOR_RE =
  /^(agent:|system$|jarvis$|auto$|x3lius-|tech-|records-)|-(agent|researcher|orchestrator|curator|summarizer|retriever|checker|generator|editor|advisor|assessor|forecaster|advocate|engine)$/i;

export const findVendorCouplingKeys = (val: unknown, prefix = ''): readonly string[] => {
  if (val === null || typeof val !== 'object') return [];
  if (Array.isArray(val)) {
    return val.flatMap((item, idx) => findVendorCouplingKeys(item, `${prefix}[${idx}]`));
  }
  const found: string[] = [];
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (VENDOR_API_FORBIDDEN_KEYS.has(k.toLowerCase())) {
      found.push(path);
    }
    found.push(...findVendorCouplingKeys(v, path));
  }
  return found;
};

export const resolveActionContract = (
  action: DawDelegationAction,
): {
  readonly spec: DawToolContractSpec | undefined;
  readonly mapping: { readonly contractName: string; readonly capabilityId: string; readonly tier: DawPermissionTier };
} => {
  const mapping = ACTION_CONTRACT_MAP[action];
  const spec = DAW_TOOL_CONTRACTS.find((c) => c.name === mapping.contractName);
  return { spec, mapping };
};

/**
 * Policy coordinator enforcing vendor isolation, agent class authorization,
 * active DAW session TTL leases, and human approvals before invoking a `DawBrainDelegate`.
 */
export class DawDelegationCoordinator {
  readonly #db: SqliteRuntimeDb;
  readonly #tools: Os3ToolRegistry;
  readonly #delegate: DawBrainDelegate | null;

  constructor(options: {
    readonly db: SqliteRuntimeDb;
    readonly tools: Os3ToolRegistry;
    readonly delegate?: DawBrainDelegate | undefined;
  }) {
    this.#db = options.db;
    this.#tools = options.tools;
    this.#delegate = options.delegate ?? null;
  }

  get hasDelegate(): boolean {
    return this.#delegate !== null;
  }

  async delegate(req: DawDelegationRequest): Promise<DawDelegationResult> {
    const { spec, mapping } = resolveActionContract(req.action);
    const session = req.sessionId
      ? this.#db.getDawSession(req.sessionId)
      : (this.#db.listDawSessions('connected', 1)[0] ?? null);

    const baseCapabilityInfo: DawDelegationCapabilityInfo = {
      capabilityId: mapping.capabilityId,
      dawToolContract: mapping.contractName,
      requiredTier: mapping.tier,
      hostAdapterId: session?.adapterId ?? null,
      hostVersion: session?.hostVersion ?? null,
      supportStatus: 'SUPPORTED',
    };

    const failWithStatus = (
      executionStatus: DawDelegationResult['executionStatus'],
      code: string,
      message: string,
      approvalId?: string | null,
      evidence: readonly DawDelegationEvidence[] = [],
    ): DawDelegationResult => {
      if (this.#db.isOpen) {
        this.#db.appendEvent({
          eventType: `jarvis.daw.${executionStatus}`,
          domain: 'TECH',
          actor: req.actor,
          payload: {
            correlationId: req.correlationId,
            action: req.action,
            sessionId: session?.id ?? req.sessionId ?? null,
            code,
            message,
            approvalId: approvalId ?? null,
          },
        });
      }
      return {
        ok: executionStatus === 'succeeded' || executionStatus === 'awaiting_approval',
        correlationId: req.correlationId,
        action: req.action,
        sessionId: session?.id ?? req.sessionId ?? null,
        executionStatus,
        stateTier: 'none',
        capabilityInfo: { ...baseCapabilityInfo, reason: message },
        result: null,
        evidence,
        approvalId,
        error: { code, message },
      };
    };

    // 1. Vendor Isolation Guard: JARVIS must never accept or pass raw vendor DAW API payloads
    const vendorKeys = findVendorCouplingKeys(req.payload);
    if (vendorKeys.length > 0) {
      return failWithStatus(
        'denied',
        'SECURITY_VENDOR_COUPLING_FORBIDDEN',
        `JARVIS cannot invoke vendor-specific DAW APIs directly (forbidden keys: ${vendorKeys.join(', ')})`,
      );
    }

    // 2. Agent Class + Tool Contract Permission Verification
    if (spec) {
      if (!spec.allowedClasses.includes(req.actorClass)) {
        return failWithStatus(
          'denied',
          'DAW_PERMISSION_DENIED',
          `Actor class "${req.actorClass}" is not permitted for DAW action "${req.action}" (contract "${spec.name}" allows [${spec.allowedClasses.join(', ')}])`,
        );
      }
      if (this.#tools.getSpec(spec.name)) {
        const auth = this.#tools.authorize(req.actorClass, spec.name);
        if (!auth.allow) {
          return failWithStatus('denied', 'DAW_PERMISSION_DENIED', auth.reason);
        }
      }
    }

    const evidenceTrail: DawDelegationEvidence[] = [
      {
        kind: 'policy_check',
        refId: `policy:${req.correlationId}`,
        summary: `Verified actor class "${req.actorClass}" for tier "${mapping.tier}" (${mapping.contractName})`,
        timestamp: new Date().toISOString(),
      },
    ];

    // 3. Approval & Active Session Lease Verification for Mutating Tiers (`execute`, `rollback`)
    const requiresMutationGate = mapping.tier === 'execute' || mapping.tier === 'rollback';
    if (requiresMutationGate) {
      const targetSessionId = session?.id ?? req.sessionId;
      if (!targetSessionId) {
        return failWithStatus(
          'denied',
          'DAW_SESSION_REQUIRED',
          `Mutating DAW action "${req.action}" requires an active connected DAW session`,
          null,
          evidenceTrail,
        );
      }

      const lease = req.leaseId
        ? this.#db.getDawLease(req.leaseId)
        : this.#db.getActiveDawLease(targetSessionId);
      const nowMs = Date.now();
      const leaseExpired = !lease || lease.revokedAt !== null || Date.parse(lease.expiresAt) <= nowMs;
      const requiredRank = LEASE_TIER_ORDER[mapping.tier] ?? 4;
      const grantedRank = lease ? (LEASE_TIER_ORDER[lease.maxPermission] ?? 0) : -1;

      if (!lease || lease.sessionId !== targetSessionId || leaseExpired || grantedRank < requiredRank) {
        return failWithStatus(
          'denied',
          'DAW_LEASE_REQUIRED',
          `Mutating DAW action "${req.action}" requires an active non-expired session lease covering "${mapping.tier}"`,
          null,
          evidenceTrail,
        );
      }

      if (!req.approvalId) {
        const pending = this.#db.queueApproval({
          itemType: 'artifact_version',
          itemId: `daw_command:${req.correlationId}:${req.action}`,
          proposer: req.actor,
          request: {
            kind: 'daw_command_execution',
            correlationId: req.correlationId,
            sessionId: targetSessionId,
            action: req.action,
            capabilityId: mapping.capabilityId,
            payload: req.payload,
          },
        });
        evidenceTrail.push({
          kind: 'approval',
          refId: pending.id,
          summary: `Queued human approval required before DAW "${req.action}" execution`,
          timestamp: new Date().toISOString(),
        });

        this.#db.appendEvent({
          eventType: 'jarvis.daw.awaiting_approval',
          domain: 'TECH',
          actor: req.actor,
          payload: {
            correlationId: req.correlationId,
            action: req.action,
            sessionId: targetSessionId,
            approvalId: pending.id,
          },
        });

        return {
          ok: true,
          correlationId: req.correlationId,
          action: req.action,
          sessionId: targetSessionId,
          executionStatus: 'awaiting_approval',
          stateTier: 'proposedModifications',
          capabilityInfo: {
            ...baseCapabilityInfo,
            reason: `Human operator approval required (approvalId="${pending.id}")`,
          },
          result: { queuedApprovalId: pending.id, proposedPayload: req.payload },
          evidence: evidenceTrail,
          approvalId: pending.id,
        };
      }

      const approval = this.#db.getApproval(req.approvalId);
      if (!approval || approval.status !== 'approved') {
        return failWithStatus(
          'denied',
          'DAW_APPROVAL_REQUIRED',
          `Approval "${req.approvalId}" has status "${approval?.status ?? 'missing'}" (requires "approved")`,
          req.approvalId,
          evidenceTrail,
        );
      }
      const approver = (approval.approver ?? '').trim();
      if (
        !approver ||
        approver.toLowerCase() === approval.proposer.toLowerCase() ||
        AGENT_OR_SYSTEM_ACTOR_RE.test(approver)
      ) {
        return failWithStatus(
          'denied',
          'SELF_APPROVAL_FORBIDDEN',
          `Approval "${req.approvalId}" violates human operator approval invariant (approver="${approver}")`,
          req.approvalId,
          evidenceTrail,
        );
      }

      evidenceTrail.push({
        kind: 'approval',
        refId: approval.id,
        summary: `Verified human approval by "${approver}" on active lease "${lease.id}"`,
        timestamp: approval.decidedAt ?? new Date().toISOString(),
      });
    }

    // 4. Delegate to DAW Brain adapter/service if attached
    if (!this.#delegate) {
      return failWithStatus(
        'unimplemented',
        'DAW_DELEGATE_NOT_ATTACHED',
        `Permission & policy checks passed for "${req.action}", but no live DawBrainDelegate is attached in runtime`,
        req.approvalId ?? null,
        evidenceTrail,
      );
    }

    const delegatedResult = await this.#delegate.executeDelegation(req);
    const mergedEvidence = [...evidenceTrail, ...delegatedResult.evidence];

    if (this.#db.isOpen) {
      this.#db.appendEvent({
        eventType: `jarvis.daw.${delegatedResult.executionStatus}`,
        domain: 'TECH',
        actor: req.actor,
        payload: {
          correlationId: req.correlationId,
          delegate: this.#delegate.delegateName,
          action: req.action,
          sessionId: delegatedResult.sessionId,
          executionStatus: delegatedResult.executionStatus,
          capabilityId: delegatedResult.capabilityInfo.capabilityId,
          supportStatus: delegatedResult.capabilityInfo.supportStatus,
          evidenceCount: mergedEvidence.length,
        },
      });
    }

    return {
      ...delegatedResult,
      evidence: mergedEvidence,
    };
  }
}
