import { randomUUID } from 'node:crypto';
import {
  computeSnapshotDigest,
  DawBrainError,
  type DawAdapter,
  type DawAdapterManifest,
  type DawAdapterPushEvent,
  type DawAudioClip,
  type DawAutomationLane,
  type DawBus,
  type DawCapability,
  type DawChannel,
  type DawCommand,
  type DawCommandResult,
  type DawCommandValidationResult,
  type DawConnection,
  type DawHealthReport,
  type DawInstance,
  type DawMarker,
  type DawMidiClip,
  type DawMixerChannel,
  type DawObservationProvenance,
  type DawPluginInstance,
  type DawRegion,
  type DawRoutingConnection,
  type DawStateSnapshot,
  type DawTrack,
} from '../../daw-brain/index.ts';
import { DefaultReaperHostProbe, type ReaperHostProbe } from './host-probe.ts';
import { HttpReaperBridgeTransport, type ReaperBridgeTransport } from './reaper-transport.ts';
import { inspectRppProjectFile } from './rpp-inspector.ts';
import {
  buildReaperCapabilities,
  type ReaperAdapterOptions,
  type ReaperExecutionProfile,
  type ReaperHostEnvironment,
  type ReaperIntegrationLogEntry,
  type ReaperLiveHelloPayload,
  type ReaperLiveSnapshotPayload,
  type ReaperPluginInventoryEntry,
  type RppParsedProject,
} from './types.ts';

const linearReaperVolToDb = (vol: number): number | null => {
  if (!Number.isFinite(vol) || vol <= 0) return null;
  // REAPER unity D_VOL == 1.0 == 0.0 dBFS (fundamentally different from FL Studio's 0.8 unity!)
  return Number((20 * Math.log10(vol)).toFixed(2));
};

const dbToLinearReaperVol = (db: number): number =>
  Number(Math.max(0, Math.min(2, Math.pow(10, db / 20))).toFixed(6));

/**
 * Secondary production DAW Adapter for Cockos REAPER (`core/daw-adapters/reaper/`).
 * Strictly isolated from `core/daw-brain/` and `core/daw-adapters/fl-studio-2025/`.
 * Translates REAPER's unified MediaTrack, linear-gain (`D_VOL = 1.0` unity),
 * dynamic track/FX instantiation, envelope/marker/region timeline, and loopback HTTP/ReaScript IPC
 * cleanly into Universal DAW Brain contracts without forcing FL-specific assumptions.
 */
export class ReaperAdapter implements DawAdapter {
  readonly manifest: DawAdapterManifest;
  readonly #executionProfile: ReaperExecutionProfile;
  readonly #timeoutMs: number;
  readonly #transport: ReaperBridgeTransport;
  readonly #hostProbe: ReaperHostProbe;

  readonly #sessions = new Map<
    string,
    {
      readonly sessionId: string;
      readonly connectionId: string;
      readonly instance: DawInstance;
      lastSnapshot: DawStateSnapshot | null;
      readonly pushListeners: Set<(event: DawAdapterPushEvent) => void>;
    }
  >();
  readonly #logs: ReaperIntegrationLogEntry[] = [];
  #logSeq = 0;

