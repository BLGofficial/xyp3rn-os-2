import type { DawStateSnapshot } from '../types.ts';
import type {
  DawAnalysisConfidence,
  DawRoutingGraph,
  DawRoutingGraphEdge,
  DawRoutingGraphNode,
  DawTrackRole,
} from './types.ts';

type RoleRule = {
  readonly role: DawTrackRole;
  readonly tokens: readonly RegExp[];
};

const ROLE_RULES: readonly RoleRule[] = [
  { role: 'master', tokens: [/\bmaster\b/i, /\b2[-\s]?bus\b/i, /\bmain\s+mix\b/i] },
  {
    role: 'vocal',
    tokens: [
      /\bvox\b/i,
      /\bvocal/i,
      /\blead\b/i,
      /\bhook\b/i,
      /\badlib/i,
      /\bharmony/i,
      /\bdubs?\b/i,
      /\bmic\b/i,
      /\brec\b/i,
      /\bchoir/i,
    ],
  },
  {
    role: 'drums_percussion',
    tokens: [
      /\bdrum/i,
      /\bkick\b/i,
      /\bsnare/i,
      /\bclap/i,
      /\bhat/i,
      /\bperc/i,
      /\bcymbal/i,
      /\btop\s*loop/i,
    ],
  },
  { role: 'bass_sub', tokens: [/\bbass\b/i, /\b808\b/i, /\bsub\b/i, /\breese\b/i] },
  {
    role: 'fx_return',
    tokens: [
      /\bverb\b/i,
      /\breverb/i,
      /\bdelay/i,
      /\bparallel/i,
      /\bsend\b/i,
      /\breturn\b/i,
      /\bdoubler\b/i,
      /\bfx\b/i,
    ],
  },
  { role: 'submix_bus', tokens: [/\bbus\b/i, /\bgroup\b/i, /\bstem\b/i, /\bbeat\b/i, /\bmusic\b/i, /\binstr/i] },
  {
    role: 'melodic_synth',
    tokens: [
      /\bsynth/i,
      /\bkey/i,
      /\bpiano/i,
      /\bstring/i,
      /\bpad\b/i,
      /\bguitar/i,
      /\bmelody/i,
      /\bpluck/i,
      /\bchord/i,
      /\barp\b/i,
    ],
  },
  { role: 'reference', tokens: [/\bref\b/i, /\breference/i, /\bcompare/i] },
];

const GENERIC_LABEL_RE =
  /^(insert\s+\d+|channel\s+\d+|track\s+\d+|audio\s+\d+|sampler|untitled|pattern\s+\d+|bus\s+\d+)$/i;

export const isGenericTrackLabel = (name: string): boolean => GENERIC_LABEL_RE.test(name.trim());

export const classifyRoleFromLabelAndPlugins = (input: {
  readonly name: string;
  readonly isMaster?: boolean | undefined;
  readonly pluginNames?: readonly string[] | undefined;
}): {
  readonly role: DawTrackRole;
  readonly confidence: DawAnalysisConfidence['level'];
  readonly evidence: readonly string[];
} => {
  if (input.isMaster) {
    return { role: 'master', confidence: 'high', evidence: ['isMaster flag = true'] };
  }

  const label = input.name.trim();
  const evidence: string[] = [];

  if (!label || isGenericTrackLabel(label)) {
    const plugs = input.pluginNames ?? [];
    if (plugs.some((p) => /reeverb|valhalla|delay|echo/i.test(p)) && plugs.length <= 2) {
      evidence.push(`Generic name "${label || '(empty)'}" with time-based plugin [${plugs.join(', ')}]`);
      return { role: 'unclassified', confidence: 'low', evidence };
    }
    return {
      role: 'unclassified',
      confidence: 'low',
      evidence: [`Generic or default label "${label || '(empty)'}" gives insufficient naming evidence`],
    };
  }

  for (const rule of ROLE_RULES) {
    const hit = rule.tokens.find((re) => re.test(label));
    if (hit) {
      evidence.push(`Label "${label}" matched ${rule.role} pattern`);
      return { role: rule.role, confidence: 'high', evidence };
    }
  }

  return {
    role: 'unclassified',
    confidence: 'medium',
    evidence: [`Custom label "${label}" did not match known role patterns`],
  };
};

const buildSignalChains = (
  nodeIds: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
  masterIds: ReadonlySet<string>,
): {
  readonly chains: ReadonlyArray<readonly string[]>;
  readonly cycles: ReadonlyArray<readonly string[]>;
} => {
  const chains: string[][] = [];
  const cycles: string[][] = [];

  const inCount = new Map<string, number>();
  for (const id of nodeIds) inCount.set(id, 0);
  for (const targets of adj.values()) {
    for (const t of targets) {
      inCount.set(t, (inCount.get(t) ?? 0) + 1);
    }
  }

  const roots = nodeIds.filter((id) => !masterIds.has(id) && (inCount.get(id) ?? 0) === 0);
  const startSet = roots.length > 0 ? roots : nodeIds.filter((id) => !masterIds.has(id));

  const dfs = (cur: string, path: string[], visited: Set<string>): void => {
    if (chains.length >= 64 || path.length > 16) return;
    const nexts = adj.get(cur) ?? [];
    if (nexts.length === 0 || masterIds.has(cur)) {
      if (path.length >= 2) chains.push([...path]);
      return;
    }
    for (const nxt of nexts) {
      if (visited.has(nxt)) {
        if (cycles.length < 16) cycles.push([...path, nxt]);
        continue;
      }
      visited.add(nxt);
      path.push(nxt);
      dfs(nxt, path, visited);
      path.pop();
      visited.delete(nxt);
    }
  };

  for (const root of startSet) {
    dfs(root, [root], new Set([root]));
  }

  return { chains, cycles };
};

