import type { DawHostKind, DawStateSnapshot } from '../types.ts';
import type { PluginCatalogRegistry } from './catalog-ingestion.ts';
import {
  classifyPluginIdentity,
  evaluatePluginCompatibility,
} from './plugin-analyzer.ts';
import type {
  PluginChainAnalysisReport,
  PluginChainEdge,
  PluginChainGraph,
  PluginChainNode,
  PluginProcessingRole,
  PluginRedundancyFinding,
  PluginSignalFlowIssue,
  PluginWorkflowKind,
} from './types.ts';

/**
 * Infers workflow kind for an observed mixer/bus container from its label & plugins.
 */
export const inferWorkflowKind = (label: string, isMaster: boolean): PluginWorkflowKind => {
  if (isMaster) return 'master_bus';
  const l = label.toLowerCase();
  if (/master\s*bus|2[-\s]?bus|mix\s*bus/i.test(l)) return 'mix_bus';
  if (/vox|vocal|lead|hook|adlib|harmony|dub/i.test(l)) return 'vocal_chain';
  if (/drum|kick|snare|clap|hat|perc/i.test(l)) return 'drum_processing';
  if (/bass|808|sub/i.test(l)) return 'bass_processing';
  if (/parallel|crush|ny/i.test(l)) return 'parallel_processing';
  if (/sc\b|sidechain|duck/i.test(l)) return 'sidechain_workflow';
  if (/verb|delay|fx|creative|throw/i.test(l)) return 'creative_fx';
  return 'instrument_chain';
};

/**
 * Extracts ordered `actual_daw_chain` graphs directly from observed `DawStateSnapshot`
 * mixer slots and routing connections. Strictly marked `actual_daw_chain`.
 */
export const extractActualChainsFromSnapshot = (
  snapshot: DawStateSnapshot,
  catalog: PluginCatalogRegistry,
  context: { readonly hostKind?: DawHostKind | undefined; readonly hostEdition?: string | undefined } = {},
): readonly PluginChainGraph[] => {
  if (snapshot.mixerChannels.status !== 'available') return [];
  const routes = snapshot.routing.status === 'available' ? snapshot.routing.value : [];
  const graphs: PluginChainGraph[] = [];

  for (const mx of snapshot.mixerChannels.value) {
    if (mx.pluginSlots.length === 0) continue;
    const orderedSlots = [...mx.pluginSlots].sort((a, b) => a.slotIndex - b.slotIndex);
    const workflowKind = inferWorkflowKind(mx.name, mx.isMaster);
    const sidechainFeed = routes.find((r) => r.targetId === mx.id && r.sidechain);

    const nodes: PluginChainNode[] = orderedSlots.map((slot, idx) => {
      const cls = classifyPluginIdentity(slot.name);
      const profile = catalog.getProfile(slot.name);
      const verdict = profile
        ? evaluatePluginCompatibility(profile, context).supportVerdict
        : slot.editionCompatible === 'excluded_by_edition'
          ? 'excluded_by_edition'
          : slot.editionCompatible === 'verified'
            ? 'verified_compatible'
            : 'unknown';

      return {
        nodeId: `${mx.id}:slot:${slot.slotIndex}`,
        orderIndex: idx,
        containerId: mx.id,
        pluginName: slot.name,
        profileId: profile?.id ?? null,
        category: profile?.category ?? cls.category,
        role: profile?.processingRoles[0] ?? cls.processingRoles[0] ?? 'unclassified',
        slotType: sidechainFeed && cls.supportsSidechain ? 'sidechain_key' : 'insert',
        bypassed: slot.bypassed,
        mixNormalized: slot.mixLevel,
        sidechainSourceRef: sidechainFeed && cls.supportsSidechain ? sidechainFeed.sourceId : null,
        installedVerified:
          profile?.installation.installedOnHost === 'verified_installed' ||
          snapshot.freshness === 'observed',
        compatibilityStatus: verdict,
      };
    });

    const edges: PluginChainEdge[] = [];
    for (let i = 0; i < nodes.length - 1; i += 1) {
      edges.push({
        id: `edge:${nodes[i]!.nodeId}->${nodes[i + 1]!.nodeId}`,
        fromNodeId: nodes[i]!.nodeId,
        toNodeId: nodes[i + 1]!.nodeId,
        signalMode: 'serial',
      });
    }

    graphs.push({
      chainId: `actual:${mx.id}`,
      label: `${mx.name} (Observed Live Chain)`,
      sourceKind: 'actual_daw_chain',
      workflowKind,
      containerId: mx.id,
      nodes,
      edges,
      missingRoles: [],
      provenanceEvidence: `Observed live slots in ${mx.id} (${snapshot.snapshotId})`,
    });
  }

  return graphs;
};

/**
 * Evaluates a plugin chain (whether observed live or suggested recipe) for redundancies,
 * ordering/signal-flow defects, edition blocks, and missing host installations.
 */
