import { join } from 'node:path';
import type { Sql } from '../../../core/db/client.ts';
import { scanRoots, type ScanResult } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore, defaultVaultDir } from '../../../knowledge/source-registry/vault-store.ts';

/**
 * The web server's index writes (AOS-04 Plan C1): the scan at boot and the owner's Rescan on /system. Both scan
 * this checkout (root id `repo`) as xyp_indexer and check the Vault's bytes, as `pnpm index scan` does.
 */

const REPO_DIR = join(import.meta.dirname, '..', '..', '..');

/**
 * @param sql - the app's pool
 * @param trigger - `boot` (instrumentation) or `owner` (Rescan)
 * @param full - rehash everything instead of trusting size and mtime
 * @returns the sealed scan
 */
export const scanIndex = (sql: Sql, trigger: 'boot' | 'owner', full = false): Promise<ScanResult> =>
  scanRoots(sql, { roots: [{ id: 'repo', dir: REPO_DIR }], trigger, store: createLocalVaultStore(defaultVaultDir()), full });
