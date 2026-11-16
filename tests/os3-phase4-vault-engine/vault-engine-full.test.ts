import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { writeFileAtomic } from '../../core/vault-engine/revision.ts';
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

  it('14. Survives interrupted atomic writes with zero target corruption and zero leftover temp files', async () => {
    const { vaultRoot, engine } = await createFixture();

    const original = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-atomic-01"',
      'title: "Atomic Target"',
      'domain: "CORE"',
      '---',
      '',
      'Intact baseline content.',
    ].join('\n');

    const written = await engine.write({
      vaultPath: '11_INBOX/AtomicTarget.md',
      content: original,
      actor: 'operator',
    });

    const absTarget = join(vaultRoot, '11_INBOX', 'AtomicTarget.md');
    let observedTempExistsDuringStaging = false;

    await expect(
      writeFileAtomic(absTarget, 'PARTIAL CORRUPTED INTERRUPTED WRITE', {
        onBeforeRename: async (tempPath) => {
          const tempContent = await readFile(tempPath, 'utf8');
          observedTempExistsDuringStaging = tempContent === 'PARTIAL CORRUPTED INTERRUPTED WRITE';
          throw new Error('Simulated power loss mid-write');
        },
      }),
    ).rejects.toThrow(/Simulated power loss mid-write/);

    expect(observedTempExistsDuringStaging).toBe(true);
    // Live file remains 100% intact with identical SHA-256
    const afterRead = await engine.read('11_INBOX/AtomicTarget.md', 'operator');
    expect(afterRead.sha256).toBe(written.sha256);
    expect(afterRead.rawContent).toBe(original);

    // Zero .tmp-* orphan files left in directory
    const dirFiles = await readdir(join(vaultRoot, '11_INBOX'));
    expect(dirFiles.some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('15. Detects corrupted documents on disk and blocks restoring tampered or corrupted revision blobs', async () => {
    const { vaultRoot, engine } = await createFixture();

    const v1 = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-corrupt-01"',
      'title: "Corruption Test Note"',
      'domain: "CORE"',
      '---',
      '',
      'Healthy v1 body.',
    ].join('\n');

    const r1 = await engine.write({
      vaultPath: '11_INBOX/CorruptionTarget.md',
      content: v1,
      actor: 'operator',
    });

    const v2 = v1.replace('Healthy v1 body.', 'Healthy v2 body.');
    await engine.update({
      vaultPath: '11_INBOX/CorruptionTarget.md',
      content: v2,
      actor: 'operator',
      expectedSha256: r1.sha256,
    });

    // 1. Corrupt live disk note with unclosed YAML fence
    const diskAbs = join(vaultRoot, '11_INBOX', 'CorruptionTarget.md');
    await writeFile(diskAbs, '---\nid: "ent-corrupt-01"\ntitle: [BROKEN\nBody without closing fence', 'utf8');

    const badYamlRes = await engine.validate('11_INBOX/CorruptionTarget.md', { requireSchema: false });
    expect(badYamlRes.ok).toBe(false);
    expect(badYamlRes.issues.some((i) => i.code === 'INVALID_YAML')).toBe(true);

    const readCorrupt = await engine.read('11_INBOX/CorruptionTarget.md', 'operator');
    expect(readCorrupt.frontmatterError).not.toBeNull();

    const conflictCorrupt = await engine.inspectConflict('11_INBOX/CorruptionTarget.md', null, 'operator');
    expect(conflictCorrupt.hasConflict).toBe(true);
    expect(conflictCorrupt.kind).toBe('corrupted_document');

    // 2. Corrupt live disk note with binary NUL bytes
    await writeFile(diskAbs, `${v1}\0CORRUPT`, 'utf8');
    const nulRes = await engine.validate('11_INBOX/CorruptionTarget.md', { requireSchema: false });
    expect(nulRes.ok).toBe(false);
    expect(nulRes.issues.some((i) => i.code === 'INVALID_YAML' && i.message.includes('NUL'))).toBe(true);

    await expect(
      engine.append({
        vaultPath: '11_INBOX/CorruptionTarget.md',
        appendText: 'Appending to NUL-corrupted file',
        actor: 'operator',
      }),
    ).rejects.toMatchObject({ name: 'VaultValidationError', code: 'INVALID_YAML' });

    // 3. Corrupt revision r1 blob inside .vault-revisions/ -> verifyHistory detects & restore() rejects CHECKSUM_MISMATCH
    const blobAbs = join(vaultRoot, '.vault-revisions', r1.sha256.slice(0, 2), `${r1.sha256}.blob`);
    await writeFile(blobAbs, 'TAMPERED REVISION BYTES ON DISK', 'utf8');

    const histCheck = await engine.verifyHistory('11_INBOX/CorruptionTarget.md');
    expect(histCheck.ok).toBe(false);
    expect(histCheck.corruptedBlobs).toContain(r1.sha256);

    await expect(
      engine.restore({
        vaultPath: '11_INBOX/CorruptionTarget.md',
        targetSha256: r1.sha256,
        actor: 'operator',
        reason: 'Attempt restore from corrupted blob',
      }),
    ).rejects.toMatchObject({ name: 'VaultConflictError', code: 'CHECKSUM_MISMATCH' });
  });

  it('16. Enforces actor authorization, readOnly mode, and custom ACL policies across all operations', async () => {
    const { vaultRoot, db, engine } = await createFixture();

    // Empty actor on mutating operations rejected with UNAUTHORIZED_ACTOR
    await expect(
      engine.write({
        vaultPath: '11_INBOX/NoActor.md',
        content: '# Anonymous write',
        actor: '   ',
      }),
    ).rejects.toMatchObject({ name: 'VaultPermissionError', code: 'UNAUTHORIZED_ACTOR' });

    // Seed one note with authorized engine
    const seeded = await engine.write({
      vaultPath: '11_INBOX/AclTarget.md',
      content: '---\nschema: "xyp3rn.entity/v3"\nid: "ent-acl-01"\ntitle: "ACL Note"\ndomain: "CORE"\n---\nBody',
      actor: 'operator',
    });

    // Read-only VaultEngine blocks all writes/updates/restores/snapshots while allowing reads/list/search
    const readOnlyEngine = new VaultEngine({ vaultRoot, db, readOnly: true });
    expect((await readOnlyEngine.read(seeded.vaultPath, 'viewer')).sha256).toBe(seeded.sha256);
    expect(readOnlyEngine.list({ sector: '11_INBOX' }, 'viewer').length).toBe(1);

    await expect(
      readOnlyEngine.write({
        vaultPath: '11_INBOX/BlockedWrite.md',
        content: '# Should block',
        actor: 'operator',
      }),
    ).rejects.toMatchObject({ name: 'VaultPermissionError', code: 'UNAUTHORIZED_ACTOR' });

    await expect(
      readOnlyEngine.restore({
        vaultPath: seeded.vaultPath,
        targetSha256: seeded.sha256,
        actor: 'operator',
      }),
    ).rejects.toMatchObject({ name: 'VaultPermissionError', code: 'UNAUTHORIZED_ACTOR' });

    // Custom sector-scoped ACL policy
    const scopedEngine = new VaultEngine({
      vaultRoot,
      db,
      authorize: ({ actor, operation, sector }) => {
        if (actor === 'daw-agent' && ['write', 'update', 'append'].includes(operation) && sector !== '10_DAW_BRAIN') {
          return { allowed: false, reason: `Agent ${actor} may only write inside 10_DAW_BRAIN` };
        }
        return true;
      },
    });

    await expect(
      scopedEngine.write({
        vaultPath: '11_INBOX/ForbiddenSector.md',
        content: '# Disallowed for daw-agent',
        actor: 'daw-agent',
      }),
    ).rejects.toMatchObject({ name: 'VaultPermissionError', code: 'UNAUTHORIZED_ACTOR' });

    const dawNote = await scopedEngine.write({
      vaultPath: '10_DAW_BRAIN/SESSIONS/ScopedSession.md',
      content: '# Allowed inside 10_DAW_BRAIN',
      actor: 'daw-agent',
    });
    expect(dawNote.vaultPath).toBe('10_DAW_BRAIN/SESSIONS/ScopedSession.md');

    const denials = engine.listAuditLog({ result: 'denied', limit: 25 });
    expect(denials.length).toBeGreaterThanOrEqual(4);
  });

  it('17. Prevents TOCTOU overwrites under concurrent no-overwrite writes and emits audit records across all operations', async () => {
    const { engine } = await createFixture();

    const makeBody = (label: string) =>
      [
        '---',
        'schema: "xyp3rn.entity/v3"',
        `id: "ent-race-${label.toLowerCase()}"`,
        `title: "Race ${label}"`,
        'domain: "CORE"',
        '---',
        '',
        `Payload from writer ${label}`,
      ].join('\n');

    const concurrentWrites = await Promise.allSettled([
      engine.write({
        vaultPath: '11_INBOX/RaceCreate.md',
        content: makeBody('ALPHA'),
        actor: 'writer-alpha',
        writeMode: 'no-overwrite',
      }),
      engine.write({
        vaultPath: '11_INBOX/RaceCreate.md',
        content: makeBody('BETA'),
        actor: 'writer-beta',
        writeMode: 'no-overwrite',
      }),
    ]);

    const fulfilled = concurrentWrites.filter((r) => r.status === 'fulfilled');
    const rejected = concurrentWrites.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ name: 'VaultConflictError', code: 'LOCK_BUSY' });
    }

    // Winner's content is intact & never partially overwritten
    const firstFulfilled = fulfilled[0];
    const winner = firstFulfilled?.status === 'fulfilled' ? firstFulfilled.value : null;
    expect(winner).not.toBeNull();
    const saved = await engine.read('11_INBOX/RaceCreate.md', 'auditor');
    expect(saved.sha256).toBe(winner!.sha256);

    // Exercise remaining read/list/search/backlinks/history audit paths
    await engine.readMetadata('11_INBOX/RaceCreate.md', 'auditor');
    engine.list({ sector: '11_INBOX' }, 'auditor');
    engine.search('Race', { sector: '11_INBOX' }, 'auditor');
    engine.backlinks('11_INBOX/RaceCreate.md', 'auditor');
    await engine.history('11_INBOX/RaceCreate.md', 'auditor');

    const auditOps = new Set(engine.listAuditLog({ actor: 'auditor', limit: 20 }).map((a) => a.operation));
    expect(auditOps.has('read')).toBe(true);
    expect(auditOps.has('readMetadata')).toBe(true);
    expect(auditOps.has('list')).toBe(true);
    expect(auditOps.has('search')).toBe(true);
    expect(auditOps.has('backlinks')).toBe(true);
    expect(auditOps.has('history')).toBe(true);
  });

  it('18. Resolves concurrency/Obsidian conflicts safely (save-fork, keep-disk, accept-proposed) and guards promote() CAS', async () => {
    const { vaultRoot, db, engine } = await createFixture();

    const baseContent = [
      '---',
      'schema: "xyp3rn.entity/v3"',
      'id: "ent-resolve-01"',
      'title: "Conflict Resolution Target"',
      'domain: "CORE"',
      '---',
      '',
      'Base v1 line.',
    ].join('\n');

    const v1 = await engine.write({
      vaultPath: '11_INBOX/ResolveMe.md',
      content: baseContent,
      actor: 'agent-author',
    });

    // Simulate external Obsidian edit on disk
    const obsidianEdit = baseContent.replace('Base v1 line.', 'Human edited in Obsidian v2.');
    await writeFile(join(vaultRoot, '11_INBOX', 'ResolveMe.md'), obsidianEdit, 'utf8');

    const report = await engine.inspectConflict('11_INBOX/ResolveMe.md', v1.sha256, 'agent-author');
    expect(report.hasConflict).toBe(true);
    expect(report.kind).toBe('external_obsidian_edit');
    expect(report.diskSha256).not.toBe(v1.sha256);

    // Strategy 1: save-fork preserves agent's proposed edit side-by-side without clobbering Obsidian edit
    const agentProposal = baseContent.replace('Base v1 line.', 'Agent proposed v2.');
    const forkRes = await engine.resolveConflict({
      vaultPath: '11_INBOX/ResolveMe.md',
      strategy: 'save-fork',
      actor: 'agent-author',
      proposedContent: agentProposal,
      reason: 'Preserve agent draft alongside Obsidian edit',
    });
    expect(forkRes.forkPath).toBe('11_INBOX/ResolveMe (2).md');
    expect((await engine.read('11_INBOX/ResolveMe.md')).rawContent).toBe(obsidianEdit);
    expect((await engine.read('11_INBOX/ResolveMe (2).md')).rawContent).toBe(agentProposal);

    // Strategy 2: keep-disk preserves Obsidian edit & syncs version history/index
    const keepRes = await engine.resolveConflict({
      vaultPath: '11_INBOX/ResolveMe.md',
      strategy: 'keep-disk',
      actor: 'blago',
      reason: 'Accept human Obsidian version',
    });
    expect(keepRes.sha256).toBe(report.diskSha256);

    // Strategy 3: accept-proposed rejects stale expectedDiskSha256, succeeds with live disk SHA, and retains old disk blob in history!
    await expect(
      engine.resolveConflict({
        vaultPath: '11_INBOX/ResolveMe.md',
        strategy: 'accept-proposed',
        actor: 'blago',
        expectedDiskSha256: v1.sha256, // stale!
        proposedContent: baseContent.replace('Base v1 line.', 'Merged resolution v3.'),
      }),
    ).rejects.toMatchObject({ name: 'VaultConflictError', code: 'CHECKSUM_MISMATCH' });

    const mergedRes = await engine.resolveConflict({
      vaultPath: '11_INBOX/ResolveMe.md',
      strategy: 'accept-proposed',
      actor: 'blago',
      expectedDiskSha256: keepRes.sha256,
      proposedContent: baseContent.replace('Base v1 line.', 'Merged resolution v3.'),
      reason: 'Apply reviewed merge after inspecting Obsidian version',
    });
    expect(mergedRes.previousSha256).toBe(keepRes.sha256);

    // Previous Obsidian edit (keepRes.sha256) MUST still be restorable from .vault-revisions!
    const restoredObsidian = await engine.restore({
      vaultPath: '11_INBOX/ResolveMe.md',
      targetSha256: keepRes.sha256,
      actor: 'blago',
      reason: 'Verify Obsidian edit remained recoverable',
    });
    expect(restoredObsidian.sha256).toBe(keepRes.sha256);

    // Optimistic concurrency on promote() revisions
    const app1 = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'daw-cap-promotion-01',
      proposer: 'research-orchestrator',
      request: {},
    });
    db.decideApproval({
      approvalId: app1.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Approved canonical rule',
    });

    const p1 = await engine.promote({
      approvalId: app1.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-CAS-Test.md',
      entityId: 'know-cas-test-01',
      title: 'CAS Promoted Rule',
      body: 'Canonical body v1.',
      domain: 'KNOWLEDGE',
      sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
      confidence: 0.92,
    });

    const app2 = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'daw-cap-promotion-02',
      proposer: 'research-orchestrator',
      request: {},
    });
    db.decideApproval({
      approvalId: app2.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Approved revision',
    });

    await expect(
      engine.promote({
        approvalId: app2.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-CAS-Test.md',
        entityId: 'know-cas-test-01',
        title: 'CAS Promoted Rule',
        body: 'Canonical body v2.',
        domain: 'KNOWLEDGE',
        sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
        confidence: 0.95,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ name: 'VaultConflictError', code: 'CHECKSUM_MISMATCH' });

    const p2 = await engine.promote({
      approvalId: app2.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-CAS-Test.md',
      entityId: 'know-cas-test-01',
      title: 'CAS Promoted Rule',
      body: 'Canonical body v2.',
      domain: 'KNOWLEDGE',
      sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0001.md'],
      confidence: 0.95,
      expectedSha256: p1.sha256,
    });
    expect(p2.previousSha256).toBe(p1.sha256);
    expect(p2.revisionNumber).toBe(2);
  });
});
