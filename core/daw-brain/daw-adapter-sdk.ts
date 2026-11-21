import {
  DawBrainError,
  type DawCapability,
  type DawCommand,
  type DawCommandResult,
  type DawConnection,
  type DawHostKind,
  type DawInstance,
  type DawObservationProvenance,
  type DawStateSnapshot,
} from './types.ts';

export type DawAdapterManifest = {
  readonly adapterId: string;
  readonly displayName: string;
  readonly hostKind: DawHostKind;
  readonly isSimulated: boolean;
  readonly minSupportedHostVersion: string;
  readonly maxTestedHostVersion: string;
  readonly minApiVersion?: number | undefined;
  readonly transportKind: DawInstance['transportKind'];
  readonly capabilities: readonly DawCapability[];
};

export type DawHealthReport = {
  readonly adapterId: string;
  readonly healthy: boolean;
  readonly reachable: boolean;
  readonly rttMs: number;
  readonly degradedReason: string | null;
  readonly missingPrerequisites: readonly string[];
  readonly provenance: DawObservationProvenance;
};

export type DawCommandValidationResult = {
  readonly valid: boolean;
  readonly capabilitySupported: boolean;
  readonly normalizedBeforeState?: Readonly<Record<string, unknown>> | undefined;
  readonly reason: string;
};

export type DawAdapterPushEvent =
  | {
      readonly kind: 'snapshot_delta';
      readonly sessionId: string;
      readonly snapshot: DawStateSnapshot;
    }
  | {
      readonly kind: 'disconnected';
      readonly sessionId: string;
      readonly reason: string;
    };

/**
 * Vendor-independent DAW Adapter contract (`Phase 10`).
 * Every real or simulated adapter MUST implement this exact lifecycle without hiding
 * unsupported capabilities behind fake successes.
 */
export interface DawAdapter {
  readonly manifest: DawAdapterManifest;

  discover(): Promise<readonly DawInstance[]>;

  connect(options?: {
    readonly instanceId?: string | undefined;
    readonly projectPath?: string | undefined;
  }): Promise<{
    readonly instance: DawInstance;
    readonly connection: DawConnection;
    readonly initialSnapshot: DawStateSnapshot;
  }>;

  disconnect(connectionId: string): Promise<void>;

  healthCheck(connectionId?: string): Promise<DawHealthReport>;

  getCapabilities(): readonly DawCapability[];

  observe(sessionId: string): Promise<DawStateSnapshot>;

  subscribe(
    sessionId: string,
    listener: (event: DawAdapterPushEvent) => void,
  ): () => void;

  validateCommand(command: DawCommand, currentSnapshot: DawStateSnapshot): Promise<DawCommandValidationResult>;

  execute(
    command: DawCommand,
    currentSnapshot: DawStateSnapshot,
  ): Promise<DawCommandResult>;
}

const REQUIRED_LIFECYCLE_METHODS = [
  'discover',
  'connect',
  'disconnect',
  'healthCheck',
  'getCapabilities',
  'observe',
  'subscribe',
  'validateCommand',
  'execute',
] as const;

/**
 * Validates that an adapter declares a valid manifest, implements every lifecycle method,
 * and never reports duplicate capability IDs or impersonates real hardware when simulated.
 */
export const validateAdapterContract = (adapter: DawAdapter): {
  readonly ok: boolean;
  readonly issues: readonly string[];
} => {
  const issues: string[] = [];

  if (!adapter.manifest.adapterId.trim()) {
    issues.push('manifest.adapterId must be non-empty');
  }
  if (adapter.manifest.hostKind === 'simulated' && !adapter.manifest.isSimulated) {
    issues.push('simulated adapter must explicitly set manifest.isSimulated = true');
  }
  if (!adapter.manifest.isSimulated && adapter.manifest.hostKind === 'simulated') {
    issues.push('non-simulated adapter cannot have hostKind "simulated"');
  }

  for (const methodName of REQUIRED_LIFECYCLE_METHODS) {
    if (typeof adapter[methodName] !== 'function') {
      issues.push(`missing lifecycle method: ${methodName}()`);
    }
  }

  const caps = adapter.getCapabilities();
  const seenCaps = new Set<string>();
  for (const c of caps) {
    if (!c.capabilityId.trim()) {
      issues.push('capability declaration with empty capabilityId');
    } else if (seenCaps.has(c.capabilityId)) {
      issues.push(`duplicate capability declaration: ${c.capabilityId}`);
    } else {
      seenCaps.add(c.capabilityId);
    }
  }

  if (caps.length === 0) {
    issues.push('adapter must declare at least one capability');
  }

  return { ok: issues.length === 0, issues };
};

export const assertValidAdapterContract = (adapter: DawAdapter): void => {
  const res = validateAdapterContract(adapter);
  if (!res.ok) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `Adapter "${adapter.manifest.adapterId}" failed contract check: ${res.issues.join('; ')}`, {
      issues: res.issues,
    });
  }
};
