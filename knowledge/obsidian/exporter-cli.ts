import { resolve } from 'node:path';
import { connect } from '../../core/db/client.ts';
import { ObsidianExporterService } from './exporter.ts';

// Usage: pnpm obsidian:export   (vault: OBSIDIAN_VAULT_PATH, else XYP_OBSIDIAN_VAULT, else ./obsidian)
// Writes every owner-approved lyric version to <vault>/canonical/lyrics/ as a read-only (0444) note.

const vault = resolve(process.env.OBSIDIAN_VAULT_PATH ?? process.env.XYP_OBSIDIAN_VAULT ?? './obsidian');
const sql = connect();
try {
  const results = await new ObsidianExporterService(vault).exportAllApproved(sql);
  for (const r of results) console.log(`${r.result.padEnd(9)} ${r.path}`);
  console.log(`obsidian-export: ${results.filter((r) => r.result === 'written').length} written, ${results.filter((r) => r.result === 'unchanged').length} unchanged`);
} catch (e) {
  console.error(`obsidian-export: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
