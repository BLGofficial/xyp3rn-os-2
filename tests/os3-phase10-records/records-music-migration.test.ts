import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  isValidGs1Code,
  isValidIsrcCode,
  Os3RecordsEngine,
  X3LIUS_DOMAINS,
} from '../../records/os3-records-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 10 — X3LIUS Records and Music System Migration (Parity, Constraints & Reconciliation)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p10-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const records = new Os3RecordsEngine({ vault, db });
    return { dir, vaultRoot, db, vault, records };
  };

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1. Covers all 13 X3LIUS/Records domains, immutable lyric revisions, homoglyph guard, creative approvals, AI provenance, and critiques', async () => {
    const { db, vault, records } = await createFixture();
    expect(X3LIUS_DOMAINS).toHaveLength(13);

    // 1. Song + immutable Song Revision preserving song.id
    const song = await records.createSong({
      id: 'song-night-echo',
      title: 'Night Echo',
      artist: 'X3LIUS',
      language: 'en',
      genre: 'UK Drill',
      bpm: 140,
    });
    const rev = await records.createSongRevision({
      songPathOrId: 'song-night-echo',
      summary: 'Tightened chorus hook bar count',
    });
    expect(rev.songId).toBe('song-night-echo');
    expect(rev.revision).toBe(2);
    expect((await vault.read(song.vaultPath)).frontmatter.id).toBe('song-night-echo');

    // 2. Creative Artifacts across subdomains
    const structureArt = await records.writeCreativeArtifact({
      subdomain: 'songwriting',
      slug: 'night-echo-structure',
      title: 'Night Echo Structure',
      body: 'Intro (4) -> Verse 1 (16) -> Chorus (8)',
    });
    const styleArt = await records.writeCreativeArtifact({
      subdomain: 'genre-style',
      slug: 'night-echo-style',
      title: 'Night Echo Style Recipe',
      body: '140 BPM sliding 808 portamento sub-bass, dark drill percussion',
    });
    await records.writeCreativeArtifact({
      subdomain: 'vocal-dna',
      slug: 'x3lius-baritone',
      title: 'Vocal DNA Profile',
      body: 'Cold baritone chest-voice close-mic resonance.',
    });
    await records.writeCreativeArtifact({
      subdomain: 'composition',
      slug: 'night-echo-chords',
      title: 'F Minor Harmonic Progression',
      body: 'Fm9 - DbMaj7 - Eb6',
    });
    await records.writeCreativeArtifact({
      subdomain: 'arrangement',
      slug: 'night-echo-arr',
      title: 'Acoustic Guitar + 808 Arrangement',
      body: 'Filter guitar highs under hook to clear vocal pocket.',
    });

    // 3. Lyric Homoglyph guard (Latin + Cyrillic inside one word rejected) & immutable monotonic versions
    await expect(
      records.createLyricVersion({
        songPathOrId: 'song-night-echo',
        lineageId: 'lin-night-echo',
        title: 'Night Echo Lyrics',
        language: 'en',
        sections: [{ label: 'Chorus', bars: undefined } as unknown as { label: string; lines: readonly string[] }],
      }),
    ).rejects.toThrow();

    await expect(
      records.createLyricVersion({
        songPathOrId: 'song-night-echo',
        lineageId: 'lin-night-echo',
        title: 'Night Echo Lyrics',
        language: 'en',
        sections: [{ label: 'Chorus', lines: ['Testing Пeak homoglyph guard'] }], // Cyrillic П + Latin eak
      }),
    ).rejects.toThrow(/homoglyph guard/i);

    const lyr1 = await records.createLyricVersion({
      songPathOrId: 'song-night-echo',
      lineageId: 'lin-night-echo',
      title: 'Night Echo Lyrics',
      language: 'en',
      sections: [{ label: 'Chorus', lines: ['Neon echo in the midnight lane'] }],
      structureRef: structureArt.vaultPath,
    });
    const lyr2 = await records.createLyricVersion({
      songPathOrId: 'song-night-echo',
      lineageId: 'lin-night-echo',
      title: 'Night Echo Lyrics',
      language: 'en',
      sections: [{ label: 'Chorus', lines: ['Silver echo down the wet overpass'] }],
      structureRef: structureArt.vaultPath,
    });
    expect(lyr1.version).toBe(1);
    expect(lyr2.version).toBe(2);
    expect(lyr1.vaultPath).not.toBe(lyr2.vaultPath);

    // 4. Creative Approval (cannot self-approve; preserves immutable lyric text)
    const apprReq = records.requestCreativeApproval({
      artifactPathOrId: lyr2.id,
      proposer: 'x3lius-lyrics',
    });
    await expect(
      records.approveCreativeVersion({
        artifactPathOrId: lyr2.id,
        approvalId: apprReq.id,
        approver: 'x3lius-lyrics',
        reason: 'Self approval attempt',
      }),
    ).rejects.toThrow(/cannot approve own/i);

    const approvedPtr = await records.approveCreativeVersion({
      artifactPathOrId: lyr2.id,
      approvalId: apprReq.id,
      approver: 'blago',
      reason: 'Approved v2 lyrics for Suno package',
    });
    expect(approvedPtr.approval.status).toBe('approved');
    expect((await vault.read(lyr2.vaultPath)).body).toContain('Silver echo down the wet overpass');

    // 5. Production Session + AI Generation Attempt & Take Provenance + Critique & Revision
    const sess = await records.recordProductionSession({
      songPathOrId: 'song-night-echo',
      dawOrEnvironment: 'FL Studio 24 + Suno v6',
      notes: 'Session initialized for Night Echo EP lead.',
    });
    expect(sess.id).toMatch(/^psess-/);

    const gen = await records.recordGenerationAttemptAndTake({
      songPathOrId: 'song-night-echo',
      sunoModel: 'suno-v6',
      stylePrompt: 'dark UK drill, acoustic guitar, sliding 808 portamento, 140 bpm',
      promptText: '[Chorus]\nSilver echo down the wet overpass',
      lyricRef: lyr2.vaultPath,
      styleRecipeRef: styleArt.vaultPath,
    });
    const takeDoc = await vault.read(gen.takePath);
    expect(takeDoc.frontmatter.suno_model).toBe('suno-v6');
    expect(takeDoc.frontmatter.generation_attempt_id).toBe(gen.attemptId);
    expect(takeDoc.frontmatter.package_sha256).toBe(gen.packageSha256);

    const critRev = await records.recordCritiqueAndRevision({
      targetPathOrId: gen.takeId,
      overallScore: 8.6,
      findings: ['Sub-bass pocket sits clean at -11.2 LUFS', 'Reduce 2kHz harshness on guitar transient by 1.5 dB'],
      revisionSummary: 'Dynamic EQ cut at 2.1 kHz applied in mix-master pass.',
    });
    expect((await vault.read(critRev.revisionPath)).frontmatter.critique_id).toBe(critRev.critiqueId);
    expect(db.isOpen).toBe(true);
  });

  it('2. Enforces Catalog invariants: GS1 UPC, ISO 3901 ISRC write-once & uniqueness, split sums (100.000%), unassigned-share block, and Release Calendar history', async () => {
    const { vault, records } = await createFixture();

    await records.createSong({ id: 'song-0010', title: 'Track One', artist: 'X3LIUS', language: 'en' });
    const gen = await records.recordGenerationAttemptAndTake({
      songPathOrId: 'song-0010',
      sunoModel: 'suno-v6',
      stylePrompt: '140 bpm drill',
      promptText: '[Verse 1]\nLine one',
    });

    const rel = await records.createRelease({
      id: 'rel-0010',
      title: 'Midnight Telemetry',
      artist: 'X3LIUS',
      kind: 'single',
    });
    const trk = await records.registerTrack({
      id: 'trk-0010',
      releasePathOrId: 'rel-0010',
      position: 1,
      title: 'Track One',
      takePathOrId: gen.takeId,
    });

    // Reject duplicate position or duplicate recording on same release
    await expect(
      records.registerTrack({
        releasePathOrId: 'rel-0010',
        position: 1,
        title: 'Dup Pos',
        sourceRef: 'audio/file.wav',
      }),
    ).rejects.toThrow(/Duplicate catalog assignment/i);
    await expect(
      records.registerTrack({
        releasePathOrId: 'rel-0010',
        position: 2,
        title: 'Dup Take',
        takePathOrId: gen.takeId,
      }),
    ).rejects.toThrow(/Duplicate catalog assignment/i);

    // ISRC & UPC validation, write-once immutability & duplicate check
    expect(isValidIsrcCode('INVALID')).toBe(false);
    expect(isValidGs1Code('012345678900')).toBe(false); // bad GS1 check digit
    expect(isValidGs1Code('012345678905')).toBe(true); // valid GS1 mod-10 UPC-A

    await expect(records.assignIsrc({ trackPathOrId: 'trk-0010', isrc: 'BAD' })).rejects.toThrow(/Invalid ISRC/i);
    await records.assignIsrc({ trackPathOrId: 'trk-0010', isrc: 'QZAB12600010' });
    await expect(records.assignIsrc({ trackPathOrId: 'trk-0010', isrc: 'QZAB12600011' })).rejects.toThrow(/never changes/i);

    await expect(records.assignUpc({ releasePathOrId: 'rel-0010', upc: '012345678900' })).rejects.toThrow(/Invalid GS1/i);
    await expect(records.assignUpc({ releasePathOrId: 'rel-0010', upc: '012345678905' })).rejects.toThrow(/Duplicate catalog assignment/i);
    await records.assignUpc({ releasePathOrId: 'rel-0010', upc: '036000291452' });
    await expect(records.assignUpc({ releasePathOrId: 'rel-0010', upc: '036000291469' })).rejects.toThrow(/never changes/i);

    // Rights splits: reject sum != 100%, allow draft with unassigned share, block scheduling until 0% unassigned!
    await expect(
      records.writeRightsSplits({
        trackPathOrId: 'trk-0010',
        shares: [{ payee: 'X3LIUS', role: 'master', percentage: 80 }],
      }),
    ).rejects.toThrow(/100\.000%/);

    const draftSplit = await records.writeRightsSplits({
      trackPathOrId: 'trk-0010',
      shares: [
        { payee: 'X3LIUS', role: 'master', percentage: 75.5 },
        { payee: null, role: 'unassigned', percentage: 24.5 },
      ],
    });
    expect(draftSplit.version).toBe(1);
    expect(draftSplit.hasUnassigned).toBe(true);

    const checkFail = records.runRightsCheck('rel-0010');
    expect(checkFail.verdict.verdict).toBe('flag');
    expect(checkFail.verdict.flags.some((f) => f.rule === 'rights.no-unassigned-share')).toBe(true);

    // Scheduling MUST fail with flagged rights check or past date
    await expect(
      records.transitionReleaseCalendar({
        releasePathOrId: 'rel-0010',
        action: 'schedule',
        releaseDate: '2026-12-15',
        rightsCheckRunId: checkFail.runId,
        todayIso: '2026-11-16',
      }),
    ).rejects.toThrow(/not a passing records-rights-splits/i);

    // Write v2 split set summing to 100.000% with zero unassigned share
    const cleanSplit = await records.writeRightsSplits({
      trackPathOrId: 'trk-0010',
      shares: [
        { payee: 'X3LIUS', role: 'master_and_publishing', percentage: 75.5 },
        { payee: 'Producer A', role: 'producer', percentage: 24.5 },
      ],
    });
    expect(cleanSplit.version).toBe(2);
    expect(cleanSplit.hasUnassigned).toBe(false);

    const checkPass = records.runRightsCheck('rel-0010');
    expect(checkPass.verdict.verdict).toBe('pass');

    // Past date rejected even on passing splits
    await expect(
      records.transitionReleaseCalendar({
        releasePathOrId: 'rel-0010',
        action: 'schedule',
        releaseDate: '2025-01-01',
        rightsCheckRunId: checkPass.runId,
        todayIso: '2026-11-16',
      }),
    ).rejects.toThrow(/in the past/i);

    // Schedule for future date -> succeeds and prevents adding new tracks to non-draft release
    const scheduled = await records.transitionReleaseCalendar({
      releasePathOrId: 'rel-0010',
      action: 'schedule',
      releaseDate: '2026-12-15',
      rightsCheckRunId: checkPass.runId,
      todayIso: '2026-11-16',
    });
    expect(scheduled.status).toBe('scheduled');

    await expect(
      records.registerTrack({
        releasePathOrId: 'rel-0010',
        position: 2,
        title: 'Late Track',
        sourceRef: 'audio/late.wav',
      }),
    ).rejects.toThrow(/draft releases/i);

    // Release before release date rejected; on/after release date succeeds; full history preserved
    await expect(
      records.transitionReleaseCalendar({
        releasePathOrId: 'rel-0010',
        action: 'release',
        todayIso: '2026-11-16',
      }),
    ).rejects.toThrow(/cannot be released before/i);

    const released = await records.transitionReleaseCalendar({
      releasePathOrId: 'rel-0010',
      action: 'release',
      todayIso: '2026-12-15',
    });
    expect(released.status).toBe('released');
    expect(released.historyLength).toBe(2);
    expect((await vault.read(rel.vaultPath)).frontmatter.release_history).toHaveLength(2);
    expect(trk.id).toBe('trk-0010');
  });

  it('3. Acceptance: Reconciles migrated Vault records against legacy OS2 exports with zero discrepancies', async () => {
    const { db, records } = await createFixture();

    await records.createSong({ id: 'song-par-1', title: 'Parity Signal', artist: 'X3LIUS', language: 'en' });
    const lyr = await records.createLyricVersion({
      songPathOrId: 'song-par-1',
      lineageId: 'lin-par-1',
      title: 'Parity Lyrics',
      language: 'en',
      sections: [{ label: 'Verse 1', lines: ['Clocked in clean on OS3'] }],
    });
    const appr = records.requestCreativeApproval({ artifactPathOrId: lyr.id, proposer: 'x3lius-lyrics' });
    await records.approveCreativeVersion({
      artifactPathOrId: lyr.id,
      approvalId: appr.id,
      approver: 'blago',
      reason: 'Approved for legacy parity check',
    });

    const gen = await records.recordGenerationAttemptAndTake({
      songPathOrId: 'song-par-1',
      sunoModel: 'suno-v6',
      stylePrompt: 'dark synthwave',
      promptText: '[Verse 1]\nClocked in clean on OS3',
      lyricRef: lyr.vaultPath,
    });

    await records.createRelease({ id: 'rel-par-1', title: 'Parity EP', artist: 'X3LIUS', kind: 'ep' });
    await records.assignUpc({ releasePathOrId: 'rel-par-1', upc: '036000291452' });
    await records.registerTrack({
      id: 'trk-par-1',
      releasePathOrId: 'rel-par-1',
      position: 1,
      title: 'Parity Signal',
      takePathOrId: gen.takeId,
    });
    await records.assignIsrc({ trackPathOrId: 'trk-par-1', isrc: 'QZAB12600099' });
    await records.writeRightsSplits({
      trackPathOrId: 'trk-par-1',
      shares: [{ payee: 'X3LIUS', role: 'all_rights', percentage: 100 }],
    });

    const check = records.runRightsCheck('rel-par-1');
    await records.transitionReleaseCalendar({
      releasePathOrId: 'rel-par-1',
      action: 'schedule',
      releaseDate: '2026-12-20',
      rightsCheckRunId: check.runId,
      todayIso: '2026-11-16',
    });

    const reconciliation = records.reconcileLegacyExports({
      songs: [{ id: 'song-par-1', title: 'Parity Signal', artist: 'X3LIUS', language: 'en' }],
      lyricVersions: [{ lineageId: 'lin-par-1', version: 1, approved: true }],
      tracks: [{ id: 'trk-par-1', releaseId: 'rel-par-1', position: 1, title: 'Parity Signal', isrc: 'QZAB12600099' }],
      releases: [{ id: 'rel-par-1', title: 'Parity EP', kind: 'ep', upc: '036000291452', status: 'scheduled' }],
      splits: [{ trackId: 'trk-par-1', version: 1, sum: 100, hasUnassigned: false }],
      takes: [{ id: gen.takeId, sunoModel: 'suno-v6', promptText: '[Verse 1]\nClocked in clean on OS3' }],
    });

    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.discrepancies).toEqual([]);
    expect(reconciliation.counts.songs?.matched).toBe(1);
    expect(reconciliation.counts.lyricVersions?.matched).toBe(1);
    expect(reconciliation.counts.tracks?.matched).toBe(1);
    expect(reconciliation.counts.releases?.matched).toBe(1);
    expect(reconciliation.counts.splits?.matched).toBe(1);
    expect(reconciliation.counts.takes?.matched).toBe(1);
    expect(db.isOpen).toBe(true);
  });
});
