import { randomUUID } from 'node:crypto';
import type { DawAvailability, DawSession, DawStateSnapshot } from '../types.ts';
import {
  buildDawRoutingGraph,
  classifyRoleFromLabelAndPlugins,
  isGenericTrackLabel,
} from './routing-graph.ts';
import { compareDawSnapshots } from './snapshot-diff.ts';
import type {
  AnalyzeDawSessionOptions,
  DawAnalysisConfidence,
  DawClassifiedTrack,
  DawComplexityReport,
  DawConfidenceLevel,
  DawConsistencyIssue,
  DawConsistencyReport,
  DawKnowledgeIntegrationReport,
  DawNamingOrganizationReport,
  DawRecommendedAction,
  DawRoutingGraph,
  DawSessionAnalysisMetadata,
  DawSessionAnalysisReport,
  DawSessionFinding,
  DawSessionInventory,
  DawSnapshotComparison,
} from './types.ts';

const buildInventory = (
  snapshot: DawStateSnapshot | null,
  meta: DawSessionAnalysisMetadata,
): DawSessionInventory => {
  if (!snapshot) {
    return {
      tempoBpm: { status: 'unknown', reason: 'No observed, cached, or saved session snapshot available' },
      timeSignature: { status: 'unknown', reason: 'No observed, cached, or saved session snapshot available' },
      projectMetadataPresent: Boolean(meta.project.projectPath || meta.project.savedSha256),
      domainAvailability: {
        tracks: 'unknown',
        channels: 'unknown',
        mixerChannels: 'unknown',
        buses: 'unknown',
        routing: 'unknown',
        plugins: 'unknown',
        automationLanes: 'unknown',
        audioClips: 'unknown',
        midiClips: 'unknown',
        markers: 'unknown',
        regions: 'unknown',
      },
      counts: {
        tracks: null,
        channels: null,
        mixerChannels: null,
        buses: null,
        routingEdges: null,
        plugins: null,
        pluginParametersInspected: null,
        automationLanes: null,
        audioClips: null,
        midiClips: null,
        markers: null,
        regions: null,
      },
      accessibleDomains: [],
      inaccessibleDomains: [{ domain: 'snapshot', status: 'unknown', reason: 'No DAW snapshot observed yet' }],
    };
  }

  const tempoUnknown =
    !Number.isFinite(snapshot.transport.tempo.bpm) ||
    snapshot.transport.tempo.bpm <= 0 ||
    meta.unknownFields.some((u) => u === 'tempo:unknown');

  const tempoBpm: DawAvailability<number> = tempoUnknown
    ? { status: 'unknown', reason: 'Tempo absent or obfuscated in project/session snapshot' }
    : { status: 'available', value: snapshot.transport.tempo.bpm };

  const tsUnknown =
    snapshot.transport.timeSignature.numerator <= 0 ||
    snapshot.transport.timeSignature.denominator <= 0 ||
    meta.unknownFields.some((u) => u === 'timeSignature:unknown');

  const timeSignature = tsUnknown
    ? ({ status: 'unknown', reason: 'Time signature absent or obfuscated in project/session snapshot' } as const)
    : ({ status: 'available', value: snapshot.transport.timeSignature } as const);

  const countOrNull = <T>(avail: DawAvailability<readonly T[]>): number | null =>
    avail.status === 'available' ? avail.value.length : null;

  const inspectedParams =
    snapshot.plugins.status === 'available'
      ? snapshot.plugins.value.reduce(
          (sum, pl) => sum + (pl.parameters.status === 'available' ? pl.parameters.value.length : 0),
          0,
        )
      : null;

  const sections: ReadonlyArray<{ readonly key: string; readonly avail: DawAvailability<readonly unknown[]> }> = [
    { key: 'tracks', avail: snapshot.tracks },
    { key: 'channels', avail: snapshot.channels },
    { key: 'mixerChannels', avail: snapshot.mixerChannels },
    { key: 'buses', avail: snapshot.buses },
    { key: 'routing', avail: snapshot.routing },
    { key: 'plugins', avail: snapshot.plugins },
    { key: 'automationLanes', avail: snapshot.automationLanes },
    { key: 'audioClips', avail: snapshot.audioClips },
    { key: 'midiClips', avail: snapshot.midiClips },
    { key: 'markers', avail: snapshot.markers },
    { key: 'regions', avail: snapshot.regions },
  ];

  const accessibleDomains = sections.filter((s) => s.avail.status === 'available').map((s) => s.key);
  const inaccessibleDomains = sections
    .filter((s) => s.avail.status !== 'available')
    .map((s) => ({
      domain: s.key,
      status: s.avail.status,
      reason: s.avail.status === 'available' ? '' : s.avail.reason,
    }));

  return {
    tempoBpm,
    timeSignature,
    projectMetadataPresent: Boolean(meta.project.projectPath || meta.project.savedSha256),
    domainAvailability: {
      tracks: snapshot.tracks.status,
      channels: snapshot.channels.status,
      mixerChannels: snapshot.mixerChannels.status,
      buses: snapshot.buses.status,
      routing: snapshot.routing.status,
      plugins: snapshot.plugins.status,
      automationLanes: snapshot.automationLanes.status,
      audioClips: snapshot.audioClips.status,
      midiClips: snapshot.midiClips.status,
      markers: snapshot.markers.status,
      regions: snapshot.regions.status,
    },
    counts: {
      tracks: countOrNull(snapshot.tracks),
      channels: countOrNull(snapshot.channels),
      mixerChannels: countOrNull(snapshot.mixerChannels),
      buses: countOrNull(snapshot.buses),
      routingEdges: countOrNull(snapshot.routing),
      plugins: countOrNull(snapshot.plugins),
      pluginParametersInspected: inspectedParams,
      automationLanes: countOrNull(snapshot.automationLanes),
      audioClips: countOrNull(snapshot.audioClips),
      midiClips: countOrNull(snapshot.midiClips),
      markers: countOrNull(snapshot.markers),
      regions: countOrNull(snapshot.regions),
    },
    accessibleDomains,
    inaccessibleDomains,
  };
};

