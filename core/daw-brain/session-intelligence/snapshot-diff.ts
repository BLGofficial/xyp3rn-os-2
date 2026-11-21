import type { DawStateSnapshot } from '../types.ts';
import type { DawSnapshotComparison } from './types.ts';

/**
 * Computes a deterministic structural & parameter diff between two DAW snapshots
 * without assuming inaccessible sections changed cleanly.
 */
export const compareDawSnapshots = (
  before: DawStateSnapshot,
  after: DawStateSnapshot,
): DawSnapshotComparison => {
  const tempoDelta =
    Number.isFinite(before.transport.tempo.bpm) && Number.isFinite(after.transport.tempo.bpm)
      ? Number((after.transport.tempo.bpm - before.transport.tempo.bpm).toFixed(3))
      : null;

  const timeSignatureChanged =
    before.transport.timeSignature.numerator !== after.transport.timeSignature.numerator ||
    before.transport.timeSignature.denominator !== after.transport.timeSignature.denominator;

  const transportChanges: string[] = [];
  if (before.transport.playing !== after.transport.playing) {
    transportChanges.push(`playing: ${String(before.transport.playing)} -> ${String(after.transport.playing)}`);
  }
  if (before.transport.recording !== after.transport.recording) {
    transportChanges.push(`recording: ${String(before.transport.recording)} -> ${String(after.transport.recording)}`);
  }
  if (before.transport.loopEnabled !== after.transport.loopEnabled) {
    transportChanges.push(`loopEnabled: ${String(before.transport.loopEnabled)} -> ${String(after.transport.loopEnabled)}`);
  }
  if (tempoDelta !== null && Math.abs(tempoDelta) > 0.0001) {
    transportChanges.push(`tempoBpm: ${before.transport.tempo.bpm} -> ${after.transport.tempo.bpm}`);
  }

  const beforeTracks = before.tracks.status === 'available' ? before.tracks.value : [];
  const afterTracks = after.tracks.status === 'available' ? after.tracks.value : [];
  const beforeTrackIds = new Set(beforeTracks.map((t) => t.id));
  const afterTrackIds = new Set(afterTracks.map((t) => t.id));
  const addedTracks = afterTracks.filter((t) => !beforeTrackIds.has(t.id)).map((t) => `${t.id} (${t.name})`);
  const removedTracks = beforeTracks.filter((t) => !afterTrackIds.has(t.id)).map((t) => `${t.id} (${t.name})`);

  const beforeMixers = before.mixerChannels.status === 'available' ? before.mixerChannels.value : [];
  const afterMixers = after.mixerChannels.status === 'available' ? after.mixerChannels.value : [];
  const beforeMixerMap = new Map(beforeMixers.map((m) => [m.id, m]));
  const afterMixerMap = new Map(afterMixers.map((m) => [m.id, m]));

  const addedMixerChannels = afterMixers
    .filter((m) => !beforeMixerMap.has(m.id))
    .map((m) => `${m.id} (${m.name})`);
  const removedMixerChannels = beforeMixers
    .filter((m) => !afterMixerMap.has(m.id))
    .map((m) => `${m.id} (${m.name})`);

  const mixerChanges: Array<{
    readonly mixerChannelId: string;
    readonly name: string;
    readonly field: 'volumeNormalized' | 'panNormalized' | 'muted' | 'soloed';
    readonly before: string | number | boolean;
    readonly after: string | number | boolean;
  }> = [];

  for (const [id, b] of beforeMixerMap.entries()) {
    const a = afterMixerMap.get(id);
    if (!a) continue;
    if (Math.abs(a.volumeNormalized - b.volumeNormalized) > 0.0005) {
      mixerChanges.push({
        mixerChannelId: id,
        name: a.name,
        field: 'volumeNormalized',
        before: Number(b.volumeNormalized.toFixed(4)),
        after: Number(a.volumeNormalized.toFixed(4)),
      });
    }
    if (Math.abs(a.panNormalized - b.panNormalized) > 0.0005) {
      mixerChanges.push({
        mixerChannelId: id,
        name: a.name,
        field: 'panNormalized',
        before: Number(b.panNormalized.toFixed(4)),
        after: Number(a.panNormalized.toFixed(4)),
      });
    }
    if (a.muted !== b.muted) {
      mixerChanges.push({ mixerChannelId: id, name: a.name, field: 'muted', before: b.muted, after: a.muted });
    }
    if (a.soloed !== b.soloed) {
      mixerChanges.push({ mixerChannelId: id, name: a.name, field: 'soloed', before: b.soloed, after: a.soloed });
    }
  }

  const beforeRoutes = before.routing.status === 'available' ? before.routing.value : [];
  const afterRoutes = after.routing.status === 'available' ? after.routing.value : [];
  const routeKey = (r: { sourceId: string; targetId: string }) => `${r.sourceId}->${r.targetId}`;
  const beforeRouteKeys = new Set(beforeRoutes.filter((r) => r.enabled).map(routeKey));
  const afterRouteKeys = new Set(afterRoutes.filter((r) => r.enabled).map(routeKey));
  const addedRouting = [...afterRouteKeys].filter((k) => !beforeRouteKeys.has(k));
  const removedRouting = [...beforeRouteKeys].filter((k) => !afterRouteKeys.has(k));

  const beforePlugs = before.plugins.status === 'available' ? before.plugins.value : [];
  const afterPlugs = after.plugins.status === 'available' ? after.plugins.value : [];
  const beforePlugMap = new Map(beforePlugs.map((p) => [p.id, p]));
  const afterPlugMap = new Map(afterPlugs.map((p) => [p.id, p]));

  const addedPlugins = afterPlugs
    .filter((p) => !beforePlugMap.has(p.id))
    .map((p) => `${p.id} (${p.name})`);
  const removedPlugins = beforePlugs
    .filter((p) => !afterPlugMap.has(p.id))
    .map((p) => `${p.id} (${p.name})`);

  const changedPluginParameters: Array<{
    readonly pluginId: string;
    readonly pluginName: string;
    readonly paramId: string;
    readonly paramName: string;
    readonly beforeValue: number;
    readonly afterValue: number;
  }> = [];

  for (const [id, bPlug] of beforePlugMap.entries()) {
    const aPlug = afterPlugMap.get(id);
    if (!aPlug || bPlug.parameters.status !== 'available' || aPlug.parameters.status !== 'available') continue;
    const bParamMap = new Map(bPlug.parameters.value.map((p) => [p.id, p]));
    for (const ap of aPlug.parameters.value) {
      const bp = bParamMap.get(ap.id);
      if (bp && Math.abs(ap.valueNormalized - bp.valueNormalized) > 0.0005) {
        changedPluginParameters.push({
          pluginId: aPlug.id,
          pluginName: aPlug.name,
          paramId: ap.id,
          paramName: ap.name,
          beforeValue: Number(bp.valueNormalized.toFixed(4)),
          afterValue: Number(ap.valueNormalized.toFixed(4)),
        });
      }
    }
  }

  const stateDigestChanged = before.stateDigest !== after.stateDigest;
  const changePieces = [
    transportChanges.length > 0 ? `${transportChanges.length} transport change(s)` : null,
    addedTracks.length + removedTracks.length > 0 ? `${addedTracks.length} added / ${removedTracks.length} removed tracks` : null,
    mixerChanges.length > 0 ? `${mixerChanges.length} mixer control change(s)` : null,
    addedRouting.length + removedRouting.length > 0 ? `${addedRouting.length} added / ${removedRouting.length} removed route(s)` : null,
    addedPlugins.length + removedPlugins.length > 0 ? `${addedPlugins.length} added / ${removedPlugins.length} removed plugin(s)` : null,
    changedPluginParameters.length > 0 ? `${changedPluginParameters.length} plugin parameter change(s)` : null,
  ].filter((x): x is string => Boolean(x));

  const summary =
    changePieces.length > 0
      ? `Detected ${changePieces.join('; ')}`
      : stateDigestChanged
        ? 'Snapshot digest changed with subtle metadata/timestamp differences'
        : 'No structural or parameter differences detected between snapshots';

  return {
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    beforeObservedAt: before.provenance.observedAt,
    afterObservedAt: after.provenance.observedAt,
    freshnessTransition: `${before.freshness}->${after.freshness}`,
    stateDigestChanged,
    tempoDeltaBpm: tempoDelta,
    timeSignatureChanged,
    transportChanges,
    addedTracks,
    removedTracks,
    addedMixerChannels,
    removedMixerChannels,
    mixerChanges,
    addedRouting,
    removedRouting,
    addedPlugins,
    removedPlugins,
    changedPluginParameters,
    summary,
  };
};
