import { resolve } from 'node:path';
import { loadOs3RuntimeConfig } from '../runtime/config.ts';
import { preflightOs3ReleaseRuntime } from '../runtime/release-startup.ts';
import { openRuntimeDb } from '../sqlite/client.ts';
import { VaultEngine } from '../vault-engine/engine.ts';
import { Os3JarvisRuntime } from './jarvis-runtime.ts';
import { startOs3GatewayServer } from './server.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const config = loadOs3RuntimeConfig({ repoRoot: REPO_ROOT });

const db = openRuntimeDb(config.sqlitePath);
const preflight = preflightOs3ReleaseRuntime(db, {
  repoRoot: REPO_ROOT,
  host: config.host,
  port: config.port,
  vaultRoot: config.vaultRoot,
  sqlitePath: config.sqlitePath,
});

const vault = new VaultEngine({ vaultRoot: config.vaultRoot, db });
const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

const handle = await startOs3GatewayServer(runtime, {
  host: config.host,
  port: config.port,
  dawBrainEnabled: preflight.dawBrainEnabled,
  enforceSingletonLock: true,
  recoverInterruptedOnBoot: false, // already recovered in preflight
});

const stats = db.getIndexStats();
console.log(
  `xyp3rn-os3-gateway listening on ${handle.url} (vault: ${config.vaultRoot} [${preflight.vaultAvailability.mode}] · ${stats.totalFiles} indexed files · ${runtime.agents.list().length} agents · dawBrain=${preflight.dawBrainEnabled ? 'enabled' : 'disabled'})`,
);

const shutdown = async (): Promise<void> => {
  await handle.close().catch(() => undefined);
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