const classifySessionEntities = (snapshot: DawStateSnapshot | null): readonly DawClassifiedTrack[] => {
  if (!snapshot) return [];
  const items: DawClassifiedTrack[] = [];

  if (snapshot.mixerChannels.status === 'available') {
    for (const mx of snapshot.mixerChannels.value) {
      const pluginNames = mx.pluginSlots.map((p) => p.name);
      const cls = classifyRoleFromLabelAndPlugins({
        name: mx.name,
        isMaster: mx.isMaster,
        pluginNames,
      });
      const outRoute =
        snapshot.routing.status === 'available'
          ? snapshot.routing.value.find((r) => r.sourceId === mx.id && r.enabled)?.targetId ?? null
          : null;
      items.push({
        refId: mx.id,
        entityKind: 'mixer_channel',
        name: mx.name,
        index: mx.index,
        role: cls.role,
        roleConfidence: cls.confidence,
        evidence: cls.evidence,
        routedToRef: outRoute,
        pluginNames,
        genericName: isGenericTrackLabel(mx.name),
      });
    }
  }

  if (snapshot.channels.status === 'available') {
    for (const ch of snapshot.channels.value) {
      const cls = classifyRoleFromLabelAndPlugins({ name: ch.name });
      items.push({
        refId: ch.id,
        entityKind: 'channel',
        name: ch.name,
        index: ch.index,
        role: cls.role,
        roleConfidence: cls.confidence,
        evidence: cls.evidence,
        routedToRef: ch.targetMixerChannelId,
        pluginNames: [],
        genericName: isGenericTrackLabel(ch.name),
      });
    }
  }

  if (snapshot.tracks.status === 'available') {
    for (const tr of snapshot.tracks.value) {
      const cls = classifyRoleFromLabelAndPlugins({
        name: tr.name,
        isMaster: tr.kind === 'master',
      });
      items.push({
        refId: tr.id,
        entityKind: 'track',
        name: tr.name,
        index: tr.index,
        role: cls.role,
        roleConfidence: cls.confidence,
        evidence: cls.evidence,
        routedToRef: tr.mixerChannelId,
        pluginNames: [],
        genericName: isGenericTrackLabel(tr.name),
      });
    }
  }

  return items;
};

