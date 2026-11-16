import { join, resolve } from 'node:path';
import { openRuntimeDb } from '../sqlite/client.ts';
import { VaultEngine } from '../vault-engine/engine.ts';
import { resolveConfiguredVaultPath } from '../vault-engine/vault-foundation.ts';
import { Os3JarvisRuntime } from './jarvis-runtime.ts';
import { DEFAULT_GATEWAY_HOST, DEFAULT_GATEWAY_PORT, startOs3GatewayServer } from './server.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_SQLITE = join(REPO_ROOT, '.local-db', 'xyp3rn-os3.sqlite');

const vaultRoot = resolveConfiguredVaultPath();
const sqlitePath = resolve(process.env.XYP_SQLITE_PATH ?? DEFAULT_SQLITE);
const port = Number(process.env.XYP_GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;

const db = openRuntimeDb(sqlitePath);
const vault = new VaultEngine({ vaultRoot, db });
const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

const handle = await startOs3GatewayServer(runtime, {
  host: DEFAULT_GATEWAY_HOST,
  port,
});

const stats = db.getIndexStats();
console.log(
  `xyp3rn-os3-gateway listening on ${handle.url} (vault: ${vaultRoot} · ${stats.totalFiles} indexed files · ${runtime.agents.list().length} agents)`,
);

const shutdown = async (): Promise<void> => {
  await handle.close().catch(() => undefined);
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
