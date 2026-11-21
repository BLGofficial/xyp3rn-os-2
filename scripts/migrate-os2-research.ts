import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openRuntimeDb } from '../core/sqlite/client.ts';
import { provisionOs3Vault, resolveConfiguredVaultPath } from '../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import {
  formatResearchMigrationReportMarkdown,
  migrateOs2ResearchToOs3,
  verifyResearchMigrationParity,
} from '../research-intelligence/migration/os2-migrator.ts';
import { Os3ResearchEngine } from '../research-intelligence/os3-research-engine.ts';
import type { Os2ResearchExportPayload } from '../research-intelligence/os3-research-types.ts';

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
const stageLegacyMd = hasFlag('--stage-legacy-md');
const sqlitePath = resolve(process.env.XYP_SQLITE_PATH ?? join(REPO_ROOT, '.local-db', 'xyp3rn-os3.sqlite'));

const emptyPayload: Os2ResearchExportPayload = {
  exportedAt: new Date().toISOString(),
  sourceSystem: 'cli-scan-only',
  projects: [],
  questions: [],
  runs: [],
  sources: [],
  evidence: [],
  findings: [],
  contradictions: [],
  experiments: [],
  experimentRuns: [],
};

const payload: Os2ResearchExportPayload = exportPath
  ? (JSON.parse(await fs.readFile(resolve(exportPath), 'utf8')) as Os2ResearchExportPayload)
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
  const research = new Os3ResearchEngine({ vault, db });
  const legacyDirs = scanLegacyDir ? [resolve(scanLegacyDir)] : [join(vaultRoot, '03_RESEARCH_INTELLIGENCE')];

  const report = await migrateOs2ResearchToOs3({
    payload,
    vault,
    db,
    research,
    dryRun,
    legacyMarkdownRootDirs: legacyDirs,
    stageIncompleteLegacyMarkdown: stageLegacyMd,
  });

  const parity = dryRun
    ? undefined
    : await verifyResearchMigrationParity({ payload, report, vault, db });
  const md = formatResearchMigrationReportMarkdown(report, parity);

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
