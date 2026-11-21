import type { DawAdapter } from '../daw-brain/index.ts';

export type MultiDawSemanticDiff = {
  readonly aspect: string;
  readonly flStudio: string;
  readonly reaper: string;
  readonly universalContractHandling: string;
};

export type MultiDawCapabilityRow = {
  readonly capabilityId: string;
  readonly adapters: Readonly<Record<string, string>>;
};

export type MultiDawCompatibilityReport = {
  readonly generatedAt: string;
  readonly adapterIds: readonly string[];
  readonly sharedCapabilities: readonly string[];
  readonly dawSpecificCapabilities: Readonly<Record<string, readonly string[]>>;
  readonly capabilityGaps: readonly MultiDawCapabilityRow[];
  readonly unsupportedEverywhere: readonly string[];
  readonly semanticDifferences: readonly MultiDawSemanticDiff[];
  readonly stateSyncComparison: Readonly<{
    readonly flStudio: string;
    readonly reaper: string;
    readonly simulated: string;
  }>;
};

/**
 * Generates an evidence-backed cross-DAW compatibility comparison from live `DawAdapter` manifests
 * without mutating core contracts or forcing identical semantics across distinct DAWs.
 */
export const buildMultiDawCompatibilityReport = (
  adapters: readonly DawAdapter[],
): MultiDawCompatibilityReport => {
  const allCapIds = new Set<string>();
  const capMaps = new Map<string, ReadonlyMap<string, string>>();

  for (const adapter of adapters) {
    const map = new Map<string, string>();
    for (const cap of adapter.getCapabilities()) {
      allCapIds.add(cap.capabilityId);
      map.set(cap.capabilityId, cap.supportLevel);
    }
    capMaps.set(adapter.manifest.adapterId, map);
  }

  const sharedCapabilities: string[] = [];
  const capabilityGaps: MultiDawCapabilityRow[] = [];
  const unsupportedEverywhere: string[] = [];
  const dawSpecificCapabilities: Record<string, string[]> = {};
  for (const a of adapters) dawSpecificCapabilities[a.manifest.adapterId] = [];

  for (const capId of [...allCapIds].sort()) {
    const row: Record<string, string> = {};
    const activeAdapters: string[] = [];
    let anyUnsupported = false;

    for (const adapter of adapters) {
      const id = adapter.manifest.adapterId;
      const lvl = capMaps.get(id)?.get(capId) ?? 'UNDECLARED';
      row[id] = lvl;
      if (lvl === 'SUPPORTED' || lvl === 'READ_ONLY' || lvl === 'TEMPLATE_SCOPED') {
        activeAdapters.push(id);
      } else {
        anyUnsupported = true;
      }
    }

    if (activeAdapters.length === adapters.length) {
      sharedCapabilities.push(capId);
    } else if (activeAdapters.length === 0) {
      unsupportedEverywhere.push(capId);
    } else {
      capabilityGaps.push({ capabilityId: capId, adapters: row });
      if (activeAdapters.length === 1 && anyUnsupported) {
        dawSpecificCapabilities[activeAdapters[0]!]!.push(capId);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    adapterIds: adapters.map((a) => a.manifest.adapterId),
    sharedCapabilities,
    dawSpecificCapabilities,
    capabilityGaps,
    unsupportedEverywhere,
    semanticDifferences: [
      {
        aspect: 'Unity Fader Calibration (0.0 dBFS)',
        flStudio: 'volumeNormalized = 0.8 equals 0.0 dBFS (TackDefaultVolume logarithmic scaling)',
        reaper: 'D_VOL linear = 1.0 equals 0.0 dBFS (20 * log10(D_VOL))',
        universalContractHandling: 'Universal safety gate compares explicit volumeDb <= 0 dBFS and host unity rather than hardcoding 0.8',
      },
      {
        aspect: 'Track vs Mixer Topology',
        flStudio: 'Decoupled Channel Rack (patterns/generators), Fixed 126 Mixer Inserts (0..125), and Playlist Tracks',
        reaper: 'Unified dynamic MediaTrack array (-1 Master, 0..N-1) owning audio/MIDI items, FX chain, and sends simultaneously',
        universalContractHandling: 'Adapters populate DawTrack, DawChannel, and DawMixerChannel with stable container/target IDs cleanly',
      },
      {
        aspect: 'Plugin Load / Track Creation',
        flStudio: 'UNSUPPORTED in Image-Line MIDI Scripting API (manual UI step required)',
        reaper: 'SUPPORTED via TrackFX_AddByName and InsertTrackAtIndex / DeleteTrack',
        universalContractHandling: 'DawCapabilityRegistry + Command Gateway fail fast on FL Studio while dispatching cleanly on REAPER',
      },
      {
        aspect: 'Timeline Arrangement Entities',
        flStudio: 'automationLanes, audioClips, midiClips, markers, regions explicitly UNSUPPORTED via MIDI SysEx API',
        reaper: 'All 5 timeline sections natively AVAILABLE via ReaScript & plain-text .rpp tree',
        universalContractHandling: 'DawAvailability<T> reports honest status ("available" vs "unsupported") without empty placeholder arrays',
      },
      {
        aspect: 'Project Format & Live-vs-Saved Sync',
        flStudio: 'Binary .flp (read-only inspection only, silent save UNSUPPORTED)',
        reaper: 'Plain-text S-expression .rpp + Main_SaveProject() SUPPORTED + opaque Base64 FX preset blobs',
        universalContractHandling: 'DawSessionModel isolates saved vs observed vs cached states across both .flp and .rpp',
      },
    ],
    stateSyncComparison: {
      flStudio: '7-bit chunked WinMM SysEx (loopMIDI) with CRC-16 + OnRefresh(HW_Dirty_*) debounced pushes (~45 ms)',
      reaper: '127.0.0.1 HTTP/RPC ReaScript defer() polling GetProjectStateChangeCount() incremental state counter pushes (~50 ms)',
      simulated: 'In-memory deterministic FakeDawAdapter push subscriber & configurable latency/fault simulation',
    },
  };
};
