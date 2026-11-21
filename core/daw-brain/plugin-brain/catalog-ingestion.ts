import type { VaultEngine } from '../../vault-engine/vault-engine.ts';
import type { DawHostKind, DawPluginInstance } from '../types.ts';
import {
  classifyPluginIdentity,
  interpretParameter,
  normalizePluginKey,
} from './plugin-analyzer.ts';
import type {
  HostScannedPluginInput,
  PluginDocSource,
  PluginFormat,
  PluginInstallationState,
  PluginProfile,
  PluginUserCatalogEntry,
} from './types.ts';

const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PLUGIN_INGEST_BATCH = 2_000;
const MAX_PLUGIN_PARAMS = 2_048;

const sanitizePluginText = (val: unknown, label: string, maxLen = 240): string => {
  if (typeof val !== 'string') {
    throw new Error(`PLUGIN_METADATA_INVALID: "${label}" must be a string`);
  }
  const clean = val.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!clean) {
    throw new Error(`PLUGIN_METADATA_INVALID: "${label}" must be non-empty`);
  }
  if (FORBIDDEN_PROTO_KEYS.has(clean.toLowerCase())) {
    throw new Error(`PLUGIN_METADATA_REJECTED: forbidden prototype key "${clean}" in "${label}"`);
  }
  return clean.slice(0, maxLen);
};

const assertSafePluginId = (val: string | undefined, label: string): void => {
  if (!val) return;
  const trimmed = val.trim();
  if (FORBIDDEN_PROTO_KEYS.has(trimmed.toLowerCase()) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`PLUGIN_METADATA_REJECTED: unsafe plugin identifier in "${label}"`);
  }
};

const dedupStrings = (arr: readonly string[]): readonly string[] => [...new Set(arr.filter((s) => s.trim()))];

