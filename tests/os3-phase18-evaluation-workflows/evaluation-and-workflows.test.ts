import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { createLocalDeterministicEmbedder, Os3SemanticIndex } from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import {
  FlStudio2025Adapter,
  inspectFlpProjectFile,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';
import {
  DefaultReaperHostProbe,
  inspectRppProjectFile,
  MockReaperBridgeTransport,
  ReaperAdapter,
  type ReaperHostEnvironment,
  type ReaperHostProbe,
} from '../../core/daw-adapters/reaper/index.ts';
import {
  AudioBrain,
  buildBalancedPassFixtureWav,
  buildClippedFixtureWav,
  createDawBrainToolRegistry,
  DAW_EVALUATION_CATEGORIES,
  DAW_PRODUCTION_WORKFLOWS,
  DawAgentTeam,
  DawCore,
  DawEvaluationEngine,
  DawSessionIntelligence,
  FakeDawAdapter,
  formatEvaluationReportMarkdown,
  loadDawWorkflowsFromVault,
  PluginBrain,
  writeDawAgentDefinitionsToDir,
  writeDawWorkflowDefinitionsToDir,
  type EvalProjectTarget,
} from '../../core/daw-brain/index.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { Os3WorkflowEngine, validateAndCompileOs3Workflow } from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const mockFlProbe = (online = true): FlStudioHostProbe => ({
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
      runningProcesses: online
        ? [{ pid: 6100, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' }]
        : [],
      midiInPorts: online ? [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }] : [],
      midiOutPorts: online ? [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }] : [],
      loopMidiInstalled: online,
      configuredInPortFound: online,
      configuredOutPortFound: online,
      controllerScriptPath: 'C:\\FL\\device_XYP3RNBrain.py',
      controllerScriptInstalled: online,
      userProjectsRoot: 'C:\\Projects',
      pluginDatabaseRoot: 'C:\\PluginDb',
      missingPrerequisites: online ? [] : ['Virtual MIDI loopback absent'],
      warnings: [],
    };
  },
  discoverProjects: () => ['C:\\Projects\\COLDINMYEYES.flp'],
  scanInstalledPlugins: () => [],
});

const mockRprProbe: ReaperHostProbe = {
  async probeHost(): Promise<ReaperHostEnvironment> {
    return {
      probedAt: new Date().toISOString(),
      installations: [
        {
          label: 'REAPER (x64)',
          installDir: 'C:\\Program Files\\REAPER (x64)',
          executablePath: 'C:\\Program Files\\REAPER (x64)\\reaper.exe',
          exists: true,
          fileVersion: '7.18.0.0',
          productVersion: '7.18',
          leftoverAssetFilesCount: 0,
        },
      ],
      runningProcesses: [{ pid: 6200, processName: 'reaper', executablePath: 'C:\\Program Files\\REAPER (x64)\\reaper.exe' }],
      appDataDir: 'C:\\AppData\\REAPER',
      appDataExists: true,
      reaperIniPath: 'C:\\AppData\\REAPER\\reaper.ini',
      reaperIniExists: true,
      luaBridgeScriptPath: 'C:\\AppData\\REAPER\\Scripts\\xyp3rn_reaper_bridge.lua',
      luaBridgeInstalled: true,
      webRemoteConfiguredPort: 8088,
      oscConfiguredPort: 8000,
      discoveredProjects: ['D:\\REAPER\\COLDINMYEYES.rpp'],
      missingPrerequisites: [],
      warnings: [],
    };
  },
  discoverProjects: () => ['D:\\REAPER\\COLDINMYEYES.rpp'],
  scanInstalledPlugins: () => [],
};

const SYNTH_EVAL_RPP = `<REAPER_PROJECT 0.1 "7.18/win64" 1732160000
  TEMPO 138 4 4
  <TRACK {11111111-1111-1111-1111-111111111111}
    NAME "Vocal Lead"
    VOLPAN 0.794328 0.0 -1 -1 1
    MAINSEND 1 0
  >
>`;

