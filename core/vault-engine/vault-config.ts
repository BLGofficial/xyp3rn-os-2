import { resolve } from 'node:path';
import type { VaultAuditLogger, VaultAuditOperation } from './audit.ts';
import { VaultPermissionError } from './errors.ts';
import {
  ALLOWED_VAULT_EXTENSIONS,
  CANONICAL_PATH_PREFIXES,
  IGNORED_VAULT_DIRS,
  OS3_VAULT_DIRS,
  VAULT_SECTORS,
} from './path-guard.ts';
import { resolveConfiguredVaultPath } from './vault-foundation.ts';

export type VaultOperationKind = VaultAuditOperation;

export type VaultPermissionContext = {
  readonly actor: string;
  readonly operation: VaultOperationKind;
  readonly vaultPath?: string | undefined;
  readonly sector?: string | undefined;
  readonly isCanonical?: boolean | undefined;
};

export type VaultPermissionDecision =
  | boolean
  | {
      readonly allowed: boolean;
      readonly reason?: string | undefined;
    };

export type VaultPermissionChecker = (ctx: VaultPermissionContext) => VaultPermissionDecision;

const MUTATING_OPERATIONS = new Set<VaultOperationKind>([
  'write',
  'update',
  'append',
  'link',
  'restore',
  'promote',
  'snapshot',
  'resolveConflict',
]);

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
  '10_DAW_BRAIN',
  '10_INBOX',
  '11_INBOX',
  '11_ARCHIVE',
  '12_ARCHIVE',
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
  readonly readOnly: boolean;
  readonly authorize: VaultPermissionChecker | undefined;
};

export type VaultEngineConfigInput = {
  readonly vaultRoot?: string | undefined;
  readonly writableSectors?: Iterable<string> | undefined;
  readonly canonicalPrefixes?: readonly string[] | undefined;
  readonly maxParseBytes?: number | undefined;
  readonly lockTtlMs?: number | undefined;
  readonly enforceSchemaOnWrite?: boolean | undefined;
  readonly enforceReferencesOnWrite?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly authorize?: VaultPermissionChecker | undefined;
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
    readOnly: input.readOnly ?? false,
    authorize: input.authorize,
  };
};

/**
 * Enforces Vault permission policies (`non-empty mutating actor`, `readOnly` mode,
 * and optional custom `authorize` ACL callback) and records denial in the Vault audit log.
 */
export const assertVaultPermission = (
  config: VaultEngineConfig,
  audit: VaultAuditLogger | undefined,
  ctx: VaultPermissionContext,
): void => {
  const deny = (reason: string): never => {
    audit?.record({
      actor: ctx.actor || 'anonymous',
      operation: ctx.operation,
      filePath: ctx.vaultPath ?? '(vault)',
      reason,
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw new VaultPermissionError('UNAUTHORIZED_ACTOR', reason, {
      vaultPath: ctx.vaultPath,
      details: { actor: ctx.actor, operation: ctx.operation, sector: ctx.sector },
    });
  };

  if (MUTATING_OPERATIONS.has(ctx.operation) && (!ctx.actor || ctx.actor.trim().length === 0)) {
    deny(`VaultEngine permission violation: operation "${ctx.operation}" requires a non-empty actor identity`);
  }

  if (MUTATING_OPERATIONS.has(ctx.operation) && config.readOnly) {
    deny(`VaultEngine read-only policy forbids "${ctx.operation}" on "${ctx.vaultPath ?? '(vault)'}"`);
  }

  if (config.authorize) {
    const decision = config.authorize(ctx);
    if (decision === false) {
      deny(`VaultEngine authorization policy denied "${ctx.actor}" for "${ctx.operation}" on "${ctx.vaultPath ?? '(vault)'}"`);
    }
    if (typeof decision === 'object' && !decision.allowed) {
      deny(
        decision.reason ??
          `VaultEngine authorization policy denied "${ctx.actor}" for "${ctx.operation}" on "${ctx.vaultPath ?? '(vault)'}"`,
      );
    }
  }
};

export { OS3_VAULT_DIRS, VAULT_SECTORS, resolveConfiguredVaultPath };
