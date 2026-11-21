import { assertValidAdapterContract, type DawAdapter } from './daw-adapter-sdk.ts';
import type { DawCapabilityRegistry } from './daw-capability-registry.ts';
import type { DawEventBus } from './daw-event-bus.ts';
import type { DawSessionModel } from './daw-session-model.ts';
import type { DawVersionManager } from './daw-version-manager.ts';
import {
  DawBrainError,
  type DawConnection,
  type DawConnectionStatus,
  type DawInstance,
  type DawSession,
} from './types.ts';

/**
 * Manages registration, discovery, version compatibility handshake, connection lifecycle transitions,
 * and clean disconnection across vendor-independent `DawAdapter` instances.
 */
export class DawConnectionManager {
  readonly #adapters = new Map<string, DawAdapter>();
  readonly #connections = new Map<string, DawConnection>();
  readonly #capabilities: DawCapabilityRegistry;
  readonly #versions: DawVersionManager;
  readonly #sessions: DawSessionModel;
  readonly #events: DawEventBus;

  constructor(options: {
    readonly capabilities: DawCapabilityRegistry;
    readonly versions: DawVersionManager;
    readonly sessions: DawSessionModel;
    readonly events: DawEventBus;
  }) {
    this.#capabilities = options.capabilities;
    this.#versions = options.versions;
    this.#sessions = options.sessions;
    this.#events = options.events;
  }

  registerAdapter(adapter: DawAdapter): void {
    assertValidAdapterContract(adapter);
    const id = adapter.manifest.adapterId;
    if (this.#adapters.has(id)) {
      throw new DawBrainError('DAW_INVALID_COMMAND', `DAW adapter "${id}" is already registered`);
    }
    this.#adapters.set(id, adapter);
    this.#capabilities.registerManifest(id, adapter.getCapabilities());
  }

  getAdapter(adapterId: string): DawAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  requireAdapter(adapterId: string): DawAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new DawBrainError('DAW_ADAPTER_NOT_FOUND', `DAW adapter not registered: "${adapterId}"`);
    }
    return adapter;
  }

  listAdapters(): readonly DawAdapter[] {
    return [...this.#adapters.values()];
  }

  async discoverAll(): Promise<readonly DawInstance[]> {
    const all: DawInstance[] = [];
    for (const adapter of this.#adapters.values()) {
      try {
        const discovered = await adapter.discover();
        for (const inst of discovered) {
          all.push(inst);
          this.#events.emit('daw.instance.discovered', null, {
            adapterId: adapter.manifest.adapterId,
            instanceId: inst.id,
            hostName: inst.hostName,
            version: inst.version,
            isSimulated: inst.isSimulated,
          });
        }
      } catch {
        // Keep discovery resilient if a single host adapter cannot probe
      }
    }
    return all;
  }

  async connect(
    adapterId: string,
    options: {
      readonly instanceId?: string | undefined;
      readonly projectPath?: string | undefined;
      readonly actor?: string | undefined;
    } = {},
  ): Promise<DawSession> {
    const adapter = this.requireAdapter(adapterId);
    const actor = options.actor ?? 'daw-connection-manager';

    const { instance, connection, initialSnapshot } = await adapter.connect({
      instanceId: options.instanceId,
      projectPath: options.projectPath,
    });

    const apiVerNum = Number.parseInt(instance.apiVersion, 10);
    const verdict = this.#versions.evaluateCompatibility({
      hostVersion: instance.version,
      minSupportedVersion: adapter.manifest.minSupportedHostVersion,
      maxTestedVersion: adapter.manifest.maxTestedHostVersion,
      minApiVersion: adapter.manifest.minApiVersion,
      actualApiVersion: Number.isFinite(apiVerNum) ? apiVerNum : undefined,
    });

    this.#events.emit(
      'daw.version.checked',
      connection.sessionId,
      { adapterId, verdict },
      actor,
    );

    if (verdict.status === 'incompatible') {
      await adapter.disconnect(connection.connectionId).catch(() => undefined);
      this.#versions.assertConnectable(verdict);
    }

    const normalizedConn: DawConnection = {
      ...connection,
      status: 'connected_read_only',
      activePermissionTier: 'observe',
      versionCompatibility: verdict.status,
      consecutiveFailures: 0,
    };
    this.#connections.set(normalizedConn.connectionId, normalizedConn);

    const projectName =
      options.projectPath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Untitled Session';

    const session = this.#sessions.createSession({
      sessionId: normalizedConn.sessionId,
      dawId: instance.id,
      hostVersion: instance.version,
      connection: normalizedConn,
      project: {
        projectId: `proj-${normalizedConn.sessionId}`,
        name: projectName,
        format: instance.hostKind === 'fl_studio' ? '.flp' : instance.hostKind === 'reaper' ? '.rpp' : '.sim',
        projectPath: options.projectPath ?? null,
        savedSha256: null,
        lastSavedAt: null,
        editionRequirement: instance.edition,
        tempo: initialSnapshot.transport.tempo,
        timeSignature: initialSnapshot.transport.timeSignature,
      },
      initialObserved: initialSnapshot,
    });

    this.#events.emit(
      'daw.adapter.connected',
      session.sessionId,
      {
        adapterId,
        connectionId: normalizedConn.connectionId,
        hostVersion: instance.version,
        versionCompatibility: verdict.status,
      },
      actor,
    );

    return session;
  }

  async disconnect(sessionId: string, actor = 'daw-connection-manager'): Promise<DawSession> {
    const sess = this.#sessions.requireSession(sessionId);
    const adapter = this.#adapters.get(sess.adapterId);
    if (adapter) {
      await adapter.disconnect(sess.connection.connectionId).catch(() => undefined);
    }
    const closedConn: DawConnection = {
      ...sess.connection,
      status: 'closed',
    };
    this.#connections.set(closedConn.connectionId, closedConn);
    const updated = this.#sessions.updateConnection(sessionId, closedConn);
    this.#events.emit(
      'daw.adapter.disconnected',
      sessionId,
      { adapterId: sess.adapterId, connectionId: closedConn.connectionId },
      actor,
    );
    return updated;
  }

  transitionConnection(
    sessionId: string,
    patch: Partial<Pick<DawConnection, 'status' | 'lastHeartbeatAt' | 'lastRttMs' | 'consecutiveFailures' | 'activePermissionTier'>>,
  ): DawSession {
    const sess = this.#sessions.requireSession(sessionId);
    const nextConn: DawConnection = {
      ...sess.connection,
      ...patch,
    };
    this.#connections.set(nextConn.connectionId, nextConn);
    if (patch.status && patch.status !== sess.connection.status) {
      this.#events.emit('daw.connection.state_changed', sessionId, {
        from: sess.connection.status,
        to: nextConn.status,
      });
    }
    return this.#sessions.updateConnection(sessionId, nextConn);
  }

  getConnection(connectionId: string): DawConnection | null {
    return this.#connections.get(connectionId) ?? null;
  }

  setStatus(sessionId: string, status: DawConnectionStatus): DawSession {
    return this.transitionConnection(sessionId, { status });
  }
}
