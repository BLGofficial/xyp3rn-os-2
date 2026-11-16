import { join, resolve } from 'node:path';
import { openRuntimeDb } from '../sqlite/client.ts';
import { bootstrapAndSyncVault } from './bootstrap.ts';
import { VaultEngine } from './engine.ts';
import { UI_SECTOR_RECONCILIATION } from './path-guard.ts';
import {
  provisionOs3Vault,
  resolveConfiguredVaultPath,
  validateAllTemplates,
  validateOs3Vault,
} from './vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_SQLITE = join(REPO_ROOT, '.local-db', 'xyp3rn-os3.sqlite');

const USAGE = `usage: vault-os3 provision | validate | validate-templates | reconcile | init | scan [--full] | status | search "<query>"`;

const vaultRoot = resolveConfiguredVaultPath();
const sqlitePath = resolve(process.env.XYP_SQLITE_PATH ?? DEFAULT_SQLITE);

const [cmd, ...rest] = process.argv.slice(2);

if (
  !cmd ||
  !['provision', 'validate', 'validate-templates', 'reconcile', 'init', 'scan', 'status', 'search'].includes(cmd)
) {
  console.error(USAGE);
  process.exit(2);
}

const db = openRuntimeDb(sqlitePath);
const engine = new VaultEngine({ vaultRoot, db });

try {
  if (cmd === 'provision') {
    const provision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const validation = await validateOs3Vault(vaultRoot);
    const scan = await engine.scanVault({ full: rest.includes('--full') });
    const stats = db.getIndexStats();

    db.appendEvent({
      eventType: 'vault.provision',
      domain: 'CORE',
      actor: 'vault-os3-cli',
      targetPath: vaultRoot,
      payload: { provision, validationOk: validation.ok, scan, stats },
    });

    console.log(
      JSON.stringify(
        {
          ok: validation.ok,
          vaultRoot: provision.vaultRoot,
          sqlitePath,
          provision,
          validation,
          scan,
          indexStats: stats,
        },
        null,
        2,
      ),
    );
    if (!validation.ok) process.exit(1);
  } else if (cmd === 'validate') {
    const validation = await validateOs3Vault(vaultRoot);
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.ok) process.exit(1);
  } else if (cmd === 'validate-templates') {
    const report = await validateAllTemplates(vaultRoot);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  } else if (cmd === 'reconcile') {
    console.log(JSON.stringify({ ok: true, uiSixSectorMapping: UI_SECTOR_RECONCILIATION }, null, 2));
  } else if (cmd === 'init') {
    const provision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const report = await bootstrapAndSyncVault({
      vaultRoot,
      repoRoot: REPO_ROOT,
      seedVaultRoot: process.env.XYP_SEED_VAULT_PATH,
    });
    const scan = await engine.scanVault({ full: rest.includes('--full') });
    const stats = db.getIndexStats();

    db.appendEvent({
      eventType: 'vault.bootstrap',
      domain: 'CORE',
      actor: 'vault-os3-cli',
      targetPath: vaultRoot,
      payload: { provision, report, scan, stats },
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          vaultRoot: report.vaultRoot,
          sqlitePath,
          provision,
          bootstrap: report,
          scan,
          indexStats: stats,
        },
        null,
        2,
      ),
    );
  } else if (cmd === 'scan') {
    const scan = await engine.scanVault({ full: rest.includes('--full') });
    const stats = db.getIndexStats();
    console.log(JSON.stringify({ ok: true, vaultRoot, sqlitePath, scan, indexStats: stats }, null, 2));
  } else if (cmd === 'status') {
    const stats = db.getIndexStats();
    const lastScan = db.getIndexMeta('last_scan');
    const pendingApprovals = db.listApprovals('pending').length;
    const recentEvents = db.listEvents({ limit: 5 });
    console.log(
      JSON.stringify(
        {
          ok: true,
          vaultRoot,
          sqlitePath,
          indexStats: stats,
          lastScan,
          pendingApprovals,
          recentEvents,
        },
        null,
        2,
      ),
    );
  } else if (cmd === 'search') {
    const query = rest.join(' ').trim();
    if (!query) {
      console.error('search requires a query string');
      process.exit(2);
    }
    const hits = engine.search(query, { limit: 20 });
    console.log(
      JSON.stringify(
        {
          ok: true,
          query,
          count: hits.length,
          hits: hits.map((h) => ({
            vaultPath: h.vaultPath,
            sector: h.sector,
            title: h.title,
            tags: h.tags,
            wikilinksCount: h.wikilinks.length,
          })),
        },
        null,
        2,
      ),
    );
  }
} finally {
  db.close();
}