const analyzeNaming = (classified: readonly DawClassifiedTrack[]): DawNamingOrganizationReport => {
  const nonMaster = classified.filter((c) => c.role !== 'master');
  if (nonMaster.length === 0) {
    return {
      totalNamedEntities: 0,
      genericOrDefaultCount: 0,
      genericExamples: [],
      duplicateNames: [],
      organizationScore: 100,
      summary: 'No non-master channels, tracks, or mixer inserts exposed for naming review',
    };
  }

  const generic = nonMaster.filter((c) => c.genericName);
  const byName = new Map<string, string[]>();
  for (const item of nonMaster) {
    const key = item.name.trim().toLowerCase();
    if (!key) continue;
    const refs = byName.get(key) ?? [];
    refs.push(item.refId);
    byName.set(key, refs);
  }

  const duplicateNames = [...byName.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([name, refIds]) => ({ name, refIds }));

  const genericRatio = generic.length / nonMaster.length;
  const dupPenalty = Math.min(30, duplicateNames.length * 10);
  const score = Math.max(0, Math.round(100 - genericRatio * 70 - dupPenalty));

  const summary =
    generic.length === 0 && duplicateNames.length === 0
      ? `Well-organized session naming across ${nonMaster.length} entities (score ${score}/100)`
      : `Detected ${generic.length}/${nonMaster.length} generic labels and ${duplicateNames.length} duplicate label group(s) (score ${score}/100)`;

  return {
    totalNamedEntities: nonMaster.length,
    genericOrDefaultCount: generic.length,
    genericExamples: generic.slice(0, 8).map((g) => `${g.refId} ("${g.name}")`),
    duplicateNames,
    organizationScore: score,
    summary,
  };
};

const assessComplexity = (inventory: DawSessionInventory): DawComplexityReport => {
  const excludedInaccessibleFactors = inventory.inaccessibleDomains
    .filter((d) => ['automationLanes', 'audioClips', 'midiClips', 'routing', 'mixerChannels'].includes(d.domain))
    .map((d) => `${d.domain} (${d.status})`);

  const chCount = inventory.counts.channels;
  const mxCount = inventory.counts.mixerChannels;
  const plCount = inventory.counts.plugins;
  const rtCount = inventory.counts.routingEdges;
  const paramCount = inventory.counts.pluginParametersInspected;

  if (chCount === null && mxCount === null && plCount === null && inventory.counts.tracks === null) {
    return {
      tier: 'undetermined',
      score: 0,
      observableFactors: {
        activeChannels: null,
        populatedMixerInserts: null,
        loadedPlugins: null,
        routingEdges: null,
        inspectedParameters: null,
      },
      excludedInaccessibleFactors,
      rationale: 'No structural counts accessible in current snapshot',
    };
  }

  const score =
    (chCount ?? 0) * 2 +
    (mxCount ?? 0) * 3 +
    (plCount ?? 0) * 4 +
    (rtCount ?? 0) * 1.5 +
    (inventory.counts.tracks ?? 0) * 2;

  const tier: DawComplexityReport['tier'] =
    score < 18 ? 'minimal' : score < 50 ? 'moderate' : score < 110 ? 'dense' : 'heavy';

  return {
    tier,
    score: Math.round(score),
    observableFactors: {
      activeChannels: chCount,
      populatedMixerInserts: mxCount,
      loadedPlugins: plCount,
      routingEdges: rtCount,
      inspectedParameters: paramCount,
    },
    excludedInaccessibleFactors,
    rationale: `Observable complexity "${tier}" (score=${Math.round(score)}) computed solely from accessible domains`,
  };
};

