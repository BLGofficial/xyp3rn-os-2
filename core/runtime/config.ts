import { join, resolve } from 'node:path';
import { resolveConfiguredVaultPath } from '../vault-engine/vault-foundation.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type Os3RuntimeConfig = {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly vaultRoot: string;
  readonly sqlitePath: string;
  readonly backupDir: string;
  readonly repoRoot: string;
  readonly logLevel: LogLevel;
  readonly lockTtlMs: number;
  readonly gracefulShutdownTimeoutMs: number;
  readonly configuredProviders: {
    readonly openrouter: boolean;
    readonly anthropic: boolean;
    readonly groq: boolean;
  };
};

export type Os3RuntimeConfigOverrides = {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly vaultRoot?: string | undefined;
  readonly sqlitePath?: string | undefined;
  readonly backupDir?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly logLevel?: LogLevel | undefined;
  readonly lockTtlMs?: number | undefined;
  readonly gracefulShutdownTimeoutMs?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
};

/**
 * Loads and validates the explicit XYP3RN OS 3.0 Local Runtime configuration.
 * - Strictly enforces `127.0.0.1` localhost binding.
 * - Requires zero PostgreSQL or Supabase configuration.
 * - Keeps API secrets in process memory only (exposing only boolean presence flags).
 */
export const loadOs3RuntimeConfig = (
  overrides: Os3RuntimeConfigOverrides = {},
): Os3RuntimeConfig => {
  const env = overrides.env ?? process.env;
  const rawHost = (overrides.host ?? env.XYP_GATEWAY_HOST ?? '127.0.0.1').trim();

  if (rawHost !== '127.0.0.1' && rawHost !== 'localhost') {
    throw new Error(
      `OS 3.0 Runtime security violation: local server must bind strictly to 127.0.0.1 (refused "${rawHost}")`,
    );
  }

  const rawPort = overrides.port ?? Number(env.XYP_GATEWAY_PORT ?? 8077);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new Error(`Invalid OS 3.0 Runtime port: ${String(rawPort)}`);
  }

  const repoRoot = resolve(overrides.repoRoot ?? process.cwd());
  const vaultRoot = resolveConfiguredVaultPath(
    overrides.vaultRoot ?? env.OBSIDIAN_VAULT_PATH ?? env.XYP_OBSIDIAN_VAULT,
  );
  const sqlitePath =
    overrides.sqlitePath === ':memory:'
      ? ':memory:'
      : resolve(overrides.sqlitePath ?? env.XYP_SQLITE_PATH ?? join(repoRoot, '.local-db', 'xyp3rn-os3.sqlite'));
  const backupDir = resolve(
    overrides.backupDir ?? env.XYP_BACKUP_DIR ?? join(repoRoot, '.local-db', 'backups'),
  );

  const rawLevel = (overrides.logLevel ?? env.XYP_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel: LogLevel =
    rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error' || rawLevel === 'silent'
      ? rawLevel
      : 'info';

  return {
    host: '127.0.0.1',
    port: rawPort,
    vaultRoot,
    sqlitePath,
    backupDir,
    repoRoot,
    logLevel,
    lockTtlMs: overrides.lockTtlMs ?? 15_000,
    gracefulShutdownTimeoutMs: overrides.gracefulShutdownTimeoutMs ?? 5_000,
    configuredProviders: {
      openrouter: Boolean(env.OPENROUTER_API_KEY?.trim()),
      anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      groq: Boolean(env.GROQ_API_KEY?.trim()),
    },
  };
};
