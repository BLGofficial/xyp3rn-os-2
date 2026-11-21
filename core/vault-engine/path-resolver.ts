import { lstat, realpath } from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';
import { VaultPathSecurityError } from './errors.ts';
import {
  ALLOWED_VAULT_EXTENSIONS,
  CANONICAL_PATH_PREFIXES,
  OS3_VAULT_DIRS,
  VAULT_SECTORS,
  resolveNoOverwritePath,
  validateVaultPath,
  type PathValidationResult,
  type VaultSector,
} from './path-guard.ts';
import { DEFAULT_WRITABLE_SECTORS, type VaultEngineConfig } from './vault-config.ts';

export type ResolvedVaultPath = {
  readonly normalizedPath: string;
  readonly absPath: string;
  readonly sector: VaultSector | 'ROOT_KB';
  readonly ext: string;
  readonly isCanonical: boolean;
  readonly isWritableSector: boolean;
};

const WRITABLE_SET = new Set<string>(DEFAULT_WRITABLE_SECTORS);

const isWithinRoot = (rootReal: string, candidateReal: string): boolean => {
  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const normCand = process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal;
  if (normCand === normRoot) return true;
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  return normCand.startsWith(rootWithSep);
};

/**
 * Synchronously validates lexical path safety and throws typed `VaultPathSecurityError`
 * on traversal, absolute paths, disallowed extensions, or disallowed sectors.
 */
export const resolveVaultPathSync = (
  vaultRootOrConfig: string | VaultEngineConfig,
  relPath: string,
  options: {
    readonly requireSectorPrefix?: boolean | undefined;
    readonly requireWritableSector?: boolean | undefined;
  } = {},
): ResolvedVaultPath => {
  const vaultRoot = typeof vaultRootOrConfig === 'string' ? resolve(vaultRootOrConfig) : vaultRootOrConfig.vaultRoot;
  const writableSectors =
    typeof vaultRootOrConfig === 'string' ? WRITABLE_SET : vaultRootOrConfig.writableSectors;

  const trimmed = relPath.trim();
  if (!trimmed) {
    throw new VaultPathSecurityError('PATH_TRAVERSAL', 'Empty vault path rejected', { vaultPath: relPath });
  }
  if (trimmed.includes('\0') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new VaultPathSecurityError('PATH_TRAVERSAL', 'Null byte or control character in vault path rejected', { vaultPath: relPath });
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.includes(':')) {
    throw new VaultPathSecurityError('ABSOLUTE_PATH_FORBIDDEN', `Absolute path or alternate data stream rejected: ${trimmed}`, {
      vaultPath: relPath,
    });
  }
  if (trimmed.includes('\\') || trimmed.includes('//')) {
    throw new VaultPathSecurityError('PATH_TRAVERSAL', `Non-POSIX path separator rejected: ${trimmed}`, {
      vaultPath: relPath,
    });
  }

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new VaultPathSecurityError('PATH_TRAVERSAL', `Path traversal segment rejected: ${trimmed}`, {
        vaultPath: relPath,
      });
    }
    if (segment.startsWith('.')) {
      throw new VaultPathSecurityError('DISALLOWED_DIRECTORY', `Hidden segment rejected: ${segment}`, {
        vaultPath: relPath,
      });
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new VaultPathSecurityError('DISALLOWED_DIRECTORY', `Reserved Windows device name rejected: ${segment}`, {
        vaultPath: relPath,
      });
    }
  }

  const normalizedPath = posix.normalize(trimmed);
  const absPath = resolve(vaultRoot, ...segments);
  if (!isWithinRoot(vaultRoot, absPath)) {
    throw new VaultPathSecurityError('PATH_TRAVERSAL', `Path escapes vault root: ${trimmed}`, {
      vaultPath: relPath,
    });
  }

  const fileName = segments.at(-1) ?? '';
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) {
    throw new VaultPathSecurityError('DISALLOWED_EXTENSION', `Missing file extension: ${fileName}`, {
      vaultPath: relPath,
    });
  }
  const ext = fileName.slice(dot).toLowerCase();
  if (!ALLOWED_VAULT_EXTENSIONS.has(ext)) {
    throw new VaultPathSecurityError('DISALLOWED_EXTENSION', `Disallowed extension "${ext}" in ${trimmed}`, {
      vaultPath: relPath,
    });
  }

  const firstSegment = segments[0] ?? '';
  const isKnownSector = (VAULT_SECTORS as readonly string[]).includes(firstSegment);
  const requireSector = options.requireSectorPrefix ?? true;

  if (requireSector && (!isKnownSector || segments.length < 2)) {
    throw new VaultPathSecurityError(
      'DISALLOWED_DIRECTORY',
      `Path "${trimmed}" must reside inside an approved Vault directory (${OS3_VAULT_DIRS.join(', ')})`,
      { vaultPath: relPath },
    );
  }

  const sector: VaultSector | 'ROOT_KB' = isKnownSector ? (firstSegment as VaultSector) : 'ROOT_KB';
  const isWritableSector = writableSectors.has(sector);

  if (options.requireWritableSector && !isWritableSector) {
    throw new VaultPathSecurityError(
      'DISALLOWED_DIRECTORY',
      `Write access to directory "${sector}" is restricted (${trimmed})`,
      { vaultPath: relPath, details: { sector } },
    );
  }

  const normalizedLower = normalizedPath.toLowerCase();
  const isCanonical =
    CANONICAL_PATH_PREFIXES.some((prefix) => normalizedLower.startsWith(prefix.toLowerCase())) ||
    (sector === 'ROOT_KB' && normalizedPath !== 'README.md');

  return {
    normalizedPath,
    absPath,
    sector,
    ext,
    isCanonical,
    isWritableSector,
  };
};

