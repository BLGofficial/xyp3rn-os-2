import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  provisionOs3Vault,
  RECOGNIZED_OS3_SCHEMAS,
  REQUIRED_OS3_VAULT_SUBDIRS,
  resolveConfiguredVaultPath,
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

  it('provisions and validates a complete, independent OS 3.0 Obsidian Vault from scratch', async () => {
    const vaultRoot = await makeTempVault();
    const provision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    expect(provision.createdDirs).toBeGreaterThanOrEqual(REQUIRED_OS3_VAULT_SUBDIRS.length);
    expect(provision.writtenFiles).toBeGreaterThanOrEqual(150);

    const validation = await validateOs3Vault(vaultRoot);
    expect(validation.ok).toBe(true);
    expect(validation.missingDirs).toEqual([]);
    expect(validation.checkedTemplates).toBe(20);
    expect(validation.invalidYamlFiles).toEqual([]);
    expect(validation.missingIdFiles).toEqual([]);
    expect(validation.duplicateIds).toEqual([]);
    expect(validation.unrecognizedSchemaFiles).toEqual([]);
    expect(validation.secretViolations).toEqual([]);
    expect(validation.obsidianConfigValid).toBe(true);
    expect(validation.checkedEntities).toBeGreaterThanOrEqual(150);

    // Idempotence check: second provision should report 0 newly written files
    const secondProvision = await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    expect(secondProvision.writtenFiles).toBe(0);
    expect(secondProvision.unchangedFiles).toBe(provision.writtenFiles);
  });

  it('rejects duplicate entity IDs, unrecognized schemas, and leaked API secrets during validation', async () => {
    const vaultRoot = await makeTempVault();
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    // 1. Inject duplicate ID + unrecognized schema + leaked secret into 10_INBOX
    const badNotePath = join(vaultRoot, '10_INBOX', 'BAD-NOTE.md');
    await writeFile(
      badNotePath,
      [
        '---',
        'schema: "xyp3rn.unknown/v99"',
        'id: "inbx-0001-welcome-inbox"',
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
    expect(report.duplicateIds.some((d) => d.id === 'inbx-0001-welcome-inbox')).toBe(true);
    expect(
      report.unrecognizedSchemaFiles.some(
        (u) => u.path === '10_INBOX/BAD-NOTE.md' && u.schema === 'xyp3rn.unknown/v99',
      ),
    ).toBe(true);
    expect(report.secretViolations.some((s) => s.path === '10_INBOX/BAD-NOTE.md')).toBe(true);
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
    expect(RECOGNIZED_OS3_SCHEMAS.length).toBe(20);
    expect(typeof resolveConfiguredVaultPath()).toBe('string');
  });
});
