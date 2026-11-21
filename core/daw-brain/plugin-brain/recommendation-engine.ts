import type { DawHostKind } from '../types.ts';
import type { PluginCatalogRegistry } from './catalog-ingestion.ts';
import { evaluatePluginCompatibility } from './plugin-analyzer.ts';
import type {
  PluginCategory,
  PluginChainEdge,
  PluginChainGraph,
  PluginChainNode,
  PluginProcessingRole,
  PluginProfile,
  PluginRecommendation,
  PluginWorkflowKind,
} from './types.ts';

type ChainBlueprintSlot = {
  readonly role: PluginProcessingRole;
  readonly categoryHint?: PluginCategory | undefined;
  readonly slotType: PluginChainNode['slotType'];
  readonly optional?: boolean | undefined;
};

const WORKFLOW_BLUEPRINTS: Readonly<Record<PluginWorkflowKind, readonly ChainBlueprintSlot[]>> = {
  vocal_chain: [
    { role: 'vocal_tuning', categoryHint: 'pitch_correction', slotType: 'insert', optional: true },
    { role: 'subtractive_eq', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'dynamic_leveling', categoryHint: 'compressor', slotType: 'insert' },
    { role: 'tonal_shaping', categoryHint: 'equalizer', slotType: 'insert', optional: true },
    { role: 'harmonic_saturation', categoryHint: 'saturation', slotType: 'insert', optional: true },
    { role: 'spatial_reverb', categoryHint: 'reverb', slotType: 'parallel_send', optional: true },
  ],
  instrument_chain: [
    { role: 'subtractive_eq', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'dynamic_leveling', categoryHint: 'compressor', slotType: 'insert', optional: true },
    { role: 'width_imaging', categoryHint: 'stereo_imaging', slotType: 'insert', optional: true },
  ],
  drum_processing: [
    { role: 'subtractive_eq', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'harmonic_saturation', categoryHint: 'saturation', slotType: 'insert', optional: true },
    { role: 'bus_glue', categoryHint: 'compressor', slotType: 'insert' },
    { role: 'peak_limiting', categoryHint: 'limiter', slotType: 'insert', optional: true },
  ],
  bass_processing: [
    { role: 'subtractive_eq', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'harmonic_saturation', categoryHint: 'saturation', slotType: 'insert', optional: true },
    { role: 'dynamic_leveling', categoryHint: 'compressor', slotType: 'insert' },
    { role: 'peak_limiting', categoryHint: 'limiter', slotType: 'insert', optional: true },
  ],
  mix_bus: [
    { role: 'tonal_shaping', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'bus_glue', categoryHint: 'compressor', slotType: 'insert' },
    { role: 'harmonic_saturation', categoryHint: 'saturation', slotType: 'insert', optional: true },
    { role: 'metering_analysis', categoryHint: 'analyzer', slotType: 'insert', optional: true },
  ],
  master_bus: [
    { role: 'surgical_resonance_control', categoryHint: 'equalizer', slotType: 'insert', optional: true },
    { role: 'tonal_shaping', categoryHint: 'equalizer', slotType: 'insert' },
    { role: 'bus_glue', categoryHint: 'compressor', slotType: 'insert', optional: true },
    { role: 'peak_limiting', categoryHint: 'limiter', slotType: 'insert' },
    { role: 'metering_analysis', categoryHint: 'analyzer', slotType: 'insert', optional: true },
  ],
  creative_fx: [
    { role: 'creative_mfx', categoryHint: 'modulation', slotType: 'insert' },
    { role: 'tempo_delay', categoryHint: 'delay', slotType: 'insert', optional: true },
    { role: 'spatial_reverb', categoryHint: 'reverb', slotType: 'insert', optional: true },
  ],
  parallel_processing: [
    { role: 'dynamic_leveling', categoryHint: 'compressor', slotType: 'parallel_send' },
    { role: 'harmonic_saturation', categoryHint: 'saturation', slotType: 'parallel_send', optional: true },
    { role: 'spatial_reverb', categoryHint: 'reverb', slotType: 'return', optional: true },
  ],
  sidechain_workflow: [
    { role: 'dynamic_leveling', categoryHint: 'compressor', slotType: 'sidechain_key' },
    { role: 'surgical_resonance_control', categoryHint: 'equalizer', slotType: 'sidechain_key', optional: true },
  ],
};

