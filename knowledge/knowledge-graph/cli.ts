import { join } from 'node:path';
import { connect } from '../../core/db/client.ts';
import { createLocalVaultStore, defaultVaultDir } from '../source-registry/vault-store.ts';
import { scanRoots } from './scan.ts';
import { formatScan, formatStatus, indexStatus } from './status.ts';

// The file index (AOS-04 Plan C1):
//   pnpm index scan [--full]   scan this checkout (root id `repo`) and check the Vault's bytes; --full rehashes
//                              every file and re-reads every Vault file instead of trusting size and mtime
//   pnpm index status          the last scan, files by status, and the diagnostics count

const REPO_DIR = join(import.meta.dirname, '..', '..');
const USAGE = 'usage: pnpm index scan [--full] | status';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'scan' && cmd !== 'status') {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const sql = connect(undefined, { max: 2 });
  try {
    if (cmd === 'scan') {
      const r = await scanRoots(sql, { roots: [{ id: 'repo', dir: REPO_DIR }], trigger: 'cli', store: createLocalVaultStore(defaultVaultDir()), full: rest.includes('--full') });
      console.log(formatScan(r).join('\n'));
      if (r.status === 'error') process.exitCode = 1;
    } else {
      console.log(formatStatus(await indexStatus(sql)).join('\n'));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
