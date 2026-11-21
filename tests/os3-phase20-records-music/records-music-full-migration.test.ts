import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault, validateOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import {
  DawCatalogBoundaryError,
  DawMusicCatalogIntegrator,
  Os3RecordsEngine,
  formatRecordsMigrationReportMarkdown,
  migrateOs2RecordsAndMusicToOs3,
  verifyRecordsMusicParity,
  type Os2FullRecordsMusicExport,
} from '../../records/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const tempDirs: string[] = [];
const openDbs: SqliteRuntimeDb[] = [];

const setupEnv = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-phase20-'));
  tempDirs.push(dir);
  const vaultRoot = join(dir, 'vault');
  await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
  const db = openRuntimeDb(join(dir, 'os3.sqlite'));
  openDbs.push(db);
  const vault = new VaultEngine({ vaultRoot, db });
  await vault.scanVault({ full: true });
  const engine = new Os3RecordsEngine({ vault, db });
  const integrator = new DawMusicCatalogIntegrator({ vault, db });
  return { dir, vaultRoot, db, vault, engine, integrator };
};

afterEach(async () => {
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Phase 20 — X3LIUS Records + Music System Full Migration & DAW Integration', () => {
  it('enforces contributor unified namespace, 13 credit roles, and non-destructive retractions', async () => {
    const { vault, engine } = await setupEnv();

    const song = await engine.createSong({
      id: 'song-2001',
      title: 'Voltage Glass',
      artist: 'X3LIUS',
      language: 'en',
    });
    expect(song.vaultPath).toContain('09_X3LIUS_MUSIC/SONGS/');

    const xelius = await engine.registerContributor({
      personId: 'per-x3lius',
      displayName: 'X3LIUS',
      kind: 'ai_persona',
      aliases: ['Xel', 'Blago Artist'],
    });
    expect(xelius.aliases).toHaveLength(2);

    // Case-insensitive collision across people & person_aliases (xyp_person_name_free)
    await expect(
      engine.registerContributor({
        personId: 'per-imposter',
        displayName: '  xel  ',
      }),
    ).rejects.toThrow(/collision/i);

    await engine.registerContributor({
      personId: 'per-mix',
      displayName: 'Mix Master Lead',
    });

    await expect(
      engine.addContributorAlias({
        personPathOrId: 'per-mix',
        alias: 'x3lius',
      }),
    ).rejects.toThrow(/collision/i);

    const cred = await engine.writeCredit({
      creditId: 'cred-2001',
      targetType: 'song',
      targetPathOrId: 'song-2001',
      personPathOrId: 'per-x3lius',
      role: 'writer',
    });

    // Duplicate live (target, person, role) rejected
    await expect(
      engine.writeCredit({
        targetType: 'song',
        targetPathOrId: 'song-2001',
        personPathOrId: 'per-x3lius',
        role: 'writer',
      }),
    ).rejects.toThrow(/Duplicate live credit/i);

    // Retract non-destructively -> allows re-issuing same role cleanly after retraction
    const ret = await engine.retractCredit({
      creditId: cred.creditId,
      reason: 'Superseded by publisher split update',
    });
    expect(ret.vaultPath).toContain('06_RECORDS/CREDITS/CRET-');

    const credDoc = await vault.read(cred.vaultPath);
    expect(credDoc.frontmatter.status).toBe('superseded');
    expect(credDoc.frontmatter.superseded_by).toBe(ret.retractionId);

    const vCredit = await vault.validate(cred.vaultPath, { checkReferences: true });
    expect(vCredit.ok).toBe(true);
  });

  it('manages music projects, mix/master versions with approval & clipping guards, album continuity, and dynamic readiness', async () => {
    const { engine, vault } = await setupEnv();

    const project = await engine.createMusicProject({
      projectId: 'mprj-neon-arc',
      title: 'Neon Arc LP',
      releaseKind: 'album',
      dawProjectPaths: ['D:/Studio/Projects/NeonArc/NeonArc.flp'],
    });
    expect(project.vaultPath).toContain('09_X3LIUS_MUSIC/PROJECTS/MPRJ-');

    await engine.createSong({ id: 'song-a1', title: 'Signal One', artist: 'X3LIUS', language: 'en' });
    await engine.createSong({ id: 'song-a2', title: 'Signal Two', artist: 'X3LIUS', language: 'en' });

    const mix1 = await engine.recordMixVersion({
      mixId: 'mix-a1-v1',
      songPathOrId: 'song-a1',
      projectId: project.projectId,
      audioSha256: 'a'.repeat(64),
      integratedLufs: -14.2,
      truePeakDbtp: -1.4,
    });
    expect(mix1.version).toBe(1);

    // Master > 0.0 dBTP true peak rejected
    await expect(
      engine.recordMasterVersion({
        songPathOrId: 'song-a1',
        mixVersionId: mix1.mixId,
        audioSha256: 'b'.repeat(64),
        truePeakDbtp: 0.4,
      }),
    ).rejects.toThrow(/0\.0 dBTP/i);

    const mstr = await engine.recordMasterVersion({
      masterId: 'mstr-a1-v1',
      songPathOrId: 'song-a1',
      mixVersionId: mix1.mixId,
      audioSha256: 'c'.repeat(64),
      integratedLufs: -9.8,
      truePeakDbtp: -1.0,
      isrc: 'USRC12600001',
    });

    const apprReq = engine.requestMasterApproval({ masterPathOrId: mstr.masterId, proposer: 'mix-engineer' });
    await expect(
      engine.approveMasterVersion({
        masterPathOrId: mstr.masterId,
        approvalId: apprReq.id,
        approver: 'mix-engineer',
        reason: 'Self sign-off',
      }),
    ).rejects.toThrow(/Security violation/i);

    await engine.approveMasterVersion({
      masterPathOrId: mstr.masterId,
      approvalId: apprReq.id,
      approver: 'mastering-lead',
      reason: 'Loudness & true peak verified',
    });

    // Album release with gap in track positions -> detected dynamically by getAlbumContinuity & computeCatalogReadinessChecks
    await engine.createRelease({ id: 'rel-alb-01', title: 'Neon Arc', artist: 'X3LIUS', kind: 'album' });
    await engine.registerTrack({
      id: 'trk-a1',
      releasePathOrId: 'rel-alb-01',
      position: 1,
      title: 'Signal One',
      songId: 'song-a1',
      sourceRef: '09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/signal-one.wav',
    });
    await engine.registerTrack({
      id: 'trk-a3',
      releasePathOrId: 'rel-alb-01',
      position: 3, // gap! missing position 2
      title: 'Signal Two',
      songId: 'song-a2',
      sourceRef: '09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/signal-two.wav',
    });

    const continuity = engine.getAlbumContinuity('rel-alb-01');
    expect(continuity.contiguousPositions).toBe(false);
    expect(continuity.blockers.some((b) => b.ruleCode === 'RELEASE_NON_CONTIGUOUS_POSITIONS')).toBe(true);
    expect(continuity.blockers.some((b) => b.ruleCode === 'TRACK_MISSING_ISRC')).toBe(true);
    expect(continuity.blockers.some((b) => b.ruleCode === 'RELEASE_MISSING_UPC')).toBe(true);

    // Artwork path traversal rejected, valid image accepted
    await expect(
      engine.setReleaseArtwork({
        releasePathOrId: 'rel-alb-01',
        assetPath: '../../secrets/cover.png',
        sha256: 'd'.repeat(64),
      }),
    ).rejects.toThrow(/Unsafe asset path/i);

    await engine.setReleaseArtwork({
      releasePathOrId: 'rel-alb-01',
      assetPath: '_attachments/artwork/neon-arc-3000.png',
      sha256: 'd'.repeat(64),
      widthPx: 3000,
      heightPx: 3000,
    });

    const delivery = await engine.recordReleaseDelivery({
      releasePathOrId: 'rel-alb-01',
      distributor: 'DistroKid',
      status: 'submitted',
      externalRef: 'DK-99412',
    });
    expect(delivery.status).toBe('submitted');

    const vMaster = await vault.validate(mstr.vaultPath, { checkReferences: true });
    expect(vMaster.ok).toBe(true);
  });

  it('enforces version-pinned split proposals, platform URL regexes, song links, and retraction invariants', async () => {
    const { engine } = await setupEnv();

    await engine.createSong({ id: 'song-sp-1', title: 'Chrome Halo', artist: 'X3LIUS', language: 'en' });
    await engine.createRelease({ id: 'rel-sp-1', title: 'Chrome Halo Single', artist: 'X3LIUS', kind: 'single' });
    await engine.registerTrack({
      id: 'trk-sp-1',
      releasePathOrId: 'rel-sp-1',
      position: 1,
      title: 'Chrome Halo',
      songId: 'song-sp-1',
      sourceRef: '09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/chrome.wav',
    });

    // Write initial v1 split
    await engine.writeRightsSplits({
      trackPathOrId: 'trk-sp-1',
      shares: [
        { payee: 'X3LIUS', role: 'artist', percentage: 80 },
        { payee: 'Producer A', role: 'producer', percentage: 20 },
      ],
    });

    // Stale version proposal rejected (`STALE_SPLIT_VERSION`)
    await expect(
      engine.proposeRightsSplitChange({
        trackPathOrId: 'trk-sp-1',
        currentVersion: 0,
        shares: [{ payee: 'X3LIUS', role: 'artist', percentage: 100 }],
        proposer: 'manager',
        reason: 'Wrong base version',
      }),
    ).rejects.toThrow(/STALE_SPLIT_VERSION/i);

    // Valid pinned v1 proposal queued
    const prop = await engine.proposeRightsSplitChange({
      proposalId: 'sprp-sp-1-v2',
      trackPathOrId: 'trk-sp-1',
      currentVersion: 1,
      shares: [
        { payee: 'X3LIUS', role: 'artist', percentage: 75 },
        { payee: 'Producer A', role: 'producer', percentage: 25 },
      ],
      proposer: 'manager',
      reason: 'Agreed master-producer adjustment',
    });

    // Queue another proposal pinning v1, apply first -> second fails CONCURRENT_SPLIT_MODIFICATION
    const propRace = await engine.proposeRightsSplitChange({
      proposalId: 'sprp-sp-1-race',
      trackPathOrId: 'trk-sp-1',
      currentVersion: 1,
      shares: [{ payee: 'X3LIUS', role: 'artist', percentage: 100 }],
      proposer: 'manager',
      reason: 'Competing proposal',
    });

    const applied = await engine.applyApprovedSplitProposal({
      proposalId: prop.proposalId,
      approver: 'rights-admin',
      reason: 'Signed split sheet matches',
    });
    expect(applied.appliedSplit.version).toBe(2);

    await expect(
      engine.applyApprovedSplitProposal({
        proposalId: propRace.proposalId,
        approver: 'rights-admin',
        reason: 'Stale apply attempt',
      }),
    ).rejects.toThrow(/CONCURRENT_SPLIT_MODIFICATION/i);

    // Platform link host check (`xyp_platform_url_ok`) + duplicate live guard + retraction
    await expect(
      engine.writePlatformLink({
        targetType: 'release',
        targetPathOrId: 'rel-sp-1',
        platform: 'spotify',
        url: 'https://evil-phishing.example.com/track/123',
      }),
    ).rejects.toThrow(/host validation/i);

    const spLink = await engine.writePlatformLink({
      linkId: 'plnk-sp-1',
      targetType: 'release',
      targetPathOrId: 'rel-sp-1',
      platform: 'spotify',
      url: 'https://open.spotify.com/album/4aAwvP1',
    });

    await expect(
      engine.writePlatformLink({
        targetType: 'release',
        targetPathOrId: 'rel-sp-1',
        platform: 'spotify',
        url: 'https://open.spotify.com/album/other',
      }),
    ).rejects.toThrow(/Duplicate live platform link/i);

    await engine.retractPlatformLink({ linkId: spLink.linkId, reason: 'URI updated by distributor' });
    await engine.writePlatformLink({
      linkId: 'plnk-sp-2',
      targetType: 'release',
      targetPathOrId: 'rel-sp-1',
      platform: 'spotify',
      url: 'https://open.spotify.com/album/updated123',
    });

    // Song links & retractions
    const sl = await engine.linkSongTarget({
      linkId: 'slnk-rq-1',
      songPathOrId: 'song-sp-1',
      linkType: 'research_question',
      targetId: 'rq-vocal-chain-01',
    });
    const slRet = await engine.retractSongLink({
      linkId: sl.linkId,
      reason: 'Superseded by final mix notes',
    });
    expect(slRet.retractionId).toContain('slrt-');
  });

  it('integrates DAW Brain sessions, audio analyses, plugin chains, and workflows without making DAW projects authoritative', async () => {
    const { engine, integrator, vault } = await setupEnv();

    await engine.createMusicProject({ id: undefined, projectId: 'mprj-daw-1', title: 'Midnight Grid' } as never);
    await engine.createSong({ id: 'song-daw-1', title: 'Midnight Grid', artist: 'X3LIUS', language: 'en' });
    await engine.createRelease({ id: 'rel-daw-1', title: 'Midnight Grid EP', artist: 'X3LIUS', kind: 'ep' });

    // Refuses equating DAW project file to authoritative Song/Release catalog record
    await expect(
      integrator.linkDawProductionToCatalog({
        targetKind: 'song',
        targetPathOrId: 'song-daw-1',
        dawHost: 'fl_studio',
        dawProjectPath: 'D:/FLStudio/Projects/MidnightGrid.flp',
        treatDawProjectAsAuthoritativeCatalog: true,
        provenance: 'fl-studio-adapter',
      }),
    ).rejects.toThrow(DawCatalogBoundaryError);

    // Valid link with CRITICAL audio verdict & live unsaved drift blocks catalog promotion
    const critLink = await integrator.linkDawProductionToCatalog({
      linkId: 'dwlk-song-crit',
      targetKind: 'song',
      targetPathOrId: 'song-daw-1',
      dawHost: 'fl_studio',
      dawProjectPath: 'D:/FLStudio/Projects/MidnightGrid.flp',
      dawSessionId: 'fl-sess-01',
      hasUnsavedLiveChanges: true,
      audioAnalysisId: 'aud-rep-crit',
      audioAnalysisVerdict: 'CRITICAL',
      pluginChainId: 'chain-vocal-lead',
      workflowIds: ['wf-daw-vocal-chain-analysis', 'wf-daw-mix-diagnostics'],
      provenance: 'fl-studio-adapter-2025',
    });
    expect(critLink.authoritativeCatalogRecord).toBe(false);

    const guardFail = integrator.evaluatePromotionFromDaw('song-daw-1');
    expect(guardFail.allowed).toBe(false);
    expect(guardFail.reasons).toHaveLength(2);

    const readiness = engine.computeCatalogReadinessChecks();
    expect(readiness.checks.some((c) => c.ruleCode === 'DAW_SESSION_DRIFT_OR_CRITICAL_AUDIO')).toBe(true);

    // Clean REAPER release master link passes promotion guard
    const cleanLink = await integrator.linkDawProductionToCatalog({
      linkId: 'dwlk-rel-pass',
      targetKind: 'release',
      targetPathOrId: 'rel-daw-1',
      dawHost: 'reaper',
      dawProjectPath: 'D:/Reaper/Projects/MidnightGrid_Master.rpp',
      dawSessionId: 'reaper-sess-02',
      hasUnsavedLiveChanges: false,
      audioAnalysisId: 'aud-rep-pass',
      audioAnalysisVerdict: 'PASS',
      pluginChainId: 'chain-master-bus',
      workflowIds: ['wf-daw-mastering-readiness'],
      provenance: 'reaper-adapter',
    });

    const guardPass = integrator.evaluatePromotionFromDaw('rel-daw-1');
    expect(guardPass.allowed).toBe(true);

    const vLink = await vault.validate(cleanLink.vaultPath, { checkReferences: true });
    expect(vLink.ok).toBe(true);

    const contextGraph = integrator.getLinkedProductionContext('song-daw-1');
    expect(contextGraph.workflows).toContain('wf-daw-vocal-chain-analysis');
    expect(contextGraph.pluginChains).toContain('chain-vocal-lead');
  });

  it('selectively & idempotently migrates OS2 exports (separating valid, rejected, conflicting, incomplete) with full parity', async () => {
    const { engine, integrator, vault, vaultRoot, db } = await setupEnv();

    const exportPayload: Os2FullRecordsMusicExport = {
      exportedAt: '2026-11-21T07:00:00Z',
      sourceSystem: 'os2-supabase-export',
      people: [
        { id: 'per-1', displayName: 'X3LIUS', kind: 'ai_persona', pro: 'ASCAP' },
        { id: 'per-2', displayName: 'Kora Synth', kind: 'human' },
        { id: 'per-dup', displayName: 'x3lius' }, // conflicting case-insensitive name!
      ],
      personAliases: [
        { id: 'pals-1', personId: 'per-1', alias: 'X3' },
        { id: 'pals-orphan', personId: 'per-missing', alias: 'Ghost' }, // incomplete!
      ],
      musicProjects: [
        { id: 'mprj-01', title: 'Afterglow Project', releaseKind: 'ep', dawProjectPaths: ['D:/DAW/Afterglow.flp'] },
      ],
      songs: [
        { id: 'song-1', title: 'Afterglow', artist: 'X3LIUS', language: 'en' },
        { id: '', title: 'Broken Song', artist: 'X3LIUS', language: 'en' }, // incomplete!
      ],
      lyricVersions: [
        {
          id: 'lyr-afterglow-v1',
          lineageId: 'afterglow-main',
          songId: 'song-1',
          title: 'Afterglow Lyrics',
          language: 'en',
          version: 1,
          sections: { Chorus: 'Running through the afterglow tonight' },
          approved: true,
          proposer: 'x3lius-lyrics',
          approver: 'human-editor',
        },
        {
          id: 'lyr-homoglyph',
          lineageId: 'bad-homoglyph',
          songId: 'song-1',
          title: 'Spoofed Lyric',
          language: 'en',
          version: 1,
          sections: { Verse: 'Neon l\u043egic breaks' }, // Cyrillic о inside Latin word -> F22 rejected!
        },
      ],
      takes: [
        {
          id: 'take-1',
          submissionId: 'sub-1',
          songId: 'song-1',
          sunoModel: 'suno-v4.5',
          stylePrompt: 'melodic synthwave 122 bpm',
          durationSec: 192,
          audioSha256: '1'.repeat(64),
          isSelected: true,
        },
      ],
      mixVersions: [
        {
          id: 'mix-1',
          songId: 'song-1',
          projectId: 'mprj-01',
          version: 1,
          audioSha256: '2'.repeat(64),
          integratedLufs: -14.0,
          truePeakDbtp: -1.5,
        },
      ],
      masterVersions: [
        {
          id: 'mstr-1',
          songId: 'song-1',
          trackId: 'trk-1',
          mixVersionId: 'mix-1',
          version: 1,
          audioSha256: '3'.repeat(64),
          integratedLufs: -9.5,
          truePeakDbtp: -1.0,
          isrc: 'USRC12600101',
          approved: true,
          proposer: 'mastering-bot',
          approver: 'blago-lead',
        },
      ],
      releases: [
        {
          id: 'rel-1',
          title: 'Afterglow EP',
          artist: 'X3LIUS',
          kind: 'ep',
          upc: '036000291452', // valid GS1 mod-10 check digit!
          releaseDate: '2026-06-01',
          status: 'released',
          approvedBy: 'label-ops',
        },
        {
          id: 'rel-bad-upc',
          title: 'Invalid Check Digit EP',
          artist: 'X3LIUS',
          kind: 'ep',
          upc: '036000291459', // invalid check digit -> rejected!
          releaseDate: null,
          status: 'draft',
        },
      ],
      tracks: [
        {
          id: 'trk-1',
          releaseId: 'rel-1',
          position: 1,
          title: 'Afterglow',
          songId: 'song-1',
          takeId: 'take-1',
          isrc: 'USRC12600101',
        },
        {
          id: 'trk-bad-isrc',
          releaseId: 'rel-1',
          position: 2,
          title: 'Bad Code',
          takeId: 'take-1',
          isrc: 'INVALID', // rejected!
        },
      ],
      splits: [
        {
          id: 'splt-1',
          trackId: 'trk-1',
          version: 1,
          shares: [
            { payee: 'per-1', role: 'artist', percentage: 60 },
            { payee: 'per-2', role: 'producer', percentage: 40 },
          ],
        },
        {
          id: 'splt-bad-sum',
          trackId: 'trk-1',
          version: 2,
          shares: [{ payee: 'per-1', role: 'artist', percentage: 90 }], // rejected != 100%!
        },
      ],
      credits: [
        { id: 'cred-1', targetType: 'song', targetId: 'song-1', personId: 'per-1', role: 'vocalist' },
      ],
      platformLinks: [
        { id: 'plnk-1', targetType: 'release', targetId: 'rel-1', platform: 'spotify', url: 'https://open.spotify.com/album/abc' },
        { id: 'plnk-bad', targetType: 'release', targetId: 'rel-1', platform: 'spotify', url: 'https://not-spotify.com/album/abc' }, // rejected!
      ],
      releaseArtwork: [
        { id: 'artw-1', releaseId: 'rel-1', assetPath: '_attachments/artwork/afterglow.png', sha256: '4'.repeat(64) },
      ],
      releaseDeliveries: [
        { id: 'dlvr-1', releaseId: 'rel-1', distributor: 'DistroKid', status: 'live', deliveryDate: '2026-06-01' },
      ],
      songLinks: [
        { id: 'slnk-1', songId: 'song-1', linkType: 'track', targetId: 'trk-1' },
      ],
      dawLinks: [
        {
          id: 'dwlk-1',
          targetKind: 'song',
          targetId: 'song-1',
          dawHost: 'fl_studio',
          dawProjectPath: 'D:/DAW/Afterglow.flp',
          dawSessionId: 'fl-sess-afterglow',
          audioAnalysisId: 'aud-afterglow',
          audioAnalysisVerdict: 'PASS',
          pluginChainId: 'chain-afterglow-vox',
          workflowIds: ['wf-daw-session-audit'],
          hasUnsavedLiveChanges: false,
        },
      ],
    };

    const report1 = await migrateOs2RecordsAndMusicToOs3({
      payload: exportPayload,
      engine,
      integrator,
      vault,
      db,
    });

    expect(report1.legacyDataUntouched).toBe(true);
    expect(report1.totals.migrated).toBeGreaterThanOrEqual(15);
    expect(report1.totals.rejected).toBeGreaterThanOrEqual(5);
    expect(report1.totals.conflicting).toBeGreaterThanOrEqual(1);
    expect(report1.totals.incomplete).toBeGreaterThanOrEqual(2);
    expect(report1.transactionalBoundaries.length).toBeGreaterThanOrEqual(4);

    const parity = await verifyRecordsMusicParity({
      payload: exportPayload,
      engine,
      report: report1,
      vault,
      db,
    });
    expect(parity.ok).toBe(true);
    expect(parity.discrepancies).toHaveLength(0);

    // Every migrated Vault file passes strict OS3 schema validator
    const vaultValidation = await validateOs3Vault(vaultRoot);
    expect(vaultValidation.invalidMetadataFiles).toHaveLength(0);
    expect(vaultValidation.duplicateIds).toHaveLength(0);

    // Re-running migration on valid subset is strictly idempotent (`migrated === 0`)
    const cleanPayload: Os2FullRecordsMusicExport = {
      ...exportPayload,
      people: exportPayload.people!.filter((p) => p.id !== 'per-dup'),
      personAliases: exportPayload.personAliases!.filter((a) => a.id !== 'pals-orphan'),
      songs: exportPayload.songs.filter((s) => Boolean(s.id)),
      lyricVersions: exportPayload.lyricVersions.filter((l) => l.id !== 'lyr-homoglyph'),
      releases: exportPayload.releases.filter((r) => r.id !== 'rel-bad-upc'),
      tracks: exportPayload.tracks.filter((t) => t.id !== 'trk-bad-isrc'),
      splits: exportPayload.splits.filter((s) => s.id !== 'splt-bad-sum'),
      platformLinks: exportPayload.platformLinks!.filter((l) => l.id !== 'plnk-bad'),
    };
    const report2 = await migrateOs2RecordsAndMusicToOs3({
      payload: cleanPayload,
      engine,
      integrator,
      vault,
      db,
    });
    expect(report2.totals.migrated).toBe(0);
    expect(report2.totals.skippedIdempotent).toBeGreaterThan(0);

    const markdown = formatRecordsMigrationReportMarkdown(report1, parity);
    expect(markdown).toContain('Transactional Boundaries');
    expect(markdown).toContain('Post-Migration Parity');
  });
});
