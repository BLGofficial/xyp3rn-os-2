import http from 'node:http';
import { DawBrainError } from '../../daw-brain/index.ts';
import type {
  ReaperLiveHelloPayload,
  ReaperLiveMarkerOrRegion,
  ReaperLiveMediaItem,
  ReaperLiveSnapshotPayload,
  ReaperLiveTrack,
  ReaperLiveEnvelope,
} from './types.ts';

export type ReaperBridgePushEvent =
  | { readonly kind: 'state_changed'; readonly snapshot: ReaperLiveSnapshotPayload }
  | { readonly kind: 'disconnected'; readonly reason: string };

export interface ReaperBridgeTransport {
  readonly transportId: string;
  isOpen(): boolean;
  open(): Promise<ReaperLiveHelloPayload>;
  close(): Promise<void>;
  call<T = unknown>(method: string, params?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T>;
  onPushEvent(listener: (event: ReaperBridgePushEvent) => void): () => void;
}

export const MAX_REAPER_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Real HTTP JSON-RPC loopback transport connecting to a running REAPER ReaScript Lua/Python
 * or Web Remote bridge on `127.0.0.1` / `localhost` / `[::1]` ONLY
 * (external non-loopback targets forbidden by security policy).
 */
export class HttpReaperBridgeTransport implements ReaperBridgeTransport {
  readonly transportId = 'reaper-loopback-http';
  readonly #url: URL;
  readonly #bridgeToken: string | undefined;
  #open = false;
  #reqSeq = 1;
  readonly #listeners = new Set<(event: ReaperBridgePushEvent) => void>();

  constructor(
    endpointUrl = 'http://127.0.0.1:8088/rpc',
    options: { readonly bridgeToken?: string | undefined } = {},
  ) {
    const parsed = new URL(endpointUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DawBrainError(
        'DAW_PERMISSION_DENIED',
        `REAPER bridge transport forbids protocol "${parsed.protocol}" (http/https loopback only)`,
      );
    }
    if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new DawBrainError(
        'DAW_PERMISSION_DENIED',
        `REAPER bridge transport strictly restricted to 127.0.0.1 loopback (got "${parsed.hostname}")`,
      );
    }
    this.#url = parsed;
    this.#bridgeToken = options.bridgeToken?.trim() || undefined;
  }

  isOpen(): boolean {
    return this.#open;
  }

  async open(): Promise<ReaperLiveHelloPayload> {
    const hello = await this.#postRpc<ReaperLiveHelloPayload>('hello', {}, 2_500);
    this.#open = true;
    return hello;
  }

  async close(): Promise<void> {
    const wasOpen = this.#open;
    this.#open = false;
    if (wasOpen) {
      for (const cb of this.#listeners) cb({ kind: 'disconnected', reason: 'Loopback HTTP bridge closed' });
    }
  }

  async call<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 2_500,
  ): Promise<T> {
    if (!this.#open && method !== 'hello' && method !== 'ping') {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'REAPER HTTP bridge is closed');
    }
    return this.#postRpc<T>(method, params, timeoutMs);
  }

