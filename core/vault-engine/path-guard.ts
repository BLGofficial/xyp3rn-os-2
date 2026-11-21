import { posix, resolve, sep } from 'node:path';

/**
 * Canonical OS 3.0 Vault top-level directories (14 folders: 00_SYSTEM..12_ARCHIVE, _attachments)
 * plus the 6 UI-xyp3rn Constellation sectors & preserved legacy directories for non-destructive resolution.
 */
export const OS3_VAULT_DIRS = [
  '00_SYSTEM',
  '01_CORE',
  '02_KNOWLEDGE',
  '03_RESEARCH_INTELLIGENCE',
  '04_AGENTS',
  '05_WORKFLOWS',
  '06_RECORDS',
  '07_TECH',
  '08_GOVERNANCE',
  '09_X3LIUS_MUSIC',
  '10_DAW_BRAIN',
  '11_INBOX',
  '12_ARCHIVE',
  '_attachments',
] as const;

export const LEGACY_UI_SECTORS = [
  '01_CORE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_RESEARCH_MATERIAL',
  '05_XYP3RN_RECORDS',
  '06_GOVERNANCE',
] as const;

export type UiSectorId = (typeof LEGACY_UI_SECTORS)[number];

/**
 * Explicit reconciliation between the 6-sector Constellation UI (`UI-xyp3rn`) and
 * the 14 physical OS 3.0 + DAW Brain Vault directories without altering sector semantics.
 */
export const UI_SECTOR_RECONCILIATION: Readonly<
  Record<
    UiSectorId,
    {
      readonly uiSector: UiSectorId;
      readonly displayName: string;
      readonly functionalDomains: readonly string[];
      readonly mappedVaultDirs: readonly string[];
      readonly note: string;
    }
  >
> = {
  '01_CORE': {
    uiSector: '01_CORE',
    displayName: 'CORE ENGINE',
    functionalDomains: ['CORE', 'TECH'],
    mappedVaultDirs: ['00_SYSTEM', '01_CORE', '04_AGENTS', '05_WORKFLOWS', '07_TECH', '11_INBOX'],
    note: 'Maps OS architecture, agents, workflows, active intake (`11_INBOX`), and tech tooling telemetry without absorbing raw research sources.',
  },
  '02_KNOWLEDGE_LAYER': {
    uiSector: '02_KNOWLEDGE_LAYER',
    displayName: 'KNOWLEDGE LAYER',
    functionalDomains: ['KNOWLEDGE'],
    mappedVaultDirs: ['02_KNOWLEDGE', '02_KNOWLEDGE_LAYER', 'ROOT_KB'],
    note: 'Holds promotion-gated canonical knowledge (`CANONICAL`, `FRAMEWORKS`, `PROMPT_LIBRARY`, `GLOSSARY`) distinct from raw source staging.',
  },
  '03_RESEARCH_INTELLIGENCE': {
    uiSector: '03_RESEARCH_INTELLIGENCE',
    displayName: 'RESEARCH INTELLIGENCE',
    functionalDomains: ['RESEARCH_INTELLIGENCE'],
    mappedVaultDirs: ['03_RESEARCH_INTELLIGENCE'],
    note: 'Projects, questions, verbatim evidence, findings, contradictions, experiments, and research specialists.',
  },
  '04_RESEARCH_MATERIAL': {
    uiSector: '04_RESEARCH_MATERIAL',
    displayName: 'RESEARCH MATERIAL',
    functionalDomains: ['KNOWLEDGE', 'RESEARCH_INTELLIGENCE'],
    mappedVaultDirs: ['04_RESEARCH_MATERIAL', '02_KNOWLEDGE/SOURCES'],
    note: 'Raw source material library; explicitly separated from `07_TECH` and DAW tooling (`10_DAW_BRAIN`).',
  },
  '05_XYP3RN_RECORDS': {
    uiSector: '05_XYP3RN_RECORDS',
    displayName: 'XYP3RN RECORDS',
    functionalDomains: ['RECORDS'],
    mappedVaultDirs: ['06_RECORDS', '05_XYP3RN_RECORDS', '09_X3LIUS_MUSIC', '10_DAW_BRAIN', '_attachments'],
    note: 'Label catalog, X3LIUS songs/lyrics/prompts, and studio production/DAW Brain studio sessions & mix references.',
  },
  '06_GOVERNANCE': {
    uiSector: '06_GOVERNANCE',
    displayName: 'GOVERNANCE',
    functionalDomains: ['GOVERNANCE'],
    mappedVaultDirs: ['08_GOVERNANCE', '06_GOVERNANCE', '12_ARCHIVE'],
    note: 'Policies, access control, human approval records, immutable audit ledgers, and archived/superseded history.',
  },
};

export const VAULT_SECTORS = [
  '00_SYSTEM',
  '01_CORE',
  '02_KNOWLEDGE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_AGENTS',
  '04_RESEARCH_MATERIAL',
  '05_WORKFLOWS',
  '05_XYP3RN_RECORDS',
  '06_RECORDS',
  '06_GOVERNANCE',
  '07_TECH',
  '08_GOVERNANCE',
  '09_X3LIUS_MUSIC',
  '10_DAW_BRAIN',
  '10_INBOX',
  '11_INBOX',
  '11_ARCHIVE',
  '12_ARCHIVE',
  '_attachments',
] as const;

