import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqliteRuntimeDb } from '../../sqlite/client.ts';
import type { DawAgentTeam } from '../agents/daw-agent-team.ts';
import { AudioBrain } from '../audio-brain/audio-brain.ts';
import type { DawAdapter } from '../daw-adapter-sdk.ts';
import { DawCore } from '../daw-core.ts';
import { FakeDawAdapter } from '../fake-adapter.ts';
import { PluginBrain } from '../plugin-brain/plugin-brain.ts';
import { DawSessionIntelligence } from '../session-intelligence/session-intelligence.ts';
import type { DawCommand } from '../types.ts';
import {
  buildControlledEvalAudioSet,
  buildControlledOrphanSnapshot,
  DEFAULT_DAW_BASELINE_THRESHOLDS,
  sha256Buffer,
  verifyReadOnlyFileProvenance,
} from './fixtures.ts';
import {
  DAW_EVALUATION_CATEGORIES,
  type DawBaselineThresholds,
  type DawCategoryBenchmarkSummary,
  type DawEvaluationCaseResult,
  type DawEvaluationCategory,
  type DawEvaluationProvenance,
  type DawEvaluationReport,
} from './types.ts';

export type EvalAdapterTarget = {
  readonly label: string;
  readonly createAdapter: () => DawAdapter;
  readonly expectedHostKind: string;
  readonly expectedTempoBpm: number;
  readonly expectedReachable: boolean;
  readonly writableMixerTargetRef?: string | undefined;
  readonly masterTargetRef?: string | undefined;
  readonly expectedInitialInsertDb?: number | undefined;
};

export type EvalProjectTarget = {
  readonly datasetId: string;
  readonly filePath: string;
  readonly inspectFn: (filePath: string) => unknown;
  readonly verifyParsed: (parsed: unknown) => { readonly ok: boolean; readonly error?: string | undefined; readonly actual: unknown };
  readonly expectedSummary: unknown;
  readonly notes: string;
};

export type DawEvaluationRunInput = {
  readonly dbFactory: (filePath: string) => SqliteRuntimeDb;
  readonly adapterTargets?: readonly EvalAdapterTarget[] | undefined;
  readonly offlineTargets?: readonly EvalAdapterTarget[] | undefined;
  readonly projectTargets?: readonly EvalProjectTarget[] | undefined;
  readonly agentTeamFactory?: (core: DawCore, db: SqliteRuntimeDb) => DawAgentTeam;
  readonly thresholds?: Partial<DawBaselineThresholds> | undefined;
  readonly customCases?: readonly (() => Promise<DawEvaluationCaseResult>)[] | undefined;
};

const SYNTH_PROV = (datasetId: string, notes: string): DawEvaluationProvenance => ({
  datasetId,
  sourceKind: 'synthetic_fixture',
  manuallyVerifiedBy: 'phase-18-ground-truth',
  verifiedAt: new Date().toISOString(),
  notes,
});

const PLUGIN_CTRL_PROV = (datasetId: string, notes: string): DawEvaluationProvenance => ({
  datasetId,
  sourceKind: 'controlled_plugin_config',
  manuallyVerifiedBy: 'phase-18-plugin-ground-truth',
  verifiedAt: new Date().toISOString(),
  notes,
});

const MANUAL_TRUTH_PROV = (datasetId: string, notes: string): DawEvaluationProvenance => ({
  datasetId,
  sourceKind: 'manual_ground_truth',
  manuallyVerifiedBy: 'phase-18-rubric-ground-truth',
  verifiedAt: new Date().toISOString(),
  notes,
});

const timedCase = async (
  meta: {
    readonly caseId: string;
    readonly category: DawEvaluationCategory;
    readonly title: string;
    readonly provenance: DawEvaluationProvenance;
    readonly expectedOutput: unknown;
    readonly limitations?: readonly string[] | undefined;
  },
  fn: () => Promise<{
    readonly passed: boolean;
    readonly actualOutput: unknown;
    readonly error?: string | null | undefined;
    readonly confidence?: number | undefined;
    readonly score?: number | undefined;
    readonly evidence: readonly string[];
    readonly limitations?: readonly string[] | undefined;
  }>,
): Promise<DawEvaluationCaseResult> => {
  const t0 = Date.now();
  try {
    const out = await fn();
    return {
      caseId: meta.caseId,
      category: meta.category,
      title: meta.title,
      provenance: meta.provenance,
      expectedOutput: meta.expectedOutput,
      actualOutput: out.actualOutput,
      error: out.error ?? null,
      confidence: out.confidence ?? (out.passed ? 1.0 : 0.0),
      evidence: out.evidence,
      passed: out.passed,
      score: out.score ?? (out.passed ? 1.0 : 0.0),
      limitations: [...(meta.limitations ?? []), ...(out.limitations ?? [])],
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      caseId: meta.caseId,
      category: meta.category,
      title: meta.title,
      provenance: meta.provenance,
      expectedOutput: meta.expectedOutput,
      actualOutput: null,
      error: (err as Error).message,
      confidence: 0,
      evidence: [`Exception thrown: ${(err as Error).message}`],
      passed: false,
      score: 0,
      limitations: meta.limitations ?? [],
      durationMs: Date.now() - t0,
    };
  }
};

/**
 * Formats an immutable Markdown evaluation report strictly from verified case results.
 */
