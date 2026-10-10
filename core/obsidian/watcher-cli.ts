import { resolve } from 'node:path';
import { ObsidianWatcherService } from '../../knowledge/obsidian/watcher.ts';
import { connect } from '../db/client.ts';

// Usage: pnpm obsidian:watch   (vault: OBSIDIAN_VAULT_PATH, else XYP_OBSIDIAN_VAULT, else ./obsidian)
// Stages edits from obsidian/{inbox,research,creative} as 'pending_approval'; the Promotion Gate decides the rest.

const vault = resolve(process.env.OBSIDIAN_VAULT_PATH ?? process.env.XYP_OBSIDIAN_VAULT ?? './obsidian');
const sql = connect();
const service = new ObsidianWatcherService(sql, vault);
await service.start();
console.log(`obsidian-watch: watching ${vault} (Ctrl+C to stop)`);

const shutdown = async (): Promise<void> => {
  await service.stop();
  await sql.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