describe('Phase 18 — DAW Brain Evaluation Engine + Production Workflows', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const cores: DawCore[] = [];

  afterEach(() => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(os.tmpdir(), 'xyp3rn-os3-p18-'));
    tempDirs.push(dir);
    return dir;
  };

  it('1. validates and executes all 10 canonical DAW production workflows end-to-end via Os3WorkflowEngine', async () => {
    const dir = makeTempDir();
    const vaultRoot = join(dir, 'vault');
    const agentsDir = join(vaultRoot, '04_AGENTS');
    const dawWfDir = join(vaultRoot, '05_WORKFLOWS', 'DAW');
    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.mkdirSync(join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'), { recursive: true });

    const db = openRuntimeDb(join(dir, 'wf-runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({ vault, db, provider: createLocalDeterministicEmbedder(64) });
    const contextEngine = new Os3ContextEngine({ vault, db, structural, semantic });

    const core = new DawCore({ db });
    cores.push(core);
    core.registerAdapter(
      new FlStudio2025Adapter({
        midiTransport: new MockFlMidiTransport({ latencyMs: 1 }),
        hostProbe: mockFlProbe(true),
      }),
    );
    const sess = await core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' });

    const sessionIntelligence = new DawSessionIntelligence({ contextEngine });
    const pluginBrain = new PluginBrain();
    const audioBrain = new AudioBrain();

    const toolRegistry = createDawBrainToolRegistry({
      vault,
      db,
      core,
      sessionIntelligence,
      pluginBrain,
      audioBrain,
      contextEngine,
    });

    writeDawAgentDefinitionsToDir(agentsDir);
    const wfFiles = writeDawWorkflowDefinitionsToDir(dawWfDir);
    expect(DAW_PRODUCTION_WORKFLOWS).toHaveLength(10);
    expect(wfFiles).toHaveLength(10);

    await vault.scanVault({ full: true });
    for (const spec of DAW_PRODUCTION_WORKFLOWS) {
      const vRes = await vault.validate(`05_WORKFLOWS/DAW/${spec.name}.md`, { requireSchema: true });
      expect(vRes.ok).toBe(true);
    }

    const agentRegistry = new Os3VaultAgentRegistry({ agentsDir, toolRegistry });
    const orchestrator = new Os3Orchestrator({ db, agents: agentRegistry, tools: toolRegistry });
    const workflowEngine = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents: agentRegistry,
      tools: toolRegistry,
      orchestrator,
    });

    const loaded = await loadDawWorkflowsFromVault(vault, workflowEngine, '05_WORKFLOWS/DAW');
    expect(loaded).toHaveLength(10);

    // Prepare WAV fixtures on disk for audio & mastering workflows
    const passWavPath = join(dir, 'pass-master.wav');
    const clipWavPath = join(dir, 'clip-mix.wav');
    fs.writeFileSync(passWavPath, buildBalancedPassFixtureWav());
    fs.writeFileSync(clipWavPath, buildClippedFixtureWav());

    const runCases: readonly {
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly assertOut: (out: Record<string, unknown>) => void;
    }[] = [
      {
        name: 'daw-session-audit',
        input: { sessionId: sess.sessionId, hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect(out.hostAudit).toBeTruthy();
          expect(out.sessionReport).toBeTruthy();
          expect(out.context).toBeTruthy();
        },
      },
      {
        name: 'daw-vocal-session-prep',
        input: { sessionId: sess.sessionId, hostKind: 'fl_studio', hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect(out.suggestedVocalChain).toBeTruthy();
          expect(out.sessionReport).toBeTruthy();
        },
      },
      {
        name: 'daw-vocal-chain-analysis',
        input: { sessionId: sess.sessionId, hostKind: 'fl_studio', hostEdition: 'Producer Edition', audioFilePath: passWavPath },
        assertOut: (out) => {
          expect(out.chainAnalysis).toBeTruthy();
          expect(out.audioReport).toBeTruthy();
        },
      },
      {
        name: 'daw-mixing-prep',
        input: { sessionId: sess.sessionId, hostKind: 'fl_studio', hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect(out.sessionAndRouting).toBeTruthy();
          expect(out.fxChains).toBeTruthy();
        },
      },
      {
        name: 'daw-mix-diagnostics',
        input: { sessionId: sess.sessionId, audioFilePath: clipWavPath, hostKind: 'fl_studio', hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect((out.audioReport as { diagnostics: { overallVerdict: string } }).diagnostics.overallVerdict).toBe('CRITICAL');
        },
      },
      {
        name: 'daw-mastering-readiness',
        input: { sessionId: sess.sessionId, audioFilePath: passWavPath, hostKind: 'fl_studio', hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          const rep = out.masterAudioReport as {
            diagnostics: { overallVerdict: string; alerts: readonly { code: string; metric: string }[] };
          };
          expect(rep.diagnostics.overallVerdict).toBe('WARN');
          expect(rep.diagnostics.alerts.some((a) => a.code === 'RUBRIC_METRIC_OUT_OF_BOUNDS')).toBe(true);
          expect(out.masterChainRecommendation).toBeTruthy();
        },
      },
      {
        name: 'daw-plugin-chain-eval',
        input: { sessionId: sess.sessionId, hostKind: 'fl_studio', hostEdition: 'Producer Edition', pluginName: 'Harmor' },
        assertOut: (out) => {
          expect(out.singlePluginCheck).toBeTruthy();
        },
      },
      {
        name: 'daw-routing-audit',
        input: { sessionId: sess.sessionId, hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect(out.routingGraph).toBeTruthy();
        },
      },
      {
        name: 'daw-audio-quality-report',
        input: { audioFilePath: passWavPath, stage: 'master', sessionId: sess.sessionId },
        assertOut: (out) => {
          expect(out.dspReport).toBeTruthy();
          expect(out.criticReport).toBeTruthy();
        },
      },
      {
        name: 'daw-project-consistency-audit',
        input: { sessionId: sess.sessionId, hostEdition: 'Producer Edition' },
        assertOut: (out) => {
          expect(out.compatibility).toBeTruthy();
          expect(out.consistencyReport).toBeTruthy();
        },
      },
    ];

    for (const rc of runCases) {
      const exec = await workflowEngine.execute(rc.name, rc.input, {
        correlationId: `corr-eval-${rc.name}`,
      });
      expect(exec.status, `${rc.name}: ${JSON.stringify(exec.steps)}`).toBe('success');
      expect(exec.correlationId).toBe(`corr-eval-${rc.name}`);
      expect(exec.steps.some((s) => s.status === 'error')).toBe(false);
      rc.assertOut((exec.output ?? {}) as Record<string, unknown>);
    }

    // Verify invalid workflow binding (calling daw_gateway_execute from non-Execution agent) fails compilation strictly
    const badWf = validateAndCompileOs3Workflow(
      DAW_PRODUCTION_WORKFLOWS[0]!.yaml.replace('daw_host_compatibility_audit', 'daw_gateway_execute'),
      agentRegistry,
      toolRegistry,
      'bad.yaml',
    );
    expect(badWf.ok).toBe(false);
  });

  it('2. runs full 11-category evaluation benchmark across Fake, FL Studio 2025, REAPER & verified projects against baseline thresholds', async () => {
    const dir = makeTempDir();
    const synthRppPath = join(dir, 'eval_ground_truth.rpp');
    fs.writeFileSync(synthRppPath, SYNTH_EVAL_RPP, 'utf8');

    const projectTargets: EvalProjectTarget[] = [
      {
        datasetId: 'fxt-rpp-ground-truth',
        filePath: synthRppPath,
        inspectFn: inspectRppProjectFile,
        expectedSummary: { tempoBpm: 138, tracksCount: 1 },
        verifyParsed: (p: unknown) => {
          const r = p as ReturnType<typeof inspectRppProjectFile>;
          const bpm = r.tempoBpm.status === 'available' ? r.tempoBpm.value : null;
          const ok = bpm === 138 && r.tracks.length === 1;
          return { ok, actual: { tempoBpm: bpm, tracksCount: r.tracks.length }, error: ok ? undefined : 'RPP parse mismatch' };
        },
        notes: 'Manually authored .rpp tree ground truth: TEMPO 138, 1 track',
      },
    ];

    // If approved real workstation FLP projects exist locally, verify them read-only too!
    const realProject1 = join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio', 'Projects', 'Project_1', 'Project_1.flp');
    if (fs.existsSync(realProject1)) {
      projectTargets.push({
        datasetId: 'workstation-approved-project-1',
        filePath: realProject1,
        inspectFn: inspectFlpProjectFile,
        expectedSummary: { flVersion: '25.1.6.4997', hasFlexPlugin: true },
        verifyParsed: (p: unknown) => {
          const f = p as ReturnType<typeof inspectFlpProjectFile>;
          const ok = f.flVersion === '25.1.6.4997' && f.pluginNames.includes('FLEX');
          return { ok, actual: { flVersion: f.flVersion, plugins: f.pluginNames.slice(0, 5) }, error: ok ? undefined : 'FLP mismatch' };
        },
        notes: 'Real user-approved FL Studio 2025 project verified non-destructively',
      });
    }

    const engine = new DawEvaluationEngine();
    const report = await engine.runEvaluation({
      dbFactory: (p) => openRuntimeDb(p),
      adapterTargets: [
        {
          label: 'FakeDawAdapter',
          createAdapter: () => new FakeDawAdapter(),
          expectedHostKind: 'simulated',
          expectedTempoBpm: 140,
          expectedReachable: true,
          writableMixerTargetRef: 'mixer:insert:1',
          masterTargetRef: 'mixer:insert:0',
        },
        {
          label: 'FlStudio2025Adapter',
          createAdapter: () =>
            new FlStudio2025Adapter({
              executionProfile: 'controlled_safe_v1',
              midiTransport: new MockFlMidiTransport({ allowControlledWrites: true, latencyMs: 1 }),
              hostProbe: mockFlProbe(true),
            }),
          expectedHostKind: 'fl_studio',
          expectedTempoBpm: 138,
          expectedReachable: true,
          writableMixerTargetRef: 'mixer:insert:1',
          masterTargetRef: 'mixer:insert:0',
        },
        {
          label: 'ReaperAdapter',
          createAdapter: () =>
            new ReaperAdapter({
              executionProfile: 'controlled_safe_v1',
              transport: new MockReaperBridgeTransport({ latencyMs: 1 }),
              hostProbe: mockRprProbe,
            }),
          expectedHostKind: 'reaper',
          expectedTempoBpm: 138,
          expectedReachable: true,
          writableMixerTargetRef: 'reaper:mixer:0',
          masterTargetRef: 'reaper:mixer:master',
        },
      ],
      offlineTargets: [
        {
          label: 'OfflineReaperProbe',
          createAdapter: () =>
            new ReaperAdapter({
              hostProbe: new DefaultReaperHostProbe({
                installDirs: [{ label: 'Missing', dir: join(dir, 'no-reaper-here') }],
                appDataDir: join(dir, 'no-appdata'),
              }),
              hostUrl: 'http://127.0.0.1:59998/rpc',
            }),
          expectedHostKind: 'reaper',
          expectedTempoBpm: 138,
          expectedReachable: false,
        },
        {
          label: 'OfflineFlProbe',
          createAdapter: () =>
            new FlStudio2025Adapter({
              midiTransport: new MockFlMidiTransport({ portsPresent: false }),
              hostProbe: mockFlProbe(false),
            }),
          expectedHostKind: 'fl_studio',
          expectedTempoBpm: 138,
          expectedReachable: false,
        },
      ],
      projectTargets,
      agentTeamFactory: (core, db) => {
        const vRoot = join(dir, `eval-vault-${Math.random().toString(36).slice(2, 6)}`);
        fs.mkdirSync(vRoot, { recursive: true });
        const v = new VaultEngine({ vaultRoot: vRoot, db });
        return new DawAgentTeam({
          vault: v,
          db,
          core,
          sessionIntelligence: new DawSessionIntelligence(),
          pluginBrain: new PluginBrain(),
          audioBrain: new AudioBrain(),
        });
      },
    });

    // Verify all 11 categories evaluated & met baseline thresholds
    expect(report.categorySummaries).toHaveLength(11);
    expect(report.categorySummaries.map((c) => c.category)).toEqual([...DAW_EVALUATION_CATEGORIES]);
    expect(report.overallPassed, JSON.stringify(report.results.filter((r) => !r.passed), null, 2)).toBe(true);
    expect(report.failedCases).toBe(0);
    expect(report.overallAccuracy).toBe(1);
    expect(report.datasetManifest.length).toBeGreaterThanOrEqual(8);

    for (const res of report.results) {
      expect(res.provenance.datasetId).toBeTruthy();
      expect(res.evidence.length).toBeGreaterThan(0);
      expect(typeof res.confidence).toBe('number');
    }

    const md = formatEvaluationReportMarkdown(report);
    expect(md).toContain('# XYP3RN DAW Brain — Evaluation Benchmark Report');
    expect(md).toContain('Overall Verdict:** **PASS**');
  });

  it('3. never tunes thresholds or hides failing cases when a genuine discrepancy occurs', async () => {
    const engine = new DawEvaluationEngine();
    const brokenReport = await engine.runEvaluation({
      dbFactory: (p) => openRuntimeDb(p),
      customCases: [
        async () => ({
          caseId: 'injected-genuine-failure',
          category: 'daw_detection_accuracy',
          title: 'Buggy adapter misreporting host tempo / presence',
          provenance: {
            datasetId: 'adv-fail-check',
            sourceKind: 'manual_ground_truth',
            manuallyVerifiedBy: 'anti-goodhart-test',
            verifiedAt: new Date().toISOString(),
            notes: 'Must fail strictly without threshold lowering',
          },
          expectedOutput: { bpm: 138 },
          actualOutput: { bpm: 999 },
          error: 'Tempo observation discrepancy: expected 138, observed 999',
          confidence: 0,
          evidence: ['Observed deliberate discrepancy 138 vs 999'],
          passed: false,
          score: 0,
          limitations: [],
          durationMs: 1,
        }),
      ],
    });

    expect(brokenReport.overallPassed).toBe(false);
    expect(brokenReport.failedCases).toBe(1);
    expect(brokenReport.overallAccuracy).toBeLessThan(1);
    const detSum = brokenReport.categorySummaries.find((s) => s.category === 'daw_detection_accuracy')!;
    expect(detSum.meetsBaseline).toBe(false);
    expect(detSum.failedCases).toBe(1);
    expect(formatEvaluationReportMarkdown(brokenReport)).toContain('**FAIL**');
  });
});