export const formatEvaluationReportMarkdown = (report: DawEvaluationReport): string => {
  const lines: string[] = [
    '# XYP3RN DAW Brain — Evaluation Benchmark Report (Phase 18)',
    '',
    `- **Report ID:** \`${report.reportId}\` (\`${report.schema}\`)`,
    `- **Generated At:** \`${report.generatedAt}\``,
    `- **Overall Verdict:** **${report.overallPassed ? 'PASS' : 'FAIL'}** (${report.passedCases}/${report.totalCases} passed, accuracy=${(report.overallAccuracy * 100).toFixed(1)}%)`,
    '',
    '## Category Summary vs Pre-Registered Baseline Thresholds',
    '',
    '| Category | Passed / Total | Accuracy | Min Baseline | Max Failures | Meets Baseline |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const s of report.categorySummaries) {
    lines.push(
      `| \`${s.category}\` | ${s.passedCases} / ${s.totalCases} | ${(s.accuracyRate * 100).toFixed(1)}% | ${(s.threshold.minAccuracy * 100).toFixed(1)}% | ${s.threshold.maxFailures} | ${s.meetsBaseline ? 'PASS' : 'FAIL'} |`,
    );
  }

  lines.push('', '## Detailed Case Results', '');
  lines.push('| Case ID | Category | Result | Confidence | Provenance Dataset | Error / Notes |');
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const c of report.results) {
    lines.push(
      `| \`${c.caseId}\` | \`${c.category}\` | ${c.passed ? 'PASS' : 'FAIL'} | ${c.confidence.toFixed(2)} | \`${c.provenance.datasetId}\` (\`${c.provenance.sourceKind}\`) | ${c.error ?? 'Verified'} |`,
    );
  }

  if (report.limitations.length > 0) {
    lines.push('', '## Declared Limitations', ...report.limitations.map((l) => `- ${l}`));
  }

  return lines.join('\n');
};

/**
 * Quantitative DAW Brain Evaluation Engine covering all 11 Phase 18 benchmark dimensions
 * without tuning thresholds or masking failed assertions.
 */
export class DawEvaluationEngine {
  async runEvaluation(input: DawEvaluationRunInput): Promise<DawEvaluationReport> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyp3rn-os3-p18-eval-'));
    const openDbs: SqliteRuntimeDb[] = [];
    const cores: DawCore[] = [];
    const results: DawEvaluationCaseResult[] = [];

    const thresholds: DawBaselineThresholds = {
      ...DEFAULT_DAW_BASELINE_THRESHOLDS,
      ...(input.thresholds ?? {}),
    };

    const mkCore = (name: string): { readonly db: SqliteRuntimeDb; readonly core: DawCore } => {
      const db = input.dbFactory(path.join(workDir, `${name}-${randomUUID().slice(0, 6)}.sqlite`));
      openDbs.push(db);
      const core = new DawCore({ db, staleThresholdMs: 500 });
      cores.push(core);
      return { db, core };
    };

    const defaultTarget: EvalAdapterTarget = {
      label: 'FakeDawAdapter (Default Simulated Target)',
      createAdapter: () => new FakeDawAdapter(),
      expectedHostKind: 'simulated',
      expectedTempoBpm: 140,
      expectedReachable: true,
      writableMixerTargetRef: 'mixer:insert:1',
      masterTargetRef: 'mixer:insert:0',
      expectedInitialInsertDb: -2.0,
    };

    const onlineTargets = input.adapterTargets?.length ? input.adapterTargets : [defaultTarget];
    const offlineTargets = input.offlineTargets ?? [
      {
        label: 'OfflineSimulatedAdapter',
        createAdapter: () => {
          const f = new FakeDawAdapter({ adapterId: 'fake-offline-check' });
          f.setOffline(true, 'Simulated DAW absent');
          return f;
        },
        expectedHostKind: 'simulated',
        expectedTempoBpm: 140,
        expectedReachable: false,
      },
    ];

