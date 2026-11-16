import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault, CANONICAL_SECTOR_DIRS } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('OS 3.0 Phase 2 — Canonical Obsidian Vault Bootstrap & Sync', () => {
  let tempVault: string;
  let tempSeed: string;
  let db: SqliteRuntimeDb;
  let engine: VaultEngine;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-vault-p2-'));
    tempSeed = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-seed-p2-'));
    db = openRuntimeDb(':memory:');
    engine = new VaultEngine({ vaultRoot: tempVault, db });
  });

  afterEach(async () => {
    db.close();
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined);
    await rm(tempSeed, { recursive: true, force: true }).catch(() => undefined);
  });

  it('creates all 6-sector directories, preserves existing notes, syncs 52 agents + 7 workflows + manifests, and is idempotent', async () => {
    // Pre-existing note in the target Vault must never be overwritten by seed
    await mkdir(join(tempVault, '01_CORE', '00_Identity'), { recursive: true });
    await writeFile(
      join(tempVault, '01_CORE', '00_Identity', 'Mission.md'),
      '# Custom Owner Mission\n\nPreserve me.\n',
      'utf8',
    );

    // Seed vault has both Mission.md (should be skipped) and Jarvis.md (should be copied)
    await mkdir(join(tempSeed, '01_CORE', '00_Identity'), { recursive: true });
    await writeFile(
      join(tempSeed, '01_CORE', '00_Identity', 'Mission.md'),
      '# Seed Mission\n\nDo not overwrite owner.\n',
      'utf8',
    );
    await mkdir(join(tempSeed, '01_CORE', '07_Tools'), { recursive: true });
    await writeFile(
      join(tempSeed, '01_CORE', '07_Tools', 'vault.write.md'),
      '# vault.write\n\nNo-overwrite guard tool spec.\n',
      'utf8',
    );

    const firstRun = await bootstrapAndSyncVault({
      vaultRoot: tempVault,
      repoRoot: REPO_ROOT,
      seedVaultRoot: tempSeed,
      uiMapPath: join(tempSeed, 'no-map.ts'),
    });

    expect(firstRun.createdDirs).toBeGreaterThanOrEqual(CANONICAL_SECTOR_DIRS.length - 1);
    expect(firstRun.syncedAgents).toBe(52);
    expect(firstRun.syncedWorkflows).toBe(7);
    expect(firstRun.syncedManifests).toBe(4);
    expect(firstRun.syncedGovernanceDocs).toBe(4);
    expect(firstRun.importedSeedNotes).toBe(1);

    // Verify owner's pre-existing Mission.md was preserved untouched
    const missionText = await readFile(join(tempVault, '01_CORE', '00_Identity', 'Mission.md'), 'utf8');
    expect(missionText).toContain('Custom Owner Mission');

    // Second run is 100% idempotent
    const secondRun = await bootstrapAndSyncVault({
      vaultRoot: tempVault,
      repoRoot: REPO_ROOT,
      seedVaultRoot: tempSeed,
      uiMapPath: join(tempSeed, 'no-map.ts'),
    });
    expect(secondRun.createdDirs).toBe(0);
    expect(secondRun.syncedAgents).toBe(0);
    expect(secondRun.syncedWorkflows).toBe(0);
    expect(secondRun.syncedManifests).toBe(0);
    expect(secondRun.syncedGovernanceDocs).toBe(0);
    expect(secondRun.importedSeedNotes).toBe(0);
    expect(secondRun.unchangedFiles).toBeGreaterThan(60);

    // Structural scan indexes all synced sectors cleanly
    const scan = await engine.scanVault();
    expect(scan.errors).toEqual([]);
    const stats = db.getIndexStats();
    expect(stats.bySector['01_CORE']).toBeGreaterThanOrEqual(52 + 14 + 2);
    expect(stats.bySector['02_KNOWLEDGE_LAYER']).toBeGreaterThanOrEqual(2);
    expect(stats.bySector['03_RESEARCH_INTELLIGENCE']).toBeGreaterThanOrEqual(20);
    expect(stats.bySector['05_XYP3RN_RECORDS']).toBeGreaterThanOrEqual(2);
    expect(stats.bySector['06_GOVERNANCE']).toBeGreaterThanOrEqual(4);
  });
});
