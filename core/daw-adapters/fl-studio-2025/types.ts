import type {
  DawAvailability,
  DawCapability,
  DawProject,
  DawTimeSignature,
} from '../../daw-brain/index.ts';

export type FlBinaryInstallInfo = {
  readonly label: string;
  readonly versionDir: string;
  readonly executablePath: string;
  readonly exists: boolean;
  readonly fileVersion: string | null;
  readonly productVersion: string | null;
  readonly hasCompanionDataDirs: boolean;
  readonly missingCompanionDirs: readonly string[];
};

export type FlMidiPortInfo = {
  readonly index: number;
  readonly direction: 'in' | 'out';
  readonly name: string;
};

export type FlRunningProcessInfo = {
  readonly pid: number;
  readonly processName: string;
  readonly executablePath: string | null;
};

export type FlHostEnvironment = {
  readonly probedAt: string;
  readonly installations: readonly FlBinaryInstallInfo[];
  readonly runningProcesses: readonly FlRunningProcessInfo[];
  readonly midiInPorts: readonly FlMidiPortInfo[];
  readonly midiOutPorts: readonly FlMidiPortInfo[];
  readonly loopMidiInstalled: boolean;
  readonly configuredInPortFound: boolean;
  readonly configuredOutPortFound: boolean;
  readonly controllerScriptPath: string;
  readonly controllerScriptInstalled: boolean;
  readonly userProjectsRoot: string;
  readonly pluginDatabaseRoot: string;
  readonly missingPrerequisites: readonly string[];
  readonly warnings: readonly string[];
};

export type FlpParsedProject = {
  readonly projectPath: string;
  readonly projectName: string;
  readonly sha256BeforeRead: string;
  readonly sha256AfterRead: string;
  readonly format: number;
  readonly channelCountHeader: number;
  readonly ppq: number;
  readonly flVersion: string | null;
  readonly flBuild: number | null;
  readonly tempoBpm: DawAvailability<number>;
  readonly timeSignature: DawAvailability<DawTimeSignature>;
  readonly arrangementName: string | null;
  readonly projectDataFolder: string | null;
  readonly channelNames: readonly string[];
  readonly mixerTrackNames: readonly string[];
  readonly playlistTrackNames: readonly string[];
  readonly samplePaths: readonly string[];
  readonly pluginNames: readonly string[];
  readonly project: DawProject;
  readonly warnings: readonly string[];
};

export type FlPluginInventoryEntry = {
  readonly name: string;
  readonly format: 'VST3' | 'VST2' | 'NATIVE' | 'UNKNOWN';
  readonly path: string;
  readonly source: 'plugin_database' | 'vst_filesystem' | 'plugin_manager_log';
  readonly producerEditionStatus: 'included_stock' | 'excluded_by_edition_unless_purchased' | 'third_party_compatible' | 'unknown';
};

export type FlSysExMessageType =
  | 0x01 // HELLO_REQ
  | 0x02 // HELLO_RESP
  | 0x03 // PING_REQ
  | 0x04 // PING_RESP
  | 0x10 // SNAPSHOT_REQ
  | 0x11 // SNAPSHOT_RESP
  | 0x12 // PARAMS_REQ
  | 0x13 // PARAMS_RESP
  | 0x20 // DIRTY_EVENT_PUSH
  | 0x30 // CMD_TRANSPORT_REQ (opt-in Phase 16 controlled_safe_v1)
  | 0x31 // CMD_TRANSPORT_RESP
  | 0x32 // CMD_MIXER_REQ
  | 0x33 // CMD_MIXER_RESP
  | 0x34 // CMD_PLUGIN_BYPASS_REQ
  | 0x35 // CMD_PLUGIN_BYPASS_RESP
  | 0x7e // ERR_READ_ONLY
  | 0x7f; // ERR_PROTOCOL

export type FlLiveHelloPayload = {
  readonly hostName: string;
  readonly fullVersionAndEdition: string;
  readonly version: string;
  readonly edition: string;
  readonly apiVersion: number;
  readonly ppq: number;
  readonly title: string;
  readonly scriptVersion: string;
  readonly readOnly: true;
};

export type FlLiveMixerSlotPlugin = {
  readonly slotIndex: number;
  readonly name: string;
  readonly bypassed: boolean | null;
  readonly mixLevel: number | null;
  readonly paramCount: number;
};

export type FlLiveMixerTrack = {
  readonly index: number;
  readonly name: string;
  readonly isMaster: boolean;
  readonly volumeNormalized: number;
  readonly panNormalized: number;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly peakNormalized: number | null;
  readonly routesToMaster: boolean | null;
  readonly routeTargets: readonly number[];
  readonly plugins: readonly FlLiveMixerSlotPlugin[];
};