export const analyzePluginChain = (chain: PluginChainGraph): PluginChainAnalysisReport => {
  const redundancies: PluginRedundancyFinding[] = [];
  const signalFlowIssues: PluginSignalFlowIssue[] = [];

  const activeNodes = chain.nodes.filter((n) => !n.bypassed);
  const bypassedNodes = chain.nodes.filter((n) => n.bypassed);

  if (bypassedNodes.length > 0) {
    redundancies.push({
      code: 'BYPASSED_DEAD_WEIGHT',
      severity: 'info',
      summary: `${bypassedNodes.length} bypassed plugin slot(s) remain in chain (${bypassedNodes.map((n) => n.pluginName).join(', ')})`,
      nodeIds: bypassedNodes.map((n) => n.nodeId),
    });
  }

  // Consecutive identical plugins or stacked identical limiter roles
  for (let i = 0; i < activeNodes.length - 1; i += 1) {
    const cur = activeNodes[i]!;
    const nxt = activeNodes[i + 1]!;
    if (cur.pluginName.toLowerCase() === nxt.pluginName.toLowerCase()) {
      redundancies.push({
        code: 'CONSECUTIVE_SAME_PLUGIN',
        severity: 'warning',
        summary: `Consecutive instances of "${cur.pluginName}" in active signal path`,
        nodeIds: [cur.nodeId, nxt.nodeId],
      });
    }
    if (cur.role !== 'unclassified' && cur.role === nxt.role && (cur.role === 'peak_limiting' || cur.role === 'vocal_tuning')) {
      redundancies.push({
        code: 'DUPLICATE_PROCESSOR_ROLE',
        severity: 'warning',
        summary: `Back-to-back "${cur.role}" processors (${cur.pluginName} -> ${nxt.pluginName}) may introduce artifacts`,
        nodeIds: [cur.nodeId, nxt.nodeId],
      });
    }
  }

  // Check edition compatibility & missing host installs
  const blockedNodes = chain.nodes.filter((n) => n.compatibilityStatus === 'excluded_by_edition');
  if (blockedNodes.length > 0) {
    redundancies.push({
      code: 'EDITION_BLOCKED_IN_CHAIN',
      severity: 'critical',
      summary: `${blockedNodes.length} plugin(s) blocked by host edition (${blockedNodes.map((n) => n.pluginName).join(', ')})`,
      nodeIds: blockedNodes.map((n) => n.nodeId),
    });
    signalFlowIssues.push({
      code: 'EXCLUDED_PLUGIN_USED',
      severity: 'critical',
      summary: 'Chain includes edition-locked plugins that cannot save cleanly under current license',
      nodeIds: blockedNodes.map((n) => n.nodeId),
    });
  }

  const uninstalledNodes = chain.nodes.filter((n) => !n.installedVerified);
  if (uninstalledNodes.length > 0) {
    redundancies.push({
      code: 'UNINSTALLED_PLUGIN_IN_RECIPE',
      severity: 'warning',
      summary: `${uninstalledNodes.length} plugin(s) not verified installed on workstation: ${uninstalledNodes.map((n) => n.pluginName).join(', ')}`,
      nodeIds: uninstalledNodes.map((n) => n.nodeId),
    });
  }

  // Master / Mix Bus final stage safety: Peak Limiter should sit last (excluding trailing metering analyzers)
  const nonAnalyzerActive = activeNodes.filter((n) => n.category !== 'analyzer');
  const limiterIdx = nonAnalyzerActive.findIndex((n) => n.category === 'limiter' || n.role === 'peak_limiting');
  if (
    (chain.workflowKind === 'master_bus' || chain.workflowKind === 'mix_bus') &&
    limiterIdx >= 0 &&
    limiterIdx < nonAnalyzerActive.length - 1
  ) {
    const limNode = nonAnalyzerActive[limiterIdx]!;
    signalFlowIssues.push({
      code: 'LIMITER_NOT_FINAL',
      severity: 'warning',
      summary: `Limiter "${limNode.pluginName}" is followed by ${nonAnalyzerActive
        .slice(limiterIdx + 1)
        .map((n) => n.pluginName)
        .join(', ')} — post-limiter EQ/FX can cause intersample overs > 0 dBTP`,
      nodeIds: [limNode.nodeId],
    });
  }

  // Check sidechain workflow key presence
  if (chain.workflowKind === 'sidechain_workflow') {
    const hasKey = activeNodes.some((n) => n.slotType === 'sidechain_key' || Boolean(n.sidechainSourceRef));
    if (!hasKey) {
      signalFlowIssues.push({
        code: 'MISSING_SIDECHAIN_KEY',
        severity: 'warning',
        summary: 'Sidechain workflow chain lacks an observed sidechain key routing source',
        nodeIds: activeNodes.map((n) => n.nodeId),
      });
    }
  }

  const installedCount = chain.nodes.filter((n) => n.installedVerified).length;
  const installedCoverageRatio =
    chain.nodes.length === 0 ? 1 : Number((installedCount / chain.nodes.length).toFixed(2));

  const orderedRoles: readonly PluginProcessingRole[] = activeNodes.map((n) => n.role);
  const compatibleForHost = blockedNodes.length === 0 && uninstalledNodes.length === 0;

  return {
    chainId: chain.chainId,
    sourceKind: chain.sourceKind,
    workflowKind: chain.workflowKind,
    compatibleForHost,
    installedCoverageRatio,
    redundancies,
    signalFlowIssues,
    orderedRoles,
    summary: `[${chain.sourceKind}] ${chain.label}: ${activeNodes.length} active nodes, compatible=${String(compatibleForHost)}, redundancies=${redundancies.length}, signalFlowIssues=${signalFlowIssues.length}`,
  };
};