  onPushEvent(listener: (event: ReaperBridgePushEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #postRpc<T>(method: string, params: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<T> {
    const id = this.#reqSeq;
    this.#reqSeq += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.#bridgeToken) {
        headers['X-XYP-Bridge-Token'] = this.#bridgeToken;
      }

      const req = http.request(
        {
          hostname: this.#url.hostname.replace(/^\[|\]$/g, ''),
          port: Number(this.#url.port || (this.#url.protocol === 'https:' ? 443 : 80)),
          path: this.#url.pathname + this.#url.search,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          let aborted = false;
          res.on('data', (c: Buffer) => {
            totalBytes += c.length;
            if (totalBytes > MAX_REAPER_RPC_RESPONSE_BYTES) {
              aborted = true;
              req.destroy();
              reject(
                new DawBrainError(
                  'DAW_INVALID_COMMAND',
                  `REAPER RPC response exceeded max ${MAX_REAPER_RPC_RESPONSE_BYTES} bytes`,
                ),
              );
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (aborted) return;
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const parsed = JSON.parse(raw) as { readonly result?: T; readonly error?: { readonly code?: string; readonly message?: string } };
              if (parsed.error) {
                reject(
                  new DawBrainError(
                    'DAW_INVALID_COMMAND',
                    parsed.error.message ?? `REAPER RPC error on method "${method}"`,
                  ),
                );
                return;
              }
              resolve(parsed.result as T);
            } catch (err) {
              reject(new DawBrainError('DAW_HOST_OFFLINE', `Invalid REAPER RPC response: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new DawBrainError('DAW_TIMEOUT', `REAPER RPC timeout after ${timeoutMs} ms`));
      });
      req.on('error', (err) => {
        reject(new DawBrainError('DAW_HOST_OFFLINE', `REAPER HTTP bridge unreachable: ${err.message}`));
      });
      req.write(body);
      req.end();
    });
  }
}

export type MockReaperBridgeOptions = {
  readonly offline?: boolean | undefined;
  readonly latencyMs?: number | undefined;
  readonly version?: string | undefined;
  readonly apiVersion?: number | undefined;
  readonly projectPath?: string | undefined;
};

/**
 * Deterministic `FXT-RPR-01` stateful REAPER bridge fixture.
 * Models authentic REAPER semantics: Master + 0-indexed unified MediaTracks,
 * D_VOL linear unity (1.0 == 0 dBFS), GetTrackNumSends, TrackFX_AddByName,
 * InsertTrackAtIndex/DeleteTrack, timeline regions/envelopes/items, and GetProjectStateChangeCount.
 */
export class MockReaperBridgeTransport implements ReaperBridgeTransport {
  readonly transportId = 'mock-reaper-fxt-rpr-01';
  #open = false;
  #offline: boolean;
  #latencyMs: number;
  #version: string;
  #apiVersion: number;
  #snapshot: ReaperLiveSnapshotPayload;
  readonly #listeners = new Set<(event: ReaperBridgePushEvent) => void>();

  constructor(options: MockReaperBridgeOptions = {}) {
    this.#offline = options.offline ?? false;
    this.#latencyMs = Math.max(0, options.latencyMs ?? 2);
    this.#version = options.version ?? '7.18';
    this.#apiVersion = options.apiVersion ?? 718;

    const tracks: ReaperLiveTrack[] = [
      {
        index: -1,
        guid: '{MASTER-TRACK-0000}',
        name: 'Master',
        isMaster: true,
        colorHex: '#06b6d4',
        volumeLinear: 1.0, // Unity = 1.0 (0.0 dBFS) in REAPER!
        pan: 0.0,
        muted: false,
        soloed: false,
        recArmed: false,
        peakLinear: 0.85,
        sendsToMaster: false,
        folderDepth: 0,
        fxSlots: [
          {
            slotIndex: 0,
            name: 'JS: Master Limiter',
            format: 'JS',
            enabled: true,
            offline: false,
            paramCount: 2,
            params: [
              { index: 0, name: 'Threshold', valueNormalized: 0.85, displayValue: '-1.5 dB' },
              { index: 1, name: 'Ceiling', valueNormalized: 0.9, displayValue: '-1.0 dB' },
            ],
          },
        ],
        sends: [],
      },
      {
        index: 0,
        guid: '{TRACK-0001-VOCAL}',
        name: 'Lead Vocal',
        isMaster: false,
        colorHex: '#f59e0b',
        volumeLinear: Number(Math.pow(10, -2.0 / 20).toFixed(6)), // -2.0 dB
        pan: 0.0,
        muted: false,
        soloed: false,
        recArmed: false,
        peakLinear: 0.42,
        sendsToMaster: true,
        folderDepth: 0,
        fxSlots: [
          {
            slotIndex: 0,
            name: 'VST3: FabFilter Pro-Q 3 (FabFilter)',
            format: 'VST3',
            enabled: true,
            offline: false,
            paramCount: 2,
            params: [
              { index: 0, name: 'Band 1 Frequency', valueNormalized: 0.38, displayValue: '160 Hz' },
              { index: 1, name: 'Band 1 Gain', valueNormalized: 0.45, displayValue: '-2.5 dB' },
            ],
          },
        ],
        sends: [
          {
            sendIndex: 0,
            sourceTrackIndex: 0,
            destTrackIndex: 2,
            destTrackName: 'VOXVERB',
            volumeLinear: 0.5,
            muted: false,
            sendMode: 0,
            destChannelOffset: 0,
          },
        ],
      },
      {
        index: 1,
        guid: '{TRACK-0002-SUB}',
        name: '808 Sub',
        isMaster: false,
        colorHex: '#ef4444',
        volumeLinear: Number(Math.pow(10, -3.0 / 20).toFixed(6)),
        pan: 0.0,
        muted: false,
        soloed: false,
        recArmed: false,
        peakLinear: 0.56,
        sendsToMaster: true,
        folderDepth: 0,
        fxSlots: [
          {
            slotIndex: 0,
            name: 'VST3: ReaEQ (Cockos)',
            format: 'VST3',
            enabled: true,
            offline: false,
            paramCount: 2,
            params: [{ index: 0, name: 'Lowpass Freq', valueNormalized: 0.25, displayValue: '120 Hz' }],
          },
        ],
        sends: [],
      },
      {
        index: 2,
        guid: '{TRACK-0003-VERB}',
        name: 'VOXVERB',
        isMaster: false,
        colorHex: '#8b5cf6',
        volumeLinear: 0.707946, // -3.0 dB
        pan: 0.0,
        muted: false,
        soloed: false,
        recArmed: false,
        peakLinear: 0.14,
        sendsToMaster: true,
        folderDepth: 0,
        fxSlots: [
          {
            slotIndex: 0,
            name: 'VST3: ValhallaVintageVerb (Valhalla DSP)',
            format: 'VST3',
            enabled: true,
            offline: false,
            paramCount: 2,
            params: [{ index: 0, name: 'Mix', valueNormalized: 1.0, displayValue: '100%' }],
          },
        ],
        sends: [],
      },
    ];

    const markers: ReaperLiveMarkerOrRegion[] = [
      { index: 1, isRegion: false, name: 'Intro', positionSec: 0, endSec: null, colorHex: null },
      { index: 2, isRegion: true, name: 'Hook 1', positionSec: 16, endSec: 32, colorHex: '#22d3ee' },
    ];
    const mediaItems: ReaperLiveMediaItem[] = [
      {
        id: 'rpr-item-0-1',
        trackIndex: 0,
        name: 'Lead_Take_3.wav',
        kind: 'audio',
        sourcePath: 'D:\\REAPER\\Media\\Lead_Take_3.wav',
        positionSec: 16,
        lengthSec: 16,
        volumeLinear: 1.0,
        muted: false,
        noteCount: null,
      },
      {
        id: 'rpr-item-1-1',
        trackIndex: 1,
        name: '808_Pattern.mid',
        kind: 'midi',
        sourcePath: null,
        positionSec: 0,
        lengthSec: 32,
        volumeLinear: 1.0,
        muted: false,
        noteCount: 24,
      },
    ];
    const envelopes: ReaperLiveEnvelope[] = [
      {
        id: 'rpr-env-0-vol',
        trackIndex: 0,
        name: 'Volume',
        active: true,
        points: [
          { positionSec: 0, value: 0.794, shape: 0 },
          { positionSec: 16, value: 0.85, shape: 0 },
        ],
      },
    ];

    this.#snapshot = {
      observedAt: new Date().toISOString(),
      version: this.#version,
      projectTitle: 'COLDINMYEYES.rpp',
      projectPath: options.projectPath ?? 'D:\\REAPER\\COLDINMYEYES.rpp',
      dirty: false,
      projectStateChangeCount: 1,
      playState: 0,
      repeatEnabled: true,
      cursorSec: 0,
      tempoBpm: 138,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      sampleRate: 48_000,
      tracks,
      markers,
      mediaItems,
      envelopes,
    };
  }

  isOpen(): boolean {
    return this.#open && !this.#offline;
  }

  setVersion(version: string, apiVersion = 718): void {
    this.#version = version;
    this.#apiVersion = apiVersion;
    this.#snapshot = { ...this.#snapshot, version };
  }

  setOffline(offline: boolean, reason = 'REAPER process closed'): void {
    const wasOpen = this.#open && !this.#offline;
    this.#offline = offline;
    if (offline && wasOpen) {
      this.#open = false;
      for (const cb of this.#listeners) cb({ kind: 'disconnected', reason });
    }
  }

  injectHostStateChange(patch: Partial<ReaperLiveSnapshotPayload>, emitPush = true): void {
    this.#snapshot = {
      ...this.#snapshot,
      ...patch,
      dirty: true,
      projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
      observedAt: new Date().toISOString(),
    };
    if (emitPush && this.isOpen()) {
      for (const cb of this.#listeners) {
        cb({ kind: 'state_changed', snapshot: this.#snapshot });
      }
    }
  }

  async open(): Promise<ReaperLiveHelloPayload> {
    if (this.#offline) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'Mock REAPER bridge is offline (reaper.exe absent)');
    }
    this.#open = true;
    return {
      hostName: 'REAPER',
      version: this.#version,
      apiVersion: this.#apiVersion,
      osPlatform: 'win64',
      bridgeKind: 'mock_fxt_rpr_01',
      projectTitle: this.#snapshot.projectTitle,
      projectPath: this.#snapshot.projectPath,
      dirtyCount: this.#snapshot.projectStateChangeCount,
    };
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  onPushEvent(listener: (event: ReaperBridgePushEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async call<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    _timeoutMs = 2_500,
  ): Promise<T> {
    if (!this.isOpen()) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'REAPER bridge offline');
    }
    if (this.#latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.#latencyMs));
    }

    if (method === 'ping') {
      return {
        pong: true,
        version: this.#version,
        apiVersion: this.#apiVersion,
        changeCount: this.#snapshot.projectStateChangeCount,
      } as T;
    }

    if (method === 'snapshot') {
      return { ...this.#snapshot, observedAt: new Date().toISOString() } as T;
    }

    if (method === 'transport.set') {
      const playing = typeof params.playing === 'boolean' ? params.playing : (this.#snapshot.playState & 1) === 1;
      const paused = typeof params.paused === 'boolean' ? params.paused : (this.#snapshot.playState & 2) === 2;
      const nextPlayState = paused ? 2 : playing ? 1 : 0;
      const nextRepeat = typeof params.loopEnabled === 'boolean' ? params.loopEnabled : this.#snapshot.repeatEnabled;
      const nextBpm = typeof params.bpm === 'number' ? params.bpm : this.#snapshot.tempoBpm;
      this.#snapshot = {
        ...this.#snapshot,
        playState: nextPlayState,
        repeatEnabled: nextRepeat,
        tempoBpm: nextBpm,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
      };
      return {
        ok: true,
        playing: nextPlayState === 1,
        paused: nextPlayState === 2,
        loopEnabled: nextRepeat,
        bpm: nextBpm,
      } as T;
    }

    if (method === 'track.set_mixer') {
      const idx = Number(params.trackIndex);
      let updated: ReaperLiveTrack | null = null;
      this.#snapshot = {
        ...this.#snapshot,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
        tracks: this.#snapshot.tracks.map((tr) => {
          if (tr.index !== idx) return tr;
          updated = {
            ...tr,
            volumeLinear:
              typeof params.volumeLinear === 'number' ? params.volumeLinear : tr.volumeLinear,
            pan: typeof params.pan === 'number' ? params.pan : tr.pan,
            muted: typeof params.muted === 'boolean' ? params.muted : tr.muted,
            soloed: typeof params.soloed === 'boolean' ? params.soloed : tr.soloed,
          };
          return updated;
        }),
      };
      return { ok: updated !== null, track: updated } as T;
    }

    if (method === 'fx.set_enabled') {
      const trIdx = Number(params.trackIndex);
      const slotIdx = Number(params.slotIndex);
      const enabled = Boolean(params.enabled);
      let found = false;
      this.#snapshot = {
        ...this.#snapshot,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
        tracks: this.#snapshot.tracks.map((tr) => {
          if (tr.index !== trIdx) return tr;
          return {
            ...tr,
            fxSlots: tr.fxSlots.map((fx) => {
              if (fx.slotIndex !== slotIdx) return fx;
              found = true;
              return { ...fx, enabled };
            }),
          };
        }),
      };
      return { ok: found, trackIndex: trIdx, slotIndex: slotIdx, enabled } as T;
    }

    if (method === 'fx.set_param_normalized') {
      const trIdx = Number(params.trackIndex);
      const slotIdx = Number(params.slotIndex);
      const pIdx = Number(params.paramIndex ?? 0);
      const val = Number(params.valueNormalized);
      let found = false;
      this.#snapshot = {
        ...this.#snapshot,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
        tracks: this.#snapshot.tracks.map((tr) => {
          if (tr.index !== trIdx) return tr;
          return {
            ...tr,
            fxSlots: tr.fxSlots.map((fx) => {
              if (fx.slotIndex !== slotIdx) return fx;
              return {
                ...fx,
                params: fx.params?.map((p) => {
                  if (p.index !== pIdx) return p;
                  found = true;
                  return { ...p, valueNormalized: val };
                }),
              };
            }),
          };
        }),
      };
      return { ok: found, trackIndex: trIdx, slotIndex: slotIdx, paramIndex: pIdx, valueNormalized: val } as T;
    }

    if (method === 'fx.add_by_name') {
      const trIdx = Number(params.trackIndex ?? 0);
      const fxName = String(params.fxName ?? 'VST3: ReaComp (Cockos)');
      let addedSlot = -1;
      this.#snapshot = {
        ...this.#snapshot,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
        tracks: this.#snapshot.tracks.map((tr) => {
          if (tr.index !== trIdx) return tr;
          addedSlot = tr.fxSlots.length;
          return {
            ...tr,
            fxSlots: [
              ...tr.fxSlots,
              {
                slotIndex: addedSlot,
                name: fxName,
                format: fxName.toUpperCase().includes('VST3') ? 'VST3' : 'VST2',
                enabled: true,
                offline: false,
                paramCount: 1,
                params: [{ index: 0, name: 'Dry/Wet', valueNormalized: 1.0, displayValue: '100%' }],
              },
            ],
          };
        }),
      };
      return { ok: addedSlot >= 0, slotIndex: addedSlot, fxName } as T;
    }

    if (method === 'track.insert') {
      const nonMasterCount = this.#snapshot.tracks.filter((t) => !t.isMaster).length;
      const newTrack: ReaperLiveTrack = {
        index: nonMasterCount,
        guid: `{TRACK-NEW-${nonMasterCount}}`,
        name: String(params.name ?? `New Track ${nonMasterCount + 1}`),
        isMaster: false,
        colorHex: null,
        volumeLinear: 1.0,
        pan: 0,
        muted: false,
        soloed: false,
        recArmed: false,
        peakLinear: null,
        sendsToMaster: true,
        folderDepth: 0,
        fxSlots: [],
        sends: [],
      };
      this.#snapshot = {
        ...this.#snapshot,
        dirty: true,
        projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
        observedAt: new Date().toISOString(),
        tracks: [...this.#snapshot.tracks, newTrack],
      };
      return { ok: true, trackIndex: newTrack.index, name: newTrack.name } as T;
    }

    if (method === 'send.set') {
      const srcIdx = Number(params.sourceTrackIndex);
      const dstIdx = Number(params.destTrackIndex);
      const enabled = params.enabled !== false;
      const sendVol = typeof params.volumeLinear === 'number' ? params.volumeLinear : 1.0;
      const destTr = this.#snapshot.tracks.find((t) => t.index === dstIdx);
      let ok = Boolean(destTr);
      if (ok) {
        this.#snapshot = {
          ...this.#snapshot,
          dirty: true,
          projectStateChangeCount: this.#snapshot.projectStateChangeCount + 1,
          observedAt: new Date().toISOString(),
          tracks: this.#snapshot.tracks.map((tr) => {
            if (tr.index !== srcIdx) return tr;
            const existing = tr.sends.find((s) => s.destTrackIndex === dstIdx);
            const nextSends = existing
              ? tr.sends.map((s) =>
                  s.destTrackIndex === dstIdx ? { ...s, muted: !enabled, volumeLinear: sendVol } : s,
                )
              : [
                  ...tr.sends,
                  {
                    sendIndex: tr.sends.length,
                    sourceTrackIndex: srcIdx,
                    destTrackIndex: dstIdx,
                    destTrackName: destTr!.name,
                    volumeLinear: sendVol,
                    muted: !enabled,
                    sendMode: 0,
                    destChannelOffset: 0,
                  },
                ];
            return { ...tr, sends: nextSends };
          }),
        };
      }
      return { ok, sourceTrackIndex: srcIdx, destTrackIndex: dstIdx, enabled } as T;
    }

    if (method === 'project.save') {
      this.#snapshot = {
        ...this.#snapshot,
        dirty: false,
        observedAt: new Date().toISOString(),
      };
      return { ok: true, projectPath: this.#snapshot.projectPath } as T;
    }

    throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', `Mock REAPER bridge does not implement "${method}"`);
  }
}
