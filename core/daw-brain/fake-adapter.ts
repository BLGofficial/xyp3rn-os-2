import { randomUUID } from 'node:crypto';
import type {
  DawAdapter,
  DawAdapterManifest,
  DawAdapterPushEvent,
  DawCommandValidationResult,
  DawHealthReport,
} from './daw-adapter-sdk.ts';
import { computeSnapshotDigest } from './daw-session-model.ts';
import type {
  DawAvailability,
  DawBus,
  DawCapability,
  DawCommand,
  DawCommandResult,
  DawConnection,
  DawInstance,
  DawMixerChannel,
  DawObservationProvenance,
  DawPluginInstance,
  DawRoutingConnection,
  DawStateSnapshot,
  DawTrack,
} from './types.ts';

export type FakeAdapterOptions = {
  readonly adapterId?: string | undefined;
  readonly hostVersion?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly minSupportedHostVersion?: string | undefined;
  readonly maxTestedHostVersion?: string | undefined;
  readonly minApiVersion?: number | undefined;
  readonly capabilityOverrides?: Readonly<Record<string, Partial<DawCapability>>> | undefined;
  readonly extraCapabilities?: readonly DawCapability[] | undefined;
  readonly unavailableAutomation?: DawAvailability<never> | undefined;
  readonly simulatedLatencyMs?: number | undefined;
};

