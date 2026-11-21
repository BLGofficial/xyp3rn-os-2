import type { AgentClass } from '../contracts/taxonomy.ts';
import type { DawSessionLeaseRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { DawPermissionTier } from '../tool-registry/daw-tool-contracts.ts';
import type { DawEventBus } from './daw-event-bus.ts';
import {
  DawBrainError,
  type DawCapability,
} from './types.ts';

export const DAW_PERMISSION_RANK: Readonly<Record<DawPermissionTier, number>> = {
  observe: 0,
  analyze: 1,
  propose: 2,
  prepare: 3,
  execute: 4,
  approve: 5,
  rollback: 5,
};

export type CapabilityCheckOutcome =
  | {
      readonly allowed: true;
      readonly capability: DawCapability;
      readonly leaseId: string | null;
      readonly maxGrantedTier: DawPermissionTier;
    }
  | {
      readonly allowed: false;
      readonly code: 'DAW_CAPABILITY_UNSUPPORTED' | 'DAW_PERMISSION_DENIED' | 'DAW_LEASE_REQUIRED';
      readonly reason: string;
    };

/**
 * Authorizes every DAW Brain operation against BOTH:
 * 1) What the registered DAW adapter explicitly declares as supported vs UNSUPPORTED;
 * 2) The active session's default read-only (`observe`) mode + time-bounded SQLite leases (`daw_session_leases`).
 */
export class DawCapabilityRegistry {
  readonly #manifests = new Map<string, Map<string, DawCapability>>();
  readonly #db: SqliteRuntimeDb | null;
  readonly #events: DawEventBus | null;

  constructor(options: {
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly events?: DawEventBus | null | undefined;
  } = {}) {
    this.#db = options.db ?? null;
    this.#events = options.events ?? null;
  }

  registerManifest(adapterId: string, capabilities: readonly DawCapability[]): void {
    const map = new Map<string, DawCapability>();
    for (const c of capabilities) {
      map.set(c.capabilityId, c);
    }
    this.#manifests.set(adapterId, map);
  }

  getCapability(adapterId: string, capabilityId: string): DawCapability | null {
    return this.#manifests.get(adapterId)?.get(capabilityId) ?? null;
  }

  listCapabilities(adapterId: string): readonly DawCapability[] {
    return [...(this.#manifests.get(adapterId)?.values() ?? [])];
  }

  grantLease(input: {
    readonly sessionId: string;
    readonly maxPermission: 'observe' | 'analyze' | 'propose' | 'prepare' | 'execute' | 'rollback';
    readonly grantedBy: string;
    readonly allowedTargets?: readonly string[] | undefined;
    readonly ttlMs?: number | undefined;
  }): DawSessionLeaseRecord {
    if (!this.#db || !this.#db.isOpen) {
      throw new DawBrainError('DAW_PERMISSION_DENIED', 'Cannot grant DAW lease without active SQLite runtime DB');
    }
    const granted = input.grantedBy.trim();
    if (!granted || /^(agent:|system$|jarvis$)/i.test(granted)) {
      throw new DawBrainError('DAW_PERMISSION_DENIED', `Lease grant rejected for non-operator actor "${input.grantedBy}"`);
    }
    const lease = this.#db.grantDawLease(input);
    this.#events?.emit(
      'daw.lease.granted',
      input.sessionId,
      { leaseId: lease.id, maxPermission: lease.maxPermission, expiresAt: lease.expiresAt, grantedBy: granted },
      granted,
    );
    return lease;
  }

  revokeLease(leaseId: string, sessionId: string | null, actor = 'operator'): boolean {
    if (!this.#db || !this.#db.isOpen) return false;
    const revoked = this.#db.revokeDawLease(leaseId);
    if (revoked) {
      this.#events?.emit('daw.lease.revoked', sessionId, { leaseId }, actor);
    }
    return revoked;
  }

  getActiveLease(sessionId: string): DawSessionLeaseRecord | null {
    if (!this.#db || !this.#db.isOpen) return null;
    return this.#db.getActiveDawLease(sessionId);
  }

  verifyCapabilitySupport(input: {
    readonly adapterId: string;
    readonly sessionId: string;
    readonly capabilityId: string;
    readonly requestedTier?: DawPermissionTier | undefined;
    readonly actor: string;
  }):
    | { readonly supported: true; readonly capability: DawCapability; readonly requiredTier: DawPermissionTier; readonly isMutatingTier: boolean }
    | { readonly supported: false; readonly code: 'DAW_CAPABILITY_UNSUPPORTED'; readonly reason: string } {
    const cap = this.getCapability(input.adapterId, input.capabilityId);
    if (!cap) {
      this.#events?.emit(
        'daw.capability.denied',
        input.sessionId,
        { adapterId: input.adapterId, capabilityId: input.capabilityId, reason: 'undeclared capability' },
        input.actor,
      );
      return {
        supported: false,
        code: 'DAW_CAPABILITY_UNSUPPORTED',
        reason: `Adapter "${input.adapterId}" does not declare capability "${input.capabilityId}"`,
      };
    }

    if (cap.supportLevel === 'UNSUPPORTED') {
      this.#events?.emit(
        'daw.capability.denied',
        input.sessionId,
        { adapterId: input.adapterId, capabilityId: input.capabilityId, supportLevel: 'UNSUPPORTED' },
        input.actor,
      );
      return {
        supported: false,
        code: 'DAW_CAPABILITY_UNSUPPORTED',
        reason: `Adapter "${input.adapterId}" explicitly reports "${input.capabilityId}" as UNSUPPORTED${cap.notes ? `: ${cap.notes}` : ''}`,
      };
    }

    const requiredTier = input.requestedTier ?? cap.requiredTier;
    const isMutatingTier = requiredTier === 'prepare' || requiredTier === 'execute' || requiredTier === 'rollback';

    if (isMutatingTier && cap.supportLevel === 'READ_ONLY') {
      return {
        supported: false,
        code: 'DAW_CAPABILITY_UNSUPPORTED',
        reason: `Capability "${input.capabilityId}" is READ_ONLY on "${input.adapterId}"; mutation "${requiredTier}" is unsupported`,
      };
    }

    return { supported: true, capability: cap, requiredTier, isMutatingTier };
  }

  checkCapability(input: {
    readonly adapterId: string;
    readonly sessionId: string;
    readonly capabilityId: string;
    readonly requestedTier?: DawPermissionTier | undefined;
    readonly targetRef?: string | undefined;
    readonly actor: string;
    readonly actorClass?: AgentClass | undefined;
    readonly leaseId?: string | undefined;
    readonly allowMutationsByVersion?: boolean | undefined;
  }): CapabilityCheckOutcome {
    const sup = this.verifyCapabilitySupport(input);
    if (!sup.supported) {
      return { allowed: false, code: sup.code, reason: sup.reason };
    }
    const { capability: cap, requiredTier, isMutatingTier } = sup;

    if (isMutatingTier && input.allowMutationsByVersion === false) {
      return {
        allowed: false,
        code: 'DAW_PERMISSION_DENIED',
        reason: `Host version compatibility degraded "${input.adapterId}" to observe-only; mutating tier "${requiredTier}" blocked`,
      };
    }

    if (isMutatingTier && input.actorClass && input.actorClass !== 'Execution' && input.actorClass !== 'Governance') {
      return {
        allowed: false,
        code: 'DAW_PERMISSION_DENIED',
        reason: `Agent class "${input.actorClass}" is forbidden from mutating tier "${requiredTier}"`,
      };
    }

    // Default baseline permission when no lease exists is 'analyze'/'observe' read compute ONLY
    const activeLease = input.leaseId && this.#db?.isOpen
      ? this.#db.getDawLease(input.leaseId)
      : this.getActiveLease(input.sessionId);

    const leaseValid =
      activeLease !== null &&
      activeLease.sessionId === input.sessionId &&
      activeLease.revokedAt === null &&
      Date.parse(activeLease.expiresAt) > Date.now();

    const maxGrantedTier: DawPermissionTier = leaseValid ? activeLease.maxPermission : 'analyze';

    if (DAW_PERMISSION_RANK[maxGrantedTier] < DAW_PERMISSION_RANK[requiredTier]) {
      const code = isMutatingTier ? 'DAW_LEASE_REQUIRED' : 'DAW_PERMISSION_DENIED';
      const reason = `Session "${input.sessionId}" permission "${maxGrantedTier}" cannot satisfy required tier "${requiredTier}" for "${input.capabilityId}"`;
      this.#events?.emit(
        'daw.capability.denied',
        input.sessionId,
        { adapterId: input.adapterId, capabilityId: input.capabilityId, requiredTier, maxGrantedTier },
        input.actor,
      );
      return { allowed: false, code, reason };
    }

    if (
      leaseValid &&
      activeLease.allowedTargets.length > 0 &&
      input.targetRef &&
      !activeLease.allowedTargets.includes(input.targetRef) &&
      !activeLease.allowedTargets.includes('*')
    ) {
      return {
        allowed: false,
        code: 'DAW_PERMISSION_DENIED',
        reason: `Active lease restricts targets to [${activeLease.allowedTargets.join(', ')}] (requested "${input.targetRef}")`,
      };
    }

    return {
      allowed: true,
      capability: cap,
      leaseId: leaseValid ? activeLease.id : null,
      maxGrantedTier,
    };
  }
}
