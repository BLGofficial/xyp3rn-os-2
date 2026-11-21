import { randomUUID } from 'node:crypto';
import {
  computeSnapshotDigest,
  DawBrainError,
  type DawAdapter,
  type DawAdapterManifest,
  type DawAdapterPushEvent,
  type DawAvailability,
  type DawBus,
  type DawCapability,
  type DawChannel,
  type DawCommand,
  type DawCommandResult,
  type DawCommandValidationResult,
  type DawConnection,
  type DawHealthReport,
  type DawInstance,
  type DawMixerChannel,
  type DawObservationProvenance,
  type DawPluginInstance,
  type DawPluginParameter,
  type DawRoutingConnection,
  type DawStateSnapshot,
  type DawTrack,
} from '../../daw-brain/index.ts';
import { inspectFlpProjectFile } from './flp-inspector.ts';
import { DefaultFlStudioHostProbe, type FlStudioHostProbe } from './host-probe.ts';
import { WinMmSysExTransport, type FlMidiSysExTransport } from './midi-transport.ts';
import {
  buildFlStudio2025Capabilities,
  FL_STUDIO_EXCLUDED_IN_PRODUCER,
  type FlExecutionProfile,
  type FlHostEnvironment,
  type FlIntegrationLogEntry,
  type FlLiveHelloPayload,
  type FlLiveParameterInfo,
  type FlLiveSnapshotPayload,
  type FlPluginInventoryEntry,
  type FlpParsedProject,
  type FlStudioAdapterOptions,
} from './types.ts';

const normalizeChannelKind = (ct: number): DawChannel['kind'] => {
  if (ct === 0) return 'sampler';
  if (ct === 1 || ct === 2) return 'generator';
  if (ct === 3) return 'layer';
  if (ct === 4) return 'audio_clip';
  return 'automation';
};

const isExcludedInProducer = (pluginName: string, edition: string): DawPluginInstance['editionCompatible'] => {
  if (/all plugins|signature/i.test(edition)) return 'verified';
  const lower = pluginName.toLowerCase();
  for (const excluded of FL_STUDIO_EXCLUDED_IN_PRODUCER) {
    if (lower.includes(excluded)) return 'excluded_by_edition';
  }
  return 'verified';
};

const normalizedFlVolumeToDb = (vol: number): number | null => {
  if (!Number.isFinite(vol) || vol <= 0) return null;
  // Image-Line `TackDefaultVolume = 0.8` = 0.0 dB unity
  const ratio = vol / 0.8;
  return Number((20 * Math.log10(ratio)).toFixed(2));
};

const dbToNormalizedFlVolume = (db: number): number => {
  const linear = 0.8 * Math.pow(10, db / 20);
  return Number(Math.max(0, Math.min(1, linear)).toFixed(6));
};

/**
 * Production Phase 11/16 FL Studio 2025 Producer Edition Adapter.
 * Strictly isolated from `core/daw-brain/`, using only Phase 09 verified mechanisms:
 * - Windows host binary/process/WinMM MIDI port inspection (`FlStudioHostProbe`)
 * - Bounded 7-bit SysEx IPC with `device_XYP3RNBrain.py` (`FlMidiSysExTransport`)
 * - Read-only `.flp` inspector + local VST/plugin database scanner
 * Defaults strictly to `'read_only'`. Opt-in `'controlled_safe_v1'` enables ONLY
 * verified low-risk transport/mixer/bypass operations through `DawCommandGateway`.
 */
export class FlStudio2025Adapter implements DawAdapter {
  readonly manifest: DawAdapterManifest;
  readonly #executionProfile: FlExecutionProfile;
  readonly #inPortName: string;
  readonly #outPortName: string;
  readonly #timeoutMs: number;
  readonly #midi: FlMidiSysExTransport;
  readonly #hostProbe: FlStudioHostProbe;
  readonly #includeParamsOnObserve: boolean;
  readonly #maxPluginsToInspectParams: number;
  readonly #maxParamsPerPlugin: number;

  readonly #sessions = new Map<
    string,
    {
      readonly sessionId: string;
      readonly connectionId: string;
      readonly instance: DawInstance;
      readonly edition: string;
      lastSnapshot: DawStateSnapshot | null;
      readonly pushListeners: Set<(event: DawAdapterPushEvent) => void>;
    }
  >();
  readonly #logs: FlIntegrationLogEntry[] = [];
  #logSeq = 0;