export const recommendPluginsForRole = (
  catalog: PluginCatalogRegistry,
  request: {
    readonly role: PluginProcessingRole;
    readonly categoryHint?: PluginCategory | undefined;
    readonly hostKind?: DawHostKind | undefined;
    readonly hostEdition?: string | undefined;
    readonly includeUninstalled?: boolean | undefined;
    readonly limit?: number | undefined;
  },
): readonly PluginRecommendation[] => {
  const limit = request.limit ?? 5;
  const recommendations: PluginRecommendation[] = [];

  for (const profile of catalog.listProfiles()) {
    const installed = profile.installation.installedOnHost === 'verified_installed';
    if (!installed && !request.includeUninstalled) continue;

    const compat = evaluatePluginCompatibility(profile, {
      hostKind: request.hostKind,
      hostEdition: request.hostEdition,
    });
    const compatible =
      compat.supportVerdict !== 'excluded_by_edition' &&
      compat.supportVerdict !== 'incompatible_host';

    const matchesRole = profile.processingRoles.includes(request.role);
    const matchesCat = request.categoryHint ? profile.category === request.categoryHint : false;
    if (!matchesRole && !matchesCat) continue;

    let score = 0;
    if (installed) score += 50;
    if (compatible) score += 30;
    if (matchesRole) score += 20;
    if (matchesCat) score += 10;
    if (profile.documentationSources.some((d) => d.sourceType.startsWith('vault_'))) score += 8;
    if (profile.format === 'VST3' || profile.format === 'NATIVE') score += 4;

    const limitations: string[] = [];
    if (!installed) limitations.push('Plugin NOT verified installed on local workstation');
    if (!compatible) limitations.push(...compat.reasons);

    recommendations.push({
      pluginId: profile.id,
      pluginName: profile.identity.productName,
      category: profile.category,
      role: request.role,
      installedOnHost: profile.installation.installedOnHost,
      compatible,
      score,
      rationale: `${profile.identity.productName} (${profile.format}) matched ${matchesRole ? `role=${request.role}` : `category=${profile.category}`}; installed=${installed}, compat=${compat.supportVerdict}`,
      limitations,
    });
  }

  return recommendations
    .sort((a, b) => b.score - a.score || a.pluginName.localeCompare(b.pluginName))
    .slice(0, limit);
};

/**
 * Generates an ordered, typed `suggested_recipe` signal-flow chain for a given workflow
 * strictly grounded in installed + edition-compatible catalog members, explicitly reporting
 * any unfulfilled role under `missingRoles` without inventing installs.
 */
