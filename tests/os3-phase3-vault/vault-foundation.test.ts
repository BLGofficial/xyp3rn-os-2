import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDb } from '../../core/sqlite/client.ts';
import {
  archiveVaultNote,
  OS3_VAULT_DIRS,
  supersedeVaultNote,
  UI_SECTOR_RECONCILIATION,
  VaultEngine,
} from '../../core/vault-engine/engine.ts';
import { validateEntityContent } from '../../core/vault-engine/schema-validator.ts';
import {
  provisionOs3Vault,
  RECOGNIZED_OS3_SCHEMAS,
  REQUIRED_OS3_VAULT_SUBDIRS,
  resolveConfiguredVaultPath,
  validateAllTemplates,
  validateOs3Vault,
} from '../../core/vault-engine/vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 3 — XYP3RN OS 3.0 Obsidian Vault Foundation', () => {
  const tempDirs: string[] = [];

  const makeTempVault = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-vault-test-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it('provisions all 14 sectors, 32 templates/schemas, and validates cleanly from scratch', async () => {
    const vaultRoot = await makeTempVault();
    const provision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    expect(OS3_VAULT_DIRS.length).toBe(14);
    expect(provision.createdDirs).toBeGreaterThanOrEqual(REQUIRED_OS3_VAULT_SUBDIRS.length);
    expect(provision.writtenFiles).toBeGreaterThanOrEqual(170);

    for (const topDir of OS3_VAULT_DIRS) {
      const st = await stat(join(vaultRoot, topDir));
      expect(st.isDirectory()).toBe(true);
    }

    const templateReport = await validateAllTemplates(vaultRoot);
    expect(templateReport.ok).toBe(true);
    expect(templateReport.checkedTemplates).toBe(32);
    expect(templateReport.missingTemplates).toEqual([]);
    expect(templateReport.failures).toEqual([]);

    const validation = await validateOs3Vault(vaultRoot);
    expect(validation.ok).toBe(true);
    expect(validation.missingDirs).toEqual([]);
    expect(validation.checkedTemplates).toBe(32);
    expect(validation.invalidYamlFiles).toEqual([]);
    expect(validation.missingIdFiles).toEqual([]);
    expect(validation.duplicateIds).toEqual([]);
    expect(validation.unrecognizedSchemaFiles).toEqual([]);
    expect(validation.invalidMetadataFiles).toEqual([]);
    expect(validation.secretViolations).toEqual([]);
    expect(validation.obsidianConfigValid).toBe(true);
    expect(validation.checkedEntities).toBeGreaterThanOrEqual(170);

    // Idempotence check: second provision should report 0 newly written files
    const secondProvision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    expect(secondProvision.writtenFiles).toBe(0);
    expect(secondProvision.unchangedFiles).toBe(provision.writtenFiles);
  });

  it('reconciles the 6 UI-xyp3rn Constellation sectors without merging research sources with tech or DAW Brain', () => {
    const uiSectors = Object.keys(UI_SECTOR_RECONCILIATION);
    expect(uiSectors).toEqual([
      '01_CORE',
      '02_KNOWLEDGE_LAYER',
      '03_RESEARCH_INTELLIGENCE',
      '04_RESEARCH_MATERIAL',
      '05_XYP3RN_RECORDS',
      '06_GOVERNANCE',
    ]);
    expect(UI_SECTOR_RECONCILIATION['04_RESEARCH_MATERIAL'].mappedVaultDirs).not.toContain('07_TECH');
    expect(UI_SECTOR_RECONCILIATION['04_RESEARCH_MATERIAL'].mappedVaultDirs).not.toContain('10_DAW_BRAIN');
    expect(UI_SECTOR_RECONCILIATION['05_XYP3RN_RECORDS'].mappedVaultDirs).toContain('09_X3LIUS_MUSIC');
    expect(UI_SECTOR_RECONCILIATION['05_XYP3RN_RECORDS'].mappedVaultDirs).toContain('10_DAW_BRAIN');
    expect(UI_SECTOR_RECONCILIATION['06_GOVERNANCE'].mappedVaultDirs).toContain('12_ARCHIVE');
  });

  it('rejects duplicate entity IDs, unrecognized schemas, and leaked API secrets during validation', async () => {
    const vaultRoot = await makeTempVault();
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    // Inject duplicate ID + unrecognized schema + leaked secret into 11_INBOX
    const badNotePath = join(vaultRoot, '11_INBOX', 'BAD-NOTE.md');
    await writeFile(
      badNotePath,
      [
        '---',
        'schema: "xyp3rn.unknown/v99"',
        'id: "inbx-0002-os3-inbox-staging"',
        'title: "Bad Note"',
        '---',
        '',
        'Leaked key: sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = await validateOs3Vault(vaultRoot);
    expect(report.ok).toBe(false);
    expect(report.duplicateIds.some((d) => d.id === 'inbx-0002-os3-inbox-staging')).toBe(true);
    expect(
      report.unrecognizedSchemaFiles.some(
        (u) => u.path === '11_INBOX/BAD-NOTE.md' && u.schema === 'xyp3rn.unknown/v99',
      ),
    ).toBe(true);
    expect(report.secretViolations.some((s) => s.path === '11_INBOX/BAD-NOTE.md')).toBe(true);
  });

  it('enforces document-specific metadata, provenance, and archive/supersession validation rules', () => {
    const badMixRef = [
      '---',
      'schema: "xyp3rn.mix-reference/v3"',
      'id: "mix-bad-001"',
      'title: "Broken Mix Reference"',
      'domain: "RECORDS"',
      'sector: "10_DAW_BRAIN"',
      'status: "draft"',
      'version: 1',
      'provenance: "operator-test"',
      'created_at: "2026-11-16T00:00:00.000Z"',
      'updated_at: "2026-11-16T00:00:00.000Z"',
      'stage: "master"',
      'target_lufs_min: -8.0',
      'target_lufs_max: -14.0',
      'max_true_peak_dbtp: 1.5',
      '---',
      '',
      'Invalid loudness bounds.',
    ].join('\n');
    const mixRes = validateEntityContent('10_DAW_BRAIN/MIX_MASTER_REFS/BAD.md', badMixRef, { requireSchema: true });
    expect(mixRes.ok).toBe(false);
    expect(mixRes.issues.some((i) => i.field === 'target_lufs_min')).toBe(true);
    expect(mixRes.issues.some((i) => i.field === 'max_true_peak_dbtp')).toBe(true);

    const missingProvPrompt = [
      '---',
      'schema: "xyp3rn.canonical-prompt/v3"',
      'id: "prm-bad-001"',
      'title: "Prompt Without Provenance"',
      'domain: "KNOWLEDGE"',
      'sector: "02_KNOWLEDGE"',
      'status: "canonical"',
      'version: 1',
      'model_scope: "suno-v6"',
      'promoted_via: "gate"',
      'prompt_text: "dark drill"',
      '---',
      '',
      'Missing provenance.',
    ].join('\n');
    const promptRes = validateEntityContent('02_KNOWLEDGE/PROMPT_LIBRARY/BAD.md', missingProvPrompt, {
      requireSchema: true,
    });
    expect(promptRes.ok).toBe(false);
    expect(promptRes.issues.some((i) => i.code === 'INVALID_METADATA' && i.field === 'provenance')).toBe(true);

    const badSuperseded = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-superseded-bad"',
      'title: "Missing Superseded Metadata"',
      'domain: "CORE"',
      'sector: "11_INBOX"',
      'status: "superseded"',
      'version: 1',
      '---',
      '',
      'Missing superseded_by and superseded_at.',
    ].join('\n');
    const supRes = validateEntityContent('11_INBOX/BAD-SUP.md', badSuperseded, { requireSchema: true });
    expect(supRes.ok).toBe(false);
    expect(supRes.issues.some((i) => i.code === 'INVALID_ARCHIVE_OR_SUPERSESSION')).toBe(true);
  });

  it('never silently overwrites existing files and preserves legacy 10_INBOX / 11_ARCHIVE without auto-migration', async () => {
    const vaultRoot = await makeTempVault();
    await mkdir(join(vaultRoot, '10_INBOX'), { recursive: true });
    await mkdir(join(vaultRoot, '11_ARCHIVE'), { recursive: true });
    await mkdir(join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'), { recursive: true });

    const legacyInboxContent = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "inbx-0001-welcome-inbox"',
      'type: "entity"',
      'title: "Legacy Inbox Note"',
      'domain: "CORE"',
      'sector: "10_INBOX"',
      'status: "draft"',
      'version: 1',
      'tags: ["legacy"]',
      '---',
      '',
      'Operator custom legacy inbox note — must never be overwritten or auto-migrated.',
      '',
    ].join('\n');
    const legacyArchiveContent = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "arch-0001-archive-index"',
      'type: "entity"',
      'title: "Archive Index"',
      'domain: "CORE"',
      'sector: "11_ARCHIVE"',
      'status: "archived"',
      'version: 1',
      'tags: ["legacy"]',
      '---',
      '',
      'Pre-existing archive index without archive_reason.',
      '',
    ].join('\n');
    const customWorkflowYaml = 'name: custom-preserved-workflow\nsteps: []\n';

    await writeFile(join(vaultRoot, '10_INBOX', 'INBX-0001-Welcome-Inbox-Note.md'), legacyInboxContent, 'utf8');
    await writeFile(join(vaultRoot, '11_ARCHIVE', 'ARCH-0001-Archive-Index.md'), legacyArchiveContent, 'utf8');
    await writeFile(
      join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS', 'retrieve-and-summarize.workflow.yaml'),
      customWorkflowYaml,
      'utf8',
    );

    const report = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    expect(report.unchangedFiles).toBeGreaterThanOrEqual(1);

    // Modify newly provisioned file & re-provision -> must preserve user bytes cleanly
    const inboxV2Path = join(vaultRoot, '11_INBOX', 'INBX-0002-OS3-Inbox-Staging.md');
    const originalInboxV2 = await readFile(inboxV2Path, 'utf8');
    const modifiedInboxV2 = `${originalInboxV2}\n## Operator Custom Marker\nKEEP_ME_UNTOUCHED\n`;
    await writeFile(inboxV2Path, modifiedInboxV2, 'utf8');

    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    expect(await readFile(join(vaultRoot, '10_INBOX', 'INBX-0001-Welcome-Inbox-Note.md'), 'utf8')).toBe(
      legacyInboxContent,
    );
    expect(await readFile(join(vaultRoot, '11_ARCHIVE', 'ARCH-0001-Archive-Index.md'), 'utf8')).toBe(
      legacyArchiveContent,
    );
    expect(
      await readFile(join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS', 'retrieve-and-summarize.workflow.yaml'), 'utf8'),
    ).toBe(customWorkflowYaml);
    expect(await readFile(inboxV2Path, 'utf8')).toBe(modifiedInboxV2);

    const validation = await validateOs3Vault(vaultRoot);
    expect(validation.ok).toBe(true);
  });

  it('supports explicit non-destructive archive and supersession via VaultEngine', async () => {
    const vaultRoot = await makeTempVault();
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(':memory:');
    try {
      const vault = new VaultEngine({ vaultRoot, db });
      const workingPath = '11_INBOX/WORK-NOTE-001.md';
      await vault.writeNote({
        vaultPath: workingPath,
        content: [
          '---',
          'schema: "xyp3rn.entity/v3"',
          'id: "work-note-001"',
          'type: "entity"',
          'title: "Working Note"',
          'domain: "CORE"',
          'sector: "11_INBOX"',
          'status: "draft"',
          'version: 1',
          'provenance: "operator-draft"',
          'created_at: "2026-11-16T00:00:00.000Z"',
          'updated_at: "2026-11-16T00:00:00.000Z"',
          'tags: ["draft"]',
          '---',
          '',
          'Initial draft note.',
        ].join('\n'),
        actor: 'operator',
        reason: 'Create working draft',
        writeMode: 'no-overwrite',
        validateSchema: true,
      });

      const supResult = await supersedeVaultNote(vault, {
        priorVaultPath: workingPath,
        supersededByIdOrPath: 'work-note-002',
        reason: 'Replaced by v2 note',
        actor: 'operator',
      });

      expect(supResult.archivedCopyPath.startsWith('12_ARCHIVE/SUPERSEDED/')).toBe(true);
      const updatedPrior = await vault.readNote(workingPath);
      expect(updatedPrior.frontmatter.status).toBe('superseded');
      expect(updatedPrior.frontmatter.superseded_by).toBe('work-note-002');
      expect(typeof updatedPrior.frontmatter.superseded_at).toBe('string');

      // Separate non-canonical note explicit archival
      const retirePath = '11_INBOX/RETIRE-NOTE-001.md';
      await vault.writeNote({
        vaultPath: retirePath,
        content: [
          '---',
          'schema: "xyp3rn.entity/v3"',
          'id: "retire-note-001"',
          'type: "entity"',
          'title: "Retire Note"',
          'domain: "CORE"',
          'sector: "11_INBOX"',
          'status: "draft"',
          'version: 1',
          'tags: ["draft"]',
          '---',
          '',
          'Candidate for archival.',
        ].join('\n'),
        actor: 'operator',
        reason: 'Create retire note',
        writeMode: 'no-overwrite',
        validateSchema: true,
      });

      const archResult = await archiveVaultNote(vault, {
        sourceVaultPath: retirePath,
        reason: 'Experiment concluded cleanly',
        actor: 'operator',
        targetSubdir: 'RETIRED',
      });
      expect(archResult.archivedPath.startsWith('12_ARCHIVE/RETIRED/')).toBe(true);
      const archivedDoc = await vault.readNote(archResult.archivedPath);
      expect(archivedDoc.frontmatter.status).toBe('archived');
      expect(archivedDoc.frontmatter.archive_reason).toBe('Experiment concluded cleanly');

      // Canonical notes reject direct archive/supersede bypass outside Promotion Gate
      await expect(
        archiveVaultNote(vault, {
          sourceVaultPath: '08_GOVERNANCE/POLICIES/POL-0001-Localhost-Binding-and-Path-Safety.md',
          reason: 'Should fail on canonical',
          actor: 'operator',
        }),
      ).rejects.toThrow();

      const finalValidation = await validateOs3Vault(vaultRoot);
      expect(finalValidation.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it('contains zero hardcoded machine-specific paths (Users/blago) in OS 3.0 runtime modules and scripts', async () => {
    const dirsToCheck = [
      join(REPO_ROOT, 'core', 'vault-engine'),
      join(REPO_ROOT, 'core', 'gateway'),
      join(REPO_ROOT, 'core', 'sqlite'),
      join(REPO_ROOT, 'scripts'),
    ];

    const violations: string[] = [];
    for (const dir of dirsToCheck) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(ts|js|ps1|sh)$/.test(entry.name)) continue;
        const abs = join(dir, entry.name);
        const content = await readFile(abs, 'utf8');
        if (/Users[\\/]+blago/i.test(content)) {
          violations.push(abs);
        }
      }
    }

    expect(violations).toEqual([]);
    expect(RECOGNIZED_OS3_SCHEMAS.length).toBe(32);
    expect(typeof resolveConfiguredVaultPath()).toBe('string');
  });
});
