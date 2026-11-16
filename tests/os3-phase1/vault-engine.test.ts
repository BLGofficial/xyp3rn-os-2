import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';
import { resolveNoOverwritePath, validateVaultPath } from '../../core/vault-engine/path-guard.ts';

describe('OS 3.0 Phase 1 — Vault Engine (core/vault-engine)', () => {
  let tempDir: string;
  let db: SqliteRuntimeDb;
  let engine: VaultEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'xyp3rn-vault-test-'));
    db = openRuntimeDb(':memory:');
    engine = new VaultEngine({ vaultRoot: tempDir, db });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('rejects path traversal, absolute paths, hidden segments, and disallowed extensions', () => {
    expect(validateVaultPath(tempDir, '../outside.md').ok).toBe(false);
    expect(validateVaultPath(tempDir, '/etc/passwd').ok).toBe(false);
    expect(validateVaultPath(tempDir, 'C:\\Windows\\system.ini').ok).toBe(false);
    expect(validateVaultPath(tempDir, '.obsidian/graph.json').ok).toBe(false);
    expect(validateVaultPath(tempDir, '01_CORE/.env').ok).toBe(false);
    expect(validateVaultPath(tempDir, '01_CORE/script.exe').ok).toBe(false);
    expect(validateVaultPath(tempDir, 'UNREGISTERED_SECTOR/note.md').ok).toBe(false);

    const valid = validateVaultPath(tempDir, '03_RESEARCH_INTELLIGENCE/00_Briefs/2026-11-16-suno.md');
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.sector).toBe('03_RESEARCH_INTELLIGENCE');
      expect(valid.isCanonical).toBe(false);
    }
  });

  it('computes numbered safe copies under the No-Overwrite Guard', () => {
    const existing = new Set([
      '05_XYP3RN_RECORDS/00_Daily_Notes/Session.md',
      '05_XYP3RN_RECORDS/00_Daily_Notes/Session (2).md',
    ]);
    expect(
      resolveNoOverwritePath('05_XYP3RN_RECORDS/00_Daily_Notes/Session.md', existing),
    ).toBe('05_XYP3RN_RECORDS/00_Daily_Notes/Session (3).md');
  });

  it('writes non-canonical notes atomically, archives immutable revisions, and preserves files via No-Overwrite Guard', async () => {
    const first = await engine.writeNote({
      vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/Drill-Sub-Bass.md',
      content: '---\ntitle: Drill Sub Bass\ntags: [drill, 808]\n---\n\n# Drill Sub Bass\n\nSee [[808 Saturation]].\n',
      actor: 'research-orchestrator',
    });

    expect(first.createdCopy).toBe(false);
    expect(first.vaultPath).toBe('03_RESEARCH_INTELLIGENCE/00_Briefs/Drill-Sub-Bass.md');

    // Second write in default no-overwrite mode creates (2) copy without touching original
    const second = await engine.writeNote({
      vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/Drill-Sub-Bass.md',
      content: '# Updated Brief\n\nSecond pass.\n',
      actor: 'research-orchestrator',
    });

    expect(second.createdCopy).toBe(true);
    expect(second.vaultPath).toBe('03_RESEARCH_INTELLIGENCE/00_Briefs/Drill-Sub-Bass (2).md');

    const readOriginal = await engine.readNote(first.vaultPath);
    expect(readOriginal.sha256).toBe(first.sha256);
    expect(readOriginal.frontmatter.tags).toEqual(['drill', '808']);
    expect(readOriginal.wikilinks.map((w) => w.target)).toEqual(['808 Saturation']);

    // Revision archive holds exact text for both versions
    const archivedFirst = await engine.revisions.readRevisionText(first.sha256);
    expect(archivedFirst).toBe(readOriginal.rawContent);
  });

  it('detects compare-and-swap conflicts and refuses to overwrite user edits', async () => {
    const initial = await engine.writeNote({
      vaultPath: '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/01_Lyrics/Neon-Static.md',
      content: '# Neon Static\n\nVerse 1 draft.\n',
      actor: 'x3lius-lyrics',
    });

    // Stale expectedSha256 is rejected and logged
    await expect(
      engine.writeNote({
        vaultPath: initial.vaultPath,
        content: '# Neon Static\n\nOverwritten verse.\n',
        actor: 'x3lius-lyrics',
        writeMode: 'compare-and-swap',
        expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/conflict detected/i);

    const conflicts = db.listEvents({ eventType: 'vault.write.conflict' });
    expect(conflicts).toHaveLength(1);

    // Matching expectedSha256 succeeds and records previousSha256 lineage
    const updated = await engine.writeNote({
      vaultPath: initial.vaultPath,
      content: '# Neon Static\n\nVerse 1 + Chorus.\n',
      actor: 'x3lius-revision',
      writeMode: 'compare-and-swap',
      expectedSha256: initial.sha256,
    });

    expect(updated.previousSha256).toBe(initial.sha256);
    expect(updated.sha256).not.toBe(initial.sha256);
  });

  it('blocks direct agent writes to canonical sectors and requires human approval via Promotion Gate', async () => {
    await expect(
      engine.writeNote({
        vaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/Suno-v6-Gravity.md',
        content: '# Gravity Rule\n\nNever bypass the gate.\n',
        actor: 'suno-researcher',
      }),
    ).rejects.toThrow(/canonical sector and cannot be written directly/i);

    const deniedEvents = db.listEvents({ eventType: 'vault.write.denied' });
    expect(deniedEvents).toHaveLength(1);

    // Queue a candidate for human approval
    const pending = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'cand-suno-gravity',
      proposer: 'research-orchestrator',
      request: { targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/Suno-v6-Gravity.md' },
    });

    // Cannot promote while still pending
    await expect(
      engine.promoteToCanonical({
        approvalId: pending.id,
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/Suno-v6-Gravity.md',
        title: 'Suno v6 Gravity Counter',
        body: 'Describe sound mechanics instead of stacking conflicting genre tags.',
        domain: 'KNOWLEDGE',
        tags: ['suno-v6', 'gravity'],
      }),
    ).rejects.toThrow(/requires human "approved" decision/i);

    // Human approves
    db.decideApproval({
      approvalId: pending.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'proven across 10 controlled Suno v6 takes',
    });

    const promoted = await engine.promoteToCanonical({
      approvalId: pending.id,
      targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/Suno-v6-Gravity.md',
      title: 'Suno v6 Gravity Counter',
      body: 'Describe sound mechanics instead of stacking conflicting genre tags.',
      domain: 'KNOWLEDGE',
      tags: ['suno-v6', 'gravity'],
    });

    const note = await engine.readNote(promoted.vaultPath);
    expect(note.isCanonical).toBe(true);
    expect(note.frontmatter.status).toBe('canonical');
    expect(note.frontmatter.promoted_via).toBe('gate');
    expect(note.frontmatter.approval_id).toBe(pending.id);
    expect(note.frontmatter.approved_by).toBe('blago');
  });

  it('scans the Vault incrementally, indexes root Suno KB notes, searches, and resolves wikilink graph edges', async () => {
    // Seed a root-level Suno KB note (like XYP3RN-Suno-KB-v1.2-Brain)
    await writeFile(
      join(tempDir, 'BEST-0001 Apply gravity-escape tools.md'),
      '---\ntitle: BEST-0001 Apply gravity-escape tools\ntags: [suno, gravity]\n---\n\n# BEST-0001\n\nLinks to [[TAG-1757 UK drill]].\n',
      'utf8',
    );
    await writeFile(
      join(tempDir, 'TAG-1757 UK drill.md'),
      '---\ntitle: TAG-1757 UK drill\ntags: [drill, x3lius]\n---\n\n# TAG-1757 UK drill\n\nBaseline production tag.\n',
      'utf8',
    );

    const scan1 = await engine.scanVault();
    expect(scan1.scannedFiles).toBe(2);
    expect(scan1.indexedFiles).toBe(2);
    expect(scan1.unchangedFiles).toBe(0);

    // Second incremental scan skips unchanged files via mtime + size fast path
    const scan2 = await engine.scanVault();
    expect(scan2.scannedFiles).toBe(2);
    expect(scan2.indexedFiles).toBe(0);
    expect(scan2.unchangedFiles).toBe(2);

    const hits = engine.search('gravity');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.vaultPath).toBe('BEST-0001 Apply gravity-escape tools.md');

    const links = engine.resolveLinks('TAG-1757 UK drill.md');
    expect(links.backlinks).toEqual(['BEST-0001 Apply gravity-escape tools.md']);
  });
});