export type FlLiveChannel = {
  readonly index: number;
  readonly name: string;
  readonly channelType: number;
  readonly targetMixerIndex: number | null;
  readonly muted: boolean;
  readonly soloed: boolean;
  readonly pluginName: string | null;
  readonly pluginParamCount: number | null;
};

export type FlLiveParameterInfo = {
  readonly containerKind: 'mixer' | 'channel';
  readonly containerIndex: number;
  readonly slotIndex: number;
  readonly pluginName: string;
  readonly paramIndex: number;
  readonly name: string;
  readonly valueNormalized: number;
  readonly displayValue: string;
};

export type FlLiveSnapshotPayload = {
  readonly observedAt: string;
  readonly title: string;
  readonly fullVersionAndEdition: string;
  readonly version: string;
  readonly edition: string;
  readonly apiVersion: number;
  readonly ppq: number;
  readonly playing: boolean;
  readonly recording: boolean;
  readonly loopMode: 'pattern' | 'song';
  readonly songPosMs: number;
  readonly songPosBeats: number | null;
  readonly tempoBpm: number;
  readonly timeSignatureNumerator: number | null;
  readonly timeSignatureDenominator: number | null;
  readonly channels: readonly FlLiveChannel[];
  readonly mixerTracks: readonly FlLiveMixerTrack[];
  readonly playlistTrackCount: number | null;
  readonly playlistTrackNames: readonly string[];
  readonly parameters?: readonly FlLiveParameterInfo[] | undefined;
  readonly dirtyFlags?: number | undefined;
};

export type FlIntegrationLogEntry = {
  readonly seq: number;
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly sessionId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
};

export type FlExecutionProfile = 'read_only' | 'controlled_safe_v1';

export type FlStudioAdapterOptions = {
  readonly adapterId?: string | undefined;
  readonly inPortName?: string | undefined;
  readonly outPortName?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly midiTransport?: import('./midi-transport.ts').FlMidiSysExTransport | undefined;
  readonly hostProbe?: import('./host-probe.ts').FlStudioHostProbe | undefined;
  readonly includeParametersOnObserve?: boolean | undefined;
  readonly maxPluginsToInspectParams?: number | undefined;
  readonly maxParamsPerPlugin?: number | undefined;
  /** Default is strictly `'read_only'` (Phase 11). `'controlled_safe_v1'` enables ONLY verified low-risk transport/mixer/bypass operations via DawCommandGateway. */
  readonly executionProfile?: FlExecutionProfile | undefined;
};

export const buildFlStudio2025Capabilities = (
  executionProfile: FlExecutionProfile = 'read_only',
): readonly DawCapability[] => {
  const safeExecEnabled = executionProfile === 'controlled_safe_v1';
  return FL_STUDIO_2025_CAPABILITIES.map((cap) => {
    if (!safeExecEnabled) return cap;
    if (
      cap.capabilityId === 'daw.transport.control' ||
      cap.capabilityId === 'daw.mixer.fader_pan_mute' ||
      cap.capabilityId === 'daw.plugin.bypass'
    ) {
      return {
        ...cap,
        supportLevel: 'SUPPORTED',
        rollbackSupported: true,
        limitations:
          cap.capabilityId === 'daw.transport.control'
            ? ['Controlled safe v1 enables play/stop/loop/bounded tempo; unattended recording capture stays blocked']
            : ['Controlled safe v1 bounded via DawCommandGateway with SysEx readback verification'],
        notes: 'Phase 16 opt-in controlled_safe_v1 low-risk execution capability',
      };
    }
    return cap;
  });
};

export const FL_STUDIO_EXCLUDED_IN_PRODUCER = new Set<string>([
  'gross beat',
  'harmor',
  'newtone',
  'newtime',
  'directwave',
  'pitch shifter',
  'vocodex',
  'sakura',
  'morphine',
  'poizone',
  'sawer',
  'toxic biohazard',
  'transient processor',
  'transporter',
  'pitcher',
  'harmless',
  'ogunn',
  'ogun',
]);

