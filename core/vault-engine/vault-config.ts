import { resolve } from 'node:path';
import {
  ALLOWED_VAULT_EXTENSIONS,
  CANONICAL_PATH_PREFIXES,
  IGNORED_VAULT_DIRS,
  OS3_VAULT_DIRS,
  VAULT_SECTORS,
} from './path-guard.ts';
import { resolveConfiguredVaultPath } from './vault-foundation.ts';

/**
 * Directories where standard controlled writes (`write`, `update`, `append`) are permitted,
 * provided the target path does not match a protected canonical prefix (`CANONICAL_PATH_PREFIXES`).
 * Note: `00_SYSTEM` is excluded from standard writes because system schemas and manifests are protected.
 */
export const DEFAULT_WRITABLE_SECTORS = [
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

export type VaultEngineConfig = {
  readonly vaultRoot: string;
  readonly allowedSectors: ReadonlySet<string>;
  readonly writableSectors: ReadonlySet<string>;
  readonly canonicalPrefixes: readonly string[];
  readonly allowedExtensions: ReadonlySet<string>;
  readonly ignoredDirs: ReadonlySet<string>;
  readonly maxParseBytes: number;
  readonly lockTtlMs: number;
  readonly enforceSchemaOnWrite: boolean;
  readonly enforceReferencesOnWrite: boolean;
};

export type VaultEngineConfigInput = {
  readonly vaultRoot?: string | undefined;
  readonly writableSectors?: Iterable<string> | undefined;
  readonly canonicalPrefixes?: readonly string[] | undefined;
  readonly maxParseBytes?: number | undefined;
  readonly lockTtlMs?: number | undefined;
  readonly enforceSchemaOnWrite?: boolean | undefined;
  readonly enforceReferencesOnWrite?: boolean | undefined;
};

export const createVaultConfig = (input: VaultEngineConfigInput = {}): VaultEngineConfig => {
  const vaultRoot = resolve(resolveConfiguredVaultPath(input.vaultRoot));
  return {
    vaultRoot,
    allowedSectors: new Set<string>(VAULT_SECTORS),
    writableSectors: new Set<string>(input.writableSectors ?? DEFAULT_WRITABLE_SECTORS),
    canonicalPrefixes: input.canonicalPrefixes ?? CANONICAL_PATH_PREFIXES,
    allowedExtensions: ALLOWED_VAULT_EXTENSIONS,
    ignoredDirs: IGNORED_VAULT_DIRS,
    maxParseBytes: input.maxParseBytes ?? 5 * 1024 * 1024,
    lockTtlMs: input.lockTtlMs ?? 15_000,
    enforceSchemaOnWrite: input.enforceSchemaOnWrite ?? false,
    enforceReferencesOnWrite: input.enforceReferencesOnWrite ?? false,
  };
};

export { OS3_VAULT_DIRS, VAULT_SECTORS, resolveConfiguredVaultPath };