const dedupSources = (sources: readonly PluginDocSource[]): readonly PluginDocSource[] => {
  const seen = new Set<string>();
  const out: PluginDocSource[] = [];
  for (const s of sources) {
    const key = `${s.sourceType}:${s.refId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
};

const mergeProfiles = (existing: PluginProfile, incoming: PluginProfile): PluginProfile => {
  const installed =
    existing.installation.installedOnHost === 'verified_installed' ||
    incoming.installation.installedOnHost === 'verified_installed'
      ? 'verified_installed'
      : incoming.installation.installedOnHost !== 'unknown'
        ? incoming.installation.installedOnHost
        : existing.installation.installedOnHost;

  const discoverySources = [...new Set([
    ...existing.installation.discoverySources,
    ...incoming.installation.discoverySources,
  ])] as PluginInstallationState['discoverySources'];

  const paramsMap = new Map(existing.parameters.map((p) => [p.id, p]));
  for (const p of incoming.parameters) {
    paramsMap.set(p.id, p);
  }

  return {
    ...existing,
    identity: {
      manufacturer: incoming.identity.manufacturer ?? existing.identity.manufacturer,
      productName: existing.identity.productName || incoming.identity.productName,
      normalizedKey: existing.identity.normalizedKey,
      version: incoming.identity.version ?? existing.identity.version,
      uid: incoming.identity.uid ?? existing.identity.uid,
    },
    format: incoming.format !== 'UNKNOWN' ? incoming.format : existing.format,
    category: existing.category !== 'other' ? existing.category : incoming.category,
    pluginType: existing.pluginType !== 'effect' ? existing.pluginType : incoming.pluginType,
    processingRoles: dedupStrings([
      ...existing.processingRoles.filter((r) => r !== 'unclassified'),
      ...incoming.processingRoles.filter((r) => r !== 'unclassified'),
    ]).length > 0
      ? (dedupStrings([
          ...existing.processingRoles.filter((r) => r !== 'unclassified'),
          ...incoming.processingRoles.filter((r) => r !== 'unclassified'),
        ]) as PluginProfile['processingRoles'])
      : existing.processingRoles,
    parameters: [...paramsMap.values()],
    presets:
      incoming.presets.status === 'available'
        ? incoming.presets
        : existing.presets,
    compatibility: {
      hosts: [...new Set([...existing.compatibility.hosts, ...incoming.compatibility.hosts])],
      architectures: [...new Set([...existing.compatibility.architectures, ...incoming.compatibility.architectures])],
      editionRequirement:
        existing.compatibility.editionRequirement !== 'Unknown'
          ? existing.compatibility.editionRequirement
          : incoming.compatibility.editionRequirement,
      supportVerdict:
        existing.compatibility.supportVerdict === 'excluded_by_edition' ||
        incoming.compatibility.supportVerdict === 'excluded_by_edition'
          ? 'excluded_by_edition'
          : incoming.compatibility.supportVerdict !== 'unknown'
            ? incoming.compatibility.supportVerdict
            : existing.compatibility.supportVerdict,
      reasons: dedupStrings([...existing.compatibility.reasons, ...incoming.compatibility.reasons]),
    },
    knownLimitations: dedupStrings([...existing.knownLimitations, ...incoming.knownLimitations]),
    documentationSources: dedupSources([...existing.documentationSources, ...incoming.documentationSources]),
    installation: {
      installedOnHost: installed,
      discoverySources,
      hostPaths: dedupStrings([...existing.installation.hostPaths, ...incoming.installation.hostPaths]),
      lastVerifiedAt: incoming.installation.lastVerifiedAt ?? existing.installation.lastVerifiedAt,
    },
    updatedAt: incoming.updatedAt,
  };
};

/**
 * Ingests plugin facts from verified sources only (`DAW live`, `local host scan`,
 * `user catalog`, `Vault approved/canonical docs`) while guaranteeing knowledge docs
 * NEVER fabricate host installation status.
 */
export class PluginCatalogRegistry {
  readonly #profilesByKey = new Map<string, PluginProfile>();

  upsertProfile(profile: PluginProfile): PluginProfile {
    const key = profile.identity.normalizedKey;
    const prev = this.#profilesByKey.get(key);
    const next = prev ? mergeProfiles(prev, profile) : profile;
    this.#profilesByKey.set(key, next);
    return next;
  }

  getProfile(idOrName: string): PluginProfile | null {
    const byKey = this.#profilesByKey.get(normalizePluginKey(idOrName));
    if (byKey) return byKey;
    for (const p of this.#profilesByKey.values()) {
      if (p.id === idOrName) return p;
    }
    return null;
  }

  listProfiles(): readonly PluginProfile[] {
    return [...this.#profilesByKey.values()];
  }

  listInstalledProfiles(): readonly PluginProfile[] {
    return this.listProfiles().filter((p) => p.installation.installedOnHost === 'verified_installed');
  }

  ingestDawExposedPlugins(
    plugins: readonly DawPluginInstance[],
    hostKind: DawHostKind = 'generic_daw',
    edition = 'Unknown',
  ): readonly PluginProfile[] {
    if (plugins.length > MAX_PLUGIN_INGEST_BATCH) {
      throw new Error(`PLUGIN_METADATA_BATCH_EXCEEDED: ${plugins.length} exceeds max ${MAX_PLUGIN_INGEST_BATCH}`);
    }
    const now = new Date().toISOString();
    const out: PluginProfile[] = [];

    for (const inst of plugins) {
      const safeName = sanitizePluginText(inst.name, 'plugin.name');
      assertSafePluginId(inst.id, 'plugin.id');
      if (inst.parameters.status === 'available' && inst.parameters.value.length > MAX_PLUGIN_PARAMS) {
        throw new Error(`PLUGIN_PARAMS_EXCEEDED: "${safeName}" exceeds max ${MAX_PLUGIN_PARAMS} parameters`);
      }
      const normalizedKey = normalizePluginKey(safeName);
      const cls = classifyPluginIdentity(safeName);
      const params =
        inst.parameters.status === 'available'
          ? inst.parameters.value.map((p) => interpretParameter(p))
          : [];

      const profile: PluginProfile = {
        id: `plg-${normalizedKey}`,
        identity: {
          manufacturer: (inst.vendor ? sanitizePluginText(inst.vendor, 'plugin.vendor') : undefined) ?? cls.manufacturer,
          productName: safeName,
          normalizedKey,
          version: null,
          uid: inst.id,
        },
        format: inst.format as PluginFormat,
        category: cls.category,
        pluginType: cls.pluginType,
        processingRoles: cls.processingRoles,
        io: {
          inputLayout: cls.pluginType === 'instrument' ? 'midi_in' : 'stereo',
          outputLayout: 'stereo',
          supportsSidechain: cls.supportsSidechain,
        },
        parameters: params,
        presets: {
          status: 'unavailable',
          reason: 'Presets not enumerated in DAW live plugin snapshot',
        },
        compatibility: {
          hosts: [hostKind],
          architectures: ['x64'],
          editionRequirement: cls.excludedInProducerDefault ? 'Signature/All Plugins or separate unlock' : edition,
          supportVerdict:
            inst.editionCompatible === 'excluded_by_edition'
              ? 'excluded_by_edition'
              : inst.editionCompatible === 'verified'
                ? 'verified_compatible'
                : 'unknown',
          reasons: [`Observed live in container "${inst.containerId}" slot ${inst.slotIndex}`],
        },
        requirements: {
          licenseModel: cls.excludedInProducerDefault ? 'edition_upgrade_or_trial' : 'unknown',
          dependencies: [],
        },
        knownLimitations:
          inst.parameterCount > params.length
            ? [`Only ${params.length}/${inst.parameterCount} parameters fetched in bounded observation sweep`]
            : [],
        documentationSources: [
          {
            sourceType: 'daw_live',
            refId: inst.id,
            approved: true,
          },
        ],
        installation: {
          installedOnHost: 'verified_installed',
          discoverySources: ['daw_live_inventory'],
          hostPaths: [],
          lastVerifiedAt: now,
        },
        updatedAt: now,
      };
      out.push(this.upsertProfile(profile));
    }

    return out;
  }

  ingestLocalHostInventory(
    entries: readonly HostScannedPluginInput[],
    hostKinds: readonly DawHostKind[] = ['fl_studio'],
  ): readonly PluginProfile[] {
    if (entries.length > MAX_PLUGIN_INGEST_BATCH) {
      throw new Error(`PLUGIN_METADATA_BATCH_EXCEEDED: ${entries.length} exceeds max ${MAX_PLUGIN_INGEST_BATCH}`);
    }
    const now = new Date().toISOString();
    const out: PluginProfile[] = [];

    for (const item of entries) {
      const safeName = sanitizePluginText(item.name, 'hostPlugin.name');
      const safeManufacturer = item.manufacturer ? sanitizePluginText(item.manufacturer, 'hostPlugin.manufacturer') : undefined;
      const normalizedKey = normalizePluginKey(safeName);
      const cls = classifyPluginIdentity(safeName);

      const profile: PluginProfile = {
        id: `plg-${normalizedKey}`,
        identity: {
          manufacturer: safeManufacturer ?? cls.manufacturer,
          productName: safeName,
          normalizedKey,
          version: item.version ?? null,
          uid: null,
        },
        format: item.format,
        category: cls.category,
        pluginType: cls.pluginType,
        processingRoles: cls.processingRoles,
        io: {
          inputLayout: cls.pluginType === 'instrument' ? 'midi_in' : 'stereo',
          outputLayout: 'stereo',
          supportsSidechain: cls.supportsSidechain,
        },
        parameters: [],
        presets: {
          status: 'unavailable',
          reason: 'Host binary scan records presence and format without enumerating presets',
        },
        compatibility: {
          hosts: item.format === 'NATIVE' ? ['fl_studio'] : hostKinds,
          architectures: ['x64'],
          editionRequirement:
            item.editionStatus === 'excluded_by_edition_unless_purchased'
              ? 'Signature/All Plugins or separate license'
              : item.editionStatus === 'included_stock'
                ? 'Producer Edition+'
                : 'Third-party license',
          supportVerdict:
            item.editionStatus === 'excluded_by_edition_unless_purchased'
              ? 'excluded_by_edition'
              : 'verified_compatible',
          reasons: [`Verified local binary/preset entry at "${item.path}"`],
        },
        requirements: {
          licenseModel:
            item.editionStatus === 'included_stock'
              ? 'included_stock'
              : item.editionStatus === 'excluded_by_edition_unless_purchased'
                ? 'edition_upgrade_or_trial'
                : item.editionStatus === 'third_party_compatible'
                  ? 'commercial_license'
                  : 'unknown',
          dependencies: [],
        },
        knownLimitations: [],
        documentationSources: [
          {
            sourceType: 'host_metadata',
            refId: item.path,
            filePath: item.path,
            approved: true,
          },
        ],
        installation: {
          installedOnHost: 'verified_installed',
          discoverySources: ['local_host_scan'],
          hostPaths: [item.path],
          lastVerifiedAt: now,
        },
        updatedAt: now,
      };
      out.push(this.upsertProfile(profile));
    }

    return out;
  }

  ingestUserCatalog(
    entries: readonly PluginUserCatalogEntry[],
    assumeInstalled = false,
  ): readonly PluginProfile[] {
    if (entries.length > MAX_PLUGIN_INGEST_BATCH) {
      throw new Error(`PLUGIN_METADATA_BATCH_EXCEEDED: ${entries.length} exceeds max ${MAX_PLUGIN_INGEST_BATCH}`);
    }
    const now = new Date().toISOString();
    const out: PluginProfile[] = [];

    for (const item of entries) {
      const safeProductName = sanitizePluginText(item.productName, 'productName');
      const safeManufacturer = item.manufacturer ? sanitizePluginText(item.manufacturer, 'manufacturer') : undefined;
      assertSafePluginId(item.id, 'id');
      if ((item.parameters?.length ?? 0) > MAX_PLUGIN_PARAMS) {
        throw new Error(`PLUGIN_PARAMS_EXCEEDED: "${safeProductName}" exceeds max ${MAX_PLUGIN_PARAMS} parameters`);
      }

      const normalizedKey = normalizePluginKey(safeProductName);
      const cls = classifyPluginIdentity(safeProductName);
      const params = (item.parameters ?? []).map((p, idx) => ({
        index: idx,
        id: `cat-param-${idx}`,
        name: sanitizePluginText(p.name, `parameter[${idx}].name`, 160),
        semanticKey: p.semanticKey ?? 'param.generic',
        min: p.min ?? 0,
        max: p.max ?? 1,
        unit: p.unit ?? null,
        defaultNormalized: null,
        stepped: false,
        readable: true,
        writable: false,
        lastObservedNormalized: null,
        lastObservedDisplay: null,
        interpretation: `Catalog spec for ${sanitizePluginText(p.name, `parameter[${idx}].name`, 160)}`,
      }));

      const profile: PluginProfile = {
        id: item.id ?? `plg-${normalizedKey}`,
        identity: {
          manufacturer: safeManufacturer ?? cls.manufacturer,
          productName: safeProductName,
          normalizedKey,
          version: item.version ?? null,
          uid: null,
        },
        format: item.format ?? 'UNKNOWN',
        category: item.category ?? cls.category,
        pluginType: item.pluginType ?? cls.pluginType,
        processingRoles: item.processingRoles ?? cls.processingRoles,
        io: {
          inputLayout: (item.pluginType ?? cls.pluginType) === 'instrument' ? 'midi_in' : 'stereo',
          outputLayout: 'stereo',
          supportsSidechain: item.supportsSidechain ?? cls.supportsSidechain,
        },
        parameters: params,
        presets: item.presets
          ? { status: 'available', value: item.presets }
          : { status: 'unavailable', reason: 'No presets declared in user catalog entry' },
        compatibility: {
          hosts: [],
          architectures: ['x64'],
          editionRequirement: item.editionRequirement ?? 'Unknown',
          supportVerdict: 'unknown',
          reasons: ['Declared in user-provided plugin catalog'],
        },
        requirements: {
          licenseModel: item.licenseModel ?? 'unknown',
          dependencies: [],
        },
        knownLimitations: item.knownLimitations ?? [],
        documentationSources: [
          {
            sourceType: 'user_catalog',
            refId: item.sourceRef ?? item.id ?? normalizedKey,
            approved: true,
          },
        ],
        installation: {
          installedOnHost: assumeInstalled ? 'verified_installed' : 'unknown',
          discoverySources: ['user_catalog'],
          hostPaths: [],
          lastVerifiedAt: assumeInstalled ? now : null,
        },
        updatedAt: now,
      };
      out.push(this.upsertProfile(profile));
    }

    return out;
  }

  /**
   * Reads approved/canonical Vault plugin notes from `10_DAW_BRAIN/PLUGINS/`.
   * CRITICAL: Never marks a plugin as `verified_installed` purely from documentation!
   */
  async ingestVaultPluginDocs(vault: VaultEngine): Promise<readonly PluginProfile[]> {
    const entries = vault.list({ sector: '10_DAW_BRAIN', prefix: '10_DAW_BRAIN/PLUGINS' });
    const now = new Date().toISOString();
    const out: PluginProfile[] = [];

    for (const item of entries) {
      if (!item.vaultPath.endsWith('.md')) continue;
      const doc = await vault.read(item.vaultPath).catch(() => null);
      if (!doc) continue;

      const fm = doc.frontmatter;
      const status = typeof fm.status === 'string' ? fm.status.toLowerCase() : '';
      const approved = status === 'canonical' || status === 'approved';
      if (!approved) continue;

      const title = typeof fm.title === 'string' ? fm.title.replace(/^Plugin\s+Profile:\s*/i, '').trim() : item.vaultPath;
      const normalizedKey = normalizePluginKey(title);
      const cls = classifyPluginIdentity(title);
      const fmtRaw = typeof fm.plugin_format === 'string' ? fm.plugin_format.toUpperCase() : 'UNKNOWN';
      const fmt: PluginFormat =
        fmtRaw.includes('VST3')
          ? 'VST3'
          : fmtRaw.includes('VST2') || fmtRaw === 'VST'
            ? 'VST2'
            : fmtRaw.includes('CLAP')
              ? 'CLAP'
              : fmtRaw.includes('AU')
                ? 'AU'
                : fmtRaw.includes('NATIVE')
                  ? 'NATIVE'
                  : 'UNKNOWN';

      const profile: PluginProfile = {
        id: typeof fm.id === 'string' ? fm.id : `plg-${normalizedKey}`,
        identity: {
          manufacturer: typeof fm.vendor === 'string' ? fm.vendor : cls.manufacturer,
          productName: title,
          normalizedKey,
          version: null,
          uid: null,
        },
        format: fmt,
        category: cls.category,
        pluginType: cls.pluginType,
        processingRoles: cls.processingRoles,
        io: {
          inputLayout: cls.pluginType === 'instrument' ? 'midi_in' : 'stereo',
          outputLayout: 'stereo',
          supportsSidechain: cls.supportsSidechain,
        },
        parameters: [],
        presets: {
          status: 'unavailable',
          reason: 'Presets listed only when explicitly documented or exposed by host',
        },
        compatibility: {
          hosts: fmt === 'NATIVE' ? ['fl_studio'] : [],
          architectures: ['x64'],
          editionRequirement:
            typeof fm.edition_requirement === 'string' ? fm.edition_requirement : 'See Vault docs',
          supportVerdict: cls.excludedInProducerDefault ? 'excluded_by_edition' : 'unknown',
          reasons: [`Documented in approved Vault profile "${item.vaultPath}" (status=${status})`],
        },
        requirements: {
          licenseModel: 'unknown',
          dependencies: [],
        },
        knownLimitations: ['Documentation presence does NOT prove local workstation installation'],
        documentationSources: [
          {
            sourceType: status === 'canonical' ? 'vault_canonical' : 'vault_approved',
            refId: typeof fm.id === 'string' ? fm.id : item.vaultPath,
            vaultPath: item.vaultPath,
            approved: true,
          },
        ],
        installation: {
          // NEVER claim installed from Vault doc alone!
          installedOnHost: 'not_detected_on_host',
          discoverySources: ['vault_knowledge_only'],
          hostPaths: [],
          lastVerifiedAt: null,
        },
        updatedAt: now,
      };
      out.push(this.upsertProfile(profile));
    }

    return out;
  }
}
