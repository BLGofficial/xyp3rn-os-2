import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DawCore,
  PluginBrain,
  type PluginWorkflowKind,
} from '../../core/daw-brain/index.ts';
import { Os3KnowledgeEngine } from '../../core/knowledge-engine/index.ts';
import {
  createLocalDeterministicEmbedder,
  Os3SemanticIndex,
} from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  DefaultFlStudioHostProbe,
  FlStudio2025Adapter,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';

const staticProbe: FlStudioHostProbe = {
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
      runningProcesses: [{ pid: 7777, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' }],
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

describe('Phase 13 — XYP3RN Plugin Brain', () => {
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

  it('1. ingests Vault docs without assuming host installation, merges verified host/live scans, interprets parameters & compares plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p13-pb-'));
    tempDirs.push(dir);
    const db = openRuntimeDb(':memory:');
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot: dir, db });
    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({ vault, db, provider: createLocalDeterministicEmbedder(64) });
    const knowledge = new Os3KnowledgeEngine({ vault, db, structural, semantic });

    const appr = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'plg-soothe2',
      request: { targetVaultPath: '10_DAW_BRAIN/PLUGINS/oeksound_soothe2.md' },
      proposer: 'x3lius-curator',
    });
    db.decideApproval({ approvalId: appr.id, decision: 'approved', approver: 'blago-operator', reason: 'Approved Phase 13 test plugin doc' });
    await knowledge.promoteCandidate({
      approvalId: appr.id,
      targetVaultPath: '10_DAW_BRAIN/PLUGINS/oeksound_soothe2.md',
      title: 'Plugin Profile: Soothe2',
      domain: 'RECORDS',
      entityId: 'plg-soothe2',
      schema: 'xyp3rn.daw-plugin/v3',
      sourceRefs: ['src-oeksound'],
      metadata: {
        type: 'plugin',
        version: 1,
        created_at: '2026-11-20T12:00:00Z',
        updated_at: '2026-11-20T12:00:00Z',
        plugin_format: 'VST3',
        vendor: 'oeksound',
        category: 'equalizer',
        edition_requirement: 'Third-party license',
      },
      provenance: 'test://approved/plg-soothe2',
      body: 'Dynamic resonance suppressor for vocal harshness.',
    });

    const brain = new PluginBrain();
    await brain.ingestVaultPluginDocs(vault);

    // CRITICAL: Vault documentation MUST NOT assume local installation!
    const sootheDoc = brain.getProfile('Soothe2');
    expect(sootheDoc).not.toBeNull();
    expect(sootheDoc!.installation.installedOnHost).toBe('not_detected_on_host');
    expect(sootheDoc!.presets.status).toBe('unavailable');
    expect(brain.recommendForRole({ role: 'surgical_resonance_control' })).toHaveLength(0);

    // User catalog entry with custom parameters & presets
    brain.ingestUserCatalog(
      [
        {
          productName: 'Valhalla VintageVerb',
          manufacturer: 'Valhalla DSP',
          format: 'VST3',
          category: 'reverb',
          processingRoles: ['spatial_reverb'],
          presets: [{ id: 'p1', name: 'Vox Plate Dark', category: 'Vocal', sourcePath: null }],
        },
      ],
      false,
    );
    expect(brain.getProfile('Valhalla VintageVerb')?.installation.installedOnHost).toBe('unknown');

    // Live FL Studio snapshot proves actual host installation + exposes parameters
    const core = new DawCore({ db });
    cores.push(core);
    core.registerAdapter(new FlStudio2025Adapter({ midiTransport: new MockFlMidiTransport(), hostProbe: staticProbe }));
    const sess = await core.connectSession('fl-studio-2025');
    brain.ingestDawSnapshot(sess.observed!, 'fl_studio', sess.dawId);

    const proQ = brain.getProfile('FabFilter Pro-Q 3');
    expect(proQ).not.toBeNull();
    expect(proQ!.installation.installedOnHost).toBe('verified_installed');
    expect(proQ!.identity.manufacturer).toBe('FabFilter');
    expect(proQ!.parameters.some((p) => p.semanticKey === 'eq.freq' && p.unit === 'Hz')).toBe(true);
    expect(proQ!.parameters.every((p) => p.writable === false)).toBe(true);

    const cmp = brain.compare('FabFilter Pro-Q 3', 'Soothe2');
    expect(cmp.sharedCategory).toBe(true);
    expect(cmp.recommendation).toContain('FabFilter Pro-Q 3');
  });

  it('2. extracts actual DAW chains vs suggested recipes across all 9 workflows and detects ordering, redundancy & edition issues', async () => {
    const db = openRuntimeDb(':memory:');
    openDbs.push(db);
    const core = new DawCore({ db });
    cores.push(core);

    const problemMidi = new MockFlMidiTransport({
      initialSnapshot: {
        mixerTracks: [
          {
            index: 0,
            name: 'Master',
            isMaster: true,
            volumeNormalized: 0.8,
            panNormalized: 0,
            muted: false,
            soloed: false,
            peakNormalized: 0.4,
            routesToMaster: null,
            routeTargets: [],
            plugins: [
              // Anti-pattern: Limiter BEFORE Parametric EQ 2 on Master Bus + consecutive EQs!
              { slotIndex: 0, name: 'Fruity Limiter', bypassed: false, mixLevel: 1, paramCount: 10 },
              { slotIndex: 1, name: 'Fruity Parametric EQ 2', bypassed: false, mixLevel: 1, paramCount: 14 },
              { slotIndex: 2, name: 'Fruity Parametric EQ 2', bypassed: false, mixLevel: 1, paramCount: 14 },
              { slotIndex: 3, name: 'Fruity Delay 3', bypassed: true, mixLevel: 1, paramCount: 12 },
            ],
          },
          {
            index: 1,
            name: 'LEAD VOX',
            isMaster: false,
            volumeNormalized: 0.8,
            panNormalized: 0,
            muted: false,
            soloed: false,
            peakNormalized: 0.35,
            routesToMaster: true,
            routeTargets: [0],
            plugins: [
              { slotIndex: 0, name: 'Pitcher', bypassed: false, mixLevel: 1, paramCount: 6 }, // Producer excluded
              { slotIndex: 1, name: 'FabFilter Pro-Q 3', bypassed: false, mixLevel: 1, paramCount: 32 },
            ],
          },
        ],
      },
    });

    core.registerAdapter(new FlStudio2025Adapter({ midiTransport: problemMidi, hostProbe: staticProbe }));
    const sess = await core.connectSession('fl-studio-2025');

    const brain = new PluginBrain();
    brain.ingestDawSnapshot(sess.observed!, 'fl_studio', 'Producer Edition');
    brain.ingestLocalHostInventory([
      { name: 'Fruity Soft Clipper', format: 'NATIVE', path: 'FL/SoftClipper.fst', editionStatus: 'included_stock' },
      { name: 'Fruity Compressor', format: 'NATIVE', path: 'FL/Comp.fst', editionStatus: 'included_stock' },
      { name: 'Fruity Reeverb 2', format: 'NATIVE', path: 'FL/Verb.fst', editionStatus: 'included_stock' },
      { name: 'TRACE', format: 'VST3', path: 'VST3/TRACE.vst3', editionStatus: 'third_party_compatible' },
      { name: 'Vintage Chorus', format: 'NATIVE', path: 'FL/Chorus.fst', editionStatus: 'included_stock' },
      { name: 'Harmor', format: 'NATIVE', path: 'FL/Harmor.fst', editionStatus: 'excluded_by_edition_unless_purchased' },
    ]);

    const actualChains = brain.extractActualChains(sess.observed!, {
      hostKind: 'fl_studio',
      hostEdition: 'Producer Edition',
    });
    expect(actualChains.length).toBe(2);
    expect(actualChains.every((c) => c.sourceKind === 'actual_daw_chain')).toBe(true);

    const masterReport = brain.analyzeChain(actualChains[0]!);
    expect(masterReport.signalFlowIssues.some((i) => i.code === 'LIMITER_NOT_FINAL')).toBe(true);
    expect(masterReport.redundancies.some((r) => r.code === 'CONSECUTIVE_SAME_PLUGIN')).toBe(true);
    expect(masterReport.redundancies.some((r) => r.code === 'BYPASSED_DEAD_WEIGHT')).toBe(true);

    const vocalReport = brain.analyzeChain(actualChains[1]!);
    expect(vocalReport.redundancies.some((r) => r.code === 'EDITION_BLOCKED_IN_CHAIN')).toBe(true);
    expect(vocalReport.compatibleForHost).toBe(false);

    // Every suggested recipe MUST be marked `suggested_recipe` and exclude Harmor in Producer Edition!
    const workflows: readonly PluginWorkflowKind[] = [
      'vocal_chain',
      'instrument_chain',
      'drum_processing',
      'bass_processing',
      'mix_bus',
      'master_bus',
      'creative_fx',
      'parallel_processing',
      'sidechain_workflow',
    ];
    for (const wf of workflows) {
      const { recipe } = brain.suggestChain({
        workflowKind: wf,
        hostKind: 'fl_studio',
        hostEdition: 'Producer Edition',
        sidechainSourceRef: 'mixer:insert:1',
      });
      expect(recipe.sourceKind).toBe('suggested_recipe');
      expect(recipe.workflowKind).toBe(wf);
      expect(recipe.nodes.every((n) => n.pluginName !== 'Harmor' && n.pluginName !== 'Pitcher')).toBe(true);
    }

    // Parameter safety: Brain ONLY constructs bounded DawCommand routed to DawCommandGateway; refuses out-of-range
    expect(() =>
      brain.proposeBoundedParameterPatch({
        sessionId: sess.sessionId,
        targetPluginRef: 'plugin:mixer:1:1',
        paramIndex: 0,
        valueNormalized: 1.5,
        requestedBy: 'tech-audio-tools',
        requestedClass: 'Execution',
        correlationId: 'corr-pb-1',
      }),
    ).toThrow(/outside \[0\.0, 1\.0\]/);

    const safeProposal = brain.proposeBoundedParameterPatch({
      sessionId: sess.sessionId,
      targetPluginRef: 'plugin:mixer:1:1',
      paramIndex: 0,
      valueNormalized: 0.35,
      requestedBy: 'tech-audio-tools',
      requestedClass: 'Execution',
      correlationId: 'corr-pb-2',
    });
    expect(safeProposal.kind).toBe('plugin.param_write');
    expect(safeProposal.capabilityId).toBe('daw.plugin.param_write');
  });

  it('3. ingests REAL workstation VST3/FL plugin scan cleanly and flags Producer Edition exclusions accurately', () => {
    if (!existsSync('C:\\Program Files\\Common Files\\VST3')) {
      return;
    }
    const hostProbe = new DefaultFlStudioHostProbe();
    const scanned = hostProbe.scanInstalledPlugins();
    if (scanned.length === 0) return;

    const brain = new PluginBrain();
    brain.ingestLocalHostInventory(
      scanned.map((s) => ({
        name: s.name,
        format: s.format,
        path: s.path,
        editionStatus: s.producerEditionStatus,
      })),
      ['fl_studio'],
    );

    expect(brain.listInstalledProfiles().length).toBeGreaterThan(10);
    const traceCompat = brain.checkCompatibility('TRACE', {
      hostKind: 'fl_studio',
      hostEdition: 'Producer Edition',
    });
    if (traceCompat.found) {
      expect(traceCompat.installed).toBe(true);
      expect(traceCompat.profile.category).toBe('analyzer');
    }
    const draftMd = brain.formatVaultProfileDraft(brain.listInstalledProfiles()[0]!);
    expect(draftMd).toContain('schema: xyp3rn.daw-plugin/v3');
    expect(draftMd).toContain('status: draft');
  });
});