const checkConsistency = (
  snapshot: DawStateSnapshot | null,
  meta: DawSessionAnalysisMetadata,
  routingGraph: DawRoutingGraph,
  naming: DawNamingOrganizationReport,
): DawConsistencyReport => {
  const issues: DawConsistencyIssue[] = [];

  if (!snapshot || meta.stale || snapshot.freshness === 'stale' || snapshot.freshness === 'cached') {
    issues.push({
      id: 'issue-stale-telemetry',
      severity: 'warning',
      code: 'STALE_OR_CACHED_TELEMETRY',
      summary: `Session telemetry is "${snapshot?.freshness ?? 'unknown'}" (stale=${String(meta.stale)}); state may not reflect live host RAM`,
      affectedRefs: [meta.sessionId],
      evidence: [`freshness=${snapshot?.freshness ?? 'unknown'}`, `stale=${String(meta.stale)}`],
    });
  }

  if (meta.hasUnsavedLiveChanges) {
    issues.push({
      id: 'issue-unsaved-drift',
      severity: 'warning',
      code: 'LIVE_VS_SAVED_DRIFT',
      summary: 'Live DAW state differs from last recorded saved project digest (unsaved RAM edits exist)',
      affectedRefs: [meta.project.projectPath ?? meta.sessionId],
      evidence: [`hasUnsavedLiveChanges=true`, `savedSha256=${meta.project.savedSha256 ?? 'null'}`],
    });
  }

  if (meta.versionCompatibility === 'degraded_read_only') {
    issues.push({
      id: 'issue-degraded-version',
      severity: 'info',
      code: 'DEGRADED_HOST_VERSION',
      summary: `Host version ${meta.hostVersion} exceeds tested baseline; session restricted to read-only observation`,
      affectedRefs: [meta.adapterId],
      evidence: [`versionCompatibility=degraded_read_only`, `hostVersion=${meta.hostVersion}`],
    });
  }

  if (
    routingGraph.observabilityStatus === 'complete' &&
    (routingGraph.orphanNodeIds.length > 0 || routingGraph.disconnectedSourceIds.length > 0)
  ) {
    const refs = [...routingGraph.disconnectedSourceIds, ...routingGraph.orphanNodeIds];
    issues.push({
      id: 'issue-routing-disconnected',
      severity: 'warning',
      code: 'DISCONNECTED_OR_ORPHAN_ROUTING',
      summary: `Detected ${routingGraph.disconnectedSourceIds.length} disconnected source(s) and ${routingGraph.orphanNodeIds.length} orphan node(s)`,
      affectedRefs: refs,
      evidence: [
        `disconnected=${routingGraph.disconnectedSourceIds.join(', ') || 'none'}`,
        `orphans=${routingGraph.orphanNodeIds.join(', ') || 'none'}`,
      ],
    });
  }

  if (snapshot?.mixerChannels.status === 'available') {
    for (const mx of snapshot.mixerChannels.value) {
      if (mx.muted && mx.pluginSlots.length > 0 && routingGraph.edges.some((e) => e.targetId === mx.id && e.enabled)) {
        issues.push({
          id: `issue-muted-bus-${mx.index}`,
          severity: 'warning',
          code: 'MUTED_ROUTED_BUS',
          summary: `Mixer target "${mx.name}" receives active routes while muted`,
          affectedRefs: [mx.id],
          evidence: [`muted=true`, `pluginCount=${mx.pluginSlots.length}`],
        });
      }
      if ((mx.peakDb !== null && mx.peakDb > -0.5) || (mx.isMaster && mx.volumeDb !== null && mx.volumeDb > 0)) {
        issues.push({
          id: `issue-headroom-${mx.index}`,
          severity: mx.isMaster ? 'critical' : 'warning',
          code: 'HEADROOM_OR_CLIP_RISK',
          summary: `Elevated peak/gain on "${mx.name}" (peakDb=${String(mx.peakDb)}, volumeDb=${String(mx.volumeDb)})`,
          affectedRefs: [mx.id],
          evidence: [`isMaster=${String(mx.isMaster)}`, `peakDb=${String(mx.peakDb)}`, `volumeDb=${String(mx.volumeDb)}`],
        });
      }
    }
  }

  if (snapshot?.plugins.status === 'available') {
    const excluded = snapshot.plugins.value.filter((p) => p.editionCompatible === 'excluded_by_edition');
    if (excluded.length > 0) {
      issues.push({
        id: 'issue-edition-excluded',
        severity: 'warning',
        code: 'EDITION_INCOMPATIBLE_PLUGIN',
        summary: `${excluded.length} loaded plugin(s) flagged incompatible/demo-locked under ${meta.edition}`,
        affectedRefs: excluded.map((p) => p.id),
        evidence: excluded.map((p) => `${p.name} (${p.editionCompatible})`),
      });
    }
  }

  if (naming.duplicateNames.length > 0) {
    issues.push({
      id: 'issue-duplicate-names',
      severity: 'info',
      code: 'DUPLICATE_LABELS',
      summary: `${naming.duplicateNames.length} duplicate track/mixer label(s) found`,
      affectedRefs: naming.duplicateNames.flatMap((d) => d.refIds),
      evidence: naming.duplicateNames.map((d) => `"${d.name}" -> [${d.refIds.join(', ')}]`),
    });
  }

  if (naming.totalNamedEntities >= 3 && naming.genericOrDefaultCount / naming.totalNamedEntities > 0.5) {
    issues.push({
      id: 'issue-generic-naming',
      severity: 'info',
      code: 'GENERIC_NAMING',
      summary: `More than half (${naming.genericOrDefaultCount}/${naming.totalNamedEntities}) of observable channels/mixers have generic default labels`,
      affectedRefs: naming.genericExamples,
      evidence: [`organizationScore=${naming.organizationScore}`],
    });
  }

  return {
    ok: !issues.some((i) => i.severity === 'critical' || i.severity === 'warning'),
    issueCount: issues.length,
    issues,
  };
};

