import type { DawHostKind, DawPluginParameter } from '../types.ts';
import type {
  PluginCategory,
  PluginComparisonResult,
  PluginCompatibilityInfo,
  PluginParameterSpec,
  PluginProcessingRole,
  PluginProfile,
  PluginType,
} from './types.ts';

type KnowledgeSignature = {
  readonly pattern: RegExp;
  readonly manufacturer?: string | undefined;
  readonly category: PluginCategory;
  readonly pluginType: PluginType;
  readonly roles: readonly PluginProcessingRole[];
  readonly supportsSidechain?: boolean | undefined;
  readonly excludedInProducer?: boolean | undefined;
};

const KNOWN_PLUGIN_SIGNATURES: readonly KnowledgeSignature[] = [
  {
    pattern: /\bpro[-\s]?q\d*\b|parametric\s+eq|equilibrium|kirchhoff|nova\b|\beq\b/i,
    category: 'equalizer',
    pluginType: 'effect',
    roles: ['subtractive_eq', 'tonal_shaping', 'surgical_resonance_control'],
    supportsSidechain: true,
  },
  {
    pattern: /\bpro[-\s]?l\d*\b|fruity\s+limiter|ozone.*maximizer|\bl2\b|\bl1\b|elevate|limit/i,
    category: 'limiter',
    pluginType: 'effect',
    roles: ['peak_limiting'],
  },
  {
    pattern: /\bpro[-\s]?c\d*\b|fruity\s+compressor|fruity\s+multiband\s+compressor|maximus|soundgoodizer|\bcl[a-]|la[-\s]?2a|1176|comp/i,
    category: 'compressor',
    pluginType: 'effect',
    roles: ['dynamic_leveling', 'bus_glue'],
    supportsSidechain: true,
  },
  {
    pattern: /\bsoothe\d*\b|resona/i,
    category: 'equalizer',
    pluginType: 'effect',
    roles: ['surgical_resonance_control'],
    supportsSidechain: true,
  },
  {
    pattern: /\bpitcher\b|auto[-\s]?tune|melodyne|newtone|wavestune/i,
    category: 'pitch_correction',
    pluginType: 'effect',
    roles: ['vocal_tuning'],
  },
  {
    pattern: /\freeverb|reverb|valhalla|pro[-\s]?r|convolver/i,
    category: 'reverb',
    pluginType: 'effect',
    roles: ['spatial_reverb'],
  },
  {
    pattern: /\bdelay|echoboy|repeater|timeless/i,
    category: 'delay',
    pluginType: 'effect',
    roles: ['tempo_delay'],
  },
  {
    pattern: /soft\s+clipper|blood\s+overdrive|fast\s+dist|saturn|decapitator|black\s+box|thermal/i,
    category: 'saturation',
    pluginType: 'effect',
    roles: ['harmonic_saturation'],
  },
  {
    pattern: /stereo\s+enhancer|imager|wider|ozon.*imager|panomatic|doubler/i,
    category: 'stereo_imaging',
    pluginType: 'effect',
    roles: ['width_imaging', 'gain_utility'],
  },
  {
    pattern: /\btrace\b|span\b|insight|levels|loudness\s+meter|wave\s+candy/i,
    category: 'analyzer',
    pluginType: 'analyzer',
    roles: ['metering_analysis'],
  },
  {
    pattern: /\bflex\b|3x\s+osc|sytrus|harmor|serum|vital|massive|omnisphere|kontakt|harmless|sawer|morphine|poizone/i,
    category: 'synth_generator',
    pluginType: 'instrument',
    roles: ['sound_generation'],
  },
  {
    pattern: /fruity\s+balance|fruity\s+send|patcher|control\s+surface/i,
    category: 'utility',
    pluginType: 'utility',
    roles: ['gain_utility'],
  },
  {
    pattern: /gross\s+beat|vintage\s+chorus|flanger|phaser|shaperbox|portal|effectrix/i,
    category: 'modulation',
    pluginType: 'effect',
    roles: ['creative_mfx'],
  },
];

const PRODUCER_EXCLUDED_RE =
  /\b(gross beat|harmor|newtone|newtime|directwave|pitch shifter|vocodex|sakura|morphine|poizone|sawer|toxic biohazard|transient processor|transporter|pitcher|harmless|ogun)\b/i;