  constructor(options: ReaperAdapterOptions = {}) {
    this.#executionProfile = options.executionProfile ?? 'controlled_safe_v1';
    this.#timeoutMs = options.requestTimeoutMs ?? 2_500;
    this.#transport = options.transport ?? new HttpReaperBridgeTransport(options.hostUrl);
    this.#hostProbe = options.hostProbe ?? new DefaultReaperHostProbe();

    this.manifest = {
      adapterId: options.adapterId ?? 'reaper',
      displayName: `Cockos REAPER (${this.#executionProfile})`,
      hostKind: 'reaper',
      isSimulated: false,
      minSupportedHostVersion: '6.0.0',
      maxTestedHostVersion: '7.99.9999',
      minApiVersion: 600,
      transportKind: 'http_ipc',
      capabilities: buildReaperCapabilities(this.#executionProfile),
    };

    this.#transport.onPushEvent((ev) => {
      if (ev.kind === 'state_changed') {
        for (const sess of this.#sessions.values()) {
          const snap = this.#mapSnapshot(sess.sessionId, sess.instance, ev.snapshot);
          sess.lastSnapshot = snap;
          this.#log('info', 'reaper.state_change_pushed', sess.sessionId, {
            changeCount: ev.snapshot.projectStateChangeCount,
            bpm: ev.snapshot.tempoBpm,
          });
          for (const listener of sess.pushListeners) {
            listener({ kind: 'snapshot_delta', sessionId: sess.sessionId, snapshot: snap });
          }
        }
      } else if (ev.kind === 'disconnected') {
        for (const sess of this.#sessions.values()) {
          this.#log('warn', 'reaper.bridge.disconnected', sess.sessionId, { reason: ev.reason });
          for (const listener of sess.pushListeners) {
            listener({ kind: 'disconnected', sessionId: sess.sessionId, reason: ev.reason });
          }
        }
      }
    });
  }

  getIntegrationLogs(): readonly ReaperIntegrationLogEntry[] {
    return [...this.#logs];
  }

  async probeHostEnvironment(): Promise<ReaperHostEnvironment> {
    const env = await this.#hostProbe.probeHost();
    this.#log('info', 'reaper.host.probed', null, {
      installsFound: env.installations.filter((i) => i.exists).map((i) => i.executablePath),
      runningPids: env.runningProcesses.map((p) => p.pid),
      appDataExists: env.appDataExists,
      luaBridgeInstalled: env.luaBridgeInstalled,
      missingPrerequisites: env.missingPrerequisites,
      warnings: env.warnings,
    });
    return env;
  }

  inspectSavedProject(rppPath: string): RppParsedProject {
    const parsed = inspectRppProjectFile(rppPath);
    this.#log('info', 'reaper.project.rpp_inspected', null, {
      projectPath: parsed.projectPath,
      version: parsed.reaperVersion,
      sha256: parsed.sha256BeforeRead,
      tracks: parsed.tracks.length,
    });
    return parsed;
  }

  discoverProjects(limit = 20): readonly string[] {
    return this.#hostProbe.discoverProjects(limit);
  }

  discoverInstalledPlugins(): readonly ReaperPluginInventoryEntry[] {
    return this.#hostProbe.scanInstalledPlugins();
  }

  getCapabilities(): readonly DawCapability[] {
    return this.manifest.capabilities;
  }

  async discover(): Promise<readonly DawInstance[]> {
    const env = await this.probeHostEnvironment();
    const now = new Date().toISOString();
    const installed = env.installations.filter((i) => i.exists);
    if (installed.length === 0) {
      return [
        {
          id: 'reaper-uninstalled',
          adapterId: this.manifest.adapterId,
          hostKind: 'reaper',
          hostName: 'REAPER (Not Installed)',
          edition: 'Unknown',
          version: '0.0.0',
          apiVersion: '0',
          processId: null,
          transportKind: 'http_ipc',
          reachable: false,
          isSimulated: false,
          discoveredAt: now,
        },
      ];
    }

    return installed.map((inst, idx) => {
      const proc =
        env.runningProcesses.find((p) => p.executablePath?.toLowerCase() === inst.executablePath.toLowerCase()) ??
        env.runningProcesses[0];
      return {
        id: `reaper-${idx}-${inst.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        adapterId: this.manifest.adapterId,
        hostKind: 'reaper',
        hostName: `Cockos ${inst.label}`,
        edition: 'Commercial / Evaluation (full ReaScript feature parity)',
        version: inst.fileVersion ?? inst.productVersion ?? '7.18',
        apiVersion: '718',
        processId: proc?.pid ?? null,
        transportKind: 'http_ipc',
        reachable: Boolean(proc) && (env.luaBridgeInstalled || env.webRemoteConfiguredPort !== null || this.#transport.isOpen()),
        isSimulated: false,
        discoveredAt: now,
      };
    });
  }

  async connect(options: {
    readonly instanceId?: string | undefined;
    readonly projectPath?: string | undefined;
  } = {}): Promise<{
    readonly instance: DawInstance;
    readonly connection: DawConnection;
    readonly initialSnapshot: DawStateSnapshot;
  }> {
    this.#log('info', 'reaper.connect.started', null, {
      instanceId: options.instanceId ?? null,
      projectPath: options.projectPath ?? null,
    });

    const hello: ReaperLiveHelloPayload = await this.#transport.open();
    let rawSnap: ReaperLiveSnapshotPayload;
    try {
      rawSnap = await this.#transport.call<ReaperLiveSnapshotPayload>('snapshot', {}, this.#timeoutMs);
    } catch (err) {
      await this.#transport.close().catch(() => undefined);
      this.#log('error', 'reaper.connect.failed', null, { reason: (err as Error).message });
      throw err;
    }

    const sessionId = `rpr-sess-${randomUUID().slice(0, 8)}`;
    const connectionId = `rpr-conn-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const env = await this.#hostProbe.probeHost().catch(() => null);
    const instance: DawInstance = {
      id: options.instanceId ?? `reaper-${hello.version}`,
      adapterId: this.manifest.adapterId,
      hostKind: 'reaper',
      hostName: 'Cockos REAPER',
      edition: 'Standard License / Eval (full API)',
      version: hello.version,
      apiVersion: String(hello.apiVersion),
      processId: env?.runningProcesses[0]?.pid ?? null,
      transportKind: 'http_ipc',
      reachable: true,
      isSimulated: false,
      discoveredAt: now,
    };

    const initialSnapshot = this.#mapSnapshot(sessionId, instance, rawSnap);
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
      lastSnapshot: initialSnapshot,
      pushListeners: new Set(),
    });

    this.#log('info', 'reaper.connect.succeeded', sessionId, {
      version: hello.version,
      apiVersion: hello.apiVersion,
      projectTitle: rawSnap.projectTitle,
      trackCount: rawSnap.tracks.length,
    });

    return { instance, connection, initialSnapshot };
  }

  async disconnect(connectionId: string): Promise<void> {
    for (const [sid, entry] of this.#sessions.entries()) {
      if (entry.connectionId === connectionId) {
        this.#sessions.delete(sid);
        this.#log('info', 'reaper.disconnect.completed', sid, { connectionId });
      }
    }
    if (this.#sessions.size === 0) {
      await this.#transport.close();
    }
  }

  async healthCheck(connectionId?: string): Promise<DawHealthReport> {
    const entry = connectionId
      ? [...this.#sessions.values()].find((s) => s.connectionId === connectionId)
      : [...this.#sessions.values()][0];
    const startMs = Date.now();
    const dawId = entry?.instance.id ?? 'reaper';
    const hostVersion = entry?.instance.version ?? 'unknown';

    if (!this.#transport.isOpen()) {
      const env = await this.#hostProbe.probeHost().catch(() => null);
      const missing = env?.missingPrerequisites.length
        ? env.missingPrerequisites
        : ['REAPER loopback bridge disconnected'];
      return {
        adapterId: this.manifest.adapterId,
        healthy: false,
        reachable: false,
        rttMs: Date.now() - startMs,
        degradedReason: missing[0] ?? 'REAPER host bridge offline',
        missingPrerequisites: missing,
        provenance: {
          observedAt: new Date().toISOString(),
          dawId,
          adapterId: this.manifest.adapterId,
          hostVersion,
          sourceEvidence: 'REAPER HTTP/ReaScript bridge offline',
          freshness: 'stale',
        },
      };
    }

    try {
      await this.#transport.call('ping', {}, Math.min(this.#timeoutMs, 1_500));
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
          sourceEvidence: `REAPER ReaScript loopback ping verified in ${rttMs}ms`,
          freshness: 'observed',
        },
      };
    } catch (err) {
      const rttMs = Date.now() - startMs;
      const reason = (err as Error).message;
      return {
        adapterId: this.manifest.adapterId,
        healthy: false,
        reachable: false,
        rttMs,
        degradedReason: reason,
        missingPrerequisites: [`REAPER bridge ping failed: ${reason}`],
        provenance: {
          observedAt: new Date().toISOString(),
          dawId,
          adapterId: this.manifest.adapterId,
          hostVersion,
          sourceEvidence: `REAPER bridge ping failed after ${rttMs}ms`,
          freshness: 'stale',
        },
      };
    }
  }

  async observe(sessionId: string): Promise<DawStateSnapshot> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new DawBrainError('DAW_SESSION_NOT_FOUND', `REAPER session not found: "${sessionId}"`);
    }
    if (!this.#transport.isOpen()) {
      await this.#transport.open();
    }
    const rawSnap = await this.#transport.call<ReaperLiveSnapshotPayload>('snapshot', {}, this.#timeoutMs);
    const snap = this.#mapSnapshot(sessionId, entry.instance, rawSnap);
    entry.lastSnapshot = snap;
    return snap;
  }

  subscribe(sessionId: string, listener: (event: DawAdapterPushEvent) => void): () => void {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      throw new DawBrainError('DAW_SESSION_NOT_FOUND', `REAPER session not found: "${sessionId}"`);
    }
    entry.pushListeners.add(listener);
    return () => entry.pushListeners.delete(listener);
  }

  async validateCommand(command: DawCommand, currentSnapshot?: DawStateSnapshot): Promise<DawCommandValidationResult> {
    const cap = this.manifest.capabilities.find((c) => c.capabilityId === command.capabilityId);
    if (!cap || cap.supportLevel === 'UNSUPPORTED' || this.#executionProfile === 'read_only') {
      return {
        valid: false,
        capabilitySupported: false,
        reason: cap?.notes || `Capability "${command.capabilityId}" unsupported on REAPER profile "${this.#executionProfile}"`,
      };
    }

    const snap = currentSnapshot ?? this.#sessions.get(command.sessionId)?.lastSnapshot ?? null;
    if (!snap) {
      return { valid: false, capabilitySupported: true, reason: `No live snapshot for REAPER session "${command.sessionId}"` };
    }

    if (command.kind === 'transport.control') {
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          playing: snap.transport.playing,
          paused: snap.transport.paused,
          loopEnabled: snap.transport.loopEnabled,
          bpm: snap.transport.tempo.bpm,
        },
        reason: 'Validated REAPER transport target',
      };
    }

    if (command.kind === 'mixer.volume_pan_mute') {
      const ch =
        snap.mixerChannels.status === 'available'
          ? snap.mixerChannels.value.find((m) => m.id === command.targetRef)
          : undefined;
      if (!ch) {
        return { valid: false, capabilitySupported: true, reason: `REAPER track not found: "${command.targetRef}"` };
      }
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          targetRef: ch.id,
          volumeDb: ch.volumeDb,
          volumeNormalized: ch.volumeNormalized,
          panNormalized: ch.panNormalized,
          muted: ch.muted,
          soloed: ch.soloed,
        },
        reason: 'Validated REAPER MediaTrack mixer target',
      };
    }

    if (command.kind === 'plugin.bypass' || command.kind === 'plugin.param_write') {
      const plug =
        snap.plugins.status === 'available'
          ? snap.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
          : undefined;
      if (!plug) {
        return { valid: false, capabilitySupported: true, reason: `REAPER TrackFX slot not found: "${command.targetRef}"` };
      }
      const pIdx = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
      const curParam = plug.parameters.status === 'available' ? plug.parameters.value[pIdx] : undefined;
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: {
          pluginId: plug.id,
          bypassed: plug.bypassed,
          paramIndex: pIdx,
          valueNormalized: curParam?.valueNormalized ?? null,
        },
        reason: 'Validated REAPER TrackFX target',
      };
    }

    if (
      command.kind === 'track.create_delete' ||
      command.kind === 'plugin.load_remove' ||
      command.kind === 'mixer.routing_write' ||
      command.kind === 'project.save' ||
      command.kind === 'render.master'
    ) {
      return {
        valid: true,
        capabilitySupported: true,
        normalizedBeforeState: { targetRef: command.targetRef, trackCount: snap.tracks.status === 'available' ? snap.tracks.value.length : 0 },
        reason: `Validated REAPER "${command.kind}" capability`,
      };
    }

    return {
      valid: false,
      capabilitySupported: false,
      reason: `Unsupported REAPER command kind "${command.kind}"`,
    };
  }

  async execute(command: DawCommand, currentSnapshot: DawStateSnapshot): Promise<DawCommandResult> {
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
        provenance: {
          ...currentSnapshot.provenance,
          observedAt: new Date().toISOString(),
          sourceEvidence: `REAPER refusal (${command.capabilityId})`,
        },
        evidence: [val.reason],
        error: {
          code: !val.capabilitySupported ? 'DAW_CAPABILITY_UNSUPPORTED' : 'DAW_INVALID_COMMAND',
          message: val.reason,
        },
      };
    }

    const beforeState = val.normalizedBeforeState ?? {};
    const cap = this.manifest.capabilities.find((c) => c.capabilityId === command.capabilityId);
    const prov: DawObservationProvenance = {
      ...currentSnapshot.provenance,
      observedAt: new Date().toISOString(),
      sourceEvidence: `REAPER ReaScript bridge (${command.capabilityId})`,
      freshness: 'applied',
    };

    try {
      if (command.kind === 'transport.control') {
        const res = await this.#transport.call<{ readonly ok: boolean; readonly playing: boolean; readonly paused: boolean; readonly loopEnabled: boolean; readonly bpm: number }>(
          'transport.set',
          command.params,
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
          afterState: { playing: res.playing, paused: res.paused, loopEnabled: res.loopEnabled, bpm: res.bpm },
          verifiedByReadback: res.ok,
          rollbackSupported: cap?.rollbackSupported ?? true,
          provenance: prov,
          evidence: [`REAPER ReaScript transport.set succeeded (bpm=${res.bpm}, playing=${res.playing})`],
        };
      }

      if (command.kind === 'mixer.volume_pan_mute') {
        const curCh =
          currentSnapshot.mixerChannels.status === 'available'
            ? currentSnapshot.mixerChannels.value.find((m) => m.id === command.targetRef)
            : undefined;
        const trackIndex = curCh?.index ?? (command.targetRef === 'reaper:mixer:master' ? -1 : Number(command.targetRef.split(':').pop() ?? 0));
        let nextLinear =
          typeof command.params.volumeNormalized === 'number' ? command.params.volumeNormalized : undefined;
        if (typeof command.params.volumeDb === 'number') {
          nextLinear = dbToLinearReaperVol(command.params.volumeDb);
        } else if (typeof command.params.deltaDb === 'number' && curCh?.volumeDb !== null && curCh?.volumeDb !== undefined) {
          nextLinear = dbToLinearReaperVol(curCh.volumeDb + command.params.deltaDb);
        }

        const res = await this.#transport.call<{ readonly ok: boolean; readonly track: { readonly volumeLinear: number; readonly pan: number; readonly muted: boolean; readonly soloed: boolean } | null }>(
          'track.set_mixer',
          {
            trackIndex,
            volumeLinear: nextLinear,
            pan: command.params.panNormalized,
            muted: command.params.muted,
            soloed: command.params.soloed,
          },
          this.#timeoutMs,
        );

        const afterDb = res.track ? linearReaperVolToDb(res.track.volumeLinear) : null;
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
                volumeDb: afterDb,
                volumeNormalized: Math.min(1, res.track.volumeLinear),
                panNormalized: res.track.pan,
                muted: res.track.muted,
                soloed: res.track.soloed,
              }
            : null,
          verifiedByReadback: res.ok && res.track !== null,
          rollbackSupported: cap?.rollbackSupported ?? true,
          provenance: prov,
          evidence: [`REAPER SetMediaTrackInfo_Value updated trackIndex=${trackIndex} (volDb=${afterDb})`],
        };
      }

      if (command.kind === 'plugin.bypass') {
        const plug =
          currentSnapshot.plugins.status === 'available'
            ? currentSnapshot.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
            : undefined;
        const parts = (plug?.id ?? command.targetRef).split(':');
        const trackIndex = Number(parts[2] ?? 0);
        const slotIndex = plug?.slotIndex ?? Number(parts[3] ?? 0);
        const bypassed = Boolean(command.params.bypassed);
        const res = await this.#transport.call<{ readonly ok: boolean; readonly enabled: boolean }>(
          'fx.set_enabled',
          { trackIndex, slotIndex, enabled: !bypassed },
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
          afterState: { pluginId: plug?.id ?? command.targetRef, bypassed: !res.enabled },
          verifiedByReadback: res.ok,
          rollbackSupported: cap?.rollbackSupported ?? true,
          provenance: prov,
          evidence: [`REAPER TrackFX_SetEnabled(${trackIndex}, ${slotIndex}, ${res.enabled}) succeeded`],
        };
      }

      if (command.kind === 'plugin.param_write') {
        const plug =
          currentSnapshot.plugins.status === 'available'
            ? currentSnapshot.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
            : undefined;
        const parts = (plug?.id ?? command.targetRef).split(':');
        const trackIndex = Number(parts[2] ?? 0);
        const slotIndex = plug?.slotIndex ?? Number(parts[3] ?? 0);
        const paramIndex = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
        const res = await this.#transport.call<{ readonly ok: boolean; readonly valueNormalized: number }>(
          'fx.set_param_normalized',
          { trackIndex, slotIndex, paramIndex, valueNormalized: command.params.valueNormalized },
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
          afterState: { pluginId: plug?.id ?? command.targetRef, paramIndex, valueNormalized: res.valueNormalized },
          verifiedByReadback: res.ok,
          rollbackSupported: cap?.rollbackSupported ?? true,
          provenance: prov,
          evidence: [`REAPER TrackFX_SetParamNormalized(${trackIndex}, ${slotIndex}, ${paramIndex}) = ${res.valueNormalized}`],
        };
      }

      if (command.kind === 'track.create_delete') {
        const res = await this.#transport.call<{ readonly ok: boolean; readonly trackIndex: number; readonly name: string }>(
          'track.insert',
          { name: command.params.name ?? 'New Track' },
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
          afterState: { insertedTrackIndex: res.trackIndex, name: res.name },
          verifiedByReadback: res.ok,
          rollbackSupported: false,
          provenance: prov,
          evidence: [`REAPER InsertTrackAtIndex created "${res.name}" at index ${res.trackIndex}`],
        };
      }

      if (command.kind === 'plugin.load_remove') {
        const trackIndex = Number(command.targetRef.split(':').pop() ?? 0);
        const fxName = String(command.params.fxName ?? 'VST3: ReaComp (Cockos)');
        const res = await this.#transport.call<{ readonly ok: boolean; readonly slotIndex: number; readonly fxName: string }>(
          'fx.add_by_name',
          { trackIndex, fxName },
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
          afterState: { trackIndex, slotIndex: res.slotIndex, fxName: res.fxName },
          verifiedByReadback: res.ok,
          rollbackSupported: false,
          provenance: prov,
          evidence: [`REAPER TrackFX_AddByName loaded "${res.fxName}" at slot ${res.slotIndex}`],
        };
      }

      if (command.kind === 'mixer.routing_write') {
        const srcIdx = Number(command.params.sourceTrackIndex ?? 0);
        const dstIdx = Number(command.params.destTrackIndex ?? 2);
        const res = await this.#transport.call<{ readonly ok: boolean; readonly enabled: boolean }>(
          'send.set',
          { sourceTrackIndex: srcIdx, destTrackIndex: dstIdx, enabled: command.params.enabled ?? true, volumeLinear: command.params.volumeLinear ?? 1.0 },
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
          afterState: { sourceTrackIndex: srcIdx, destTrackIndex: dstIdx, enabled: res.enabled },
          verifiedByReadback: res.ok,
          rollbackSupported: true,
          provenance: prov,
          evidence: [`REAPER CreateTrackSend/SetTrackSendInfo_Value (${srcIdx}->${dstIdx}, enabled=${res.enabled})`],
        };
      }

      if (command.kind === 'project.save') {
        const res = await this.#transport.call<{ readonly ok: boolean; readonly projectPath: string | null }>(
          'project.save',
          {},
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
          afterState: { savedProjectPath: res.projectPath },
          verifiedByReadback: res.ok,
          rollbackSupported: false,
          provenance: prov,
          evidence: [`REAPER Main_SaveProject saved "${res.projectPath ?? 'active project'}"`],
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
      evidence: [`Unhandled REAPER kind ${command.kind}`],
      error: { code: 'DAW_CAPABILITY_UNSUPPORTED', message: `Unhandled REAPER kind ${command.kind}` },
    };
  }

  #mapSnapshot(
    sessionId: string,
    instance: DawInstance,
    raw: ReaperLiveSnapshotPayload,
  ): DawStateSnapshot {
    const prov: DawObservationProvenance = {
      observedAt: raw.observedAt || new Date().toISOString(),
      dawId: instance.id,
      adapterId: this.manifest.adapterId,
      hostVersion: raw.version || instance.version,
      sourceEvidence: `REAPER ReaScript loopback (changeCount=${raw.projectStateChangeCount})`,
      freshness: 'observed',
    };

    const tracks: DawTrack[] = raw.tracks.map((tr) => ({
      id: tr.isMaster ? 'reaper:track:master' : `reaper:track:${tr.index}`,
      index: tr.index,
      name: tr.name,
      kind: tr.isMaster ? 'master' : tr.folderDepth > 0 ? 'folder' : raw.mediaItems.some((it) => it.trackIndex === tr.index && it.kind === 'midi') ? 'midi' : 'audio',
      color: tr.colorHex,
      muted: tr.muted,
      soloed: tr.soloed,
      armed: tr.recArmed,
      mixerChannelId: tr.isMaster ? 'reaper:mixer:master' : `reaper:mixer:${tr.index}`,
    }));

    const channels: DawChannel[] = raw.tracks
      .filter((t) => !t.isMaster)
      .map((t) => ({
        id: `reaper:chan:${t.index}`,
        index: t.index,
        name: t.name,
        kind: raw.mediaItems.some((m) => m.trackIndex === t.index && m.kind === 'audio') ? 'audio_clip' : 'generator',
        targetMixerChannelId: `reaper:mixer:${t.index}`,
        muted: t.muted,
        soloed: t.soloed,
        volumeNormalized: Math.min(1, t.volumeLinear),
        panNormalized: t.pan,
      }));

    const allPlugins: DawPluginInstance[] = [];
    const mixerChannels: DawMixerChannel[] = raw.tracks.map((tr) => {
      const containerId = tr.isMaster ? 'reaper:mixer:master' : `reaper:mixer:${tr.index}`;
      const slots: DawPluginInstance[] = tr.fxSlots.map((fx) => {
        const plug: DawPluginInstance = {
          id: tr.isMaster ? `reaper:fx:master:${fx.slotIndex}` : `reaper:fx:${tr.index}:${fx.slotIndex}`,
          slotIndex: fx.slotIndex,
          containerId,
          name: fx.name,
          vendor: null,
          format: fx.format === 'JS' ? 'NATIVE' : fx.format,
          bypassed: !fx.enabled,
          mixLevel: 1.0,
          editionCompatible: 'verified',
          parameterCount: fx.paramCount,
          parameters:
            fx.params && fx.params.length > 0
              ? {
                  status: 'available',
                  value: fx.params.map((p) => ({
                    index: p.index,
                    id: `rprparam:${tr.index}:${fx.slotIndex}:${p.index}`,
                    name: p.name,
                    valueNormalized: p.valueNormalized,
                    displayValue: p.displayValue,
                    defaultNormalized: null,
                    unit: null,
                    readable: true,
                    writable: true,
                  })),
                }
              : { status: 'unavailable', reason: 'TrackFX exposes 0 inspectable parameters' },
        };
        allPlugins.push(plug);
        return plug;
      });

      return {
        id: containerId,
        index: tr.index,
        name: tr.name,
        isMaster: tr.isMaster,
        volumeNormalized: Math.min(1, tr.volumeLinear),
        volumeDb: linearReaperVolToDb(tr.volumeLinear),
        panNormalized: tr.pan,
        muted: tr.muted,
        soloed: tr.soloed,
        stereoSeparation: null,
        peakDb: tr.peakLinear !== null && tr.peakLinear > 0 ? linearReaperVolToDb(tr.peakLinear) : null,
        pluginSlots: slots,
      };
    });

    const buses: DawBus[] = raw.tracks
      .filter((t) => t.isMaster || raw.tracks.some((other) => other.sends.some((s) => s.destTrackIndex === t.index)))
      .map((t) => ({
        id: t.isMaster ? 'reaper:mixer:master' : `reaper:mixer:${t.index}`,
        mixerChannelId: t.isMaster ? 'reaper:mixer:master' : `reaper:mixer:${t.index}`,
        name: t.name,
        role: t.isMaster ? 'master' : t.name.toLowerCase().includes('verb') ? 'send' : 'submix',
        sourceIds: t.isMaster
          ? raw.tracks.filter((o) => !o.isMaster && o.sendsToMaster).map((o) => `reaper:mixer:${o.index}`)
          : raw.tracks.filter((o) => o.sends.some((s) => s.destTrackIndex === t.index)).map((o) => `reaper:mixer:${o.index}`),
        destinationId: t.isMaster ? null : t.sendsToMaster ? 'reaper:mixer:master' : null,
      }));

    const routing: DawRoutingConnection[] = [];
    for (const t of raw.tracks) {
      if (t.isMaster) continue;
      if (t.sendsToMaster) {
        routing.push({
          id: `reaper:route:${t.index}->master`,
          sourceId: `reaper:mixer:${t.index}`,
          targetId: 'reaper:mixer:master',
          sendNormalized: 1,
          sendDb: 0,
          enabled: true,
          preFader: false,
          sidechain: false,
        });
      }
      for (const s of t.sends) {
        routing.push({
          id: `reaper:route:${s.sourceTrackIndex}->${s.destTrackIndex}`,
          sourceId: `reaper:mixer:${s.sourceTrackIndex}`,
          targetId: `reaper:mixer:${s.destTrackIndex}`,
          sendNormalized: Math.min(1, s.volumeLinear),
          sendDb: linearReaperVolToDb(s.volumeLinear),
          enabled: !s.muted,
          preFader: s.sendMode !== 0,
          sidechain: s.destChannelOffset >= 2,
        });
      }
    }

    const secToBeats = (sec: number) => Number(((sec * raw.tempoBpm) / 60).toFixed(3));
    const automationLanes: DawAutomationLane[] = raw.envelopes.map((e) => ({
      id: e.id,
      targetRef: `reaper:track:${e.trackIndex}`,
      parameterName: e.name,
      enabled: e.active,
      points: {
        status: 'available',
        value: e.points.map((p) => ({
          positionBeats: secToBeats(p.positionSec),
          valueNormalized: Math.max(0, Math.min(1, p.value)),
          curve: 'linear',
        })),
      },
    }));

    const audioClips: DawAudioClip[] = raw.mediaItems
      .filter((m) => m.kind === 'audio')
      .map((m) => ({
        id: m.id,
        name: m.name,
        trackId: `reaper:track:${m.trackIndex}`,
        sourcePath: m.sourcePath,
        startBeats: secToBeats(m.positionSec),
        lengthBeats: secToBeats(m.lengthSec),
        gainDb: linearReaperVolToDb(m.volumeLinear),
        muted: m.muted,
      }));

    const midiClips: DawMidiClip[] = raw.mediaItems
      .filter((m) => m.kind === 'midi')
      .map((m) => ({
        id: m.id,
        name: m.name,
        trackId: `reaper:track:${m.trackIndex}`,
        channelId: `reaper:chan:${m.trackIndex}`,
        patternId: null,
        startBeats: secToBeats(m.positionSec),
        lengthBeats: secToBeats(m.lengthSec),
        noteCount: m.noteCount,
      }));

    const markers: DawMarker[] = raw.markers
      .filter((m) => !m.isRegion)
      .map((m) => ({
        id: `reaper:marker:${m.index}`,
        name: m.name,
        positionBeats: secToBeats(m.positionSec),
        kind: 'marker',
      }));

    const regions: DawRegion[] = raw.markers
      .filter((m) => m.isRegion)
      .map((m) => ({
        id: `reaper:region:${m.index}`,
        name: m.name,
        startBeats: secToBeats(m.positionSec),
        endBeats: secToBeats(m.endSec ?? m.positionSec),
        color: m.colorHex,
      }));

    const playing = (raw.playState & 1) === 1;
    const paused = (raw.playState & 2) === 2;
    const recording = (raw.playState & 4) === 4;

    const base: DawStateSnapshot = {
      snapshotId: `rprsnap-${randomUUID().slice(0, 8)}`,
      sessionId,
      freshness: 'observed',
      provenance: prov,
      transport: {
        playing,
        paused,
        recording,
        loopEnabled: raw.repeatEnabled,
        songPositionBeats: secToBeats(raw.cursorSec),
        songPositionSeconds: Number(raw.cursorSec.toFixed(3)),
        tempo: { bpm: raw.tempoBpm, freshness: 'observed' },
        timeSignature: { numerator: raw.timeSigNumerator, denominator: raw.timeSigDenominator },
        provenance: prov,
      },
      tracks: { status: 'available', value: tracks },
      channels: { status: 'available', value: channels },
      mixerChannels: { status: 'available', value: mixerChannels },
      buses: { status: 'available', value: buses },
      routing: { status: 'available', value: routing },
      plugins: { status: 'available', value: allPlugins },
      automationLanes: { status: 'available', value: automationLanes },
      audioClips: { status: 'available', value: audioClips },
      midiClips: { status: 'available', value: midiClips },
      markers: { status: 'available', value: markers },
      regions: { status: 'available', value: regions },
      stateDigest: '',
    };

    return {
      ...base,
      stateDigest: computeSnapshotDigest(base),
    };
  }

  #log(
    level: ReaperIntegrationLogEntry['level'],
    event: string,
    sessionId: string | null,
    details: Readonly<Record<string, unknown>>,
  ): void {
    this.#logSeq += 1;
    this.#logs.push({ seq: this.#logSeq, timestamp: new Date().toISOString(), level, event, sessionId, details });
    if (this.#logs.length > 500) this.#logs.shift();
  }
}
