import type { DawAvailability, DawCapability, DawProject, DawTimeSignature } from '../../daw-brain/index.ts';

export type ReaperExecutionProfile = 'read_only' | 'controlled_safe_v1' | 'reascript_full';

export type ReaperBinaryInstallInfo = {
  readonly label: string;
  readonly installDir: string;
  readonly executablePath: string;
  readonly exists: boolean;
  readonly fileVersion: string | null;
  readonly productVersion: string | null;
  readonly leftoverAssetFilesCount: number;
};

export type ReaperRunningProcessInfo = {
  readonly pid: number;
  readonly processName: string;
  readonly executablePath: string | null;
};

export type ReaperHostEnvironment = {
  readonly probedAt: string;
  readonly installations: readonly ReaperBinaryInstallInfo[];
  readonly runningProcesses: readonly ReaperRunningProcessInfo[];
  readonly appDataDir: string;
  readonly appDataExists: boolean;
  readonly reaperIniPath: string;
  readonly reaperIniExists: boolean;
  readonly luaBridgeScriptPath: string;
  readonly luaBridgeInstalled: boolean;
  readonly webRemoteConfiguredPort: number | null;
  readonly oscConfiguredPort: number | null;
  readonly discoveredProjects: readonly string[];
  readonly missingPrerequisites: readonly string[];
  readonly warnings: readonly string[];
};

export type ReaperPluginInventoryEntry = {
  readonly name: string;
  readonly format: 'VST3' | 'VST2' | 'CLAP' | 'JS' | 'UNKNOWN';
  readonly path: string;
  readonly source: 'vst_filesystem' | 'reaper_ini';
};

export type RppSendEntry = {
  readonly sourceTrackIndex: number;
  readonly targetTrackIndex: number;
  readonly enabled: boolean;
  readonly volumeLinear: number;
  readonly volumeDb: number | null;
  readonly pan: number;
  readonly preFader: boolean;
  readonly sidechainChannel: number | null;
};

export type RppFxEntry = {
  readonly slotIndex: number;
  readonly name: string;
  readonly format: 'VST3' | 'VST2' | 'CLAP' | 'JS' | 'NATIVE' | 'UNKNOWN';
  readonly bypassed: boolean;
  readonly offline: boolean;
  readonly hasOpaqueBinaryChunk: boolean;
};

export type RppEnvelopePoint = {
  readonly positionSec: number;
  readonly value: number;
  readonly shape: number;
};

export type RppEnvelopeEntry = {
  readonly targetName: string;
  readonly armed: boolean;
  readonly points: readonly RppEnvelopePoint[];
};

export type RppMediaItemEntry = {
  readonly name: string;
  readonly startSec: number;
  readonly lengthSec: number;
  readonly gainLinear: number;
  readonly muted: boolean;
  readonly kind: 'audio' | 'midi' | 'unknown';
  readonly sourcePath: string | null;
};

export type RppTrackEntry = {
  readonly index: number;
  readonly guid: string;
  readonly name: string;
  readonly volumeLinear: number;
  readonly volumeDb: number | null;
  readonly pan: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly armed: boolean;
  readonly sendsToMaster: boolean;
  readonly isFolderParent: boolean;
  readonly fxChain: readonly RppFxEntry[];
  readonly receives: readonly RppSendEntry[];
  readonly envelopes: readonly RppEnvelopeEntry[];
  readonly items: readonly RppMediaItemEntry[];
};

export type RppParsedProject = {
  readonly projectPath: string;
  readonly projectName: string;
  readonly sha256BeforeRead: string;
  readonly sha256AfterRead: string;
  readonly reaperVersion: string | null;
  readonly sampleRate: number | null;
  readonly tempoBpm: DawAvailability<number>;
  readonly timeSignature: DawAvailability<DawTimeSignature>;
  readonly masterVolumeLinear: number;
  readonly masterVolumeDb: number | null;
  readonly tracks: readonly RppTrackEntry[];
  readonly markers: readonly { readonly id: number; readonly name: string; readonly positionSec: number; readonly isRegion: boolean; readonly regionEndSec?: number | undefined }[];
  readonly renderOutputFile: string | null;
  readonly project: DawProject;
  readonly warnings: readonly string[];
};

export type ReaperLiveFxParam = {
  readonly index: number;
  readonly name: string;
  readonly valueNormalized: number;
  readonly displayValue: string;
};