export type VaultSector = (typeof VAULT_SECTORS)[number];

export const ALLOWED_VAULT_EXTENSIONS = new Set([
  '.md',
  '.yaml',
  '.yml',
  '.json',
  '.txt',
  '.wav',
  '.mp3',
  '.flac',
  '.png',
  '.jpg',
  '.jpeg',
  '.pdf',
  '.canvas',
]);

/**
 * Canonical prefixes that require Promotion Gate + human approval to write.
 * Agents may never write to these paths directly.
 */
export const CANONICAL_PATH_PREFIXES = [
  '00_SYSTEM/',
  '01_CORE/00_Identity/',
  '01_CORE/01_System_Prompts/',
  '01_CORE/IDENTITY/',
  '01_CORE/SYSTEM_PROMPTS/',
  '02_KNOWLEDGE/CANONICAL/',
  '02_KNOWLEDGE_LAYER/',
  '06_GOVERNANCE/',
  '08_GOVERNANCE/',
  '10_DAW_BRAIN/CAPABILITIES/',
  '10_DAW_BRAIN/ADAPTERS/',
  '10_DAW_BRAIN/MIX_MASTER_REFS/',
  'canonical/',
] as const;

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED_STEM_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Ignored directories during Vault structural scans and agent operations.
 */
export const IGNORED_VAULT_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.vault-revisions',
  'node_modules',
]);

export type PathValidationResult =
  | {
      readonly ok: true;
      readonly normalizedPath: string;
      readonly absPath: string;
      readonly sector: VaultSector | 'ROOT_KB';
      readonly ext: string;
      readonly isCanonical: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Normalizes and validates a vault-relative path against path traversal, hidden system folders,
 * sector boundaries, and extension standards.
 */
export const validateVaultPath = (
  vaultRoot: string,
  relPath: string,
  options: { readonly requireSectorPrefix?: boolean | undefined } = {},
): PathValidationResult => {
  const requireSector = options.requireSectorPrefix ?? true;
  const trimmed = relPath.trim();

  if (!trimmed) {
    return { ok: false, reason: 'empty vault path' };
  }
  if (trimmed.includes('\0') || CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, reason: 'null byte or control character in vault path' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.includes(':')) {
    return { ok: false, reason: `absolute path, drive prefix, or alternate data stream rejected: ${trimmed}` };
  }
  if (trimmed.includes('\\') || trimmed.includes('//')) {
    return { ok: false, reason: `non-POSIX path separator rejected: ${trimmed}` };
  }

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      return { ok: false, reason: `path traversal segment rejected: ${trimmed}` };
    }
    if (segment.startsWith('.')) {
      return { ok: false, reason: `hidden segment rejected: ${segment}` };
    }
    if (WINDOWS_RESERVED_STEM_RE.test(segment)) {
      return { ok: false, reason: `reserved Windows device filename rejected: ${segment}` };
    }
  }

  const normalizedPath = posix.normalize(trimmed);
  const rootAbs = resolve(vaultRoot);
  const absPath = resolve(rootAbs, ...segments);
  const normRootCmp = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
  const normAbsCmp = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const relFromRoot = absPath.slice(rootAbs.length);
  if (
    !normAbsCmp.startsWith(normRootCmp) ||
    (relFromRoot.length > 0 && !relFromRoot.startsWith(sep))
  ) {
    return { ok: false, reason: `path escapes vault root: ${trimmed}` };
  }

  const fileName = segments.at(-1) ?? '';
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: false, reason: `missing file extension: ${fileName}` };
  }
  const ext = fileName.slice(dot).toLowerCase();
  if (!ALLOWED_VAULT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `disallowed extension "${ext}" in ${trimmed}` };
  }

  const firstSegment = segments[0] ?? '';
  const isKnownSector = (VAULT_SECTORS as readonly string[]).includes(firstSegment);

  if (requireSector && (!isKnownSector || segments.length < 2)) {
    return {
      ok: false,
      reason: `path "${trimmed}" must reside inside a canonical sector (${OS3_VAULT_DIRS.join(', ')})`,
    };
  }

  const sector: VaultSector | 'ROOT_KB' = isKnownSector
    ? (firstSegment as VaultSector)
    : 'ROOT_KB';

  const normalizedLower = normalizedPath.toLowerCase();
  const isCanonical =
    CANONICAL_PATH_PREFIXES.some((prefix) => normalizedLower.startsWith(prefix.toLowerCase())) ||
    (sector === 'ROOT_KB' && normalizedPath !== 'README.md');

  return {
    ok: true,
    normalizedPath,
    absPath,
    sector,
    ext,
    isCanonical,
  };
};

/**
 * Enforces the No-Overwrite Guard (01_CORE/07_Tools/vault.write.md):
 * when `filePath` already exists in `existingPaths`, returns `Stem (2).ext`, `Stem (3).ext`, etc.
 */
export const resolveNoOverwritePath = (
  filePath: string,
  existingPaths: ReadonlySet<string>,
): string => {
  const clean = filePath.trim();
  if (!existingPaths.has(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let n = 2;
  while (existingPaths.has(`${stem} (${n})${ext}`)) {
    n += 1;
  }
  return `${stem} (${n})${ext}`;
};
