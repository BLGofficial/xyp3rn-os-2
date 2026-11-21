import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DawCore,
  DawSessionIntelligence,
  FakeDawAdapter,
  type DawStateSnapshot,
} from '../../core/daw-brain/index.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import {
  createLocalDeterministicEmbedder,
  Os3SemanticIndex,
} from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import { Os3KnowledgeEngine } from '../../core/knowledge-engine/index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  FlStudio2025Adapter,
  inspectFlpAsDawSession,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
void REPO_ROOT;

const staticFlProbe: FlStudioHostProbe = {
  async probeHost(): Promise<FlHostEnvironment> {
    return {
      probedAt: new Date().toISOString(),
      installations: [
        {
          label: 'FL Studio 2025',
          versionDir: 'C:\\Program Files\\Image-Line\\FL Studio 2025',
          executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe',
          exists: true,
          fileVersion: '25.1.6.4997',
          productVersion: '25.1.6.4997',
          hasCompanionDataDirs: false,
          missingCompanionDirs: ['Data', 'Plugins', 'Shared', 'System'],
        },
      ],
      runningProcesses: [{ pid: 9012, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' }],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath: 'C:\\Users\\test\\device_XYP3RNBrain.py',
      controllerScriptInstalled: true,
      userProjectsRoot: 'C:\\Users\\test\\Projects',
      pluginDatabaseRoot: 'C:\\Users\\test\\PluginDb',
      missingPrerequisites: [],
      warnings: [],
    };
  },
  discoverProjects: () => [],
  scanInstalledPlugins: () => [],
};

describe('Phase 12 — DAW Session Intelligence', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const cores: DawCore[] = [];

  afterEach(async () => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeDb = () => {
    const db = openRuntimeDb(':memory:');
    openDbs.push(db);
    return db;
  };

  it('1. interprets fake DAW session structure, classifies tracks, builds routing graph & detects orphan/headroom/stale issues without fabricating unavailable data', async () => {
    const db = makeDb();
    const core = new DawCore({ db });
    cores.push(core);

    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId, { projectPath: 'D:/Projects/SignalCheck.sim' });

    const intel = new DawSessionIntelligence();
    const report = await intel.analyzeSession(sess);

    expect(report.projectName).toBe('SignalCheck');
    expect(report.sessionId).toBe(sess.sessionId);
    expect(report.daw.adapterId).toBe(fake.manifest.adapterId);
    expect(report.observationTimestamp).toBeTruthy();
    expect(report.dataFreshness.stateFreshness).toBe('observed');
    expect(report.dataFreshness.isLive).toBe(true);
    expect(report.confidence.level).toBe('high');

    // Inventory honestly reports null counts & inaccessible domains without fabrication
    expect(report.inventory.counts.mixerChannels).toBeGreaterThan(0);
    expect(report.inventory.counts.automationLanes).toBeNull();
    expect(report.inventory.counts.audioClips).toBeNull();
    expect(report.limitations.some((l) => l.includes('automationLanes'))).toBe(true);
    expect(report.limitations.some((l) => l.includes('audioClips'))).toBe(true);

    // Track classification identifies Master & Lead Vocal roles
    expect(report.trackClassification.some((t) => t.role === 'master')).toBe(true);
    expect(report.trackClassification.some((t) => t.role === 'vocal')).toBe(true);

    // Signal flow & routing graph constructed
    expect(report.routingGraph.observabilityStatus).toBe('complete');
    expect(report.routingGraph.masterSinkIds).toContain('mixer:insert:0');
    expect(report.routingGraph.signalFlowChains.some((c) => c[c.length - 1] === 'mixer:insert:0')).toBe(true);

    // Also test stale degradation lowers confidence and emits STALE_OR_CACHED_TELEMETRY
    fake.setOffline(true, 'Host window closed');
    await core.checkHealth(sess.sessionId);
    const staleSess = core.sessions.requireSession(sess.sessionId);
    const staleReport = await intel.analyzeSession(staleSess);
    expect(staleReport.dataFreshness.isStale).toBe(true);
    expect(staleReport.confidence.score).toBeLessThan(report.confidence.score);
    expect(staleReport.consistency.issues.some((i) => i.code === 'STALE_OR_CACHED_TELEMETRY')).toBe(true);
    expect(staleReport.recommendedNextActions.some((a) => a.actionType === 'refresh_live_connection')).toBe(true);
  });

  it('2. detects disconnected routing, muted active buses, edition-incompatible plugins, and snapshot state diffs on FL Studio session', async () => {
    const db = makeDb();
    const core = new DawCore({ db });
    cores.push(core);

    const flMidi = new MockFlMidiTransport({
      initialSnapshot: {
        tempoBpm: 140,
        mixerTracks: [
          {
            index: 0,
            name: 'Master',
            isMaster: true,
            volumeNormalized: 0.9, // > 0.8 => +1.02 dB headroom risk!
            panNormalized: 0,
            muted: false,
            soloed: false,
            peakNormalized: 0.98, // -0.17 dBFS peak risk
            routesToMaster: null,
            routeTargets: [],
            plugins: [{ slotIndex: 0, name: 'Fruity Limiter', bypassed: false, mixLevel: 1, paramCount: 10 }],
          },
          {
            index: 1,
            name: 'LEAD VOX',
            isMaster: false,
            volumeNormalized: 0.8,
            panNormalized: 0,
            muted: false,
            soloed: false,
            peakNormalized: 0.45,
            routesToMaster: true,
            routeTargets: [2], // Routed to muted Insert 2 (and Insert 2 does not route to Master!)
            plugins: [{ slotIndex: 0, name: 'Gross Beat', bypassed: false, mixLevel: 1, paramCount: 8 }], // Excluded in Producer Edition
          },
          {
            index: 2,
            name: 'Insert 2',
            isMaster: false,
            volumeNormalized: 0.8,
            panNormalized: 0,
            muted: true,
            soloed: false,
            peakNormalized: 0.1,
            routesToMaster: false,
            routeTargets: [],
            plugins: [{ slotIndex: 0, name: 'Fruity Reeverb 2', bypassed: false, mixLevel: 1, paramCount: 12 }],
          },
          {
            index: 3,
            name: 'Insert 3',
            isMaster: false,
            volumeNormalized: 0.8,
            panNormalized: 0,
            muted: false,
            soloed: false,
            peakNormalized: 0,
            routesToMaster: false,
            routeTargets: [],
            plugins: [],
          },
        ],
      },
    });

    const adapter = new FlStudio2025Adapter({ midiTransport: flMidi, hostProbe: staticFlProbe });
    core.registerAdapter(adapter);
    const sess = await core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\ProblemMix.flp' });

    const intel = new DawSessionIntelligence();
    const rep1 = await intel.analyzeSession(sess, { edition: 'Producer Edition' });

    expect(rep1.daw.hostKind).toBe('fl_studio');
    expect(rep1.consistency.ok).toBe(false);
    const codes = new Set(rep1.consistency.issues.map((i) => i.code));
    expect(codes.has('EDITION_INCOMPATIBLE_PLUGIN')).toBe(true);
    expect(codes.has('MUTED_ROUTED_BUS')).toBe(true);
    expect(codes.has('DISCONNECTED_OR_ORPHAN_ROUTING')).toBe(true);
    expect(codes.has('HEADROOM_OR_CLIP_RISK')).toBe(true);
    expect(rep1.routingGraph.orphanNodeIds).toContain('mixer:insert:3');
    expect(rep1.routingGraph.disconnectedSourceIds).toContain('mixer:insert:2');

    // Generic insert name classifies honestly as `unclassified`
    const insert3 = rep1.trackClassification.find((t) => t.refId === 'mixer:insert:3');
    expect(insert3?.role).toBe('unclassified');

    // Out-of-band state change triggers snapshot diff cleanly on second analysis
    const prevSnap: DawStateSnapshot = sess.observed!;
    flMidi.injectHostStateChange({ tempoBpm: 144, playing: true }, false);
    await core.refreshSession(sess.sessionId);
    const updatedSess = core.sessions.requireSession(sess.sessionId);
    const rep2 = await intel.analyzeSession(updatedSess, { previousSnapshot: prevSnap });

    expect(rep2.stateDiffFromPrevious).not.toBeNull();
    expect(rep2.stateDiffFromPrevious?.tempoDeltaBpm).toBe(4);
    expect(rep2.stateDiffFromPrevious?.transportChanges.some((c) => c.includes('playing: false -> true'))).toBe(true);
    expect(rep2.stateDiffFromPrevious?.stateDigestChanged).toBe(true);

    const md = intel.formatMarkdownReport(rep2);
    expect(md).toContain('DAW Session Intelligence Report');
    expect(md).toContain('State Change Detection');
  });

  it('3. analyzes REAL saved FL Studio .flp sessions on disk honestly without fabricating routing or obfuscated tempo', async () => {
    const projectsRoot = join(homedir(), 'Documents', 'Image-Line', 'FL Studio', 'Projects');
    const coldPath = join(projectsRoot, 'COLDINMYEYES', 'COLDINMYEYES.flp');
    const recTplPath = join(projectsRoot, 'Templates', 'recording template', 'recording template.flp');
    if (!existsSync(coldPath) || !existsSync(recTplPath)) {
      return; // Gracefully no-op on external CI hosts without user FL Studio Projects folder
    }

    const intel = new DawSessionIntelligence();

    const coldSess = inspectFlpAsDawSession(coldPath);
    const coldReport = await intel.analyzeSession(coldSess, { edition: 'Producer Edition' });
    expect(coldReport.projectName).toBe('COLDINMYEYES');
    expect(coldReport.daw.version).toBe('26.1.1.5547');
    expect(coldReport.dataFreshness.stateFreshness).toBe('saved');
    // Offline `.flp` lacks live routing matrix -> MUST report `unavailable` cleanly without false disconnect warnings!
    expect(coldReport.routingGraph.observabilityStatus).toBe('unavailable');
    expect(coldReport.consistency.issues.some((i) => i.code === 'DISCONNECTED_OR_ORPHAN_ROUTING')).toBe(false);
    expect(coldReport.inventory.tempoBpm.status).toBe('unknown');
    expect(coldReport.trackClassification.some((t) => t.role === 'vocal' && t.name === 'LEAD VOX')).toBe(true);
    expect(coldReport.limitations.some((l) => l.includes('routing [unavailable]'))).toBe(true);
    expect(coldReport.confidence.level).not.toBe('high');

    const tplSess = inspectFlpAsDawSession(recTplPath);
    const tplReport = await intel.analyzeSession(tplSess, { edition: 'Producer Edition' });
    expect(tplReport.daw.version).toBe('25.1.6.4997');
    expect(tplReport.inventory.tempoBpm).toEqual({ status: 'available', value: 140 });
    expect(tplReport.inventory.counts.mixerChannels).toBe(31);
    expect(tplReport.inventory.counts.plugins).toBe(10);
    expect(tplReport.trackClassification.filter((t) => t.role === 'vocal').length).toBeGreaterThan(5);
  });

  it('4. integrates X3LIUS Music records, plugin docs, production knowledge, strictly approved preferences & historical records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p12-intel-'));
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
      provider: createLocalDeterministicEmbedder(96),
    });
    const knowledge = new Os3KnowledgeEngine({ vault, db, structural, semantic });
    const contextEngine = new Os3ContextEngine({ vault, db, structural, semantic });

    const promote = async (p: {
      readonly id: string;
      readonly path: string;
      readonly title: string;
      readonly body: string;
      readonly domain: string;
      readonly schema: string;
      readonly tags?: readonly string[];
      readonly extra?: Record<string, unknown>;
    }) => {
      const appr = db.queueApproval({
        itemType: 'vault_promotion',
        itemId: p.id,
        request: { targetVaultPath: p.path },
        proposer: 'x3lius-curator',
      });
      db.decideApproval({
        approvalId: appr.id,
        decision: 'approved',
        approver: 'blago-operator',
        reason: 'Canonical approval for Phase 12 test',
      });
      return knowledge.promoteCandidate({
        approvalId: appr.id,
        targetVaultPath: p.path,
        title: p.title,
        body: p.body,
        domain: p.domain,
        entityId: p.id,
        schema: p.schema,
        sourceRefs: ['src-p12'],
        tags: p.tags,
        metadata: {
          version: 1,
          created_at: '2026-11-20T12:00:00Z',
          updated_at: '2026-11-20T12:00:00Z',
          ...(p.extra ?? {}),
        },
        provenance: `test://approved/${p.id}`,
      });
    };

    await promote({
      id: 'song-coldinmyeyes',
      path: '09_X3LIUS_MUSIC/SONGS/COLDINMYEYES.md',
      title: 'COLDINMYEYES',
      domain: 'RECORDS',
      schema: 'xyp3rn.song/v3',
      body: 'Trap-melodic lead vocal session COLDINMYEYES at 138 BPM with warm analog sub and wide hook stack.',
      tags: ['x3lius', 'vocal'],
      extra: { type: 'song', artist: 'X3LIUS', language: 'en' },
    });
    await promote({
      id: 'plugin-pro-q-3',
      path: '10_DAW_BRAIN/PLUGINS/FabFilter_Pro_Q_3.md',
      title: 'FabFilter Pro-Q 3',
      domain: 'TECH',
      schema: 'xyp3rn.daw-plugin/v3',
      body: 'FabFilter Pro-Q 3 surgical linear/zero-latency EQ for vocal mud attenuation around 200-350 Hz.',
      tags: ['plugin', 'eq'],
      extra: {
        type: 'daw_plugin',
        plugin_format: 'VST3',
        vendor: 'FabFilter',
        category: 'EQ',
        edition_requirement: 'Third-party compatible (Producer+)',
      },
    });
    await promote({
      id: 'dsp-vocal-clarity',
      path: '10_DAW_BRAIN/DSP_CONCEPTS/Vocal_Mud_Cleanup.md',
      title: 'Vocal Mud Cleanup Workflow',
      domain: 'TECH',
      schema: 'xyp3rn.dsp-concept/v3',
      body: 'Attenuate 220 Hz resonance before compression when lead vocals fight 808 upper harmonics.',
      tags: ['production', 'vocal'],
      extra: { type: 'dsp_concept', category: 'EQ', acoustic_principle: 'Low-mid masking reduction' },
    });
    await promote({
      id: 'pref-approved-master',
      path: '10_DAW_BRAIN/MIX_MASTER_REFS/Approved_Streaming_Target.md',
      title: 'Approved X3LIUS Streaming Target',
      domain: 'TECH',
      schema: 'xyp3rn.mix-reference/v3',
      body: 'Approved preference: retain -1.2 dBTP master ceiling and -9.5 LUFS target loudness.',
      tags: ['preference', 'mastering-target'],
      extra: {
        type: 'mix_reference',
        category: 'preference',
        stage: 'master',
        target_lufs_min: -10.5,
        target_lufs_max: -8.5,
        max_true_peak_dbtp: -1.0,
      },
    });

    // Unapproved draft preference written directly to 11_INBOX MUST NOT leak into userApprovedPreferences!
    const draftPath = join(vaultRoot, '11_INBOX', 'Unapproved_Bad_Pref.md');
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(
      draftPath,
      [
        '---',
        'id: pref-draft-unsafe',
        'type: preference',
        'title: Unsafe Draft Preference',
        'domain: TECH',
        'sector: 11_INBOX',
        'status: draft',
        'version: 1',
        'category: preference',
        '---',
        '',
        'Push COLDINMYEYES master to +3 dBTP clip ceiling.',
      ].join('\n'),
      'utf8',
    );

    await structural.rebuildFromScratch();
    await semantic.rebuild();

    const flMidi = new MockFlMidiTransport({
      initialSnapshot: {
        title: 'COLDINMYEYES.flp',
        tempoBpm: 138,
      },
    });
    const adapter = new FlStudio2025Adapter({ midiTransport: flMidi, hostProbe: staticFlProbe });
    const core = new DawCore({ db });
    cores.push(core);
    core.registerAdapter(adapter);
    const sess = await core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' });

    db.recordDawAudioAnalysis({
      sessionId: sess.sessionId,
      sourceKind: 'bounce_wav',
      sourceSha256: 'sha256-coldinmyeyes-render',
      traceAnalysis: { integratedLufs: -10.4, truePeakDbtp: -1.1 },
      traceReport: {
        verdict: 'NEEDS_LOW_MID_CLEANUP',
        score: 76,
        issues: ['250 Hz boxiness'],
        recommendations: ['Cut 250 Hz -2.0 dB'],
      },
    });

    const intel = new DawSessionIntelligence({ contextEngine });
    const report = await intel.analyzeSession(sess, {
      projectVaultPath: '09_X3LIUS_MUSIC/SONGS/COLDINMYEYES.md',
      queryHint: 'COLDINMYEYES FabFilter Pro-Q 3 vocal mix preference',
    });

    expect(report.knowledgeContext).not.toBeNull();
    const kc = report.knowledgeContext!;
    expect(kc.x3liusMusicRecords.some((r) => r.title === 'COLDINMYEYES')).toBe(true);
    expect(kc.pluginKnowledge.some((r) => r.title.includes('FabFilter Pro-Q 3'))).toBe(true);
    expect(kc.loadedPluginsMatched).toContain('FabFilter Pro-Q 3');
    expect(kc.loadedPluginsMissingKnowledge).toContain('Fruity Limiter');
    expect(kc.productionKnowledge.some((r) => r.title.includes('Vocal Mud Cleanup'))).toBe(true);
    expect(kc.userApprovedPreferences.some((r) => r.title.includes('Approved X3LIUS Streaming Target'))).toBe(true);
    expect(kc.userApprovedPreferences.some((r) => r.title.includes('Unsafe Draft'))).toBe(false);
    expect(kc.recentAudioAnalyses).toHaveLength(1);
    expect(kc.historicalSessionDeltas.some((d) => d.includes('score=76'))).toBe(true);
    expect(report.recommendedNextActions.some((a) => a.actionType === 'record_knowledge_or_preference')).toBe(true);
  });
});