const KNOWN_MANUFACTURERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfabfilter|pro[-\s]?[qclrm]/i, 'FabFilter'],
  [/\bfruity\b|\bflex\b|\bmaximus\b|\bsoundgoodizer\b|\bpatcher\b|\bgross beat\b|\bharmless\b|\bharmor\b|\bsytrus\b|\b3x osc\b|\bconvolver\b/i, 'Image-Line'],
  [/\bizotope\b|\bozone\b|\bneutron\b|\bnectar\b/i, 'iZotope'],
  [/\boeksound\b|\bsoothe/i, 'oeksound'],
  [/\bcelemo|melodyne/i, 'Celemony'],
  [/\bantares\b|auto[-\s]?tune/i, 'Antares'],
  [/\bwaves|waveshell|cla[-\s]/i, 'Waves'],
  [/\bvalhalla/i, 'Valhalla DSP'],
  [/\btrace\b/i, 'XYP3RN Tech'],
];

export const normalizePluginKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\.(vst3|dll|component)$/i, '')
    .replace(/\[64bit\]/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const inferManufacturer = (name: string, explicitVendor?: string | null): string | null => {
  if (explicitVendor && explicitVendor.trim()) return explicitVendor.trim();
  for (const [re, vendor] of KNOWN_MANUFACTURERS) {
    if (re.test(name)) return vendor;
  }
  return null;
};

export const classifyPluginIdentity = (name: string): {
  readonly category: PluginCategory;
  readonly pluginType: PluginType;
  readonly processingRoles: readonly PluginProcessingRole[];
  readonly supportsSidechain: boolean;
  readonly manufacturer: string | null;
  readonly excludedInProducerDefault: boolean;
} => {
  const manufacturer = inferManufacturer(name);
  const excludedInProducerDefault = PRODUCER_EXCLUDED_RE.test(name);

  for (const sig of KNOWN_PLUGIN_SIGNATURES) {
    if (sig.pattern.test(name)) {
      return {
        category: sig.category,
        pluginType: sig.pluginType,
        processingRoles: sig.roles,
        supportsSidechain: sig.supportsSidechain ?? false,
        manufacturer,
        excludedInProducerDefault,
      };
    }
  }

  return {
    category: 'other',
    pluginType: 'effect',
    processingRoles: ['unclassified'],
    supportsSidechain: false,
    manufacturer,
    excludedInProducerDefault,
  };
};

export const interpretParameter = (
  param: Pick<DawPluginParameter, 'index' | 'id' | 'name' | 'valueNormalized' | 'displayValue' | 'defaultNormalized' | 'unit' | 'readable' | 'writable'>,
): PluginParameterSpec => {
  const lower = param.name.toLowerCase();
  let semanticKey = 'param.generic';
  let unit = param.unit;
  let min = 0;
  let max = 1;
  let interpretation = `Normalized ${param.name} = ${param.valueNormalized.toFixed(3)} (${param.displayValue || 'no display unit'})`;

  if (/freq|cutoff|hpf|lpf/i.test(lower)) {
    semanticKey = /hp/i.test(lower) ? 'eq.hpf_freq' : /lp/i.test(lower) ? 'eq.lpf_freq' : 'eq.freq';
    unit = unit ?? 'Hz';
    min = 20;
    max = 20_000;
    interpretation = `Frequency control "${param.name}" currently at ${param.displayValue || `${(param.valueNormalized * 100).toFixed(1)}%`}`;
  } else if (/thresh/i.test(lower)) {
    semanticKey = 'dynamics.threshold';
    unit = unit ?? 'dB';
    min = -60;
    max = 0;
    interpretation = `Threshold "${param.name}" (${param.displayValue || param.valueNormalized.toFixed(2)})`;
  } else if (/ratio/i.test(lower)) {
    semanticKey = 'dynamics.ratio';
    unit = unit ?? ':1';
    min = 1;
    max = 20;
    interpretation = `Compression ratio "${param.name}" (${param.displayValue || param.valueNormalized.toFixed(2)})`;
  } else if (/gain|level|output|ceil/i.test(lower)) {
    semanticKey = /ceil/i.test(lower) ? 'limiter.ceiling' : 'gain.db';
    unit = unit ?? 'dB';
    min = -24;
    max = 24;
    interpretation = `Gain/ceiling parameter "${param.name}" at ${param.displayValue || param.valueNormalized.toFixed(2)}`;
  } else if (/mix|wet|dry/i.test(lower)) {
    semanticKey = 'mix.wet_dry';
    unit = unit ?? '%';
    min = 0;
    max = 100;
    interpretation = `Blend control "${param.name}" at ${(param.valueNormalized * 100).toFixed(0)}%`;
  } else if (/attack/i.test(lower)) {
    semanticKey = 'dynamics.attack';
    unit = unit ?? 'ms';
  } else if (/release/i.test(lower)) {
    semanticKey = 'dynamics.release';
    unit = unit ?? 'ms';
  } else if (/pan/i.test(lower)) {
    semanticKey = 'stereo.pan';
    unit = unit ?? '%';
    min = -100;
    max = 100;
  }

  return {
    index: param.index,
    id: param.id,
    name: param.name,
    semanticKey,
    min,
    max,
    unit,
    defaultNormalized: param.defaultNormalized,
    stepped: false,
    readable: param.readable,
    writable: false, // Never allow direct autonomous parameter writes from Plugin Brain
    lastObservedNormalized: param.valueNormalized,
    lastObservedDisplay: param.displayValue || null,
    interpretation,
  };
};

export const evaluatePluginCompatibility = (
  profile: PluginProfile,
  context: {
    readonly hostKind?: DawHostKind | undefined;
    readonly hostEdition?: string | undefined;
  } = {},
): PluginCompatibilityInfo => {
  const reasons: string[] = [];
  const hostKind = context.hostKind;
  const hostEdition = context.hostEdition ?? '';

  if (hostKind && profile.compatibility.hosts.length > 0 && !profile.compatibility.hosts.includes(hostKind)) {
    return {
      ...profile.compatibility,
      supportVerdict: 'incompatible_host',
      reasons: [`Plugin "${profile.identity.productName}" targets [${profile.compatibility.hosts.join(', ')}], not "${hostKind}"`],
    };
  }

  if (
    hostKind === 'fl_studio' &&
    /producer/i.test(hostEdition) &&
    PRODUCER_EXCLUDED_RE.test(profile.identity.productName)
  ) {
    reasons.push(
      `"${profile.identity.productName}" is typically excluded/demo-locked in FL Studio Producer Edition (requires Signature/All Plugins or standalone license)`,
    );
    return {
      ...profile.compatibility,
      supportVerdict: 'excluded_by_edition',
      reasons,
    };
  }

  if (profile.installation.installedOnHost === 'not_detected_on_host') {
    reasons.push(`Not detected on workstation host (${profile.installation.discoverySources.join(', ')})`);
  }

  return {
    ...profile.compatibility,
    supportVerdict:
      profile.compatibility.supportVerdict === 'excluded_by_edition' && /all plugins/i.test(hostEdition)
        ? 'verified_compatible'
        : profile.compatibility.supportVerdict,
    reasons: reasons.length > 0 ? reasons : profile.compatibility.reasons,
  };
};

export const comparePlugins = (a: PluginProfile, b: PluginProfile): PluginComparisonResult => {
  const sharedRoles = a.processingRoles.filter((r) => b.processingRoles.includes(r));
  const sharedCategory = a.category === b.category;
  const sameFormat = a.format === b.format;
  const aInstalled = a.installation.installedOnHost === 'verified_installed';
  const bInstalled = b.installation.installedOnHost === 'verified_installed';

  const tradeoffs: string[] = [];
  if (aInstalled !== bInstalled) {
    tradeoffs.push(
      aInstalled
        ? `"${a.identity.productName}" is verified installed on host while "${b.identity.productName}" is not detected`
        : `"${b.identity.productName}" is verified installed on host while "${a.identity.productName}" is not detected`,
    );
  }
  if (a.io.supportsSidechain !== b.io.supportsSidechain) {
    tradeoffs.push(
      `${a.io.supportsSidechain ? a.identity.productName : b.identity.productName} supports external sidechain key input`,
    );
  }
  if (a.parameters.length !== b.parameters.length) {
    tradeoffs.push(
      `Observed parameter granularity differs (${a.parameters.length} vs ${b.parameters.length} mapped parameters)`,
    );
  }

  const recommendation =
    aInstalled && !bInstalled
      ? `Prefer "${a.identity.productName}" (verified installed on host)`
      : bInstalled && !aInstalled
        ? `Prefer "${b.identity.productName}" (verified installed on host)`
        : sharedCategory
          ? `Both cover "${a.category}"; choose based on "${sharedRoles.join(', ') || 'workflow preference'}"`
          : `Complementary categories ("${a.category}" vs "${b.category}") rather than direct substitutes`;

  return {
    pluginA: { id: a.id, name: a.identity.productName, installed: aInstalled },
    pluginB: { id: b.id, name: b.identity.productName, installed: bInstalled },
    sharedCategory,
    sharedRoles,
    sameFormat,
    parameterCountDelta: a.parameters.length - b.parameters.length,
    recommendation,
    tradeoffs,
  };
};