export type ReaperLiveFxSlot = {
  readonly slotIndex: number;
  readonly name: string;
  readonly format: 'VST3' | 'VST2' | 'CLAP' | 'JS' | 'UNKNOWN';
  readonly enabled: boolean;
  readonly offline: boolean;
  readonly paramCount: number;
  readonly params?: readonly ReaperLiveFxParam[] | undefined;
};

export type ReaperLiveSend = {
  readonly sendIndex: number;
  readonly sourceTrackIndex: number;
  readonly destTrackIndex: number;
  readonly destTrackName: string;
  readonly volumeLinear: number;
  readonly muted: boolean;
  readonly sendMode: number; // 0=post-fader, 1=pre-fx, 3=post-fx/pre-fader
  readonly destChannelOffset: number;
};

export type ReaperLiveTrack = {
  readonly index: number; // -1 for Master track, 0..N-1 for project tracks
  readonly guid: string;
  readonly name: string;
  readonly isMaster: boolean;
  readonly colorHex: string | null;
  readonly volumeLinear: number; // 1.0 == 0.0 dBFS unity in REAPER (unlike FL Studio's 0.8!)
  readonly pan: number; // -1.0..+1.0
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly recArmed: boolean;
  readonly peakLinear: number | null;
  readonly sendsToMaster: boolean;
  readonly folderDepth: number;
  readonly fxSlots: readonly ReaperLiveFxSlot[];
  readonly sends: readonly ReaperLiveSend[];
};

export type ReaperLiveMarkerOrRegion = {
  readonly index: number;
  readonly isRegion: boolean;
  readonly name: string;
  readonly positionSec: number;
  readonly endSec: number | null;
  readonly colorHex: string | null;
};

export type ReaperLiveMediaItem = {
  readonly id: string;
  readonly trackIndex: number;
  readonly name: string;
  readonly kind: 'audio' | 'midi';
  readonly sourcePath: string | null;
  readonly positionSec: number;
  readonly lengthSec: number;
  readonly volumeLinear: number;
  readonly muted: boolean;
  readonly noteCount: number | null;
};

export type ReaperLiveEnvelope = {
  readonly id: string;
  readonly trackIndex: number;
  readonly name: string;
  readonly active: boolean;
  readonly points: readonly RppEnvelopePoint[];
};

export type ReaperLiveHelloPayload = {
  readonly hostName: 'REAPER';
  readonly version: string;
  readonly apiVersion: number;
  readonly osPlatform: string;
  readonly bridgeKind: 'reascript_lua_http' | 'osc_web_remote' | 'mock_fxt_rpr_01';
  readonly projectTitle: string;
  readonly projectPath: string | null;
  readonly dirtyCount: number;
};

export type ReaperLiveSnapshotPayload = {
  readonly observedAt: string;
  readonly version: string;
  readonly projectTitle: string;
  readonly projectPath: string | null;
  readonly dirty: boolean;
  readonly projectStateChangeCount: number;
  readonly playState: number; // 0=stop, 1=play, 2=pause, 4=record, 5=play+record
  readonly repeatEnabled: boolean;
  readonly cursorSec: number;
  readonly tempoBpm: number;
  readonly timeSigNumerator: number;
  readonly timeSigDenominator: number;
  readonly sampleRate: number;
  readonly tracks: readonly ReaperLiveTrack[];
  readonly markers: readonly ReaperLiveMarkerOrRegion[];
  readonly mediaItems: readonly ReaperLiveMediaItem[];
  readonly envelopes: readonly ReaperLiveEnvelope[];
};

export type ReaperIntegrationLogEntry = {
  readonly seq: number;
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly sessionId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
};

export type ReaperAdapterOptions = {
  readonly adapterId?: string | undefined;
  readonly transport?: import('./reaper-transport.ts').ReaperBridgeTransport | undefined;
  readonly hostProbe?: import('./host-probe.ts').ReaperHostProbe | undefined;
  readonly hostUrl?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly executionProfile?: ReaperExecutionProfile | undefined;
};