export const FL_STUDIO_2025_CAPABILITIES: readonly DawCapability[] = [
  {
    capabilityId: 'daw.health.probe',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Verified read-only host binary + WinMM MIDI loopback + SysEx PING probe',
  },
  {
    capabilityId: 'daw.version.inspect',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads ui.getVersion(VER_FullVersionAndEdition), general.getVersion(), and PE FileVersion',
  },
  {
    capabilityId: 'daw.session.inspect',
    category: 'session_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Read-only live session topology combined with optional read-only .flp saved checksums',
  },
  {
    capabilityId: 'daw.transport.read',
    category: 'daw_observation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads transport.isPlaying(), isRecording(), getLoopMode(), getSongPos(), mixer.getCurrentTempo(0)',
  },
  {
    capabilityId: 'daw.mixer.read',
    category: 'track_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads fixed 126-insert mixer names, normalized volumes, pans, mute, solo, and momentary peaks',
  },
  {
    capabilityId: 'daw.routing.read',
    category: 'routing_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads channel->mixer targetFxTrack and active mixer.getRouteSendActive(src, dst) topology',
  },
  {
    capabilityId: 'daw.plugin.inventory_live',
    category: 'plugin_discovery',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Enumerates already-loaded channel generator and mixer slot plugins via plugins.isValid/getPluginName',
  },
  {
    capabilityId: 'daw.plugin.params_read',
    category: 'parameter_inspection',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Reads bounded plugin parameter names, normalized values, and display strings where host exposes them',
  },
  {
    capabilityId: 'daw.project.flp_inspect',
    category: 'project_validation',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Read-only .flp FLhd/FLdt container inspector + SHA-256 verification; obfuscated scalars marked unknown',
  },
  {
    capabilityId: 'daw.plugin.database_scan',
    category: 'plugin_discovery',
    requiredTier: 'observe',
    supportLevel: 'READ_ONLY',
    rollbackSupported: false,
    notes: 'Read-only scan of VST3/VST2 directories and FL PluginManager logs with Producer Edition audit',
  },
  // ── Explicitly UNSUPPORTED in FL Studio API or deferred in Phase 11 Read-Only v1 ──
  {
    capabilityId: 'daw.track.create_delete',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Image-Line MIDI Scripting API has no function to create or delete mixer inserts or channels'],
    notes: 'Officially absent in FL Studio Python scripting (fixed 126-insert mixer architecture)',
  },
  {
    capabilityId: 'daw.plugin.load_remove',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Image-Line MIDI Scripting API cannot instantiate, replace, or remove plugins on channels or mixer slots'],
    notes: 'Officially absent in FL Studio Python scripting; requires manual operator insertion',
  },
  {
    capabilityId: 'daw.project.save',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['No silent programmatic saveProjectAs(path) API exists in FL Python scripting', 'Binary .flp writes forbidden by OS3 safety policy'],
    notes: 'UNSUPPORTED — binary .flp mutation and unattended saves are blocked',
  },
  {
    capabilityId: 'daw.automation.edit',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Playlist Automation Clip envelopes/points cannot be inspected or edited via FL MIDI controller scripting'],
    notes: 'UNSUPPORTED — no spline breakpoint API in Image-Line MIDI scripting',
  },
  {
    capabilityId: 'daw.audio.pcm_tap',
    category: 'audio_analysis',
    requiredTier: 'analyze',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Controller Python sandbox exposes momentary track peaks only, not live PCM/FFT streams'],
    notes: 'Use offline WAV Audio Brain or external TRACE integration instead of MIDI SysEx PCM capture',
  },
  {
    capabilityId: 'daw.render.split_stems',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['FL64.exe /R CLI does not expose a native split-mixer-tracks switch'],
    notes: 'UNSUPPORTED via headless CLI switches',
  },
  {
    capabilityId: 'daw.transport.control',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Phase 11 read-only release: transport write commands disabled pending EXP-FL-02 approval release'],
    notes: 'Intentionally locked in Phase 11 observation-only adapter release',
  },
  {
    capabilityId: 'daw.mixer.fader_pan_mute',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Phase 11 read-only release: mixer fader/pan/mute writes disabled pending EXP-FL-03 approval release'],
    notes: 'Intentionally locked in Phase 11 observation-only adapter release',
  },
  {
    capabilityId: 'daw.mixer.routing_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Phase 11 read-only release: mixer send/route writes disabled pending EXP-FL-03 approval release'],
    notes: 'Intentionally locked in Phase 11 observation-only adapter release',
  },
  {
    capabilityId: 'daw.plugin.param_write',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Phase 11 read-only release: VST/native parameter writes disabled pending EXP-FL-04 approval release'],
    notes: 'Intentionally locked in Phase 11 observation-only adapter release',
  },
  {
    capabilityId: 'daw.plugin.bypass',
    category: 'daw_command_execution',
    requiredTier: 'execute',
    supportLevel: 'UNSUPPORTED',
    rollbackSupported: false,
    limitations: ['Phase 11 read-only release: plugin mute/bypass writes disabled pending EXP-FL-04 approval release'],
    notes: 'Intentionally locked in Phase 11 observation-only adapter release',
  },
];
