import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeContextQuery,
  Os3ContextEngine,
} from '../../core/context-engine/os3-context-engine.ts';
import {
  createLocalDeterministicEmbedder,
  Os3SemanticIndex,
} from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';

describe('Phase 6 — Local Knowledge Index, Semantic Retrieval & OS 3.0 Context Engine', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p6-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await mkdir(vaultRoot, { recursive: true });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({
      vault,
      db,
      provider: createLocalDeterministicEmbedder(128),
    });
    const contextEngine = new Os3ContextEngine({
      vault,
      db,
      structural,
      semantic,
    });

    return { dir, vaultRoot, db, vault, structural, semantic, contextEngine };
  };

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) {
        await rm(d, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it('1. Indexes structural metadata, full-text search, entity lookup, tag/domain search, backlinks, and multi-hop relationship traversal', async () => {
    const { db, vault, structural } = await createFixture();

    await vault.write({
      vaultPath: '02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study.md',
      content: [
        '---',
        'schema: "xyp3rn.source/v3"',
        'id: "src-0100-portamento-study"',
        'type: "source"',
        'title: "Portamento 808 Sub-Bass Field Study"',
        'domain: "KNOWLEDGE"',
        'origin: "first_party"',
        'status: "approved"',
        'tags: [suno-v6, 808, portamento]',
        '---',
        '',
        '# Portamento 808 Sub-Bass Field Study',
        '',
        'Empirical measurements show portamento glide descriptors retain sub-bass articulation at 140 BPM.',
      ].join('\n'),
      actor: 'researcher',
    });

    await vault.write({
      vaultPath: '03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-0100-Glide-Quote.md',
      content: [
        '---',
        'schema: "xyp3rn.evidence/v3"',
        'id: "evid-0100-glide-quote"',
        'type: "evidence"',
        'title: "Evidence: Portamento Glide Quote"',
        'domain: "RESEARCH_INTELLIGENCE"',
        'source_ref: "02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study.md"',
        'verbatim_quote: "portamento glide descriptors retain sub-bass articulation"',
        'confidence: 0.92',
        'status: "approved"',
        'tags: [evidence, 808, suno-v6]',
        '---',
        '',
        '# Evidence: Portamento Glide Quote',
        '',
        'Extracted from [[02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study|SRC-0100]].',
      ].join('\n'),
      actor: 'suno-researcher',
    });

    const appr = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'know-0100-glide-rule',
      proposer: 'research-orchestrator',
      request: {},
    });
    db.decideApproval({
      approvalId: appr.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Approved canonical rule',
    });

    await vault.promote({
      approvalId: appr.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-0100-Glide-Rule.md',
      entityId: 'know-0100-glide-rule',
      title: 'Canonical 808 Portamento Rule',
      body: 'Always specify portamento 808 sub-bass when pairing UK drill drums with acoustic guitar on Suno v6. See [[03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-0100-Glide-Quote|EVID-0100]].',
      domain: 'KNOWLEDGE',
      sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study.md'],
      evidenceIds: ['evid-0100-glide-quote'],
      confidence: 0.92,
      tags: ['808', 'portamento', 'suno-v6'],
    });

    // Entity lookup by ID & path
    const byId = structural.lookupByEntityId('know-0100-glide-rule');
    expect(byId).not.toBeNull();
    expect(byId?.vaultPath).toBe('02_KNOWLEDGE/CANONICAL/KNOW-0100-Glide-Rule.md');
    expect(byId?.status).toBe('canonical');
    expect(byId?.dependencies).toContain('02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study.md');

    // Tag search ('all' and 'any')
    const tagAll = structural.searchByTags(['808', 'portamento'], 'all');
    expect(tagAll.map((n) => n.entityId).sort()).toEqual([
      'know-0100-glide-rule',
      'src-0100-portamento-study',
    ]);

    // Domain search
    const researchNodes = structural.searchByDomain('RESEARCH_INTELLIGENCE');
    expect(researchNodes).toHaveLength(1);
    expect(researchNodes[0]?.entityId).toBe('evid-0100-glide-quote');

    // Backlinks
    const srcBacklinks = structural.getBacklinks('02_KNOWLEDGE/SOURCES/SRC-0100-Portamento-Study.md');
    expect(srcBacklinks).toContain('03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-0100-Glide-Quote.md');

    // Multi-hop relationship traversal (KNOW-0100 -> EVID-0100 + SRC-0100)
    const relHits = structural.traverseRelationships('know-0100-glide-rule', 2);
    expect(relHits.map((r) => r.entityId).sort()).toEqual([
      'evid-0100-glide-quote',
      'src-0100-portamento-study',
    ]);

    // Full-text search across body text ("Empirical measurements")
    const ftsHits = await structural.fullTextSearch('Empirical measurements articulation');
    expect(ftsHits.length).toBeGreaterThanOrEqual(1);
    expect(ftsHits[0]?.node.entityId).toBe('src-0100-portamento-study');
    expect(ftsHits[0]?.excerpt).toContain('Empirical measurements');
  });

  it('2 & 3. Rebuilds local semantic index, analyzes queries, ranks hybrid context, enforces token budgets, deduplicates, and caches by Vault generation', async () => {
    const { db, vault, semantic, contextEngine } = await createFixture();

    await vault.write({
      vaultPath: '09_X3LIUS_MUSIC/SONGS/SONG-0200-Midnight-Drill.md',
      content: [
        '---',
        'schema: "xyp3rn.song/v3"',
        'id: "song-0200-midnight-drill"',
        'title: "Midnight Drill"',
        'domain: "RECORDS"',
        'artist: "X3LIUS"',
        'language: "en"',
        'provenance: "vault://09_X3LIUS_MUSIC/SONGS/SONG-0200-Midnight-Drill.md"',
        'tags: [drill, 808, x3lius]',
        '---',
        '',
        '# Midnight Drill',
        '',
        'Cold baritone vocals over sliding 808 sub-bass and acoustic guitar arpeggios at 140 BPM.',
      ].join('\n'),
      actor: 'x3lius',
    });

    await vault.write({
      vaultPath: '07_TECH/TRACE/TECH-0200-Loudness-Meter.md',
      content: [
        '---',
        'schema: "xyp3rn.entity/v3"',
        'id: "tech-0200-loudness-meter"',
        'title: "TRACE BS.1770 Loudness Meter"',
        'domain: "TECH"',
        'tags: [trace, lufs, audio]',
        '---',
        '',
        '# TRACE BS.1770 Loudness Meter',
        '',
        'Measures integrated LUFS, short-term LUFS, and true-peak dBTP.',
      ].join('\n'),
      actor: 'tech-lead',
    });

    // Rebuild local semantic vector index
    const semBuild = await semantic.rebuild();
    expect(semBuild.indexedCount).toBe(2);

    const semHits = await semantic.search('sliding 808 baritone vocals drill');
    expect(semHits.length).toBeGreaterThanOrEqual(1);
    expect(semHits[0]?.entityId).toBe('song-0200-midnight-drill');
    expect(semHits[0]?.provenance).toContain('SONG-0200-Midnight-Drill.md');

    // Query analysis
    const qAnalysis = analyzeContextQuery('How to write sliding 808 drill vocals on suno-v6 #x3lius');
    expect(qAnalysis.intent).toBe('creative');
    expect(qAnalysis.targetDomains).toContain('RECORDS');
    expect(qAnalysis.tagFilters).toEqual(['x3lius']);
    expect(qAnalysis.modelScope).toBe('suno-v6');

    // Context retrieval (first call = cache miss, second call = cache hit)
    const pkg1 = await contextEngine.retrieveContext('sliding 808 baritone drill #x3lius', {
      maxItems: 5,
      tokenBudget: 800,
    });
    expect(pkg1.cache).toBe('miss');
    expect(pkg1.items.length).toBeGreaterThanOrEqual(1);

    const topItem = pkg1.items[0]!;
    expect(topItem.entityId).toBe('song-0200-midnight-drill');
    expect(topItem.filePath).toBe('09_X3LIUS_MUSIC/SONGS/SONG-0200-Midnight-Drill.md');
    expect(topItem.relevantExcerpt).toContain('Cold baritone');
    expect(topItem.relevanceScore).toBeGreaterThan(0);
    expect(topItem.provenance.origin).toContain('SONG-0200-Midnight-Drill.md');
    expect(topItem.checksum).toMatch(/^[a-f0-9]{64}$/);

    const pkg2 = await contextEngine.retrieveContext('sliding 808 baritone drill #x3lius', {
      maxItems: 5,
      tokenBudget: 800,
    });
    expect(pkg2.cache).toBe('hit');

    // Writing a new note changes Vault generation and automatically invalidates the cache
    await vault.write({
      vaultPath: '10_INBOX/NewNoteInvalidatesCache.md',
      content: '---\nschema: "xyp3rn.entity/v3"\nid: "ent-cache-inv"\ntitle: "Cache Inv"\ndomain: "CORE"\n---\n# Inv\n',
      actor: 'operator',
    });

    const pkg3 = await contextEngine.retrieveContext('sliding 808 baritone drill #x3lius', {
      maxItems: 5,
      tokenBudget: 800,
    });
    expect(pkg3.cache).toBe('miss');
    expect(pkg3.vaultGeneration).not.toBe(pkg1.vaultGeneration);

    // Token budget truncation check
    const tightPkg = await contextEngine.retrieveContext('sliding 808 LUFS loudness', {
      maxItems: 10,
      tokenBudget: 25,
      bypassCache: true,
    });
    expect(tightPkg.totalTokens).toBeLessThanOrEqual(25);
    expect(tightPkg.truncatedByBudget).toBe(true);
    expect(db.isOpen).toBe(true);
  });

  it('4. Index Consistency: detects external edits, deletions, and renames, and rebuilds from scratch (Vault always wins)', async () => {
    const { vaultRoot, vault, structural } = await createFixture();

    const noteA = await vault.write({
      vaultPath: '10_INBOX/OriginalName.md',
      content: [
        '---',
        'schema: "xyp3rn.entity/v3"',
        'id: "ent-rename-me"',
        'title: "Rename Target"',
        'domain: "CORE"',
        '---',
        '',
        'Stable content across file rename.',
      ].join('\n'),
      actor: 'operator',
    });

    await vault.write({
      vaultPath: '10_INBOX/ToDelete.md',
      content: '---\nschema: "xyp3rn.entity/v3"\nid: "ent-delete-me"\ntitle: "Delete Target"\ndomain: "CORE"\n---\nBye.\n',
      actor: 'operator',
    });

    await vault.write({
      vaultPath: '10_INBOX/ToEditExternally.md',
      content: '---\nschema: "xyp3rn.entity/v3"\nid: "ent-edit-me"\ntitle: "Edit Target"\ndomain: "CORE"\n---\nBefore.\n',
      actor: 'operator',
    });

    // Simulate external Obsidian operations on disk:
    // 1. Rename OriginalName.md -> RenamedNote.md
    await rename(
      join(vaultRoot, '10_INBOX', 'OriginalName.md'),
      join(vaultRoot, '10_INBOX', 'RenamedNote.md'),
    );
    // 2. Delete ToDelete.md
    await unlink(join(vaultRoot, '10_INBOX', 'ToDelete.md'));
    // 3. Modify ToEditExternally.md
    await writeFile(
      join(vaultRoot, '10_INBOX', 'ToEditExternally.md'),
      '---\nschema: "xyp3rn.entity/v3"\nid: "ent-edit-me"\ntitle: "Edit Target"\ndomain: "CORE"\n---\nAfter external Obsidian edit!\n',
      'utf8',
    );

    // Detect stale entries before reconciliation
    const stale = await structural.detectStaleEntries();
    expect(stale.some((s) => s.vaultPath === '10_INBOX/OriginalName.md' && s.reason === 'deleted_on_disk')).toBe(true);
    expect(stale.some((s) => s.vaultPath === '10_INBOX/ToDelete.md' && s.reason === 'deleted_on_disk')).toBe(true);
    expect(stale.some((s) => s.vaultPath === '10_INBOX/ToEditExternally.md' && s.reason === 'checksum_mismatch')).toBe(true);
    expect(stale.some((s) => s.vaultPath === '10_INBOX/RenamedNote.md' && s.reason === 'unindexed_on_disk')).toBe(true);

    // Reconcile with Vault: detects rename, modification, and deletion
    const rec = await structural.reconcileWithVault();
    expect(rec.renamed).toEqual([
      {
        fromPath: '10_INBOX/OriginalName.md',
        toPath: '10_INBOX/RenamedNote.md',
        entityId: 'ent-rename-me',
        sha256: noteA.sha256,
      },
    ]);
    expect(rec.modified).toEqual(['10_INBOX/ToEditExternally.md']);
    expect(rec.deleted).toEqual(['10_INBOX/ToDelete.md']);
    expect(rec.totalIndexedAfter).toBe(2);

    // Wipe index_state and rebuild from scratch — the Vault on disk always wins
    const rebuilt = await structural.rebuildFromScratch();
    expect(rebuilt.totalIndexed).toBe(2);
    expect(structural.lookupByEntityId('ent-rename-me')?.vaultPath).toBe('10_INBOX/RenamedNote.md');
    expect(await structural.detectStaleEntries()).toEqual([]);
  });
});