const computeConfidence = (
  snapshot: DawStateSnapshot | null,
  inventory: DawSessionInventory,
  meta: DawSessionAnalysisMetadata,
  routingGraph: DawRoutingGraph,
): DawAnalysisConfidence => {
  if (!snapshot) {
    return {
      level: 'insufficient',
      score: 0.1,
      rationale: 'No observed, cached, or saved snapshot available',
    };
  }

  let score = 0.92;
  const reasons: string[] = [];

  if (snapshot.freshness === 'stale' || meta.stale) {
    score -= 0.42;
    reasons.push('stale cached telemetry');
  } else if (snapshot.freshness === 'cached') {
    score -= 0.25;
    reasons.push('cached snapshot (not fresh live readback)');
  } else if (snapshot.freshness === 'saved') {
    score -= 0.22;
    reasons.push('offline saved project file without live host runtime');
  } else if (snapshot.freshness === 'unknown') {
    score -= 0.5;
    reasons.push('unknown freshness');
  }

  if (inventory.tempoBpm.status !== 'available') {
    score -= 0.08;
    reasons.push('tempo unknown');
  }
  if (routingGraph.observabilityStatus === 'unavailable') {
    score -= 0.12;
    reasons.push('routing matrix unavailable');
  } else if (routingGraph.observabilityStatus === 'partial') {
    score -= 0.06;
    reasons.push('routing partially observable');
  }

  const blockedCriticalDomains = inventory.inaccessibleDomains.filter((d) =>
    ['mixerChannels', 'plugins', 'channels'].includes(d.domain),
  ).length;
  score -= blockedCriticalDomains * 0.12;

  const clamped = Math.max(0.05, Math.min(1, Number(score.toFixed(2))));
  const level: DawConfidenceLevel =
    clamped >= 0.78 ? 'high' : clamped >= 0.55 ? 'medium' : clamped >= 0.3 ? 'low' : 'insufficient';

  return {
    level,
    score: clamped,
    rationale:
      reasons.length > 0
        ? `Confidence "${level}" (${clamped}) reduced by: ${reasons.join('; ')}`
        : `High confidence (${clamped}) grounded in live observed telemetry across ${inventory.accessibleDomains.length} domain(s)`,
  };
};