    try {
      // ── 1. DAW Detection Accuracy ───────────────────────────────────────────
      for (const t of onlineTargets) {
        results.push(
          await timedCase(
            {
              caseId: `det-online-${t.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              category: 'daw_detection_accuracy',
              title: `Detect reachable host (${t.label})`,
              provenance: SYNTH_PROV(`adapter-${t.label}`, 'Adapter manifest & live discover() match expected host kind/reachability'),
              expectedOutput: { hostKind: t.expectedHostKind, reachable: t.expectedReachable },
            },
            async () => {
              const { core } = mkCore('det');
              const ad = t.createAdapter();
              core.registerAdapter(ad);
              const found = await core.discoverInstances();
              const inst = found[0] ?? null;
              const match = Boolean(inst && inst.hostKind === t.expectedHostKind && inst.reachable === t.expectedReachable);
              return {
                passed: match,
                actualOutput: inst ? { hostKind: inst.hostKind, version: inst.version, reachable: inst.reachable } : null,
                error: match ? null : `Expected reachable=${t.expectedReachable}, hostKind=${t.expectedHostKind}`,
                evidence: [`discoverInstances returned ${found.length} instance(s)`],
              };
            },
          ),
        );
      }

      for (const off of offlineTargets) {
        results.push(
          await timedCase(
            {
              caseId: `det-offline-${off.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              category: 'daw_detection_accuracy',
              title: `Detect offline / absent host accurately (${off.label})`,
              provenance: SYNTH_PROV(`offline-${off.label}`, 'Offline/absent DAW binary MUST report reachable=false and fail closed'),
              expectedOutput: { reachable: false },
            },
            async () => {
              const { core } = mkCore('det-off');
              const ad = off.createAdapter();
              core.registerAdapter(ad);
              const found = await core.discoverInstances();
              const first = found[0] ?? null;
              const pass = first === null || first.reachable === false;
              return {
                passed: pass,
                actualOutput: first ? { id: first.id, reachable: first.reachable } : { count: 0 },
                error: pass ? null : `Offline host incorrectly reported reachable=${String(first?.reachable)}`,
                evidence: [`Offline probe yielded count=${found.length}, reachable=${String(first?.reachable ?? false)}`],
              };
            },
          ),
        );
      }

      // ── 2. State Observation Accuracy ───────────────────────────────────────
      for (const t of onlineTargets) {
        results.push(
          await timedCase(
            {
              caseId: `obs-${t.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              category: 'state_observation_accuracy',
              title: `Observe live snapshot & explicit unavailability (${t.label})`,
              provenance: MANUAL_TRUTH_PROV(`obs-${t.label}`, 'Tempo, mixer availability & unsupported truthfulness match specification'),
              expectedOutput: { tempoBpm: t.expectedTempoBpm, mixerAvailable: true, digestPresent: true },
            },
            async () => {
              const { core } = mkCore('obs');
              const ad = t.createAdapter();
              core.registerAdapter(ad);
              const sess = await core.connectSession(ad.manifest.adapterId);
              const snap = sess.observed;
              const bpm = snap?.transport.tempo.bpm ?? null;
              const ok =
                snap !== null &&
                bpm === t.expectedTempoBpm &&
                snap.mixerChannels.status === 'available' &&
                Boolean(snap.stateDigest);
              return {
                passed: ok,
                actualOutput: {
                  bpm,
                  mixerStatus: snap?.mixerChannels.status,
                  automationStatus: snap?.automationLanes.status,
                },
                error: ok ? null : `Expected BPM=${t.expectedTempoBpm}, got ${String(bpm)}`,
                evidence: [`Observed snapshot digest ${snap?.stateDigest.slice(0, 12)}`],
              };
            },
          ),
        );
      }

      // Real / approved project file inspections when provided (preserves SHA-256)
      for (const pt of input.projectTargets ?? []) {
        results.push(
          await timedCase(
            {
              caseId: `proj-${pt.datasetId}`,
              category: 'state_observation_accuracy',
              title: `Read-only project file ground truth (${pt.datasetId})`,
              provenance: {
                datasetId: pt.datasetId,
                sourceKind: 'user_approved_project',
                sourcePath: pt.filePath,
                sha256: fs.existsSync(pt.filePath) ? sha256Buffer(fs.readFileSync(pt.filePath)) : undefined,
                manuallyVerifiedBy: 'phase-18-project-verifier',
                verifiedAt: new Date().toISOString(),
                notes: pt.notes,
              },
              expectedOutput: pt.expectedSummary,
            },
            async () => {
              const check = verifyReadOnlyFileProvenance(pt.filePath, pt.datasetId, pt.inspectFn, pt.notes);
              const ver = pt.verifyParsed(check.parsed);
              const ok = check.ok && ver.ok;
              return {
                passed: ok,
                actualOutput: { shaUnchanged: check.ok, ...(ver.actual as Record<string, unknown>) },
                error: !check.ok ? 'File SHA-256 changed after read-only inspection' : ver.error ?? null,
                evidence: [`shaBefore=${check.shaBefore.slice(0, 12)} shaAfter=${check.shaAfter.slice(0, 12)}`],
              };
            },
          ),
        );
      }

      // ── 3. Session Model Completeness ───────────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'sess-model-7-states',
            category: 'session_model_completeness',
            title: 'Verify 7-state session isolation, save drift detection, and staleness expiry',
            provenance: MANUAL_TRUTH_PROV('session-model-invariant', 'Observed/cached/stale/proposed/applied/saved/unknown & drift'),
            expectedOutput: { hasUnsavedAfterEdit: true, staleAfterMark: true, all7StatesTracked: true },
          },
          async () => {
            const { core } = mkCore('sess');
            const fake = new FakeDawAdapter();
            core.registerAdapter(fake);
            const s = await core.connectSession(fake.manifest.adapterId, { projectPath: 'D:\\Eval\\Session.sim' });
            core.setSavedProject(s.sessionId, { ...s.project, savedSha256: 'base-sha-1' });
            fake.mutateHostOutOfBand({ bpm: 146 });
            await core.refreshSession(s.sessionId);
            const afterEdit = core.sessions.getSession(s.sessionId)!;
            const drifted = afterEdit.hasUnsavedLiveChanges;
            core.sessions.markStale(s.sessionId, 'Eval expiry check');
            const afterStale = core.sessions.getSession(s.sessionId)!;

            const ok =
              drifted &&
              afterStale.stale &&
              afterStale.observed === null &&
              afterStale.cached !== null &&
              afterStale.saved?.savedSha256 === 'base-sha-1' &&
              afterStale.unknownFields.length > 0;
            return {
              passed: ok,
              actualOutput: {
                hasUnsavedLiveChanges: drifted,
                stale: afterStale.stale,
                hasCached: afterStale.cached !== null,
                unknownFieldsCount: afterStale.unknownFields.length,
              },
              error: ok ? null : 'Session 7-state invariants or drift tracking failed',
              evidence: [`unknownFields=[${afterStale.unknownFields.join(', ')}]`],
            };
          },
        ),
      );

      // ── 4. Plugin Identification Accuracy ───────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'plug-ident-producer-compat',
            category: 'plugin_identification_accuracy',
            title: 'Identify loaded plugins & Producer Edition compatibility/exclusions accurately',
            provenance: PLUGIN_CTRL_PROV('ctrl-plugin-orphan-set', 'Harmor excluded under Producer Edition; FabFilter Pro-Q 3 verified'),
            expectedOutput: { harmorCompatible: false, proQRole: 'subtractive_eq', chainsExtracted: 1 },
          },
          async () => {
            const pb = new PluginBrain();
            const snap = buildControlledOrphanSnapshot('eval-plug-1');
            pb.ingestDawSnapshot(snap, 'fl_studio', 'Producer Edition');
            const harmorCompat = pb.checkCompatibility('Harmor', { hostKind: 'fl_studio', hostEdition: 'Producer Edition' });
            const proQProfile = pb.getProfile('FabFilter Pro-Q 3');
            const chains = pb.extractActualChains(snap, { hostKind: 'fl_studio', hostEdition: 'Producer Edition' });
            const ok =
              harmorCompat.verdict === 'excluded_by_edition' &&
              proQProfile?.processingRoles.includes('subtractive_eq') === true &&
              chains.length === 1;
            return {
              passed: ok,
              actualOutput: {
                harmorVerdict: harmorCompat.verdict,
                proQRoles: proQProfile?.processingRoles ?? [],
                chainsExtracted: chains.length,
              },
              error: ok ? null : 'Plugin classification or Producer Edition exclusion check failed',
              evidence: [`Harmor verdict=${harmorCompat.verdict}, Pro-Q 3 roles=${proQProfile?.processingRoles.join(',')}`],
            };
          },
        ),
      );

      // ── 5. Parameter Interpretation Accuracy ────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'param-interp-bounds-and-flags',
            category: 'parameter_interpretation_accuracy',
            title: 'Verify parameter range [0..1] enforcement and readable/writable separation',
            provenance: PLUGIN_CTRL_PROV('ctrl-param-bounds', 'Bounded parameter patch rejects >1.0 and accepts normalized [0..1]'),
            expectedOutput: { outOfRangeBlocked: true, validPatchAccepted: true, writableDetected: true },
          },
          async () => {
            const pb = new PluginBrain();
            const snap = buildControlledOrphanSnapshot('eval-param-1');
            const plugs = snap.plugins.status === 'available' ? snap.plugins.value : [];
            const proQParams = plugs.find((p) => p.id === 'p-proq')?.parameters;
            const writableOk =
              proQParams?.status === 'available' &&
              proQParams.value[0]?.writable === true &&
              proQParams.value[0]?.valueNormalized === 0.25;

            let outOfRangeBlocked = false;
            try {
              pb.proposeBoundedParameterPatch({
                sessionId: 'eval-param-1',
                targetPluginRef: 'p-proq',
                paramIndex: 0,
                valueNormalized: 1.4,
                requestedBy: 'daw-operator',
                requestedClass: 'Execution',
                correlationId: 'corr-p-eval',
              });
            } catch {
              outOfRangeBlocked = true;
            }

            const validCmd = pb.proposeBoundedParameterPatch({
              sessionId: 'eval-param-1',
              targetPluginRef: 'p-proq',
              paramIndex: 0,
              valueNormalized: 0.42,
              requestedBy: 'daw-operator',
              requestedClass: 'Execution',
              correlationId: 'corr-p-eval-ok',
            });

            const ok = writableOk && outOfRangeBlocked && validCmd.params.valueNormalized === 0.42;
            return {
              passed: ok,
              actualOutput: { writableOk, outOfRangeBlocked, validNormalized: validCmd.params.valueNormalized },
              error: ok ? null : 'Parameter metadata or bounded normalization failed',
              evidence: ['Rejected 1.4 normalized float; verified writable param p0=0.25 -> proposed 0.42'],
            };
          },
        ),
      );

      // ── 6. Audio Analysis Accuracy ──────────────────────────────────────────
      const audioSet = buildControlledEvalAudioSet();
      const brain = new AudioBrain();

      const tonePath = path.join(workDir, 'tone-1khz.wav');
      const clipPath = path.join(workDir, 'clip.wav');
      const mudPath = path.join(workDir, 'mud.wav');
      const passPath = path.join(workDir, 'pass.wav');
      const invPath = path.join(workDir, 'inv.wav');
      fs.writeFileSync(tonePath, audioSet.toneWav.buf);
      fs.writeFileSync(clipPath, audioSet.clippedWav.buf);
      fs.writeFileSync(mudPath, audioSet.mudWav.buf);
      fs.writeFileSync(passPath, audioSet.passWav.buf);
      fs.writeFileSync(invPath, audioSet.invertedWav.buf);

      results.push(
        await timedCase(
          {
            caseId: 'audio-ref-1khz-analytical',
            category: 'audio_analysis_accuracy',
            title: 'Analytical 1000 Hz -6.02 dBFS sine wave DSP ground truth',
            provenance: audioSet.toneWav.provenance,
            expectedOutput: { samplePeakDbfs: -6.02, rmsDbfs: -9.03, correlation: 1.0, toleranceDb: 0.25 },
          },
          async () => {
            const rep = brain.analyzeAudioFile(tonePath, { stage: 'mix' });
            const peakErr = Math.abs(rep.features.samplePeakDbfs - -6.02);
            const rmsErr = Math.abs(rep.features.rmsDbfs - -9.03);
            const corrErr = Math.abs(rep.features.stereo.correlation - 1.0);
            const mirLabelled = rep.mir.status === 'available' && rep.mir.value.probabilistic === true;
            const ok = peakErr <= 0.15 && rmsErr <= 0.25 && corrErr <= 0.02 && mirLabelled;
            return {
              passed: ok,
              actualOutput: {
                samplePeakDbfs: rep.features.samplePeakDbfs,
                rmsDbfs: rep.features.rmsDbfs,
                correlation: rep.features.stereo.correlation,
                mirProbabilistic: mirLabelled,
              },
              error: ok ? null : `DSP residual peakErr=${peakErr.toFixed(3)}, rmsErr=${rmsErr.toFixed(3)}, corrErr=${corrErr.toFixed(3)}`,
              evidence: [`samplePeak=${rep.features.samplePeakDbfs} dBFS, rms=${rep.features.rmsDbfs} dBFS, corr=${rep.features.stereo.correlation}`],
            };
          },
        ),
      );

      results.push(
        await timedCase(
          {
            caseId: 'audio-clip-mud-pass-phase',
            category: 'audio_analysis_accuracy',
            title: 'Audio diagnostics verdict accuracy (clip, mud, pass & L=-R phase inversion)',
            provenance: audioSet.clippedWav.provenance,
            expectedOutput: { clipVerdict: 'CRITICAL', mudAlert: 'LOW_MID_MASKING_MUD', passVerdict: 'PASS', invertedCorr: -1.0 },
          },
          async () => {
            const clipRep = brain.analyzeAudioFile(clipPath, { stage: 'master' });
            const mudRep = brain.analyzeAudioFile(mudPath, { stage: 'mix' });
            const passRep = brain.analyzeAudioFile(passPath, {
              stage: 'master',
              rubricBounds: {
                'loudness.true-peak-dbtp': { max: -1.0 },
                'dynamics.crest-factor-db': { min: 5.5 },
                'stereo.correlation': { min: 0.15 },
                'stereo.sub.width-pct': { max: 10 },
              },
            });
            const invRep = brain.analyzeAudioFile(invPath, { stage: 'mix' });
            const ok =
              clipRep.diagnostics.overallVerdict === 'CRITICAL' &&
              mudRep.diagnostics.alerts.some((a) => a.code === 'LOW_MID_MASKING_MUD') &&
              passRep.diagnostics.overallVerdict === 'PASS' &&
              invRep.features.stereo.correlation <= -0.95 &&
              invRep.diagnostics.alerts.some((a) => a.code === 'NEGATIVE_STEREO_CORRELATION');
            return {
              passed: ok,
              actualOutput: {
                clipVerdict: clipRep.diagnostics.overallVerdict,
                mudAlerts: mudRep.diagnostics.alerts.map((a) => a.code),
                passVerdict: passRep.diagnostics.overallVerdict,
                invertedCorr: invRep.features.stereo.correlation,
                invertedAlerts: invRep.diagnostics.alerts.map((a) => a.code),
              },
              error: ok ? null : 'One or more reference acoustic diagnostics misclassified',
              evidence: [
                `clip=${clipRep.diagnostics.overallVerdict}`,
                `pass=${passRep.diagnostics.overallVerdict}`,
                `invCorr=${invRep.features.stereo.correlation}`,
              ],
            };
          },
        ),
      );

      // ── 7. Routing Interpretation Accuracy ──────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'routing-orphan-and-chain-graph',
            category: 'routing_interpretation_accuracy',
            title: 'Detect Master routing edges, dead-end buses, and isolated orphan mixer inserts accurately',
            provenance: SYNTH_PROV(
              'ctrl-orphan-routing',
              'Insert 2 OrphanFX dead-ends without reaching Master; Insert 3 IsolatedUnusedFX has zero incoming/outgoing links',
            ),
            expectedOutput: { orphanNodeIds: ['mixer:insert:3'], disconnectedSourceIds: ['mixer:insert:2'] },
          },
          async () => {
            const si = new DawSessionIntelligence();
            const snap = buildControlledOrphanSnapshot('eval-route-1');
            const rep = await si.analyzeSnapshot(snap, {
              sessionId: 'eval-route-1',
              project: {
                projectId: 'proj-eval',
                name: 'OrphanTest',
                format: '.sim',
                projectPath: null,
                savedSha256: null,
                lastSavedAt: null,
                editionRequirement: 'Standard',
                tempo: { bpm: 138, freshness: 'observed' },
                timeSignature: { numerator: 4, denominator: 4 },
              },
              adapterId: 'synthetic-eval',
              hostKind: 'simulated',
              hostName: 'EvalFixture',
              hostVersion: '1.0.0',
              edition: 'Standard',
              versionCompatibility: 'compatible',
              stale: false,
              hasUnsavedLiveChanges: false,
              unknownFields: [],
            });
            const ok =
              rep.routingGraph.observabilityStatus === 'complete' &&
              rep.routingGraph.orphanNodeIds.includes('mixer:insert:3') &&
              rep.routingGraph.disconnectedSourceIds.includes('mixer:insert:2');
            return {
              passed: ok,
              actualOutput: {
                observability: rep.routingGraph.observabilityStatus,
                orphanNodeIds: rep.routingGraph.orphanNodeIds,
                disconnectedSourceIds: rep.routingGraph.disconnectedSourceIds,
              },
              error: ok ? null : 'Routing graph failed to detect isolated orphan insert and disconnected dead-end bus',
              evidence: [
                `edges=${rep.routingGraph.edges.length}`,
                `orphans=[${rep.routingGraph.orphanNodeIds.join(', ')}]`,
                `disconnectedSources=[${rep.routingGraph.disconnectedSourceIds.join(', ')}]`,
              ],
            };
          },
        ),
      );

      // ── 8. Agent Recommendation Quality ─────────────────────────────────────
      if (input.agentTeamFactory) {
        results.push(
          await timedCase(
            {
              caseId: 'agent-team-routing-and-grounding',
              category: 'agent_recommendation_quality',
              title: 'Verify specialist selection, analyze-by-default isolation, grounded recs & Execution gating',
              provenance: MANUAL_TRUTH_PROV('agent-contract-matrix', 'Non-Execution classes must escalate; analyze emits zero unsolicited recs'),
              expectedOutput: { analyzeRecs: 0, clipRecommendCountMin: 1, nonExecBlocked: true },
            },
            async () => {
              const { db, core } = mkCore('ag');
              const ad = onlineTargets[0]!.createAdapter();
              core.registerAdapter(ad);
              const sess = await core.connectSession(ad.manifest.adapterId);
              const team = input.agentTeamFactory!(core, db);

              const selVocal = team.selectAgentForTask('Audit lead vocal tuning and de-ess vocal balance').name;
              const selExec = team.selectAgentForTask('Execute prepared trim', 'execute_with_approval').name;
              const defRun = await team.runTask({
                agentName: 'daw-session-analyst',
                goal: 'Inspect live session',
                sessionId: sess.sessionId,
              });
              const recRun = await team.runTask({
                agentName: 'daw-audio-quality-analyst',
                goal: 'Evaluate master clipping',
                mode: 'recommend',
                audioFilePath: clipPath,
              });
              const nonExecPrep = await team.runTask({
                agentName: 'daw-mixing-engineer',
                goal: 'Try unauthorized mutation',
                mode: 'prepare',
                sessionId: sess.sessionId,
              });

              const ok =
                selVocal === 'daw-vocal-engineer' &&
                selExec === 'daw-operator' &&
                defRun.ok &&
                defRun.mode === 'analyze' &&
                defRun.recommendations.length === 0 &&
                recRun.ok &&
                recRun.recommendations.length >= 1 &&
                recRun.evidence.some((e) => e.includes('verdict=CRITICAL')) &&
                !nonExecPrep.ok &&
                nonExecPrep.error?.code === 'DAW_PERMISSION_DENIED' &&
                nonExecPrep.escalatedTo === 'daw-operator';
              return {
                passed: ok,
                actualOutput: {
                  selVocal,
                  selExec,
                  defaultAnalyzeRecs: defRun.recommendations.length,
                  clipRecs: recRun.recommendations.length,
                  nonExecErr: nonExecPrep.error?.code,
                },
                error: ok ? null : 'Agent team selection, grounding, or Execution class isolation failed',
                evidence: recRun.evidence,
              };
            },
          ),
        );
      }

      // ── 9. Command Validation Correctness ───────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'cmd-validation-safety-and-policy',
            category: 'command_validation_correctness',
            title: 'Reject out-of-range gain, Master >0 dBFS, non-allowlisted, stale & project mismatch commands',
            provenance: MANUAL_TRUTH_PROV('gateway-validation-suite', 'Default-deny policy rejects unsafe & mismatched commands cleanly'),
            expectedOutput: { allInvalidRejected: true },
          },
          async () => {
            const { core } = mkCore('val');
            const fake = new FakeDawAdapter();
            core.registerAdapter(fake);
            const sess = await core.connectSession(fake.manifest.adapterId, { projectPath: 'D:\\Safe\\Proj.sim' });
            const lease = core.grantSessionLease({
              sessionId: sess.sessionId,
              maxPermission: 'rollback',
              grantedBy: 'blago-operator',
              allowedTargets: ['*'],
              ttlMs: 60_000,
            });

            const expectReject = async (cmd: DawCommand, code: string): Promise<boolean> => {
              try {
                await core.prepareCommand(cmd, { leaseId: lease.id });
                return false;
              } catch (e) {
                return (e as { code?: string }).code === code;
              }
            };

            const baseCmd = (over: Partial<DawCommand>): DawCommand => ({
              commandId: `val-${randomUUID().slice(0, 6)}`,
              sessionId: sess.sessionId,
              kind: 'mixer.volume_pan_mute',
              capabilityId: 'daw.mixer.fader_pan_mute',
              targetRef: 'mixer:insert:1',
              params: { deltaDb: -1.0 },
              requestedBy: 'daw-operator',
              requestedClass: 'Execution',
              correlationId: 'corr-val-eval',
              createdAt: new Date().toISOString(),
              ...over,
            });

            const checks = {
              gainClamp: await expectReject(baseCmd({ params: { deltaDb: 5.0 } }), 'DAW_SAFETY_VIOLATION'),
              masterBoost: await expectReject(baseCmd({ targetRef: 'mixer:insert:0', params: { volumeDb: 2.0 } }), 'DAW_SAFETY_VIOLATION'),
              projectMismatch: await expectReject(baseCmd({ expectedProjectPath: 'D:\\Safe\\OTHER.sim' }), 'DAW_PROJECT_MISMATCH'),
              nonAllowlisted: await expectReject(
                baseCmd({ kind: 'plugin.param_write', capabilityId: 'daw.plugin.param_write', targetRef: 'plug-sim-eq-1', params: { paramIndex: 0, valueNormalized: 0.4 } }),
                'DAW_ACTION_NOT_ALLOWLISTED',
              ),
              unsupported: await expectReject(
                baseCmd({ kind: 'plugin.load_remove', capabilityId: 'daw.plugin.load_remove' }),
                'DAW_CAPABILITY_UNSUPPORTED',
              ),
              classDeny: await expectReject(baseCmd({ requestedClass: 'Creative' }), 'DAW_PERMISSION_DENIED'),
            };

            const passedCount = Object.values(checks).filter(Boolean).length;
            const total = Object.keys(checks).length;
            return {
              passed: passedCount === total,
              score: passedCount / total,
              actualOutput: checks,
              error: passedCount === total ? null : `Validation failures: ${JSON.stringify(checks)}`,
              evidence: [`Verified ${passedCount}/${total} safety & policy refusal gates`],
            };
          },
        ),
      );

      // ── 10. Execution Reliability ───────────────────────────────────────────
      for (const t of onlineTargets) {
        results.push(
          await timedCase(
            {
              caseId: `exec-rel-${t.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              category: 'execution_reliability',
              title: `End-to-end dry-run, approval, postcondition readback & duplicate block (${t.label})`,
              provenance: MANUAL_TRUTH_PROV(`exec-rel-${t.label}`, 'Single-shot execution verifies readback & deduplicates replays'),
              expectedOutput: { ok: true, postconditionVerified: true, duplicateBlocked: true },
            },
            async () => {
              const { db, core } = mkCore('exec');
              const ad = t.createAdapter();
              core.registerAdapter(ad);
              const sess = await core.connectSession(ad.manifest.adapterId);
              const lease = core.grantSessionLease({
                sessionId: sess.sessionId,
                maxPermission: 'rollback',
                grantedBy: 'blago-operator',
                allowedTargets: ['*'],
                ttlMs: 60_000,
              });

              const cmd: DawCommand = {
                commandId: `eval-exec-${randomUUID().slice(0, 8)}`,
                sessionId: sess.sessionId,
                kind: 'mixer.volume_pan_mute',
                capabilityId: 'daw.mixer.fader_pan_mute',
                targetRef: t.writableMixerTargetRef ?? 'mixer:insert:1',
                params: { deltaDb: -1.5 },
                idempotencyKey: `idem-eval-${randomUUID().slice(0, 6)}`,
                requestedBy: 'daw-operator',
                requestedClass: 'Execution',
                correlationId: 'corr-eval-exec',
                createdAt: new Date().toISOString(),
              };

              const dry = await core.dryRunCommand(cmd, { leaseId: lease.id });
              const prep = await core.prepareCommand(cmd, { leaseId: lease.id, queueApproval: true });
              db.decideApproval({
                approvalId: prep.approvalId!,
                decision: 'approved',
                approver: 'blago-operator',
                reason: 'Eval execution check',
              });
              const execRes = await core.executeCommand(prep.prepareId, {
                actor: 'daw-operator',
                approvalId: prep.approvalId!,
                leaseId: lease.id,
              });
              const dupRes = await core.executeCommand(
                { ...cmd, commandId: `${cmd.commandId}-replay` },
                { actor: 'daw-operator', approvalId: prep.approvalId!, leaseId: lease.id },
              );

              const ok =
                dry.ok &&
                execRes.ok &&
                execRes.postconditionVerified === true &&
                execRes.verifiedByReadback &&
                !dupRes.ok &&
                dupRes.error?.code === 'DAW_DUPLICATE_COMMAND';
              return {
                passed: ok,
                actualOutput: {
                  dryRunOk: dry.ok,
                  execOk: execRes.ok,
                  postconditionVerified: execRes.postconditionVerified,
                  dupCode: dupRes.error?.code,
                },
                error: ok ? null : 'Execution postcondition or duplicate protection failed',
                evidence: [`receipt=${execRes.receiptId}`, `dupCode=${dupRes.error?.code}`],
              };
            },
          ),
        );
      }

      // ── 11. Recovery Behavior ───────────────────────────────────────────────
      results.push(
        await timedCase(
          {
            caseId: 'rec-rollback-and-timeout-comp',
            category: 'recovery_behavior',
            title: 'Verify exact beforeState rollback, timeout partial-mutation recovery & cancellation',
            provenance: SYNTH_PROV('recovery-fault-injection', 'Timeout partial mutation must restore initial -2.0 dB via rollback_restored'),
            expectedOutput: { manualRbRestored: -2.0, timeoutCompStrategy: 'rollback_restored', timeoutRestoredDb: -2.0 },
          },
          async () => {
            const { db, core } = mkCore('rec');
            const fake = new FakeDawAdapter();
            core.registerAdapter(fake);
            const sess = await core.connectSession(fake.manifest.adapterId);
            const lease = core.grantSessionLease({
              sessionId: sess.sessionId,
              maxPermission: 'rollback',
              grantedBy: 'blago-operator',
              allowedTargets: ['*'],
              ttlMs: 60_000,
            });
            const appr = db.queueApproval({
              itemType: 'artifact_version',
              itemId: 'daw:eval-rec',
              proposer: 'daw-operator',
              request: { targetRef: 'mixer:insert:1' },
            });
            db.decideApproval({ approvalId: appr.id, decision: 'approved', approver: 'blago-operator', reason: 'Eval recovery' });

            // 1. Clean execute -> rollback restores exact -2.0 dB
            const prep = await core.prepareCommand(
              {
                commandId: 'eval-rec-rb-1',
                sessionId: sess.sessionId,
                kind: 'mixer.volume_pan_mute',
                capabilityId: 'daw.mixer.fader_pan_mute',
                targetRef: 'mixer:insert:1',
                params: { deltaDb: -1.5 },
                requestedBy: 'daw-operator',
                requestedClass: 'Execution',
                correlationId: 'corr-eval-rb',
                createdAt: new Date().toISOString(),
              },
              { leaseId: lease.id },
            );
            const execOk = await core.executeCommand(prep.prepareId, { actor: 'daw-operator', approvalId: appr.id, leaseId: lease.id });
            const rb = await core.rollbackCommand(execOk.receiptId!, { actor: 'blago-operator', leaseId: lease.id });
            const rbSnap = core.sessions.getSession(sess.sessionId)!.observed!;
            const rbVol = rbSnap.mixerChannels.status === 'available'
              ? rbSnap.mixerChannels.value.find((m) => m.index === 1)?.volumeDb
              : null;

            // 2. Timeout + partial write -> auto-compensating recovery restores -2.0 dB
            const apprTo = db.queueApproval({
              itemType: 'artifact_version',
              itemId: 'daw:eval-rec-to',
              proposer: 'daw-operator',
              request: { targetRef: 'mixer:insert:1' },
            });
            db.decideApproval({ approvalId: apprTo.id, decision: 'approved', approver: 'blago-operator', reason: 'Eval timeout recovery' });
            fake.setExecuteDelayMs(110);
            fake.setMutateBeforeTimeoutOrHang(true);
            const toRes = await core.executeCommand(
              {
                commandId: 'eval-rec-to-1',
                sessionId: sess.sessionId,
                kind: 'mixer.volume_pan_mute',
                capabilityId: 'daw.mixer.fader_pan_mute',
                targetRef: 'mixer:insert:1',
                params: { deltaDb: 1.5 },
                timeoutMs: 25,
                requestedBy: 'daw-operator',
                requestedClass: 'Execution',
                correlationId: 'corr-eval-to',
                createdAt: new Date().toISOString(),
              },
              { actor: 'daw-operator', approvalId: apprTo.id, leaseId: lease.id },
            );
            await new Promise((r) => setTimeout(r, 130));
            fake.setExecuteDelayMs(0);
            fake.setMutateBeforeTimeoutOrHang(false);
            const postToSnap = await core.refreshSession(sess.sessionId);
            const postToVol = postToSnap?.mixerChannels.status === 'available'
              ? postToSnap.mixerChannels.value.find((m) => m.index === 1)?.volumeDb
              : null;

            const ok =
              rb.ok &&
              rbVol === -2.0 &&
              toRes.error?.code === 'DAW_TIMEOUT' &&
              toRes.recovery?.strategy === 'rollback_restored' &&
              postToVol === -2.0;
            return {
              passed: ok,
              actualOutput: { rbVol, timeoutStrategy: toRes.recovery?.strategy, postToVol },
              error: ok ? null : 'Rollback or timeout compensating recovery failed',
              evidence: [`manualRbVol=${rbVol}`, `timeoutRecovery=${toRes.recovery?.strategy}`, `postToVol=${postToVol}`],
            };
          },
        ),
      );

      // Run any injected custom evaluation cases strictly without tuning or hiding results
      for (const custom of input.customCases ?? []) {
        results.push(await custom());
      }

      // Build honest category summaries against baseline thresholds
      const categorySummaries: DawCategoryBenchmarkSummary[] = DAW_EVALUATION_CATEGORIES.map((category) => {
        const catCases = results.filter((r) => r.category === category);
        const totalCases = catCases.length;
        const passedCases = catCases.filter((c) => c.passed).length;
        const failedCases = totalCases - passedCases;
        const accuracyRate = totalCases > 0 ? Number((passedCases / totalCases).toFixed(4)) : 0;
        const meanScore =
          totalCases > 0
            ? Number((catCases.reduce((s, c) => s + c.score, 0) / totalCases).toFixed(4))
            : 0;
        const threshold = thresholds[category];
        const meetsBaseline =
          totalCases > 0 && accuracyRate >= threshold.minAccuracy && failedCases <= threshold.maxFailures;

        return {
          category,
          totalCases,
          passedCases,
          failedCases,
          accuracyRate,
          meanScore,
          threshold,
          meetsBaseline,
        };
      });

      const totalCases = results.length;
      const passedCases = results.filter((r) => r.passed).length;
      const failedCases = totalCases - passedCases;
      const overallAccuracy = totalCases > 0 ? Number((passedCases / totalCases).toFixed(4)) : 0;
      const overallPassed = categorySummaries.every((s) => s.meetsBaseline);

      const provMap = new Map<string, DawEvaluationProvenance>();
      for (const r of results) {
        if (!provMap.has(r.provenance.datasetId)) {
          provMap.set(r.provenance.datasetId, r.provenance);
        }
      }

      const limitations = [...new Set(results.flatMap((r) => r.limitations))];

      return {
        reportId: `eval-${randomUUID().slice(0, 8)}`,
        schema: 'xyp3rn.daw-eval/v1',
        generatedAt: new Date().toISOString(),
        overallPassed,
        overallAccuracy,
        totalCases,
        passedCases,
        failedCases,
        thresholds,
        categorySummaries,
        results,
        datasetManifest: [...provMap.values()],
        limitations,
      };
    } finally {
      while (cores.length > 0) cores.pop()?.dispose();
      while (openDbs.length > 0) openDbs.pop()?.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
