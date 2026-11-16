import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import {
  VaultConflictError,
  VaultEngine,
  VaultPathSecurityError,
  VaultPermissionError,
  VaultValidationError,
} from '../../core/vault-engine/vault-engine.ts';

describe('Phase 4 — Production XYP3RN Vault Engine (All 13 Operations & 13 Security/Safety Suites)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-ve-p4-'));
    tempDirs.push(root);
    const vaultRoot = join(root, 'vault');
    const outsideDir = join(root, 'outside');
    await mkdir(vaultRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const db = openRuntimeDb(join(root, 'runtime.sqlite'));
    openDbs.push(db);
    const engine = new VaultEngine({ vaultRoot, db });
    return { root, vaultRoot, outsideDir, db, engine };
  };

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it('1 & 2. Read/write, readMetadata, list, search, and atomic writes without temp leftovers', async () => {
    const { vaultRoot, engine } = await createFixture();

    const noteContent = [
      '---',
      'schema: "xyp3rn.song/v3"',
      'id: "song-0010-crimson-sub"',
      'title: "Crimson Sub"',
      'domain: "RECORDS"',
      'artist: "X3LIUS"',
      'language: "en"',
      'tags: [drill, 808, x3lius]',
      '---',
      '',
      '# Crimson Sub',
      '',
      'Sliding portamento 808 sub-bass at 142 BPM.',
    ].join('\n');

    const writeRes = await engine.write({
      vaultPath: '09_X3LIUS_MUSIC/SONGS/SONG-0010-Crimson-Sub.md',
      content: noteContent,
      actor: 'lyric-architect',
      reason: 'Initial song concept creation',
    });

    expect(writeRes.createdCopy).toBe(false);
    expect(writeRes.revisionNumber).toBe(1);
    expect(writeRes.sha256).toMatch(/^[a-f0-9]{64}$/);

    // Verify no leftover .tmp-* files in target folder
    const dirEntries = await readdir(join(vaultRoot, '09_X3LIUS_MUSIC', 'SONGS'));
    expect(dirEntries.some((f) => f.startsWith('.tmp-'))).toBe(false);

    // read()
    const doc = await engine.read('09_X3LIUS_MUSIC/SONGS/SONG-0010-Crimson-Sub.md', 'operator');
    expect(doc.frontmatter.title).toBe('Crimson Sub');
    expect(doc.frontmatter.tags).toEqual(['drill', '808', 'x3lius']);
    expect(doc.sha256).toBe(writeRes.sha256);

    // readMetadata()
    const meta = await engine.readMetadata('09_X3LIUS_MUSIC/SONGS/SONG-0010-Crimson-Sub.md', 'operator');
    expect(meta.entityId).toBe('song-0010-crimson-sub');
    expect(meta.schema).toBe('xyp3rn.song/v3');
    expect(meta.domain).toBe('RECORDS');
    expect(meta.sector).toBe('09_X3LIUS_MUSIC');

    // list() & search()
    const listed = engine.list({ sector: '09_X3LIUS_MUSIC', domain: 'RECORDS', tag: '808' });
    expect(listed.length).toBe(1);
    expect(listed[0]?.vaultPath).toBe('09_X3LIUS_MUSIC/SONGS/SONG-0010-Crimson-Sub.md');

    const hits = engine.search('Crimson', { sector: '09_X3LIUS_MUSIC' });
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toBe('Crimson Sub');
  });

  it('3 & 4. Concurrent updates, checksum conflicts, and silent overwrite rejection', async () => {
    const { engine } = await createFixture();

    const v1 = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-concurrency-01"',
      'title: "Concurrency Target"',
      'domain: "CORE"',
      '---',
      '',
      'Version 1 body.',
    ].join('\n');

    const created = await engine.write({
      vaultPath: '10_INBOX/Concurrency.md',
      content: v1,
      actor: 'actor-a',
    });

    // Silent overwrite rejected when writeMode = 'reject-overwrite'
    await expect(
      engine.write({
        vaultPath: '10_INBOX/Concurrency.md',
        content: `${v1}\nSilent overwrite attempt`,
        actor: 'actor-b',
        writeMode: 'reject-overwrite',
      }),
    ).rejects.toThrowError(VaultConflictError);

    // Default writeMode = 'no-overwrite' creates Concurrency (2).md without clobbering
    const copyRes = await engine.write({
      vaultPath: '10_INBOX/Concurrency.md',
      content: v1.replace('ent-concurrency-01', 'ent-concurrency-02'),
      actor: 'actor-b',
    });
    expect(copyRes.createdCopy).toBe(true);
    expect(copyRes.vaultPath).toBe('10_INBOX/Concurrency (2).md');

    // Stale expectedSha256 on update() throws CHECKSUM_MISMATCH
    await expect(
      engine.update({
        vaultPath: '10_INBOX/Concurrency.md',
        content: v1.replace('Version 1 body.', 'Stale update'),
        actor: 'actor-b',
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({
      name: 'VaultConflictError',
      code: 'CHECKSUM_MISMATCH',
    });

    // Concurrent updates racing on the same path: exactly one succeeds and one rejects with LOCK_BUSY or CHECKSUM_MISMATCH
    const results = await Promise.allSettled([
      engine.update({
        vaultPath: '10_INBOX/Concurrency.md',
        content: v1.replace('Version 1 body.', 'Concurrent A'),
        actor: 'actor-a',
        expectedSha256: created.sha256,
      }),
      engine.update({
        vaultPath: '10_INBOX/Concurrency.md',
        content: v1.replace('Version 1 body.', 'Concurrent B'),
        actor: 'actor-b',
        expectedSha256: created.sha256,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('5 & 6. Path traversal and symbolic-link escapes outside the Vault root are blocked', async () => {
    const { vaultRoot, outsideDir, engine } = await createFixture();

    const traversalPaths = [
      '../outside/secret.md',
      '10_INBOX/../../outside/secret.md',
      '10_INBOX\\backslashes.md',
      '/abs/path.md',
      'C:/Windows/win.ini',
      '.obsidian/app.json',
      '10_INBOX/payload.exe',
    ];

    for (const badPath of traversalPaths) {
      await expect(
        engine.write({
          vaultPath: badPath,
          content: '# Bad',
          actor: 'attacker',
        }),
      ).rejects.toThrowError(VaultPathSecurityError);
    }

    // Create a directory symlink/junction inside 10_INBOX pointing to outsideDir
    await mkdir(join(vaultRoot, '10_INBOX'), { recursive: true });
    await writeFile(join(outsideDir, 'escaped.md'), '# Outside File\n', 'utf8');
    const symlinkDir = join(vaultRoot, '10_INBOX', 'linked_outside');

    await symlink(
      outsideDir,
      symlinkDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(engine.read('10_INBOX/linked_outside/escaped.md')).rejects.toMatchObject({
      name: 'VaultPathSecurityError',
      code: 'SYMLINK_ESCAPE',
    });

    await expect(
      engine.write({
        vaultPath: '10_INBOX/linked_outside/pwn.md',
        content: '# Pwn',
        actor: 'attacker',
      }),
    ).rejects.toMatchObject({
      name: 'VaultPathSecurityError',
      code: 'SYMLINK_ESCAPE',
    });
  });

  it('7, 8 & 9. Invalid YAML, invalid schema, entity ID mutation, and broken references are rejected', async () => {
    const { engine } = await createFixture();

    // Invalid YAML frontmatter
    await expect(
      engine.write({
        vaultPath: '10_INBOX/BadYaml.md',
        content: '---\ntitle: [unclosed\n---\nBody',
        actor: 'author',
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'INVALID_YAML',
    });

    // Unrecognized schema
    await expect(
      engine.write({
        vaultPath: '10_INBOX/BadSchema.md',
        content: '---\nschema: "xyp3rn.unknown/v99"\nid: "bad-1"\ntitle: "Bad"\n---\nBody',
        actor: 'author',
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'INVALID_SCHEMA',
    });

    // Missing required schema fields (e.g. rights-split total_percentage != 100)
    await expect(
      engine.write({
        vaultPath: '06_RECORDS/RIGHTS/BadSplit.md',
        content: [
          '---',
          'schema: "xyp3rn.rights-split/v3"',
          'id: "splt-bad"',
          'title: "Bad Split"',
          'total_percentage: 85',
          'has_unassigned_share: false',
          'shares: []',
          '---',
          'Body',
        ].join('\n'),
        actor: 'author',
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'INVALID_SCHEMA',
    });

    // Broken reference check via write(checkReferences: true) and link()
    await expect(
      engine.write({
        vaultPath: '10_INBOX/BrokenLink.md',
        content: [
          '---',
          'schema: "xyp3rn.entity/v3"',
          'id: "ent-broken-link"',
          'title: "Broken Link Note"',
          'domain: "CORE"',
          '---',
          '',
          'See [[02_KNOWLEDGE/CANONICAL/DOES-NOT-EXIST]]',
        ].join('\n'),
        actor: 'author',
        checkReferences: true,
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'BROKEN_REFERENCE',
    });

    // Valid target note + link() + backlinks() + entity ID mutation guard
    const targetNote = await engine.write({
      vaultPath: '06_RECORDS/TRACKS/TRK-0099-Target.md',
      content: [
        '---',
        'schema: "xyp3rn.track/v3"',
        'id: "trk-0099-target"',
        'title: "Target Track"',
        'position: 1',
        '---',
        '# Target Track',
      ].join('\n'),
      actor: 'author',
    });

    const sourceNote = await engine.write({
      vaultPath: '06_RECORDS/RELEASES/REL-0099-Source.md',
      content: [
        '---',
        'schema: "xyp3rn.release/v3"',
        'id: "rel-0099-source"',
        'title: "Source Release"',
        'artist: "X3LIUS"',
        'kind: "single"',
        '---',
        '# Source Release',
      ].join('\n'),
      actor: 'author',
    });

    // Mutating stable entity ID on update() is forbidden
    await expect(
      engine.update({
        vaultPath: sourceNote.vaultPath,
        content: [
          '---',
          'schema: "xyp3rn.release/v3"',
          'id: "rel-MUTATED-ID"',
          'title: "Source Release"',
          'artist: "X3LIUS"',
          'kind: "single"',
          '---',
          '# Source Release',
        ].join('\n'),
        actor: 'author',
        expectedSha256: sourceNote.sha256,
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'ENTITY_ID_MUTATION_FORBIDDEN',
    });

    // link() to non-existent note throws BROKEN_REFERENCE
    await expect(
      engine.link({
        sourceVaultPath: sourceNote.vaultPath,
        targetVaultPath: '06_RECORDS/TRACKS/MISSING.md',
        actor: 'author',
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'BROKEN_REFERENCE',
    });

    // link() to valid target succeeds and backlinks() resolves it
    const linkRes = await engine.link({
      sourceVaultPath: sourceNote.vaultPath,
      targetVaultPath: targetNote.vaultPath,
      alias: 'Target Track',
      relationLabel: 'Featured Track',
      actor: 'author',
    });
    expect(linkRes.alreadyLinked).toBe(false);
    expect(linkRes.wikilinkSyntax).toBe('[[06_RECORDS/TRACKS/TRK-0099-Target|Target Track]]');

    const incoming = engine.backlinks(targetNote.vaultPath);
    expect(incoming).toEqual([sourceNote.vaultPath]);

    // validate() confirms reference integrity passes
    const valRes = await engine.validate(sourceNote.vaultPath, { checkReferences: true });
    expect(valRes.ok).toBe(true);
  });

  it('10 & 11. Version history, restore(), snapshot(), and batch transaction rollback', async () => {
    const { vaultRoot, engine } = await createFixture();

    const v1Content = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-hist-01"',
      'title: "History Note"',
      'domain: "CORE"',
      '---',
      '',
      'Line 1.',
    ].join('\n');

    const r1 = await engine.write({
      vaultPath: '10_INBOX/HistoryNote.md',
      content: v1Content,
      actor: 'operator',
      reason: 'v1 write',
    });

    const r2 = await engine.append({
      vaultPath: '10_INBOX/HistoryNote.md',
      appendText: 'Line 2 appended.',
      actor: 'operator',
      expectedSha256: r1.sha256,
      reason: 'v2 append',
    });

    expect(r2.revisionNumber).toBe(2);

    const histBeforeRestore = await engine.history('10_INBOX/HistoryNote.md');
    expect(histBeforeRestore.length).toBe(2);
    expect(histBeforeRestore[0]?.sha256).toBe(r1.sha256);
    expect(histBeforeRestore[1]?.sha256).toBe(r2.sha256);

    // Restore back to r1.sha256
    const restored = await engine.restore({
      vaultPath: '10_INBOX/HistoryNote.md',
      targetSha256: r1.sha256,
      actor: 'operator',
      reason: 'Rollback to v1',
    });
    expect(restored.sha256).toBe(r1.sha256);
    expect(restored.revisionNumber).toBe(3);

    const docAfterRestore = await engine.read('10_INBOX/HistoryNote.md');
    expect(docAfterRestore.body.trim()).toBe('Line 1.');

    // Create Vault snapshot
    const snap = await engine.snapshot('phase4-checkpoint', 'operator');
    expect(snap.totalFiles).toBe(1);
    expect(snap.files[0]?.sha256).toBe(r1.sha256);

    // Multi-file transaction rollback when a write fails mid-batch
    const tx = engine.versions;
    expect(tx).toBeDefined();
    await expect(
      // Trigger failure on second item by passing a directory path as file path
      (async () => {
        await mkdir(join(vaultRoot, '10_INBOX', 'SubDirAsFile.md'), { recursive: true });
        const tm = new (await import('../../core/vault-engine/transaction-manager.ts')).VaultTransactionManager(
          null,
          engine.versions,
        );
        await tm.executeAtomicBatch(
          [
            {
              vaultPath: '10_INBOX/HistoryNote.md',
              absPath: join(vaultRoot, '10_INBOX', 'HistoryNote.md'),
              content: 'CORRUPTED BY FAILED TX',
            },
            {
              vaultPath: '10_INBOX/SubDirAsFile.md',
              absPath: join(vaultRoot, '10_INBOX', 'SubDirAsFile.md'),
              content: 'Will fail because target is a directory',
            },
          ],
          'operator',
        );
      })(),
    ).rejects.toThrow();

    // Verify HistoryNote.md was rolled back to its exact v1 content!
    const afterFailedBatch = await engine.read('10_INBOX/HistoryNote.md');
    expect(afterFailedBatch.sha256).toBe(r1.sha256);
  });

  it('12. Permission failures, Promotion Gate self-approval block, provenance & evidence checks, and audit trail', async () => {
    const { db, engine } = await createFixture();

    // Writing to 00_SYSTEM is blocked by writableSectors restriction
    await expect(
      engine.write({
        vaultPath: '00_SYSTEM/SCHEMAS/hack.md',
        content: '# Hack',
        actor: 'rogue-agent',
      }),
    ).rejects.toMatchObject({
      name: 'VaultPathSecurityError',
      code: 'DISALLOWED_DIRECTORY',
    });

    // Direct write to canonical path 02_KNOWLEDGE/CANONICAL/ is blocked
    await expect(
      engine.write({
        vaultPath: '02_KNOWLEDGE/CANONICAL/DirectCanonical.md',
        content: '# Unauthorized',
        actor: 'suno-researcher',
      }),
    ).rejects.toMatchObject({
      name: 'VaultPermissionError',
      code: 'CANONICAL_WRITE_FORBIDDEN',
    });

    // Self-approval by an agent is blocked by Promotion Gate
    const selfApproval = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'find-self-approved',
      proposer: 'suno-researcher',
      request: {},
    });
    db.decideApproval({
      approvalId: selfApproval.id,
      decision: 'approved',
      approver: 'suno-researcher',
      reason: 'Agent trying to approve its own work',
    });

    await expect(
      engine.promote({
        approvalId: selfApproval.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Self.md',
        title: 'Self Approved',
        body: 'Should fail.',
        domain: 'KNOWLEDGE',
      }),
    ).rejects.toMatchObject({
      name: 'VaultPermissionError',
      code: 'SELF_APPROVAL_FORBIDDEN',
    });

    // Valid human approval, but missing provenance (empty sourceRefs) or low confidence (< 0.7) is rejected
    const humanApproval = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'find-0099-verified',
      proposer: 'research-orchestrator',
      request: {},
    });
    db.decideApproval({
      approvalId: humanApproval.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Verified by human operator',
    });

    await expect(
      engine.promote({
        approvalId: humanApproval.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-0099.md',
        title: 'Missing Provenance',
        body: 'Body.',
        domain: 'KNOWLEDGE',
        sourceRefs: [],
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'MISSING_PROVENANCE',
    });

    await expect(
      engine.promote({
        approvalId: humanApproval.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-0099.md',
        title: 'Low Confidence',
        body: 'Body.',
        domain: 'KNOWLEDGE',
        sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
        confidence: 0.45,
      }),
    ).rejects.toMatchObject({
      name: 'VaultValidationError',
      code: 'INSUFFICIENT_EVIDENCE',
    });

    // Valid promotion with human approval, provenance, and confidence >= 0.7 succeeds
    const promoted = await engine.promote({
      approvalId: humanApproval.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-0099-Verified-Rule.md',
      entityId: 'know-0099-verified-rule',
      title: 'Verified Canonical Rule',
      body: 'Proven sound mechanics rule.',
      domain: 'KNOWLEDGE',
      sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
      evidenceIds: ['evid-0001'],
      confidence: 0.91,
    });
    expect(promoted.vaultPath).toBe('02_KNOWLEDGE/CANONICAL/KNOW-0099-Verified-Rule.md');

    // Audit log records denied, invalid, and successful operations with full metadata
    const audits = engine.listAuditLog({ limit: 50 });
    expect(audits.some((a) => a.operation === 'promote' && a.result === 'denied')).toBe(true);
    expect(audits.some((a) => a.operation === 'promote' && a.result === 'invalid')).toBe(true);
    const successPromote = audits.find(
      (a) => a.operation === 'promote' && a.result === 'success' && a.entityId === 'know-0099-verified-rule',
    );
    expect(successPromote).toBeDefined();
    expect(successPromote?.actor).toBe('blago');
    expect(successPromote?.newChecksum).toBe(promoted.sha256);
  });

  it('13. Detects external Obsidian edits, prevents overwriting user edits, and preserves external version in history', async () => {
    const { vaultRoot, engine } = await createFixture();

    const initialContent = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-obsidian-01"',
      'title: "Live Obsidian Note"',
      'domain: "CORE"',
      '---',
      '',
      'Agent initial text.',
    ].join('\n');

    const created = await engine.write({
      vaultPath: '10_INBOX/ObsidianLive.md',
      content: initialContent,
      actor: 'agent-writer',
    });

    // Simulate the user editing the file directly in Obsidian on disk
    const externalObsidianContent = initialContent.replace(
      'Agent initial text.',
      'User edited this paragraph directly inside Obsidian!',
    );
    await writeFile(join(vaultRoot, '10_INBOX', 'ObsidianLive.md'), externalObsidianContent, 'utf8');

    // When an agent tries to update() using the pre-Obsidian-edit SHA-256, VaultEngine throws EXTERNAL_OBSIDIAN_EDIT
    await expect(
      engine.update({
        vaultPath: '10_INBOX/ObsidianLive.md',
        content: initialContent.replace('Agent initial text.', 'Agent blind overwrite attempt'),
        actor: 'agent-writer',
        expectedSha256: created.sha256,
      }),
    ).rejects.toMatchObject({
      name: 'VaultConflictError',
      code: 'EXTERNAL_OBSIDIAN_EDIT',
    });

    // Moreover, the external Obsidian edit was automatically preserved in version history!
    const history = await engine.history('10_INBOX/ObsidianLive.md');
    expect(history.length).toBe(2);
    expect(history[1]?.operation).toBe('external-sync');
    expect(history[1]?.actor).toBe('obsidian-external');

    // Reconciling via watcher updates index_state to the Obsidian edit's checksum
    const reconciled = await engine.reconcileExternalEdit('10_INBOX/ObsidianLive.md');
    expect(reconciled?.changeType).toBe('modified');
    expect(reconciled?.previousSha256).toBe(created.sha256);
  });
});