/**
 * Verifies that neither `absPath` nor any of its existing ancestor directories inside `vaultRoot`
 * is a symbolic link or Windows junction escaping outside `realpath(vaultRoot)`.
 */
export const assertNoSymlinkEscape = async (
  vaultRoot: string,
  absPath: string,
  relPathForError?: string,
): Promise<void> => {
  const rootAbs = resolve(vaultRoot);
  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  // Walk from rootAbs down to absPath checking each existing segment via lstat + realpath
  const relSegments = absPath
    .slice(rootAbs.length)
    .split(sep)
    .filter((s) => s.length > 0);

  let current = rootAbs;
  for (const seg of relSegments) {
    current = resolve(current, seg);
    const lst = await lstat(current).catch(() => null);
    if (!lst) {
      // Once an ancestor does not exist on disk yet, verify the deepest existing parent's realpath
      const parentReal = await realpath(dirname(current)).catch(() => dirname(current));
      if (!isWithinRoot(rootReal, parentReal)) {
        throw new VaultPathSecurityError(
          'SYMLINK_ESCAPE',
          `Symbolic link escape detected outside Vault root for "${relPathForError ?? absPath}"`,
          { vaultPath: relPathForError, details: { targetRealPath: parentReal, vaultRoot: rootReal } },
        );
      }
      break;
    }

    if (lst.isSymbolicLink()) {
      const targetReal = await realpath(current).catch(() => null);
      if (!targetReal || !isWithinRoot(rootReal, targetReal)) {
        throw new VaultPathSecurityError(
          'SYMLINK_ESCAPE',
          `Symbolic link "${relPathForError ?? current}" resolves outside the Vault root (${targetReal ?? 'broken link'})`,
          { vaultPath: relPathForError, details: { symlinkPath: current, targetRealPath: targetReal, vaultRoot: rootReal } },
        );
      }
    }
  }
};

/**
 * Full async path resolution: lexical validation + filesystem symlink-escape verification.
 */
export const resolveVaultPath = async (
  vaultRootOrConfig: string | VaultEngineConfig,
  relPath: string,
  options: {
    readonly requireSectorPrefix?: boolean | undefined;
    readonly requireWritableSector?: boolean | undefined;
  } = {},
): Promise<ResolvedVaultPath> => {
  const resolved = resolveVaultPathSync(vaultRootOrConfig, relPath, options);
  const vaultRoot = typeof vaultRootOrConfig === 'string' ? vaultRootOrConfig : vaultRootOrConfig.vaultRoot;
  await assertNoSymlinkEscape(vaultRoot, resolved.absPath, resolved.normalizedPath);
  return resolved;
};

export { resolveNoOverwritePath, validateVaultPath, type PathValidationResult, type VaultSector };