  constructor(options: FlStudioAdapterOptions = {}) {
    this.#executionProfile = options.executionProfile ?? 'read_only';
    this.#inPortName = options.inPortName ?? 'XYP3RN_IN';
    this.#outPortName = options.outPortName ?? 'XYP3RN_OUT';
    this.#timeoutMs = options.requestTimeoutMs ?? 2_500;
    this.#midi = options.midiTransport ?? new WinMmSysExTransport();
    this.#hostProbe = options.hostProbe ?? new DefaultFlStudioHostProbe();
    this.#includeParamsOnObserve = options.includeParametersOnObserve ?? true;
    this.#maxPluginsToInspectParams = options.maxPluginsToInspectParams ?? 4;
    this.#maxParamsPerPlugin = options.maxParamsPerPlugin ?? 32;

    this.manifest = {
      adapterId: options.adapterId ?? 'fl-studio-2025',
      displayName:
        this.#executionProfile === 'controlled_safe_v1'
          ? 'FL Studio 2025 (Producer Edition — Controlled Safe v1)'
          : 'FL Studio 2025 (Producer Edition — Read-Only v1)',
      hostKind: 'fl_studio',
      isSimulated: false,
      minSupportedHostVersion: '24.0.0',
      maxTestedHostVersion: '25.1.9999',
      minApiVersion: 20,
      transportKind: 'midi_sysex',
      capabilities: buildFlStudio2025Capabilities(this.#executionProfile),
    };

    this.#midi.onPushMessage((msg) => {
      if (msg.msgType === 0x20 && msg.json && typeof msg.json === 'object') {
        const payload = msg.json as FlLiveSnapshotPayload;
        for (const sess of this.#sessions.values()) {
          const snap = this.#mapSnapshot(sess.sessionId, sess.instance, payload, new Map());
          sess.lastSnapshot = snap;
          this.#log('info', 'fl.sysex.push_delta', sess.sessionId, {
            dirtyFlags: payload.dirtyFlags ?? null,
            bpm: payload.tempoBpm,
          });
          for (const listener of sess.pushListeners) {
            listener({ kind: 'snapshot_delta', sessionId: sess.sessionId, snapshot: snap });
          }
        }
      }
    });

    this.#midi.onDisconnect((reason) => {
      for (const sess of this.#sessions.values()) {
        this.#log('warn', 'fl.transport.disconnected', sess.sessionId, { reason });
        for (const listener of sess.pushListeners) {
          listener({ kind: 'disconnected', sessionId: sess.sessionId, reason });
        }
      }
    });
  }

  getIntegrationLogs(): readonly FlIntegrationLogEntry[] {
    return [...this.#logs];
  }

  async probeHostEnvironment(): Promise<FlHostEnvironment> {
    const env = await this.#hostProbe.probeHost({
      inPortName: this.#inPortName,
      outPortName: this.#outPortName,
    });
    this.#log('info', 'fl.host.probed', null, {
      installsFound: env.installations.filter((i) => i.exists).map((i) => `${i.label}:${i.fileVersion ?? '?'}`),
      runningPids: env.runningProcesses.map((p) => p.pid),
      loopMidiInstalled: env.loopMidiInstalled,
      configuredPortsReady: env.configuredInPortFound && env.configuredOutPortFound,
      missingPrerequisites: env.missingPrerequisites,
    });
    return env;
  }

  inspectSavedProject(flpPath: string): FlpParsedProject {
    const parsed = inspectFlpProjectFile(flpPath);
    this.#log('info', 'fl.project.flp_inspected', null, {
      projectPath: parsed.projectPath,
      flVersion: parsed.flVersion,
      sha256: parsed.sha256BeforeRead,
      channels: parsed.channelNames.length,
      plugins: parsed.pluginNames.length,
      warnings: parsed.warnings.length,
    });
    return parsed;
  }

  discoverProjects(limit = 32): readonly string[] {
    return this.#hostProbe.discoverProjects(limit);
  }

  discoverInstalledPlugins(): readonly FlPluginInventoryEntry[] {
    return this.#hostProbe.scanInstalledPlugins();
  }

  getCapabilities(): readonly DawCapability[] {
    return this.manifest.capabilities;
  }

  async discover(): Promise<readonly DawInstance[]> {
    const env = await this.probeHostEnvironment();
    const discovered: DawInstance[] = [];
    const now = new Date().toISOString();

    for (const inst of env.installations) {
      if (!inst.exists) continue;
      const version = inst.fileVersion ?? inst.productVersion ?? '25.1.6.4997';
      const proc = env.runningProcesses.find(
        (p) => p.executablePath?.toLowerCase() === inst.executablePath.toLowerCase(),
      ) ?? (env.runningProcesses.length > 0 && inst.label === 'FL Studio 2025' ? env.runningProcesses[0] : undefined);

      const midiReady = env.configuredInPortFound && env.configuredOutPortFound && env.controllerScriptInstalled;
      discovered.push({
        id: `fl-${inst.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        adapterId: this.manifest.adapterId,
        hostKind: 'fl_studio',
        hostName: inst.label,
        edition: 'Producer Edition (host default unverified until handshake)',
        version,
        apiVersion: 'unknown',
        processId: proc?.pid ?? null,
        transportKind: 'midi_sysex',
        reachable: Boolean(proc) && midiReady,
        isSimulated: false,
        discoveredAt: now,
      });
    }

    if (discovered.length === 0 && env.configuredInPortFound && env.configuredOutPortFound) {
      discovered.push({
        id: 'fl-sysex-endpoint',
        adapterId: this.manifest.adapterId,
        hostKind: 'fl_studio',
        hostName: 'FL Studio 2025 (SysEx Port Endpoint)',
        edition: 'Unknown until handshake',
        version: 'unknown',
        apiVersion: 'unknown',
        processId: env.runningProcesses[0]?.pid ?? null,
        transportKind: 'midi_sysex',
        reachable: true,
        isSimulated: false,
        discoveredAt: now,
      });
    }

    return discovered;
  }

  async connect(options: {
    readonly instanceId?: string | undefined;
    readonly projectPath?: string | undefined;
  } = {}): Promise<{
    readonly instance: DawInstance;
    readonly connection: DawConnection;
    readonly initialSnapshot: DawStateSnapshot;
  }> {
    this.#log('info', 'fl.connect.started', null, {
      instanceId: options.instanceId ?? null,
      projectPath: options.projectPath ?? null,
    });

    await this.#midi.open({ inPortName: this.#inPortName, outPortName: this.#outPortName });

    let hello: FlLiveHelloPayload;
    let rawSnap: FlLiveSnapshotPayload;
    try {
      hello = await this.#midi.request<FlLiveHelloPayload>(0x01, 0x02, {}, this.#timeoutMs);
      rawSnap = await this.#midi.request<FlLiveSnapshotPayload>(0x10, 0x11, {}, this.#timeoutMs);
    } catch (err) {
      await this.#midi.close().catch(() => undefined);
      this.#log('error', 'fl.connect.failed', null, { reason: (err as Error).message });
      throw err;
    }

    const sessionId = `fl-sess-${randomUUID().slice(0, 8)}`;
    const connectionId = `fl-conn-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const env = await this.#hostProbe.probeHost({
      inPortName: this.#inPortName,
      outPortName: this.#outPortName,
    }).catch(() => null);

    const instance: DawInstance = {
      id: options.instanceId ?? `fl-studio-${hello.version}`,
      adapterId: this.manifest.adapterId,
      hostKind: 'fl_studio',
      hostName: 'FL Studio',
      edition: hello.edition || 'Unknown',
      version: hello.version,
      apiVersion: String(hello.apiVersion),
      processId: env?.runningProcesses[0]?.pid ?? null,
      transportKind: 'midi_sysex',
      reachable: true,
      isSimulated: false,
      discoveredAt: now,
    };

    const paramMap = await this.#fetchBoundedParams(rawSnap);
    const initialSnapshot = this.#mapSnapshot(sessionId, instance, rawSnap, paramMap);

    const connection: DawConnection = {
      connectionId,
      instanceId: instance.id,
      adapterId: this.manifest.adapterId,
      sessionId,
      status: 'connected_read_only',
      activePermissionTier: 'observe',
      versionCompatibility: 'compatible',
      connectedAt: now,
      lastHeartbeatAt: now,
      lastRttMs: 0,
      consecutiveFailures: 0,
    };

    this.#sessions.set(sessionId, {
      sessionId,
      connectionId,
      instance,
      edition: hello.edition,
      lastSnapshot: initialSnapshot,
      pushListeners: new Set(),
    });

    this.#log('info', 'fl.connect.succeeded', sessionId, {
      version: hello.version,
      edition: hello.edition,
      apiVersion: hello.apiVersion,
      title: hello.title,
      channels: rawSnap.channels.length,
      mixerTracks: rawSnap.mixerTracks.length,
    });

    return { instance, connection, initialSnapshot };
  }

  async disconnect(connectionId: string): Promise<void> {
    for (const [sid, entry] of this.#sessions.entries()) {
      if (entry.connectionId === connectionId) {
        this.#sessions.delete(sid);
        this.#log('info', 'fl.disconnect.completed', sid, { connectionId });
      }
    }
    if (this.#sessions.size === 0) {
      await this.#midi.close();
    }
  }

  async healthCheck(connectionId?: string): Promise<DawHealthReport> {
    const entry = connectionId
      ? [...this.#sessions.values()].find((s) => s.connectionId === connectionId)
      : [...this.#sessions.values()][0];

    const hostVersion = entry?.instance.version ?? 'unknown';
    const dawId = entry?.instance.id ?? 'fl-studio-2025';
    const startMs = Date.now();

    if (!this.#midi.isOpen()) {
      const env = await this.#hostProbe.probeHost({
        inPortName: this.#inPortName,
        outPortName: this.#outPortName,
      }).catch(() => null);
      const missing = env?.missingPrerequisites.length
        ? env.missingPrerequisites
        : [`SysEx MIDI transport (${this.#inPortName} / ${this.#outPortName}) disconnected`];
      this.#log('warn', 'fl.health.offline', entry?.sessionId ?? null, { missing });
      return {
        adapterId: this.manifest.adapterId,
        healthy: false,
        reachable: false,
        rttMs: Date.now() - startMs,
        degradedReason: missing[0] ?? 'FL Studio SysEx transport offline',
        missingPrerequisites: missing,
        provenance: {
          observedAt: new Date().toISOString(),
          dawId,
          adapterId: this.manifest.adapterId,
          hostVersion,
          sourceEvidence: 'WinMM MIDI port offline / controller disconnected',
          freshness: 'stale',
        },
      };
    }

    try {
      await this.#midi.request(0x03, 0x04, { ts: Date.now() }, Math.min(this.#timeoutMs, 1_500));
      const rttMs = Date.now() - startMs;
      return {
        adapterId: this.manifest.adapterId,
        healthy: true,
        reachable: true,
        rttMs,
        degradedReason: null,
        missingPrerequisites: [],
        provenance: {
          observedAt: new Date().toISOString(),
          dawId,
          adapterId: this.manifest.adapterId,
          hostVersion,
          sourceEvidence: `SysEx PING_RESP verified in ${rttMs}ms`,
          freshness: 'observed',
        },
      };
    } catch (err) {
      const rttMs = Date.now() - startMs;
      const reason = (err as Error).message;
      this.#log('warn', 'fl.health.degraded', entry?.sessionId ?? null, { reason, rttMs });
      return {
        adapterId: this.manifest.adapterId,
        healthy: false,
        reachable: false,
        rttMs,
        degradedReason: reason,
        missingPrerequisites: [`SysEx PING failed: ${reason}`],
        provenance: {
          observedAt: new Date().toISOString(),
          dawId,
          adapterId: this.manifest.adapterId,
          hostVersion,
          sourceEvidence: `SysEx PING failed after ${rttMs}ms`,
          freshness: 'stale',
        },
      };
    }
  }

  async observe(sessionId: string): Promise<DawStateSnapshot> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new DawBrainError('DAW_SESSION_NOT_FOUND', `FL Studio session not found: "${sessionId}"`);
    }
    if (!this.#midi.isOpen()) {
      await this.#midi.open({ inPortName: this.#inPortName, outPortName: this.#outPortName });
    }
    const rawSnap = await this.#midi.request<FlLiveSnapshotPayload>(0x10, 0x11, {}, this.#timeoutMs);
    const paramMap = await this.#fetchBoundedParams(rawSnap);
    const snapshot = this.#mapSnapshot(sessionId, entry.instance, rawSnap, paramMap);
    entry.lastSnapshot = snapshot;
    this.#log('info', 'fl.session.observed', sessionId, {
      bpm: snapshot.transport.tempo.bpm,
      playing: snapshot.transport.playing,
      digest: snapshot.stateDigest.slice(0, 12),
    });
    return snapshot;
  }

  subscribe(sessionId: string, listener: (event: DawAdapterPushEvent) => void): () => void {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new DawBrainError('DAW_SESSION_NOT_FOUND', `FL Studio session not found: "${sessionId}"`);
    }
    entry.pushListeners.add(listener);
    return () => {
      entry.pushListeners.delete(listener);
    };
  }

  async validateCommand(command: DawCommand, currentSnapshot?: DawStateSnapshot): Promise<DawCommandValidationResult> {
    const cap = this.manifest.capabilities.find((c) => c.capabilityId === command.capabilityId);
    if (this.#executionProfile !== 'controlled_safe_v1' || !cap || cap.supportLevel !== 'SUPPORTED') {
      const reason =
        cap?.limitations?.join('; ') ||
        cap?.notes ||
        `Capability "${command.capabilityId}" is UNSUPPORTED in Phase 11 read-only FL Studio 2025 adapter`;
      this.#log('warn', 'fl.mutation.refused_validation', command.sessionId, {
        commandId: command.commandId,
        kind: command.kind,
        capabilityId: command.capabilityId,
        reason,
      });
      return {
        valid: false,
        capabilitySupported: false,
        reason,
      };
    }

    const snap = currentSnapshot ?? this.#sessions.get(command.sessionId)?.lastSnapshot ?? null;
    if (!snap) {
      return {
        valid: false,
        capabilitySupported: true,
        reason: `No snapshot observed for FL Studio session "${command.sessionId}"`,
      };
    }

    if (command.kind === 'transport.control') {
      if (command.params.recording === true) {
        return {
          valid: false,
          capabilitySupported: false,
          reason: 'FL Studio controlled_safe_v1 refuses unattended recording arming',
        };
      }
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          playing: snap.transport.playing,
          loopEnabled: snap.transport.loopEnabled,
          bpm: snap.transport.tempo.bpm,
        },
        reason: 'Validated FL Studio transport control command',
      };
    }

    if (command.kind === 'mixer.volume_pan_mute') {
      const target =
        snap.mixerChannels.status === 'available'
          ? snap.mixerChannels.value.find((ch) => ch.id === command.targetRef)
          : undefined;
      if (!target) {
        return {
          valid: false,
          capabilitySupported: true,
          reason: `FL Studio mixer insert not found: "${command.targetRef}"`,
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
        reason: 'Validated FL Studio mixer control command',
      };
    }

    if (command.kind === 'plugin.bypass') {
      const plug =
        snap.plugins.status === 'available'
          ? snap.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
          : undefined;
      if (!plug || plug.slotIndex < 0) {
        return {
          valid: false,
          capabilitySupported: true,
          reason: `FL Studio mixer FX slot not found for bypass: "${command.targetRef}"`,
        };
      }
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          pluginId: plug.id,
          bypassed: plug.bypassed,
        },
        reason: 'Validated FL Studio plugin bypass toggle',
      };
    }

    return {
      valid: false,
      capabilitySupported: false,
      reason: `Unsupported command kind "${command.kind}" in FL Studio controlled_safe_v1`,
    };
  }

  async execute(command: DawCommand, currentSnapshot: DawStateSnapshot): Promise<DawCommandResult> {
    const val = await this.validateCommand(command, currentSnapshot);
    if (!val.capabilitySupported || !val.valid || this.#executionProfile !== 'controlled_safe_v1') {
      this.#log('warn', 'fl.mutation.refused_execute', command.sessionId, {
        commandId: command.commandId,
        kind: command.kind,
        capabilityId: command.capabilityId,
        reason: val.reason,
      });
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
        provenance: {
          ...currentSnapshot.provenance,
          observedAt: new Date().toISOString(),
          sourceEvidence:
            this.#executionProfile === 'controlled_safe_v1'
              ? 'FL Studio 2025 Phase 16 controlled_safe_v1 refusal'
              : 'FL Studio 2025 Phase 11 adapter (observation-only lock)',
        },
        evidence: [val.reason],
        error: {
          code: !val.capabilitySupported ? 'DAW_CAPABILITY_UNSUPPORTED' : 'DAW_INVALID_COMMAND',
          message: val.reason,
        },
      };
    }

    const beforeState = val.normalizedBeforeState ?? {};
    const prov: DawObservationProvenance = {
      ...currentSnapshot.provenance,
      observedAt: new Date().toISOString(),
      sourceEvidence: `FL Studio MIDI SysEx controlled_safe_v1 (${command.capabilityId})`,
      freshness: 'applied',
    };

    try {
      if (command.kind === 'transport.control') {
        const res = await this.#midi.request<{
          readonly ok: boolean;
          readonly playing: boolean;
          readonly loopMode: 'pattern' | 'song';
          readonly tempoBpm: number;
        }>(
          0x30,
          0x31,
          {
            playing: command.params.playing,
            loopMode:
              typeof command.params.loopEnabled === 'boolean'
                ? (command.params.loopEnabled ? 'pattern' : 'song')
                : undefined,
            tempoBpm: command.params.bpm,
          },
          this.#timeoutMs,
        );
        return {
          commandId: command.commandId,
          sessionId: command.sessionId,
          ok: res.ok,
          status: res.ok ? 'succeeded' : 'failed',
          stateFreshness: 'applied',
          capabilityId: command.capabilityId,
          beforeState,
          afterState: {
            playing: res.playing,
            loopEnabled: res.loopMode === 'pattern',
            bpm: res.tempoBpm,
          },
          verifiedByReadback: res.ok,
          rollbackSupported: true,
          provenance: prov,
          evidence: [`FL Studio SysEx 0x30 applied transport update (bpm=${res.tempoBpm}, playing=${res.playing})`],
        };
      }

      if (command.kind === 'mixer.volume_pan_mute') {
        const curCh =
          currentSnapshot.mixerChannels.status === 'available'
            ? currentSnapshot.mixerChannels.value.find((ch) => ch.id === command.targetRef)
            : undefined;
        const mixerIndex = curCh?.index ?? Number(command.targetRef.split(':').pop() ?? 1);
        let nextVolNorm =
          typeof command.params.volumeNormalized === 'number' ? command.params.volumeNormalized : undefined;
        if (typeof command.params.volumeDb === 'number') {
          nextVolNorm = dbToNormalizedFlVolume(command.params.volumeDb);
        } else if (typeof command.params.deltaDb === 'number' && curCh?.volumeDb !== null && curCh?.volumeDb !== undefined) {
          nextVolNorm = dbToNormalizedFlVolume(curCh.volumeDb + command.params.deltaDb);
        }

        const res = await this.#midi.request<{
          readonly ok: boolean;
          readonly track: {
            readonly index: number;
            readonly volumeNormalized: number;
            readonly panNormalized: number;
            readonly muted: boolean;
            readonly soloed: boolean;
          } | null;
        }>(
          0x32,
          0x33,
          {
            mixerIndex,
            volumeNormalized: nextVolNorm,
            panNormalized: command.params.panNormalized,
            muted: command.params.muted,
            soloed: command.params.soloed,
          },
          this.#timeoutMs,
        );
        const afterVolDb = res.track ? normalizedFlVolumeToDb(res.track.volumeNormalized) : null;
        return {
          commandId: command.commandId,
          sessionId: command.sessionId,
          ok: res.ok && res.track !== null,
          status: res.ok && res.track ? 'succeeded' : 'failed',
          stateFreshness: 'applied',
          capabilityId: command.capabilityId,
          beforeState,
          afterState: res.track
            ? {
                targetRef: command.targetRef,
                volumeDb: afterVolDb,
                volumeNormalized: res.track.volumeNormalized,
                panNormalized: res.track.panNormalized,
                muted: res.track.muted,
                soloed: res.track.soloed,
              }
            : null,
          verifiedByReadback: res.ok && res.track !== null,
          rollbackSupported: true,
          provenance: prov,
          evidence: [`FL Studio SysEx 0x32 applied mixer insert ${mixerIndex} update`],
        };
      }

      if (command.kind === 'plugin.bypass') {
        const plug =
          currentSnapshot.plugins.status === 'available'
            ? currentSnapshot.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
            : undefined;
        const mixerIndex = Number(plug?.containerId.split(':').pop() ?? 0);
        const slotIndex = plug?.slotIndex ?? 0;
        const res = await this.#midi.request<{
          readonly ok: boolean;
          readonly bypassed: boolean;
        }>(
          0x34,
          0x35,
          { mixerIndex, slotIndex, bypassed: Boolean(command.params.bypassed) },
          this.#timeoutMs,
        );
        return {
          commandId: command.commandId,
          sessionId: command.sessionId,
          ok: res.ok,
          status: res.ok ? 'succeeded' : 'failed',
          stateFreshness: 'applied',
          capabilityId: command.capabilityId,
          beforeState,
          afterState: { pluginId: plug?.id ?? command.targetRef, bypassed: res.bypassed },
          verifiedByReadback: res.ok,
          rollbackSupported: true,
          provenance: prov,
          evidence: [`FL Studio SysEx 0x34 applied plugin bypass=${res.bypassed} on insert=${mixerIndex} slot=${slotIndex}`],
        };
      }
    } catch (err) {
      const code = err instanceof DawBrainError ? err.code : 'DAW_TIMEOUT';
      return {
        commandId: command.commandId,
        sessionId: command.sessionId,
        ok: false,
        status: 'failed',
        stateFreshness: 'unknown',
        capabilityId: command.capabilityId,
        beforeState,
        afterState: null,
        verifiedByReadback: false,
        rollbackSupported: false,
        provenance: prov,
        evidence: [(err as Error).message],
        error: { code, message: (err as Error).message },
      };
    }

    return {
      commandId: command.commandId,
      sessionId: command.sessionId,
      ok: false,
      status: 'unsupported',
      stateFreshness: 'unknown',
      capabilityId: command.capabilityId,
      beforeState: null,
      afterState: null,
      verifiedByReadback: false,
      rollbackSupported: false,
      provenance: prov,
      evidence: ['Unhandled controlled write kind'],
      error: { code: 'DAW_CAPABILITY_UNSUPPORTED', message: `Unhandled kind ${command.kind}` },
    };
  }

  async #fetchBoundedParams(
    rawSnap: FlLiveSnapshotPayload,
  ): Promise<Map<string, readonly FlLiveParameterInfo[]>> {
    const out = new Map<string, readonly FlLiveParameterInfo[]>();
    if (!this.#includeParamsOnObserve || this.#maxPluginsToInspectParams <= 0) {
      return out;
    }

    let inspected = 0;
    for (const track of rawSnap.mixerTracks) {
      for (const slot of track.plugins) {
        if (inspected >= this.#maxPluginsToInspectParams) break;
        if (slot.paramCount <= 0) continue;
        inspected += 1;
        try {
          const res = await this.#midi.request<{ readonly parameters?: readonly FlLiveParameterInfo[] }>(
            0x12,
            0x13,
            {
              containerKind: 'mixer',
              containerIndex: track.index,
              slotIndex: slot.slotIndex,
              maxParams: this.#maxParamsPerPlugin,
            },
            this.#timeoutMs,
          );
          if (res.parameters) {
            out.set(`mixer:${track.index}:${slot.slotIndex}`, res.parameters);
          }
        } catch {
          // Leave parameters explicitly unavailable on individual slot timeout
        }
      }
      if (inspected >= this.#maxPluginsToInspectParams) break;
    }
    return out;
  }

  #mapSnapshot(
    sessionId: string,
    instance: DawInstance,
    raw: FlLiveSnapshotPayload,
    paramMap: ReadonlyMap<string, readonly FlLiveParameterInfo[]>,
  ): DawStateSnapshot {
    const provenance: DawObservationProvenance = {
      observedAt: raw.observedAt || new Date().toISOString(),
      dawId: instance.id,
      adapterId: this.manifest.adapterId,
      hostVersion: raw.version || instance.version,
      sourceEvidence: `FL Studio MIDI SysEx controller (${this.#inPortName} <-> ${this.#outPortName})`,
      freshness: 'observed',
    };

    const tracks: DawTrack[] = raw.playlistTrackNames.map((name, idx) => ({
      id: `playlist:track:${idx + 1}`,
      index: idx + 1,
      name,
      kind: 'audio',
      color: null,
      muted: false,
      soloed: false,
      armed: false,
      mixerChannelId: null,
    }));

    const channels: DawChannel[] = raw.channels.map((c) => ({
      id: `channel:${c.index}`,
      index: c.index,
      name: c.name,
      kind: normalizeChannelKind(c.channelType),
      targetMixerChannelId: c.targetMixerIndex !== null ? `mixer:insert:${c.targetMixerIndex}` : null,
      muted: c.muted,
      soloed: c.soloed,
      volumeNormalized: 0.78125,
      panNormalized: 0,
    }));

    const allPlugins: DawPluginInstance[] = [];

    for (const c of raw.channels) {
      if (!c.pluginName) continue;
      const editionCompatible = isExcludedInProducer(c.pluginName, raw.edition || instance.edition);
      allPlugins.push({
        id: `plugin:channel:${c.index}`,
        slotIndex: -1,
        containerId: `channel:${c.index}`,
        name: c.pluginName,
        vendor: null,
        format: 'UNKNOWN',
        bypassed: c.muted,
        mixLevel: null,
        editionCompatible,
        parameterCount: c.pluginParamCount ?? 0,
        parameters: {
          status: 'unavailable',
          reason: 'Channel generator parameters fetched on explicit targeted inspection only',
        },
      });
    }

    const mixerChannels: DawMixerChannel[] = raw.mixerTracks.map((mt) => {
      const slotPlugins: DawPluginInstance[] = mt.plugins.map((pl) => {
        const key = `mixer:${mt.index}:${pl.slotIndex}`;
        const rawParams = paramMap.get(key) ?? raw.parameters?.filter(
          (p) => p.containerKind === 'mixer' && p.containerIndex === mt.index && p.slotIndex === pl.slotIndex,
        );
        const mappedParams: DawAvailability<readonly DawPluginParameter[]> =
          rawParams && rawParams.length > 0
            ? {
                status: 'available',
                value: rawParams.map((p) => ({
                  index: p.paramIndex,
                  id: `param:${mt.index}:${pl.slotIndex}:${p.paramIndex}`,
                  name: p.name,
                  valueNormalized: p.valueNormalized,
                  displayValue: p.displayValue,
                  defaultNormalized: null,
                  unit: null,
                  readable: true,
                  writable: false,
                })),
              }
            : {
                status: 'unavailable',
                reason:
                  pl.paramCount === 0
                    ? 'Plugin exposes 0 automatable parameters via FL wrapper'
                    : 'Parameters not fetched in bounded sweep (use targeted inspection)',
              };

        const inst: DawPluginInstance = {
          id: `plugin:mixer:${mt.index}:${pl.slotIndex}`,
          slotIndex: pl.slotIndex,
          containerId: `mixer:insert:${mt.index}`,
          name: pl.name,
          vendor: null,
          format: 'UNKNOWN',
          bypassed: pl.bypassed ?? false,
          mixLevel: pl.mixLevel,
          editionCompatible: isExcludedInProducer(pl.name, raw.edition || instance.edition),
          parameterCount: pl.paramCount,
          parameters: mappedParams,
        };
        allPlugins.push(inst);
        return inst;
      });

      return {
        id: `mixer:insert:${mt.index}`,
        index: mt.index,
        name: mt.name,
        isMaster: mt.isMaster,
        volumeNormalized: mt.volumeNormalized,
        volumeDb: normalizedFlVolumeToDb(mt.volumeNormalized),
        panNormalized: mt.panNormalized,
        muted: mt.muted,
        soloed: mt.soloed,
        stereoSeparation: null,
        peakDb:
          mt.peakNormalized !== null && mt.peakNormalized > 0
            ? Number((20 * Math.log10(mt.peakNormalized)).toFixed(2))
            : null,
        pluginSlots: slotPlugins,
      };
    });

    const buses: DawBus[] = raw.mixerTracks
      .filter((mt) => mt.isMaster || mt.name.toLowerCase().includes('bus') || mt.name.toLowerCase().includes('verb'))
      .map((mt) => ({
        id: `mixer:insert:${mt.index}`,
        mixerChannelId: `mixer:insert:${mt.index}`,
        name: mt.name,
        role: mt.isMaster ? 'master' : mt.name.toLowerCase().includes('verb') ? 'send' : 'submix',
        sourceIds: raw.mixerTracks
          .filter((other) => other.index !== mt.index && other.routeTargets.includes(mt.index))
          .map((other) => `mixer:insert:${other.index}`),
        destinationId: mt.routeTargets[0] !== undefined ? `mixer:insert:${mt.routeTargets[0]}` : null,
      }));

    const routing: DawRoutingConnection[] = [];
    for (const mt of raw.mixerTracks) {
      for (const dst of mt.routeTargets) {
        routing.push({
          id: `route:${mt.index}->${dst}`,
          sourceId: `mixer:insert:${mt.index}`,
          targetId: `mixer:insert:${dst}`,
          sendNormalized: 1,
          sendDb: null,
          enabled: true,
          preFader: false,
          sidechain: false,
        });
      }
    }

    const baseSnap: DawStateSnapshot = {
      snapshotId: `flsnap-${randomUUID().slice(0, 8)}`,
      sessionId,
      freshness: 'observed',
      provenance,
      transport: {
        playing: raw.playing,
        paused: !raw.playing && raw.songPosMs > 0,
        recording: raw.recording,
        loopEnabled: raw.loopMode === 'pattern',
        songPositionBeats: raw.songPosBeats ?? Number(((raw.songPosMs / 1000) * (raw.tempoBpm / 60)).toFixed(3)),
        songPositionSeconds: Number((raw.songPosMs / 1000).toFixed(3)),
        tempo: { bpm: raw.tempoBpm, freshness: 'observed' },
        timeSignature: {
          numerator: raw.timeSignatureNumerator ?? 4,
          denominator: raw.timeSignatureDenominator ?? 4,
          ppq: raw.ppq || 96,
        },
        provenance,
      },
      tracks:
        tracks.length > 0
          ? { status: 'available', value: tracks }
          : {
              status: 'unavailable',
              reason: 'Playlist track names unavailable or zero named playlist tracks reported',
            },
      channels: { status: 'available', value: channels },
      mixerChannels: { status: 'available', value: mixerChannels },
      buses: { status: 'available', value: buses },
      routing: { status: 'available', value: routing },
      plugins: { status: 'available', value: allPlugins },
      automationLanes: {
        status: 'unsupported',
        reason: 'FL Studio MIDI Scripting API does not expose Playlist Automation Clip splines/points',
      },
      audioClips: {
        status: 'unsupported',
        reason: 'FL Studio MIDI Scripting API does not expose live timeline audio clip positions/paths',
      },
      midiClips: {
        status: 'unsupported',
        reason: 'FL Studio MIDI Scripting API does not expose full Piano Roll clip note arrays over SysEx',
      },
      markers: {
        status: 'unsupported',
        reason: 'FL Studio MIDI Scripting API does not expose Playlist timeline marker structures reliably',
      },
      regions: {
        status: 'unsupported',
        reason: 'FL Studio uses Playlist Arrangements rather than named export regions',
      },
      stateDigest: '',
    };

    return {
      ...baseSnap,
      stateDigest: computeSnapshotDigest(baseSnap),
    };
  }

  #log(
    level: FlIntegrationLogEntry['level'],
    event: string,
    sessionId: string | null,
    details: Readonly<Record<string, unknown>>,
  ): void {
    this.#logSeq += 1;
    this.#logs.push({
      seq: this.#logSeq,
      timestamp: new Date().toISOString(),
      level,
      event,
      sessionId,
      details,
    });
    if (this.#logs.length > 500) {
      this.#logs.shift();
    }
  }
}