/**
 * Builds a directed signal-flow graph from observed channels, tracks, mixer inserts, buses,
 * and routing edges. Never fabricates routing or false-positive orphan warnings when `routing`
 * telemetry is marked `unavailable` or `unsupported`.
 */
export const buildDawRoutingGraph = (snapshot: DawStateSnapshot): DawRoutingGraph => {
  const nodesMap = new Map<string, DawRoutingGraphNode>();
  const edges: DawRoutingGraphEdge[] = [];
  const seenEdgeIds = new Set<string>();

  const channelsAvail = snapshot.channels.status === 'available' ? snapshot.channels.value : [];
  const mixerAvail = snapshot.mixerChannels.status === 'available' ? snapshot.mixerChannels.value : [];
  const busesAvail = snapshot.buses.status === 'available' ? snapshot.buses.value : [];
  const routingAvail = snapshot.routing.status === 'available' ? snapshot.routing.value : [];
  const tracksAvail = snapshot.tracks.status === 'available' ? snapshot.tracks.value : [];

  const masterSinkIds: string[] = [];

  for (const mx of mixerAvail) {
    if (mx.isMaster) masterSinkIds.push(mx.id);
    const pluginNames = mx.pluginSlots.map((p) => p.name);
    const { role } = classifyRoleFromLabelAndPlugins({
      name: mx.name,
      isMaster: mx.isMaster,
      pluginNames,
    });
    nodesMap.set(mx.id, {
      id: mx.id,
      nodeKind: mx.isMaster ? 'master' : 'mixer_channel',
      label: mx.name,
      role,
      isMaster: mx.isMaster,
      muted: mx.muted,
      soloed: mx.soloed,
      pluginNames,
      inDegree: 0,
      outDegree: 0,
    });
  }

  for (const bus of busesAvail) {
    if (!nodesMap.has(bus.mixerChannelId) && !nodesMap.has(bus.id)) {
      nodesMap.set(bus.id, {
        id: bus.id,
        nodeKind: bus.role === 'master' ? 'master' : 'bus',
        label: bus.name,
        role: bus.role === 'master' ? 'master' : bus.role === 'send' ? 'fx_return' : 'submix_bus',
        isMaster: bus.role === 'master',
        muted: false,
        soloed: false,
        pluginNames: [],
        inDegree: 0,
        outDegree: 0,
      });
      if (bus.role === 'master') masterSinkIds.push(bus.id);
    }
  }

  for (const ch of channelsAvail) {
    const { role } = classifyRoleFromLabelAndPlugins({ name: ch.name });
    nodesMap.set(ch.id, {
      id: ch.id,
      nodeKind: 'channel',
      label: ch.name,
      role,
      isMaster: false,
      muted: ch.muted,
      soloed: ch.soloed,
      pluginNames: [],
      inDegree: 0,
      outDegree: 0,
    });

    if (ch.targetMixerChannelId) {
      if (!nodesMap.has(ch.targetMixerChannelId)) {
        nodesMap.set(ch.targetMixerChannelId, {
          id: ch.targetMixerChannelId,
          nodeKind: 'unknown_target',
          label: ch.targetMixerChannelId,
          role: 'unclassified',
          isMaster: false,
          muted: false,
          soloed: false,
          pluginNames: [],
          inDegree: 0,
          outDegree: 0,
        });
      }
      const edgeId = `ch:${ch.id}->${ch.targetMixerChannelId}`;
      seenEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        sourceId: ch.id,
        targetId: ch.targetMixerChannelId,
        edgeKind: 'channel_to_mixer',
        enabled: !ch.muted,
        sendNormalized: ch.volumeNormalized,
        preFader: false,
        sidechain: false,
        evidence: `Channel "${ch.name}" targetMixerChannelId=${ch.targetMixerChannelId}`,
      });
    }
  }

  for (const tr of tracksAvail) {
    if (!nodesMap.has(tr.id)) {
      const { role } = classifyRoleFromLabelAndPlugins({ name: tr.name, isMaster: tr.kind === 'master' });
      nodesMap.set(tr.id, {
        id: tr.id,
        nodeKind: tr.kind === 'master' ? 'master' : 'track',
        label: tr.name,
        role,
        isMaster: tr.kind === 'master',
        muted: tr.muted,
        soloed: tr.soloed,
        pluginNames: [],
        inDegree: 0,
        outDegree: 0,
      });
      if (tr.kind === 'master' && !masterSinkIds.includes(tr.id)) {
        masterSinkIds.push(tr.id);
      }
    }
    if (tr.mixerChannelId && !seenEdgeIds.has(`tr:${tr.id}->${tr.mixerChannelId}`)) {
      const edgeId = `tr:${tr.id}->${tr.mixerChannelId}`;
      seenEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        sourceId: tr.id,
        targetId: tr.mixerChannelId,
        edgeKind: 'channel_to_mixer',
        enabled: !tr.muted,
        sendNormalized: 1,
        preFader: false,
        sidechain: false,
        evidence: `Track "${tr.name}" mapped to ${tr.mixerChannelId}`,
      });
    }
  }

  for (const r of routingAvail) {
    const eid = `rt:${r.sourceId}->${r.targetId}`;
    if (seenEdgeIds.has(eid)) continue;
    seenEdgeIds.add(eid);

    for (const ep of [r.sourceId, r.targetId]) {
      if (!nodesMap.has(ep)) {
        nodesMap.set(ep, {
          id: ep,
          nodeKind: 'unknown_target',
          label: ep,
          role: ep.toLowerCase().includes('master') ? 'master' : 'unclassified',
          isMaster: ep.toLowerCase().includes('master'),
          muted: false,
          soloed: false,
          pluginNames: [],
          inDegree: 0,
          outDegree: 0,
        });
      }
    }

    edges.push({
      id: eid,
      sourceId: r.sourceId,
      targetId: r.targetId,
      edgeKind: 'mixer_send',
      enabled: r.enabled,
      sendNormalized: r.sendNormalized,
      preFader: r.preFader,
      sidechain: r.sidechain,
      evidence: `Observed route "${r.id}" (${r.sourceId} -> ${r.targetId}, enabled=${r.enabled})`,
    });
  }

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const e of edges) {
    if (!e.enabled) continue;
    outDeg.set(e.sourceId, (outDeg.get(e.sourceId) ?? 0) + 1);
    inDeg.set(e.targetId, (inDeg.get(e.targetId) ?? 0) + 1);
    const arr = adj.get(e.sourceId) ?? [];
    arr.push(e.targetId);
    adj.set(e.sourceId, arr);
  }

  const finalNodes: DawRoutingGraphNode[] = [...nodesMap.values()].map((n) => ({
    ...n,
    inDegree: inDeg.get(n.id) ?? 0,
    outDegree: outDeg.get(n.id) ?? 0,
  }));

  const routingObservable = snapshot.routing.status === 'available';
  const mixerObservable = snapshot.mixerChannels.status === 'available';

  let observabilityStatus: DawRoutingGraph['observabilityStatus'] = 'complete';
  let observabilityReason = 'Channels, mixer inserts, and routing edges are all directly observable';
  if (!routingObservable && !mixerObservable) {
    observabilityStatus = 'unavailable';
    observabilityReason = `Routing (${snapshot.routing.status}) and mixer (${snapshot.mixerChannels.status}) unavailable in current snapshot`;
  } else if (snapshot.routing.status !== 'available') {
    observabilityStatus = 'unavailable';
    observabilityReason = `Routing edges ${snapshot.routing.status}: ${snapshot.routing.reason}`;
  } else if (channelsAvail.length > 0 && channelsAvail.every((c) => c.targetMixerChannelId === null) && snapshot.freshness === 'saved') {
    observabilityStatus = 'partial';
    observabilityReason = 'Offline saved project extracted named entities, but live channel-to-mixer links are unavailable without host runtime';
  }

  const orphanNodeIds: string[] = [];
  const disconnectedSourceIds: string[] = [];

  if (observabilityStatus === 'complete') {
    const masterSet = new Set(masterSinkIds);
    const reverseAdj = new Map<string, string[]>();
    for (const e of edges) {
      if (!e.enabled) continue;
      const arr = reverseAdj.get(e.targetId) ?? [];
      arr.push(e.sourceId);
      reverseAdj.set(e.targetId, arr);
    }

    const reachesMaster = new Set<string>(masterSinkIds);
    const queue = [...masterSinkIds];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const prev of reverseAdj.get(cur) ?? []) {
        if (!reachesMaster.has(prev)) {
          reachesMaster.add(prev);
          queue.push(prev);
        }
      }
    }

    for (const node of finalNodes) {
      if (node.isMaster) continue;
      if (node.inDegree === 0 && node.outDegree === 0) {
        orphanNodeIds.push(node.id);
      } else if (
        (node.nodeKind === 'channel' || (node.nodeKind === 'mixer_channel' && node.inDegree > 0)) &&
        masterSet.size > 0 &&
        !reachesMaster.has(node.id)
      ) {
        disconnectedSourceIds.push(node.id);
      }
    }
  }

  const masterSet = new Set(masterSinkIds);
  const { chains, cycles } = buildSignalChains(
    finalNodes.map((n) => n.id),
    adj,
    masterSet,
  );

  return {
    observabilityStatus,
    observabilityReason,
    nodes: finalNodes,
    edges,
    signalFlowChains: chains,
    masterSinkIds,
    orphanNodeIds,
    disconnectedSourceIds,
    cyclePaths: cycles,
  };
};