export const buildSuggestedChainRecipe = (
  catalog: PluginCatalogRegistry,
  request: {
    readonly workflowKind: PluginWorkflowKind;
    readonly targetContainerId?: string | undefined;
    readonly hostKind?: DawHostKind | undefined;
    readonly hostEdition?: string | undefined;
    readonly sidechainSourceRef?: string | undefined;
  },
): PluginChainGraph => {
  const blueprint = WORKFLOW_BLUEPRINTS[request.workflowKind];
  if (!blueprint) {
    throw new Error(`Unsupported workflowKind "${String(request.workflowKind)}" in suggestChain`);
  }
  const containerId = request.targetContainerId ?? `suggested:${request.workflowKind}`;
  const nodes: PluginChainNode[] = [];
  const edges: PluginChainEdge[] = [];
  const missingRoles: PluginProcessingRole[] = [];
  const usedNames = new Set<string>();

  for (const slot of blueprint) {
    const candidates = recommendPluginsForRole(catalog, {
      role: slot.role,
      categoryHint: slot.categoryHint,
      hostKind: request.hostKind,
      hostEdition: request.hostEdition,
      includeUninstalled: false,
      limit: 5,
    }).filter((c) => c.compatible && !usedNames.has(c.pluginName.toLowerCase()));

    const pick = candidates[0];
    if (!pick) {
      missingRoles.push(slot.role);
      continue;
    }

    usedNames.add(pick.pluginName.toLowerCase());
    const profile = catalog.getProfile(pick.pluginId ?? pick.pluginName);
    const nodeIdx = nodes.length;
    const node: PluginChainNode = {
      nodeId: `${containerId}:node:${nodeIdx}`,
      orderIndex: nodeIdx,
      containerId,
      pluginName: pick.pluginName,
      profileId: profile?.id ?? pick.pluginId,
      category: pick.category,
      role: slot.role,
      slotType: slot.slotType,
      bypassed: false,
      mixNormalized: slot.slotType === 'parallel_send' ? 0.35 : 1.0,
      sidechainSourceRef:
        slot.slotType === 'sidechain_key' ? (request.sidechainSourceRef ?? 'external-key-required') : null,
      installedVerified: pick.installedOnHost === 'verified_installed',
      compatibilityStatus: pick.compatible ? 'verified_compatible' : 'unknown',
    };
    nodes.push(node);

    if (nodes.length >= 2) {
      const prev = nodes[nodes.length - 2]!;
      edges.push({
        id: `edge:${prev.nodeId}->${node.nodeId}`,
        fromNodeId: prev.nodeId,
        toNodeId: node.nodeId,
        signalMode:
          node.slotType === 'parallel_send' || node.slotType === 'return'
            ? 'parallel_wet'
            : node.slotType === 'sidechain_key'
              ? 'sidechain_key'
              : 'serial',
      });
    }
  }

  return {
    chainId: `recipe:${request.workflowKind}:${containerId}`,
    label: `Suggested Recipe: ${request.workflowKind}`,
    sourceKind: 'suggested_recipe',
    workflowKind: request.workflowKind,
    containerId,
    nodes,
    edges,
    missingRoles,
    provenanceEvidence: `Suggested recipe generated from verified-installed catalog (host=${request.hostKind ?? 'generic'}, edition=${request.hostEdition ?? 'unspecified'})`,
  };
};

export const formatPluginProfileVaultMarkdown = (profile: PluginProfile): string => {
  const now = new Date().toISOString();
  const lines: string[] = [
    '---',
    `schema: xyp3rn.daw-plugin/v3`,
    `id: ${profile.id}`,
    `type: plugin`,
    `title: "Plugin Profile: ${profile.identity.productName.replace(/"/g, '\\"')}"`,
    `domain: RECORDS`,
    `sector: 10_DAW_BRAIN`,
    `status: draft`,
    `version: 1`,
    `plugin_format: "${profile.format}"`,
    `vendor: "${(profile.identity.manufacturer ?? 'Unknown').replace(/"/g, '\\"')}"`,
    `category: "${profile.category}"`,
    `edition_requirement: "${profile.compatibility.editionRequirement}"`,
    `provenance: "plugin-brain://catalog-profile/${profile.id}"`,
    `created_at: "${now}"`,
    `updated_at: "${now}"`,
    `tags: [xyp3rn, os3, daw-brain, plugin]`,
    '---',
    '',
    `# ${profile.identity.productName}`,
    '',
    `- **Category / Type:** \`${profile.category}\` / \`${profile.pluginType}\``,
    `- **Processing Roles:** ${profile.processingRoles.join(', ')}`,
    `- **Verified Host Installation:** \`${profile.installation.installedOnHost}\``,
  ];
  return lines.join('\n');
};