const DEFAULT_CAPABILITIES: readonly DawCapability[] = [
  {
    capabilityId: 'daw.health.probe',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.transport.read',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.transport.control',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
  },
  {
    capabilityId: 'daw.session.inspect',
    category: 'session_inspection',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.mixer.read',
    category: 'track_inspection',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.mixer.fader_pan_mute',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
  },
  {
    capabilityId: 'daw.routing.read',
    category: 'routing_inspection',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.mixer.routing_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
  },
  {
    capabilityId: 'daw.plugin.inventory_live',
    category: 'plugin_discovery',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.plugin.param_read',
    category: 'parameter_inspection',
    requiredTier: 'observe',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
  },
  {
    capabilityId: 'daw.plugin.param_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
  },
  {
    capabilityId: 'daw.plugin.bypass',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
  },
  {
    capabilityId: 'daw.plugin.load_remove',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    notes: 'Simulated unsupported capability matching constrained host constraints',
  },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic simulated DAW Adapter (`isSimulated: true`).
 * Used strictly for Phase 10+ automated contract, lifecycle, safety, drift,
 * latency, and failure testing; never masquerades as real FL Studio or REAPER IPC.
 */
export class FakeDawAdapter implements DawAdapter {
  readonly manifest: DawAdapterManifest;
  readonly #hostVersion: string;
  readonly #apiVersion: string;
  readonly #unavailableAutomation: DawAvailability<never>;
  readonly #subscribers = new Map<string, Set<(e: DawAdapterPushEvent) => void>>();

  #latencyMs: number;
  #executeDelayMs = 0;
  #disconnectHealth = false;
  #healthFailReason = 'Simulated host disconnected';
  #failNextObserve: string | null = null;
  #failNextExecute: string | null = null;
  #simulatePostconditionMismatch = false;
  #mutateBeforeTimeoutOrHang = false;
  #playing = false;
  #paused = false;
  #loopEnabled = true;
  #bpm = 140;
  #mixerChannels: DawMixerChannel[];
  #tracks: DawTrack[];
  #buses: DawBus[];
  #routing: DawRoutingConnection[];

  constructor(options: FakeAdapterOptions = {}) {
    const adapterId = options.adapterId ?? 'fake-simulated-daw';
    this.#hostVersion = options.hostVersion ?? '1.2.0';
    this.#apiVersion = options.apiVersion ?? '12';
    this.#latencyMs = Math.max(0, options.simulatedLatencyMs ?? 0);
    this.#unavailableAutomation = options.unavailableAutomation ?? {
      status: 'unavailable',
      reason: 'Simulated adapter intentionally marks timeline automation splines unavailable',
    };

    const overrides = options.capabilityOverrides ?? {};
    const capabilities = [
      ...DEFAULT_CAPABILITIES.map((c) => ({
        ...c,
        ...(overrides[c.capabilityId] ?? {}),
      })),
      ...(options.extraCapabilities ?? []),
    ];

    this.manifest = {
      adapterId,
      displayName: `Simulated DAW Fixture (${adapterId})`,
      hostKind: 'simulated',
      isSimulated: true,
      minSupportedHostVersion: options.minSupportedHostVersion ?? '1.0.0',
      maxTestedHostVersion: options.maxTestedHostVersion ?? '2.0.0',
      minApiVersion: options.minApiVersion ?? 10,
      transportKind: 'simulated',
      capabilities,
    };

    const eqPlugin: DawPluginInstance = {
      id: 'plug-sim-eq-1',
      slotIndex: 0,
      containerId: 'mixer:insert:1',
      name: 'Simulated Parametric EQ',
      vendor: 'SimulationFixture',
      format: 'NATIVE',
      bypassed: false,
      mixLevel: 1.0,
      editionCompatible: 'verified',
      parameterCount: 2,
      parameters: {
        status: 'available',
        value: [
          {
            index: 0,
            id: 'band1_freq',
            name: 'Band 1 Frequency',
            valueNormalized: 0.25,
            displayValue: '120 Hz',
            defaultNormalized: 0.25,
            unit: 'Hz',
            readable: true,
            writable: true,
          },
          {
            index: 1,
            id: 'band1_gain',
            name: 'Band 1 Gain',
            valueNormalized: 0.5,
            displayValue: '0.0 dB',
            defaultNormalized: 0.5,
            unit: 'dB',
            readable: true,
            writable: true,
          },
        ],
      },
    };

    this.#mixerChannels = [
      {
        id: 'mixer:insert:0',
        index: 0,
        name: 'Master',
        isMaster: true,
        volumeNormalized: 0.8,
        volumeDb: 0.0,
        panNormalized: 0.0,
        muted: false,
        soloed: false,
        stereoSeparation: 0.0,
        peakDb: -1.4,
        pluginSlots: [],
      },
      {
        id: 'mixer:insert:1',
        index: 1,
        name: 'Lead Vocal',
        isMaster: false,
        volumeNormalized: 0.75,
        volumeDb: -2.0,
        panNormalized: 0.0,
        muted: false,
        soloed: false,
        stereoSeparation: 0.0,
        peakDb: -8.2,
        pluginSlots: [eqPlugin],
      },
    ];

    this.#tracks = [
      {
        id: 'track-0',
        index: 0,
        name: 'Master Track',
        kind: 'master',
        color: '#22d3ee',
        muted: false,
        soloed: false,
        armed: false,
        mixerChannelId: 'mixer:insert:0',
      },
      {
        id: 'track-1',
        index: 1,
        name: 'Lead Vocal',
        kind: 'audio',
        color: '#f59e0b',
        muted: false,
        soloed: false,
        armed: false,
        mixerChannelId: 'mixer:insert:1',
      },
    ];

    this.#buses = [
      {
        id: 'bus-master',
        mixerChannelId: 'mixer:insert:0',
        name: 'Master Bus',
        role: 'master',
        sourceIds: ['mixer:insert:1'],
        destinationId: null,
      },
    ];

    this.#routing = [
      {
        id: 'route-1-0',
        sourceId: 'mixer:insert:1',
        targetId: 'mixer:insert:0',
        sendNormalized: 1.0,
        sendDb: 0.0,
        enabled: true,
        preFader: false,
        sidechain: false,
      },
    ];
  }

  // ─── Simulation / Fault Injection Helpers for Tests ────────────────────────

  setLatencyMs(ms: number): void {
    this.#latencyMs = Math.max(0, ms);
  }

  setOffline(offline: boolean, reason = 'Simulated host disconnected'): void {
    this.#disconnectHealth = offline;
    this.#healthFailReason = reason;
    if (offline) {
      for (const [sessionId, listeners] of this.#subscribers.entries()) {
        for (const fn of listeners) {
          fn({ kind: 'disconnected', sessionId, reason });
        }
      }
    }
  }

  setFailNextObserve(reason: string | null): void {
    this.#failNextObserve = reason;
  }

  setFailNextExecute(reason: string | null): void {
    this.#failNextExecute = reason;
  }

  setExecuteDelayMs(ms: number): void {
    this.#executeDelayMs = Math.max(0, ms);
  }

  setSimulatePostconditionMismatch(enabled: boolean): void {
    this.#simulatePostconditionMismatch = enabled;
  }

  setMutateBeforeTimeoutOrHang(enabled: boolean): void {
    this.#mutateBeforeTimeoutOrHang = enabled;
  }

  mutateHostOutOfBand(patch: { readonly bpm?: number; readonly track1VolumeDb?: number }): void {
    if (patch.bpm !== undefined) this.#bpm = patch.bpm;
    if (patch.track1VolumeDb !== undefined) {
      this.#mixerChannels = this.#mixerChannels.map((ch) =>
        ch.index === 1 ? { ...ch, volumeDb: patch.track1VolumeDb! } : ch,
      );
    }
  }

  async pushSnapshotToSubscribers(sessionId: string): Promise<void> {
    const snap = await this.observe(sessionId);
    const listeners = this.#subscribers.get(sessionId);
    if (!listeners) return;
    for (const fn of listeners) {
      fn({ kind: 'snapshot_delta', sessionId, snapshot: snap });
    }
  }

  // ─── DawAdapter Lifecycle ──────────────────────────────────────────────────

  async discover(): Promise<readonly DawInstance[]> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    return [this.#buildInstance()];
  }

  async connect(options: { readonly instanceId?: string | undefined; readonly projectPath?: string | undefined } = {}): Promise<{
    readonly instance: DawInstance;
    readonly connection: DawConnection;
    readonly initialSnapshot: DawStateSnapshot;
  }> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    if (this.#disconnectHealth) {
      throw new Error(this.#healthFailReason);
    }
    const now = new Date().toISOString();
    const sessionId = `sim-sess-${randomUUID().slice(0, 8)}`;
    const instance = this.#buildInstance(options.instanceId);
    const connection: DawConnection = {
      connectionId: `sim-conn-${randomUUID().slice(0, 8)}`,
      instanceId: instance.id,
      adapterId: this.manifest.adapterId,
      sessionId,
      status: 'connected_read_only',
      activePermissionTier: 'observe',
      versionCompatibility: 'compatible',
      connectedAt: now,
      lastHeartbeatAt: now,
      lastRttMs: this.#latencyMs,
      consecutiveFailures: 0,
    };
    const initialSnapshot = await this.observe(sessionId);
    return { instance, connection, initialSnapshot };
  }

  async disconnect(_connectionId: string): Promise<void> {
    this.#subscribers.clear();
  }

  async healthCheck(_connectionId?: string): Promise<DawHealthReport> {
    const t0 = Date.now();
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    const healthy = !this.#disconnectHealth;
    return {
      adapterId: this.manifest.adapterId,
      healthy,
      reachable: healthy,
      rttMs: Date.now() - t0,
      degradedReason: healthy ? null : this.#healthFailReason,
      missingPrerequisites: [],
      provenance: this.#provenance('health_probe', healthy ? 'observed' : 'stale'),
    };
  }

  getCapabilities(): readonly DawCapability[] {
    return this.manifest.capabilities;
  }

  async observe(sessionId: string): Promise<DawStateSnapshot> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    if (this.#failNextObserve) {
      const msg = this.#failNextObserve;
      this.#failNextObserve = null;
      throw new Error(msg);
    }
    if (this.#disconnectHealth) {
      throw new Error(this.#healthFailReason);
    }

    const prov = this.#provenance('simulated_memory_observe', 'observed');
    const plugins: DawPluginInstance[] = this.#mixerChannels.flatMap((c) => c.pluginSlots);

    const base: Omit<DawStateSnapshot, 'stateDigest'> = {
      snapshotId: `snap-${randomUUID().slice(0, 8)}`,
      sessionId,
      freshness: 'observed',
      provenance: prov,
      transport: {
        playing: this.#playing,
        paused: this.#paused,
        recording: false,
        loopEnabled: this.#loopEnabled,
        songPositionBeats: 0,
        songPositionSeconds: 0,
        tempo: { bpm: this.#bpm, freshness: 'observed' },
        timeSignature: { numerator: 4, denominator: 4, ppq: 96 },
        provenance: prov,
      },
      tracks: { status: 'available', value: this.#tracks },
      channels: {
        status: 'available',
        value: [
          {
            id: 'chan-0',
            index: 0,
            name: 'Lead Vocal Audio',
            kind: 'audio_clip',
            targetMixerChannelId: 'mixer:insert:1',
            muted: false,
            soloed: false,
            volumeNormalized: 0.8,
            panNormalized: 0.0,
          },
        ],
      },
      mixerChannels: { status: 'available', value: this.#mixerChannels },
      buses: { status: 'available', value: this.#buses },
      routing: { status: 'available', value: this.#routing },
      plugins: { status: 'available', value: plugins },
      automationLanes: this.#unavailableAutomation,
      audioClips: { status: 'unknown', reason: 'Simulated fixture has not populated arrangement clips' },
      midiClips: { status: 'available', value: [] },
      markers: { status: 'unavailable', reason: 'No markers defined in simulated session' },
      regions: { status: 'unavailable', reason: 'Regions not configured in simulated session' },
    };

    const dummy: DawStateSnapshot = { ...base, stateDigest: '' };
    return {
      ...base,
      stateDigest: computeSnapshotDigest(dummy),
    };
  }

  subscribe(sessionId: string, listener: (event: DawAdapterPushEvent) => void): () => void {
    const set = this.#subscribers.get(sessionId) ?? new Set<(e: DawAdapterPushEvent) => void>();
    set.add(listener);
    this.#subscribers.set(sessionId, set);
    return () => {
      set.delete(listener);
    };
  }

  async validateCommand(command: DawCommand, _currentSnapshot: DawStateSnapshot): Promise<DawCommandValidationResult> {
    const cap = this.manifest.capabilities.find((c) => c.capabilityId === command.capabilityId);
    if (!cap || cap.supportLevel === 'UNSUPPORTED') {
      return {
        valid: false,
        capabilitySupported: false,
        reason: `Simulated adapter marks "${command.capabilityId}" UNSUPPORTED`,
      };
    }

    if (command.kind === 'mixer.volume_pan_mute') {
      const target = this.#mixerChannels.find((c) => c.id === command.targetRef);
      if (!target) {
        return {
          valid: false,
          capabilitySupported: true,
          reason: `Unknown mixer target "${command.targetRef}"`,
        };
      }
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          targetRef: target.id,
          volumeDb: target.volumeDb,
          volumeNormalized: target.volumeNormalized,
          panNormalized: target.panNormalized,
          muted: target.muted,
          soloed: target.soloed,
        },
        reason: 'Validated mixer target on simulated adapter',
      };
    }

    if (command.kind === 'transport.control') {
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          playing: this.#playing,
          paused: this.#paused,
          loopEnabled: this.#loopEnabled,
          bpm: this.#bpm,
        },
        reason: 'Validated transport control target',
      };
    }

    if (command.kind === 'plugin.param_write' || command.kind === 'plugin.bypass') {
      const target = this.#mixerChannels.flatMap((c) => c.pluginSlots).find((p) => p.containerId === command.targetRef || p.id === command.targetRef);
      if (!target) {
        return {
          valid: false,
          capabilitySupported: true,
          reason: `Plugin target not found: "${command.targetRef}"`,
        };
      }
      const paramIndex = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
      const curParam =
        target.parameters.status === 'available' ? target.parameters.value[paramIndex] : undefined;
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          pluginId: target.id,
          bypassed: target.bypassed,
          paramIndex,
          valueNormalized: curParam?.valueNormalized ?? null,
        },
        reason: 'Validated plugin parameter target',
      };
    }

    return { valid: true, capabilitySupported: true, reason: 'Validated simulated command' };
  }

  async execute(command: DawCommand, currentSnapshot: DawStateSnapshot): Promise<DawCommandResult> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs);
    if (this.#mutateBeforeTimeoutOrHang && command.kind === 'mixer.volume_pan_mute' && typeof command.params.deltaDb === 'number') {
      this.#mixerChannels = this.#mixerChannels.map((ch) =>
        ch.id === command.targetRef && ch.volumeDb !== null
          ? { ...ch, volumeDb: Number((ch.volumeDb + (command.params.deltaDb as number)).toFixed(3)) }
          : ch,
      );
    }
    if (this.#executeDelayMs > 0) await sleep(this.#executeDelayMs);
    const prov = this.#provenance(`simulated_execute:${command.capabilityId}`, 'applied');

    if (this.#failNextExecute) {
      const errMsg = this.#failNextExecute;
      this.#failNextExecute = null;
      return {
        commandId: command.commandId,
        sessionId: command.sessionId,
        ok: false,
        status: 'failed',
        stateFreshness: 'unknown',
        capabilityId: command.capabilityId,
        beforeState: null,
        afterState: null,
        verifiedByReadback: false,
        rollbackSupported: false,
        provenance: prov,
        evidence: [errMsg],
        error: { code: 'DAW_TIMEOUT', message: errMsg },
      };
    }

    const val = await this.validateCommand(command, currentSnapshot);
    if (!val.capabilitySupported || !val.valid) {
      return {
        commandId: command.commandId,
        sessionId: command.sessionId,
        ok: false,
        status: !val.capabilitySupported ? 'unsupported' : 'failed',
        stateFreshness: 'unknown',
        capabilityId: command.capabilityId,
        beforeState: null,
        afterState: null,
        verifiedByReadback: false,
        rollbackSupported: false,
        provenance: prov,
        evidence: [val.reason],
        error: {
          code: !val.capabilitySupported ? 'DAW_CAPABILITY_UNSUPPORTED' : 'DAW_INVALID_COMMAND',
          message: val.reason,
        },
      };
    }

    const beforeState = val.normalizedBeforeState ?? {};
    let afterState: Record<string, unknown> = { ...beforeState };

    if (command.kind === 'mixer.volume_pan_mute') {
      this.#mixerChannels = this.#mixerChannels.map((ch) => {
        if (ch.id !== command.targetRef) return ch;
        const rawDelta =
          typeof command.params.deltaDb === 'number' && !this.#simulatePostconditionMismatch
            ? command.params.deltaDb
            : typeof command.params.deltaDb === 'number'
              ? 0
              : null;
        const nextDb =
          this.#simulatePostconditionMismatch
            ? ch.volumeDb
            : typeof command.params.volumeDb === 'number'
              ? command.params.volumeDb
              : rawDelta !== null && ch.volumeDb !== null
                ? Number((ch.volumeDb + rawDelta).toFixed(3))
                : ch.volumeDb;
        const nextVol =
          typeof command.params.volumeNormalized === 'number' && !this.#simulatePostconditionMismatch
            ? command.params.volumeNormalized
            : ch.volumeNormalized;
        const nextPan =
          typeof command.params.panNormalized === 'number' && !this.#simulatePostconditionMismatch
            ? command.params.panNormalized
            : ch.panNormalized;
        const nextMuted = typeof command.params.muted === 'boolean' ? command.params.muted : ch.muted;
        const nextSoloed = typeof command.params.soloed === 'boolean' ? command.params.soloed : ch.soloed;
        afterState = {
          targetRef: ch.id,
          volumeDb: nextDb,
          volumeNormalized: nextVol,
          panNormalized: nextPan,
          muted: nextMuted,
          soloed: nextSoloed,
        };
        return { ...ch, volumeDb: nextDb, volumeNormalized: nextVol, panNormalized: nextPan, muted: nextMuted, soloed: nextSoloed };
      });
    } else if (command.kind === 'transport.control') {
      if (typeof command.params.playing === 'boolean' && !this.#simulatePostconditionMismatch) this.#playing = command.params.playing;
      if (typeof command.params.paused === 'boolean' && !this.#simulatePostconditionMismatch) this.#paused = command.params.paused;
      if (typeof command.params.loopEnabled === 'boolean' && !this.#simulatePostconditionMismatch) this.#loopEnabled = command.params.loopEnabled;
      if (typeof command.params.bpm === 'number' && !this.#simulatePostconditionMismatch) this.#bpm = command.params.bpm;
      afterState = { playing: this.#playing, paused: this.#paused, loopEnabled: this.#loopEnabled, bpm: this.#bpm };
    } else if (command.kind === 'plugin.param_write' || command.kind === 'plugin.bypass') {
      const paramIndex = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
      this.#mixerChannels = this.#mixerChannels.map((ch) => ({
        ...ch,
        pluginSlots: ch.pluginSlots.map((plug) => {
          if (plug.id !== command.targetRef && plug.containerId !== command.targetRef) return plug;
          const nextBypass =
            typeof command.params.bypassed === 'boolean' ? command.params.bypassed : plug.bypassed;
          let nextParams = plug.parameters;
          if (
            typeof command.params.valueNormalized === 'number' &&
            plug.parameters.status === 'available'
          ) {
            nextParams = {
              status: 'available',
              value: plug.parameters.value.map((p) =>
                p.index === paramIndex
                  ? { ...p, valueNormalized: command.params.valueNormalized as number }
                  : p,
              ),
            };
          }
          const updatedVal =
            nextParams.status === 'available' ? nextParams.value[paramIndex]?.valueNormalized : null;
          afterState = { pluginId: plug.id, bypassed: nextBypass, paramIndex, valueNormalized: updatedVal };
          return { ...plug, bypassed: nextBypass, parameters: nextParams };
        }),
      }));
    }

    const cap = this.manifest.capabilities.find((c) => c.capabilityId === command.capabilityId);
    return {
      commandId: command.commandId,
      sessionId: command.sessionId,
      ok: true,
      status: 'succeeded',
      stateFreshness: 'applied',
      capabilityId: command.capabilityId,
      beforeState,
      afterState,
      verifiedByReadback: true,
      rollbackSupported: cap?.rollbackSupported ?? true,
      provenance: prov,
      evidence: [`Simulated host applied "${command.kind}" on "${command.targetRef}" with readback verification`],
    };
  }

  #buildInstance(instanceId?: string): DawInstance {
    return {
      id: instanceId ?? `sim-inst-${this.manifest.adapterId}`,
      adapterId: this.manifest.adapterId,
      hostKind: 'simulated',
      hostName: 'XYP3RN Simulated DAW Fixture',
      edition: 'Simulation Test Harness',
      version: this.#hostVersion,
      apiVersion: this.#apiVersion,
      processId: null,
      transportKind: 'simulated',
      reachable: !this.#disconnectHealth,
      isSimulated: true,
      discoveredAt: new Date().toISOString(),
    };
  }

  #provenance(sourceEvidence: string, freshness: DawObservationProvenance['freshness']): DawObservationProvenance {
    return {
      observedAt: new Date().toISOString(),
      dawId: `sim-inst-${this.manifest.adapterId}`,
      adapterId: this.manifest.adapterId,
      hostVersion: this.#hostVersion,
      sourceEvidence,
      freshness,
    };
  }
}