const BASE_REAPER_CAPABILITIES: readonly DawCapability[] = [
  {
    capabilityId: 'daw.health.probe',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Probes reaper.exe binary, running process, %APPDATA%\\REAPER config, and loopback bridge RTT',
  },
  {
    capabilityId: 'daw.version.inspect',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads reaper.GetAppVersion() and Windows PE FileVersion',
  },
  {
    capabilityId: 'daw.session.inspect',
    category: 'session_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads live REAPER state + GetProjectStateChangeCount() alongside plain-text .rpp saved hash',
  },
  {
    capabilityId: 'daw.transport.read',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads GetPlayState(), GetSetRepeat(), GetCursorPosition(), Master_GetTempo(), TimeMap_GetTimeSigAtTime()',
  },
  {
    capabilityId: 'daw.mixer.read',
    category: 'track_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Unified MediaTrack read (Master + dynamic track list: D_VOL, D_PAN, B_MUTE, I_SOLO, peaks)',
  },
  {
    capabilityId: 'daw.routing.read',
    category: 'routing_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads GetTrackNumSends() + B_MAINSEND + pre/post I_SENDMODE + sidechain channel offset',
  },
  {
    capabilityId: 'daw.plugin.inventory_live',
    category: 'plugin_discovery',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads TrackFX_GetCount(), TrackFX_GetFXName(), TrackFX_GetEnabled(), TrackFX_GetOffline()',
  },
  {
    capabilityId: 'daw.plugin.param_read',
    category: 'parameter_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads TrackFX_GetNumParams(), GetParamName(), GetParamNormalized(), GetFormattedParamValue()',
  },
  {
    capabilityId: 'daw.project.rpp_inspect',
    category: 'project_validation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Plain-text .rpp S-expression container inspection with SHA-256 read-only integrity guard',
  },
  {
    capabilityId: 'daw.plugin.database_scan',
    category: 'plugin_discovery',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Scans local VST3/VST2 directories without needing live REAPER host running',
  },
  {
    capabilityId: 'daw.transport.control',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
    limitations: ['Controlled via DawCommandGateway; unattended recording capture stays blocked unless permitted'],
    notes: 'CSurf_OnPlay / CSurf_OnStop / SetCurrentTempo / GetSetRepeat',
  },
  {
    capabilityId: 'daw.mixer.fader_pan_mute',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
    notes: 'SetMediaTrackInfo_Value D_VOL (1.0 == 0 dBFS), D_PAN, B_MUTE, I_SOLO with beforeState restore',
  },
  {
    capabilityId: 'daw.plugin.bypass',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
    notes: 'TrackFX_SetEnabled(track, fxIdx, enabled) with direct readback verification',
  },
  {
    capabilityId: 'daw.plugin.param_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
    limitations: ['Requires explicit gateway policy allowlist opt-in'],
    notes: 'TrackFX_SetParamNormalized(track, fxIdx, paramIdx, val)',
  },
  {
    capabilityId: 'daw.mixer.routing_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: true,
    limitations: ['Requires strong human approval & explicit gateway allowlist opt-in'],
    notes: 'CreateTrackSend / RemoveTrackSend / SetTrackSendInfo_Value',
  },
  {
    capabilityId: 'daw.track.create_delete',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
    limitations: ['Dynamic track deletion requires strong confirmation and REAPER undo history; scalar rollback disabled'],
    notes: 'InsertTrackAtIndex / DeleteTrack (contrast with fixed-126-insert FL Studio where UNSUPPORTED)',
  },
  {
    capabilityId: 'daw.plugin.load_remove',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
    limitations: ['Removing an FX discards internal binary preset chunk unless saved'],
    notes: 'TrackFX_AddByName / TrackFX_Delete (contrast with FL Studio where UNSUPPORTED)',
  },
  {
    capabilityId: 'daw.project.save',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
    limitations: ['Overwrites .rpp project file on disk; lacks atomic gateway rollback'],
    notes: 'Main_SaveProject(0, false)',
  },
  {
    capabilityId: 'daw.render.master',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'SUPPORTED',
    rollbackSupported: false,
    limitations: ['External WAV render artifact creation; CLI reaper.exe -renderproject uses disk .rpp'],
    notes: 'reaper.exe -renderproject <file.rpp>',
  },
  {
    capabilityId: 'daw.audio.pcm_tap',
    category: 'audio_analysis',
    requiredTier: 'analyze',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['ReaScript defer/HTTP bridge does not stream continuous lock-free PCM/FFT buffers'],
    notes: 'Use Audio Brain offline WAV analysis on reaper.exe -renderproject output instead',
  },
];

export const REAPER_CAPABILITIES = BASE_REAPER_CAPABILITIES;

export const buildReaperCapabilities = (
  profile: ReaperExecutionProfile = 'controlled_safe_v1',
): readonly DawCapability[] => {
  if (profile === 'read_only') {
    return BASE_REAPER_CAPABILITIES.map((c) =>
      c.requiredTier === 'execute'
        ? { ...c, supportLevel: 'UNSUPPORTED' as const, rollbackSupported: false, notes: 'Locked read_only profile' }
        : c,
    );
  }
  return BASE_REAPER_CAPABILITIES;
};