export const sessionToMetadata = (
  session: DawSession,
  overrides: {
    readonly hostKind?: AnalyzeDawSessionOptions['hostKind'];
    readonly hostName?: string | undefined;
    readonly edition?: string | undefined;
  } = {},
): DawSessionAnalysisMetadata => ({
  sessionId: session.sessionId,
  project: session.project,
  adapterId: session.adapterId,
  hostKind:
    overrides.hostKind ??
    (session.adapterId.includes('fl-studio')
      ? 'fl_studio'
      : session.adapterId.includes('reaper')
        ? 'reaper'
        : session.adapterId.includes('fake')
          ? 'simulated'
          : 'generic_daw'),
  hostName: overrides.hostName ?? session.dawId,
  hostVersion: session.hostVersion,
  edition: overrides.edition ?? session.project.editionRequirement ?? 'Unknown',
  versionCompatibility: session.connection.versionCompatibility,
  hasUnsavedLiveChanges: session.hasUnsavedLiveChanges,
  stale: session.stale,
  unknownFields: session.unknownFields,
});

export const analyzeSessionCore = (input: {
  readonly snapshot: DawStateSnapshot | null;
  readonly meta: DawSessionAnalysisMetadata;
  readonly knowledgeContext: DawKnowledgeIntegrationReport | null;
  readonly previousSnapshot?: DawStateSnapshot | undefined;
  readonly previousReport?: DawSessionAnalysisReport | undefined;
}): DawSessionAnalysisReport => {
  const { snapshot, meta, knowledgeContext } = input;
  const inventory = buildInventory(snapshot, meta);
  const trackClassification = classifySessionEntities(snapshot);
  const routingGraph: DawRoutingGraph = snapshot
    ? buildDawRoutingGraph(snapshot)
    : {
        observabilityStatus: 'unavailable',
        observabilityReason: 'No DAW snapshot available',
        nodes: [],
        edges: [],
        signalFlowChains: [],
        masterSinkIds: [],
        orphanNodeIds: [],
        disconnectedSourceIds: [],
        cyclePaths: [],
      };
  const namingOrganization = analyzeNaming(trackClassification);
  const complexity = assessComplexity(inventory);
  const consistency = checkConsistency(snapshot, meta, routingGraph, namingOrganization);
  const confidence = computeConfidence(snapshot, inventory, meta, routingGraph);

  const stateDiffFromPrevious: DawSnapshotComparison | null =
    snapshot && input.previousSnapshot ? compareDawSnapshots(input.previousSnapshot, snapshot) : null;

  const limitations: string[] = [];
  for (const domain of inventory.inaccessibleDomains) {
    limitations.push(`${domain.domain} [${domain.status}]: ${domain.reason}`);
  }
  if (inventory.tempoBpm.status !== 'available') {
    limitations.push(`tempo [${inventory.tempoBpm.status}]: ${inventory.tempoBpm.reason}`);
  }
  if (inventory.timeSignature.status !== 'available') {
    limitations.push(`timeSignature [${inventory.timeSignature.status}]: ${inventory.timeSignature.reason}`);
  }
  if (meta.stale || snapshot?.freshness === 'stale' || snapshot?.freshness === 'cached') {
    limitations.push('Session snapshot is cached or stale — live RAM state may have diverged');
  }
  if (meta.versionCompatibility === 'degraded_read_only') {
    limitations.push(`Host version ${meta.hostVersion} degraded to read-only observation mode`);
  }

  const evidence: string[] = [
    snapshot
      ? `Snapshot ${snapshot.snapshotId} (${snapshot.freshness}) observedAt=${snapshot.provenance.observedAt} source="${snapshot.provenance.sourceEvidence}" digest=${snapshot.stateDigest.slice(0, 12)}`
      : 'No runtime snapshot available',
    meta.project.savedSha256
      ? `Saved project "${meta.project.name}" sha256=${meta.project.savedSha256.slice(0, 12)}`
      : `Project "${meta.project.name}" (no saved disk SHA-256 baseline)`,
    `Accessible domains (${inventory.accessibleDomains.length}): ${inventory.accessibleDomains.join(', ') || 'none'}`,
    `Inaccessible domains (${inventory.inaccessibleDomains.length}): ${inventory.inaccessibleDomains.map((d) => `${d.domain}:${d.status}`).join(', ') || 'none'}`,
  ];

  const findings: DawSessionFinding[] = [];
  findings.push({
    id: 'finding-inventory',
    category: 'structure',
    severity: 'info',
    title: 'Observable Session Structure',
    detail: `Tempo=${inventory.tempoBpm.status === 'available' ? `${inventory.tempoBpm.value} BPM` : 'unknown'}, channels=${String(inventory.counts.channels ?? 'inaccessible')}, mixerInserts=${String(inventory.counts.mixerChannels ?? 'inaccessible')}, tracks=${String(inventory.counts.tracks ?? 'inaccessible')}, plugins=${String(inventory.counts.plugins ?? 'inaccessible')}`,
    evidence: [evidence[0]!, evidence[2]!],
    confidence: confidence.level,
    affectedRefs: [meta.sessionId],
  });

  if (routingGraph.observabilityStatus === 'complete') {
    findings.push({
      id: 'finding-routing-flow',
      category: 'routing',
      severity:
        routingGraph.disconnectedSourceIds.length > 0 || routingGraph.orphanNodeIds.length > 0 ? 'warning' : 'info',
      title: 'Signal-Flow Graph Constructed',
      detail: `Constructed ${routingGraph.nodes.length} nodes, ${routingGraph.edges.length} edges, ${routingGraph.signalFlowChains.length} signal-flow chain(s); disconnectedSources=${routingGraph.disconnectedSourceIds.length}, orphans=${routingGraph.orphanNodeIds.length}`,
      evidence: routingGraph.signalFlowChains.slice(0, 4).map((c) => c.join(' -> ')),
      confidence: confidence.level,
      affectedRefs: [...routingGraph.disconnectedSourceIds, ...routingGraph.orphanNodeIds],
    });
  } else {
    findings.push({
      id: 'finding-routing-limited',
      category: 'routing',
      severity: 'info',
      title: 'Routing Graph Observability Restricted',
      detail: routingGraph.observabilityReason,
      evidence: [routingGraph.observabilityReason],
      confidence: 'low',
      affectedRefs: [],
    });
  }

  findings.push({
    id: 'finding-complexity',
    category: 'complexity',
    severity: 'info',
    title: `Observable Project Complexity: ${complexity.tier}`,
    detail: complexity.rationale,
    evidence: [JSON.stringify(complexity.observableFactors)],
    confidence: confidence.level,
    affectedRefs: [],
  });

  for (const issue of consistency.issues) {
    findings.push({
      id: `finding-${issue.id}`,
      category:
        issue.code === 'STALE_OR_CACHED_TELEMETRY'
          ? 'freshness'
          : issue.code === 'DISCONNECTED_OR_ORPHAN_ROUTING' || issue.code === 'MUTED_ROUTED_BUS'
            ? 'routing'
            : issue.code === 'DUPLICATE_LABELS' || issue.code === 'GENERIC_NAMING'
              ? 'naming'
              : 'consistency',
      severity: issue.severity,
      title: issue.code.replace(/_/g, ' '),
      detail: issue.summary,
      evidence: issue.evidence,
      confidence: confidence.level,
      affectedRefs: issue.affectedRefs,
    });
  }

  if (knowledgeContext) {
    findings.push({
      id: 'finding-knowledge-link',
      category: 'knowledge',
      severity: 'info',
      title: 'Vault Knowledge & Preference Link Summary',
      detail: `Linked X3LIUS records=${knowledgeContext.x3liusMusicRecords.length}, pluginDocs=${knowledgeContext.pluginKnowledge.length}, prodKnowledge=${knowledgeContext.productionKnowledge.length}, approvedPrefs=${knowledgeContext.userApprovedPreferences.length}, historical=${knowledgeContext.historicalVaultRecords.length}`,
      evidence: [knowledgeContext.epistemicSeparationNotice],
      confidence: 'high',
      affectedRefs: knowledgeContext.loadedPluginsMissingKnowledge,
    });
  }

  const recommendedNextActions: DawRecommendedAction[] = [];
  if (meta.stale || snapshot?.freshness === 'stale' || snapshot?.freshness === 'cached') {
    recommendedNextActions.push({
      priority: 'high',
      actionType: 'refresh_live_connection',
      title: 'Reconnect & refresh live DAW observation',
      rationale: 'Current analysis relies on cached/stale state and cannot verify live host RAM edits.',
      targetRefs: [meta.sessionId],
      requiresApproval: false,
    });
  }
  if (meta.hasUnsavedLiveChanges) {
    recommendedNextActions.push({
      priority: 'high',
      actionType: 'save_project_before_render',
      title: 'Save project in DAW before CLI bounce or external render',
      rationale: 'Unsaved live edits diverge from saved project on disk; headless renders read saved disk state only.',
      targetRefs: [meta.project.projectPath ?? meta.sessionId],
      requiresApproval: false,
    });
  }
  for (const issue of consistency.issues) {
    if (issue.code === 'EDITION_INCOMPATIBLE_PLUGIN') {
      recommendedNextActions.push({
        priority: 'high',
        actionType: 'replace_excluded_plugin',
        title: 'Replace edition-excluded plugin or confirm license unlock',
        rationale: issue.summary,
        targetRefs: issue.affectedRefs,
        requiresApproval: true,
        blockedByLimitation: 'Host adapter currently observation-only; plugin swap must be performed in DAW UI',
      });
    } else if (issue.code === 'DISCONNECTED_OR_ORPHAN_ROUTING' || issue.code === 'HEADROOM_OR_CLIP_RISK' || issue.code === 'MUTED_ROUTED_BUS') {
      recommendedNextActions.push({
        priority: issue.severity === 'critical' ? 'high' : 'medium',
        actionType: 'inspect_routing_or_gain',
        title: `Inspect ${issue.code.toLowerCase().replace(/_/g, ' ')}`,
        rationale: issue.summary,
        targetRefs: issue.affectedRefs,
        requiresApproval: true,
      });
    }
  }
  if (knowledgeContext && knowledgeContext.loadedPluginsMissingKnowledge.length > 0) {
    recommendedNextActions.push({
      priority: 'low',
      actionType: 'record_knowledge_or_preference',
      title: 'Document undocumented loaded plugins in 10_DAW_BRAIN/PLUGINS/',
      rationale: `Loaded plugins missing canonical Vault docs: ${knowledgeContext.loadedPluginsMissingKnowledge.join(', ')}`,
      targetRefs: knowledgeContext.loadedPluginsMissingKnowledge,
      requiresApproval: true,
    });
  }
  if (recommendedNextActions.length === 0) {
    recommendedNextActions.push({
      priority: 'low',
      actionType: 'audio_brain_render_check',
      title: 'Capture reference bounce for Audio Brain rubric verification',
      rationale: 'Session topology is internally consistent across all accessible domains.',
      targetRefs: [meta.sessionId],
      requiresApproval: false,
    });
  }

  const freshnessValue = snapshot?.freshness ?? 'unknown';
  return {
    reportId: `dawrep-${randomUUID().slice(0, 8)}`,
    projectId: meta.project.projectId,
    projectName: meta.project.name,
    sessionId: meta.sessionId,
    daw: {
      adapterId: meta.adapterId,
      hostKind: meta.hostKind,
      hostName: meta.hostName,
      version: meta.hostVersion,
      edition: meta.edition,
    },
    observationTimestamp: snapshot?.provenance.observedAt ?? new Date().toISOString(),
    dataFreshness: {
      stateFreshness: freshnessValue,
      isLive: freshnessValue === 'observed' && !meta.stale,
      isStale: meta.stale || freshnessValue === 'stale' || freshnessValue === 'cached',
      hasUnsavedLiveChanges: meta.hasUnsavedLiveChanges,
      authoritativeSource: snapshot?.provenance.sourceEvidence ?? 'No snapshot source',
    },
    evidence,
    inventory,
    trackClassification,
    routingGraph,
    namingOrganization,
    complexity,
    consistency,
    knowledgeContext,
    stateDiffFromPrevious,
    findings,
    confidence,
    limitations,
    recommendedNextActions,
  };
};
