import { randomUUID } from 'node:crypto';
import type { AgentClass } from '../../contracts/taxonomy.ts';
import type { VaultEngine } from '../../vault-engine/vault-engine.ts';
import {
  DawBrainError,
  type DawCommand,
  type DawHostKind,
  type DawPluginInstance,
  type DawStateSnapshot,
} from '../types.ts';
import { PluginCatalogRegistry } from './catalog-ingestion.ts';
import { analyzePluginChain, extractActualChainsFromSnapshot } from './chain-intelligence.ts';
import { comparePlugins, evaluatePluginCompatibility } from './plugin-analyzer.ts';
import {
  buildSuggestedChainRecipe,
  formatPluginProfileVaultMarkdown,
  recommendPluginsForRole,
} from './recommendation-engine.ts';
import type {
  HostScannedPluginInput,
  PluginChainAnalysisReport,
  PluginChainGraph,
  PluginComparisonResult,
  PluginProfile,
  PluginRecommendation,
  PluginUserCatalogEntry,
  PluginWorkflowKind,
} from './types.ts';

/**
 * Independent Plugin Brain subsystem integrated with DAW Brain.
 * Discovers plugins strictly from verified sources, builds structured plugin profiles,
 * interprets live parameters, analyzes actual vs suggested chains, checks edition/host
 * compatibility, and never modifies plugin parameters directly.
 */
export class PluginBrain {
  readonly catalog = new PluginCatalogRegistry();

  ingestDawSnapshot(
    snapshot: DawStateSnapshot,
    hostKind: DawHostKind = 'generic_daw',
    edition = 'Unknown',
  ): readonly PluginProfile[] {
    if (snapshot.plugins.status !== 'available') return [];
    return this.catalog.ingestDawExposedPlugins(snapshot.plugins.value, hostKind, edition);
  }

  ingestDawPlugins(
    plugins: readonly DawPluginInstance[],
    hostKind: DawHostKind = 'generic_daw',
    edition = 'Unknown',
  ): readonly PluginProfile[] {
    return this.catalog.ingestDawExposedPlugins(plugins, hostKind, edition);
  }

  ingestLocalHostInventory(
    entries: readonly HostScannedPluginInput[],
    hostKinds: readonly DawHostKind[] = ['fl_studio'],
  ): readonly PluginProfile[] {
    return this.catalog.ingestLocalHostInventory(entries, hostKinds);
  }

  ingestUserCatalog(
    entries: readonly PluginUserCatalogEntry[],
    assumeInstalled = false,
  ): readonly PluginProfile[] {
    return this.catalog.ingestUserCatalog(entries, assumeInstalled);
  }

  async ingestVaultPluginDocs(vault: VaultEngine): Promise<readonly PluginProfile[]> {
    return this.catalog.ingestVaultPluginDocs(vault);
  }

  getProfile(idOrName: string): PluginProfile | null {
    return this.catalog.getProfile(idOrName);
  }

  listProfiles(): readonly PluginProfile[] {
    return this.catalog.listProfiles();
  }

  listInstalledProfiles(): readonly PluginProfile[] {
    return this.catalog.listInstalledProfiles();
  }

  checkCompatibility(
    idOrName: string,
    context: { readonly hostKind?: DawHostKind | undefined; readonly hostEdition?: string | undefined } = {},
  ) {
    const profile = this.catalog.getProfile(idOrName);
    if (!profile) {
      return {
        found: false as const,
        installed: false,
        verdict: 'unknown' as const,
        reasons: [`Plugin "${idOrName}" not present in verified catalog or host scan`],
      };
    }
    const compat = evaluatePluginCompatibility(profile, context);
    return {
      found: true as const,
      profile,
      installed: profile.installation.installedOnHost === 'verified_installed',
      verdict: compat.supportVerdict,
      reasons: compat.reasons,
    };
  }

  compare(pluginA: string, pluginB: string): PluginComparisonResult {
    const a = this.catalog.getProfile(pluginA);
    const b = this.catalog.getProfile(pluginB);
    if (!a || !b) {
      throw new DawBrainError(
        'DAW_INVALID_COMMAND',
        `Cannot compare plugins: missing profile for "${!a ? pluginA : pluginB}"`,
      );
    }
    return comparePlugins(a, b);
  }

  extractActualChains(
    snapshot: DawStateSnapshot,
    context: { readonly hostKind?: DawHostKind | undefined; readonly hostEdition?: string | undefined } = {},
  ): readonly PluginChainGraph[] {
    return extractActualChainsFromSnapshot(snapshot, this.catalog, context);
  }

  analyzeChain(chain: PluginChainGraph): PluginChainAnalysisReport {
    return analyzePluginChain(chain);
  }

  recommendForRole(
    request: Parameters<typeof recommendPluginsForRole>[1],
  ): readonly PluginRecommendation[] {
    return recommendPluginsForRole(this.catalog, request);
  }

  suggestChain(
    request: Parameters<typeof buildSuggestedChainRecipe>[1],
  ): { readonly recipe: PluginChainGraph; readonly analysis: PluginChainAnalysisReport } {
    const recipe = buildSuggestedChainRecipe(this.catalog, request);
    const analysis = analyzePluginChain(recipe);
    return { recipe, analysis };
  }

  formatVaultProfileDraft(profile: PluginProfile): string {
    return formatPluginProfileVaultMarkdown(profile);
  }

  /**
   * Plugin Brain NEVER executes live parameter writes directly.
   * Any future bounded write proposal must route through `DawCommandGateway.prepare()`
   * + human approval + lease verification.
   */
  proposeBoundedParameterPatch(input: {
    readonly sessionId: string;
    readonly targetPluginRef: string;
    readonly paramIndex: number;
    readonly valueNormalized: number;
    readonly requestedBy: string;
    readonly requestedClass: AgentClass;
    readonly correlationId: string;
    readonly expectedBeforeDigest?: string | undefined;
  }): DawCommand {
    if (
      !Number.isFinite(input.valueNormalized) ||
      input.valueNormalized < 0 ||
      input.valueNormalized > 1
    ) {
      throw new DawBrainError(
        'DAW_SAFETY_VIOLATION',
        `Proposed normalized parameter value ${String(input.valueNormalized)} outside [0.0, 1.0]`,
      );
    }
    return {
      commandId: `plugcmd-${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      kind: 'plugin.param_write',
      capabilityId: 'daw.plugin.param_write',
      targetRef: input.targetPluginRef,
      params: {
        paramIndex: input.paramIndex,
        valueNormalized: input.valueNormalized,
      },
      expectedBeforeDigest: input.expectedBeforeDigest,
      requestedBy: input.requestedBy,
      requestedClass: input.requestedClass,
      correlationId: input.correlationId,
      createdAt: new Date().toISOString(),
    };
  }
}

export type { PluginWorkflowKind };
