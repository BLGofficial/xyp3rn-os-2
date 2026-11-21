import {
  computeSnapshotDigest,
  type DawAudioClip,
  type DawChannel,
  type DawMixerChannel,
  type DawObservationProvenance,
  type DawPluginInstance,
  type DawSession,
  type DawStateSnapshot,
  type DawTrack,
} from '../../daw-brain/index.ts';
import { inspectFlpProjectFile } from './flp-inspector.ts';
import type { FlpParsedProject } from './types.ts';

/**
 * Converts a read-only parsed `.flp` container into a universal `DawSession` (`freshness: 'saved'`)
 * for offline Phase 12 DAW Session Intelligence inspection.
 * Guarantees unavailable binary fields (routing topology, clip timelines, plugin parameters,
 * and obfuscated scalar tempo/time-signature tokens) stay explicitly labeled rather than fabricated.
 */
export const flpParsedToDawSession = (parsed: FlpParsedProject): DawSession => {
  const sessionId = `flp-saved-${parsed.project.projectId}`;
  const observedAt = parsed.project.lastSavedAt ?? new Date().toISOString();
  const version = parsed.flVersion ?? 'unknown';

  const provenance: DawObservationProvenance = {
    observedAt,
    dawId: `fl-studio-file:${parsed.project.projectId}`,
    adapterId: 'fl-studio-2025',
    hostVersion: version,
    sourceEvidence: `Read-only .flp inspection (${parsed.projectPath}, sha256=${parsed.sha256BeforeRead.slice(0, 12)})`,
    freshness: 'saved',
  };

  const channels: DawChannel[] = parsed.channelNames.map((name, idx) => ({
    id: `channel:${idx}`,
    index: idx,
    name,
    kind: 'generator',
    targetMixerChannelId: null, // Target insert index not safely decoded offline
    muted: false,
    soloed: false,
    volumeNormalized: 0.78125,
    panNormalized: 0,
  }));

  const mixerChannels: DawMixerChannel[] = parsed.mixerTrackNames.map((name, idx) => ({
    id: `mixer:insert:${idx + 1}`,
    index: idx + 1,
    name,
    isMaster: false,
    volumeNormalized: 0.8,
    volumeDb: null,
    panNormalized: 0,
    muted: false,
    soloed: false,
    stereoSeparation: null,
    peakDb: null,
    pluginSlots: [],
  }));

  const tracks: DawTrack[] = parsed.playlistTrackNames.map((name, idx) => ({
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

  const plugins: DawPluginInstance[] = parsed.pluginNames.map((name, idx) => ({
    id: `plugin:flp:${idx}`,
    slotIndex: idx,
    containerId: 'flp:project',
    name,
    vendor: null,
    format: 'UNKNOWN',
    bypassed: false,
    mixLevel: null,
    editionCompatible: 'unknown',
    parameterCount: 0,
    parameters: {
      status: 'unavailable',
      reason: 'Plugin parameter values are stored inside opaque host chunks in .flp files; inspect live via controller script',
    },
  }));

  const audioClips: DawAudioClip[] = parsed.samplePaths.map((samplePath, idx) => ({
    id: `sample:${idx}`,
    name: samplePath.split(/[\\/]/).pop() ?? samplePath,
    trackId: 'unknown',
    sourcePath: samplePath,
    startBeats: 0,
    lengthBeats: 0,
    gainDb: null,
    muted: false,
  }));

  const unknownFields: string[] = [
    'buses:unavailable',
    'routing:unavailable',
    'automationLanes:unsupported',
    'midiClips:unavailable',
    'markers:unavailable',
    'regions:unavailable',
  ];
  if (parsed.tempoBpm.status !== 'available') unknownFields.push('tempo:unknown');
  if (parsed.timeSignature.status !== 'available') unknownFields.push('timeSignature:unknown');

  const snapshotBase: DawStateSnapshot = {
    snapshotId: `flpsnap-${parsed.sha256BeforeRead.slice(0, 10)}`,
    sessionId,
    freshness: 'saved',
    provenance,
    transport: {
      playing: false,
      paused: false,
      recording: false,
      loopEnabled: false,
      songPositionBeats: 0,
      songPositionSeconds: 0,
      tempo: {
        bpm: parsed.tempoBpm.status === 'available' ? parsed.tempoBpm.value : Number.NaN,
        freshness: parsed.tempoBpm.status === 'available' ? 'saved' : 'unknown',
      },
      timeSignature:
        parsed.timeSignature.status === 'available'
          ? parsed.timeSignature.value
          : { numerator: 0, denominator: 0, ppq: parsed.ppq },
      provenance,
    },
    tracks:
      tracks.length > 0
        ? { status: 'available', value: tracks }
        : { status: 'unavailable', reason: 'No named playlist tracks found in FLP event stream' },
    channels:
      channels.length > 0
        ? { status: 'available', value: channels }
        : { status: 'unavailable', reason: 'No named channels extracted from FLP stream' },
    mixerChannels:
      mixerChannels.length > 0
        ? { status: 'available', value: mixerChannels }
        : { status: 'unavailable', reason: 'No named mixer tracks extracted from FLP stream' },
    buses: {
      status: 'unavailable',
      reason: 'Offline .flp container inspection does not extract live FL bus routing topology',
    },
    routing: {
      status: 'unavailable',
      reason: 'Offline .flp container inspection does not extract live mixer send/route connections',
    },
    plugins:
      plugins.length > 0
        ? { status: 'available', value: plugins }
        : { status: 'unavailable', reason: 'No plugin identifier events extracted from FLP stream' },
    automationLanes: {
      status: 'unsupported',
      reason: 'Automation clip spline points are inaccessible in offline FLP header inspection',
    },
    audioClips:
      audioClips.length > 0
        ? { status: 'available', value: audioClips }
        : { status: 'unavailable', reason: 'No sample references found in FLP stream' },
    midiClips: {
      status: 'unavailable',
      reason: 'Full Piano Roll pattern note events require live/full binary chunk decoding not performed here',
    },
    markers: {
      status: 'unavailable',
      reason: 'Playlist markers not extracted by minimal read-only FLP inspector',
    },
    regions: {
      status: 'unavailable',
      reason: 'Timeline arrangement regions unavailable in offline FLP inspector',
    },
    stateDigest: '',
  };

  const savedSnapshot: DawStateSnapshot = {
    ...snapshotBase,
    stateDigest: computeSnapshotDigest(snapshotBase),
  };

  return {
    sessionId,
    adapterId: 'fl-studio-2025',
    dawId: `fl-studio-file:${parsed.project.projectId}`,
    hostVersion: version,
    project: parsed.project,
    connection: {
      connectionId: `offline-${parsed.project.projectId}`,
      instanceId: `fl-file-${parsed.project.projectId}`,
      adapterId: 'fl-studio-2025',
      sessionId,
      status: 'disconnected',
      activePermissionTier: 'observe',
      versionCompatibility: version.startsWith('26.') ? 'degraded_read_only' : 'compatible',
      connectedAt: observedAt,
      lastHeartbeatAt: null,
      lastRttMs: null,
      consecutiveFailures: 0,
    },
    stateFreshness: 'saved',
    observed: savedSnapshot,
    cached: null,
    stale: false,
    saved: parsed.project,
    proposed: [],
    applied: [],
    unknownFields,
    hasUnsavedLiveChanges: false,
    updatedAt: observedAt,
  };
};

export const inspectFlpAsDawSession = (filePath: string): DawSession =>
  flpParsedToDawSession(inspectFlpProjectFile(filePath));
