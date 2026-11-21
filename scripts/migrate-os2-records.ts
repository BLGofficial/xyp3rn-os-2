import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openRuntimeDb } from '../core/sqlite/client.ts';
import { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault, resolveConfiguredVaultPath } from '../core/vault-engine/vault-foundation.ts';
import { DawMusicCatalogIntegrator } from '../records/daw-catalog-integration.ts';
import {
  formatRecordsMigrationReportMarkdown,
  migrateOs2RecordsAndMusicToOs3,
  verifyRecordsMusicParity,
} from '../records/migration/os2-records-migrator.ts';
import { Os3RecordsEngine } from '../records/os3-records-engine.ts';
import type { Os2FullRecordsMusicExport } from '../records/os3-records-types.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');

const argVal = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

const hasFlag = (flag: string): boolean => process.argv.includes(flag);

const vaultRoot = resolveConfiguredVaultPath(argVal('--vault'));
const exportPath = argVal('--export');
const scanLegacyDir = argVal('--scan-legacy-dir');
const reportOut = argVal('--report-out');
const dryRun = hasFlag('--dry-run');
const sqlitePath = resolve(process.env.XYP_SQLITE_PATH ?? join(REPO_ROOT, '.local-db', 'xyp3rn-os3.sqlite'));

const emptyPayload: Os2FullRecordsMusicExport = {
  exportedAt: new Date().toISOString(),
  sourceSystem: 'cli-scan-only',
  songs: [],
  lyricVersions: [],
  releases: [],
  tracks: [],
  splits: [],
};

const payload: Os2FullRecordsMusicExport = exportPath
  ? (JSON.parse(await fs.readFile(resolve(exportPath), 'utf8')) as Os2FullRecordsMusicExport)
  : emptyPayload;

if (!dryRun) {
  await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
}

const db = openRuntimeDb(dryRun ? ':memory:' : sqlitePath);
try {
  const vault = new VaultEngine({ vaultRoot, db });
  if (!dryRun) {
    await vault.scanVault({ full: true });
  }
  const engine = new Os3RecordsEngine({ vault, db });
  const integrator = new DawMusicCatalogIntegrator({ vault, db });
  const legacyDirs = scanLegacyDir
    ? [resolve(scanLegacyDir)]
    : [join(vaultRoot, '06_RECORDS'), join(vaultRoot, '09_X3LIUS_MUSIC')];

  const report = await migrateOs2RecordsAndMusicToOs3({
    payload,
    engine,
    integrator,
    vault,
    db,
    dryRun,
    legacyMarkdownRootDirs: legacyDirs,
  });

  const parity = dryRun ? undefined : await verifyRecordsMusicParity({ payload, engine, report, vault, db });
  const md = formatRecordsMigrationReportMarkdown(report, parity);

  if (reportOut) {
    await fs.writeFile(resolve(reportOut), md, 'utf8');
  }

  console.log(
    JSON.stringify(
      {
        ok: report.legacyDataUntouched && (parity ? parity.ok : true),
        dryRun,
        vaultRoot,
        totals: report.totals,
        legacyScan: {
          totalMarkdownFiles: report.legacyMarkdownScan.totalMarkdownFiles,
          validOs3Count: report.legacyMarkdownScan.validOs3Count,
          incompleteLegacyCount: report.legacyMarkdownScan.incompleteLegacyCount,
          invalidFrontmatterCount: report.legacyMarkdownScan.invalidFrontmatterCount,
        },
        parityOk: parity?.ok ?? null,
        discrepancies: parity?.discrepancies ?? [],
      },
      null,
      2,
    ),
  );
  if (parity && !parity.ok) process.exitCode = 1;
} finally {
  db.close();
}
