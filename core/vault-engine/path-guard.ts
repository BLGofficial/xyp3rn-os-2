import { posix, resolve, sep } from 'node:path';

/**
 * Canonical OS 3.0 Vault top-level directories (00_SYSTEM..11_ARCHIVE, _attachments)
 * plus the 6 UI-xyp3rn Constellation sectors for backward-compatible path resolution.
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
  '10_INBOX',
  '11_ARCHIVE',
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
  '10_INBOX',
  '11_ARCHIVE',
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
  '00_SYSTEM/SCHEMAS/',
  '00_SYSTEM/SYSTEM_MANIFEST.md',
  '00_SYSTEM/TAXONOMY.md',
  '01_CORE/00_Identity/',
  '01_CORE/01_System_Prompts/',
  '01_CORE/IDENTITY/',
  '01_CORE/SYSTEM_PROMPTS/',
  '02_KNOWLEDGE/CANONICAL/',
  '02_KNOWLEDGE_LAYER/',
  '06_GOVERNANCE/00_Policies/',
  '06_GOVERNANCE/01_Standards/',
  '06_GOVERNANCE/02_Access_Control/',
  '08_GOVERNANCE/POLICIES/',
  '08_GOVERNANCE/STANDARDS/',
  '08_GOVERNANCE/ACCESS_CONTROL/',
  'canonical/',
] as const;

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
  if (trimmed.includes('\0')) {
    return { ok: false, reason: 'null byte in vault path' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, reason: `absolute path rejected: ${trimmed}` };
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
  }

  const normalizedPath = posix.normalize(trimmed);
  const rootAbs = resolve(vaultRoot);
  const absPath = resolve(rootAbs, ...segments);
  const relFromRoot = absPath.slice(rootAbs.length);
  if (
    !absPath.startsWith(rootAbs) ||
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

  const isCanonical =
    CANONICAL_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix)) ||
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
