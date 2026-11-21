import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { traceMetrics, type TraceAnalysis } from '../../../tech/trace/analysis.ts';
import type { TraceBound, TraceCheck } from '../../../tech/trace/report.ts';
import type {
  AudioBrainRecommendation,
  AudioDiagnosticAlert,
  AudioDiagnosticReport,
  AudioDspFeatures,
} from './types.ts';

type MixRubricYamlShape = {
  readonly mix?: Readonly<Record<string, TraceBound>> | undefined;
  readonly master?: Readonly<Record<string, TraceBound>> | undefined;
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

export const loadDefaultMixRubricBounds = (
  stage: 'mix' | 'master',
  rubricFilePath?: string,
): { readonly bounds: Readonly<Record<string, TraceBound>>; readonly source: string } => {
  const candidates = rubricFilePath
    ? [rubricFilePath]
    : [path.resolve(process.cwd(), 'records', 'x3lius', 'mix-rubric.yaml')];

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseYaml(fs.readFileSync(p, 'utf8')) as MixRubricYamlShape | null;
      const stageMap = stage === 'master' ? parsed?.master : parsed?.mix;
      if (stageMap && typeof stageMap === 'object') {
        return { bounds: stageMap, source: p };
      }
    } catch {
      // Fall back cleanly if rubric YAML unreadable
    }
  }
  return { bounds: {}, source: 'none' };
};

/**
 * Stages 6 & 7 (Diagnostic Reasoning & Analysis-Only Recommendation Generation):
 * Evaluates clipping, true-peak ceiling, low-mid mud masking, sub-bass stereo width,
 * negative stereo phase correlation, over-limiting, silence/noise floor, and X3LIUS
 * mix/master rubric compliance without executing automatic DAW changes.
 */
export const runAudioDiagnosticsAndRecommendations = (input: {
  readonly stage: 'mix' | 'master';
  readonly features: AudioDspFeatures;
  readonly traceAnalysis: TraceAnalysis;
  readonly rubricBounds?: Readonly<Record<string, TraceBound>> | undefined;
  readonly rubricSource?: string | undefined;
}): {
  readonly diagnostics: AudioDiagnosticReport;
  readonly recommendations: readonly AudioBrainRecommendation[];
} => {
  const loaded = input.rubricBounds
    ? { bounds: input.rubricBounds, source: input.rubricSource ?? 'custom_rubric' }
    : loadDefaultMixRubricBounds(input.stage);

  const metrics = traceMetrics(input.traceAnalysis);
  const checks: TraceCheck[] = [];
  const unsetMetrics: string[] = [];

  for (const m of metrics) {
    const b = loaded.bounds[m.id];
    if (!b) {
      unsetMetrics.push(m.id);
      continue;
    }
    const action =
      b.min !== undefined && m.value < b.min
        ? ('raise' as const)
        : b.max !== undefined && m.value > b.max
          ? ('lower' as const)
          : ('keep' as const);
    const by =
      action === 'raise'
        ? round2((b.min ?? m.value) - m.value)
        : action === 'lower'
          ? round2(m.value - (b.max ?? m.value))
          : 0;
    checks.push({
      metric: m.id,
      unit: m.unit,
      measured: m.value,
      rubric: b,
      action,
      by,
      ref: `canonical_prompts:00000000-0000-0000-0000-000000000000#x3lius.${input.stage}.${m.id}`,
      version: 1,
    });
  }

  const alerts: AudioDiagnosticAlert[] = [];
  const recommendations: AudioBrainRecommendation[] = [];
  const { features } = input;
  const truePeak = features.truePeakDbtp.status === 'available' ? features.truePeakDbtp.value : input.traceAnalysis.loudness.truePeakDbtp;

  // 1. Hard sample clipping & > -1.0 dBTP true-peak check
  if (features.clipping.exceedsZeroDbfs || features.clipping.clippedSampleCount > 0) {
    alerts.push({
      code: 'HARD_SAMPLE_CLIPPING',
      severity: 'critical',
      metric: 'samplePeakDbfs',
      measured: features.samplePeakDbfs,
      summary: `Hard digital clipping detected (${features.clipping.clippedSampleCount} sample(s), samplePeak=${features.samplePeakDbfs} dBFS)`,
    });
  }
  if (truePeak > (input.stage === 'master' ? -1.0 : -3.0)) {
    const targetCeiling = input.stage === 'master' ? -1.0 : -6.0;
    const trimDb = round2(targetCeiling - truePeak);
    alerts.push({
      code: 'TRUE_PEAK_EXCEEDED',
      severity: truePeak > 0 ? 'critical' : 'warning',
      metric: 'loudness.true-peak-dbtp',
      measured: truePeak,
      summary: `True peak ${truePeak} dBTP exceeds safe ${input.stage} ceiling (${targetCeiling} dBTP)`,
    });
    recommendations.push({
      priority: 'high',
      actionType: 'gain_trim',
      title: `Trim ${input.stage} ceiling / pre-limiter gain`,
      rationale: `True peak ${truePeak} dBTP exceeds ${targetCeiling} dBTP headroom target`,
      targetMetric: 'loudness.true-peak-dbtp',
      suggestedDelta: `${trimDb} dB`,
      requiresApprovalOrManualAction: true,
    });
  }

  // 2. Low-mid masking mud check (`low-mid` vs `mid` / full band concentration)
  const lowMidDb = input.traceAnalysis.tonalBalanceDb['low-mid'];
  const midDb = input.traceAnalysis.tonalBalanceDb.mid;
  if (lowMidDb - midDb > 4.0 && lowMidDb > -6.0) {
    alerts.push({
      code: 'LOW_MID_MASKING_MUD',
      severity: 'warning',
      metric: 'tonal.low-mid-db',
      measured: lowMidDb,
      summary: `Excess low-mid concentration (low-mid=${lowMidDb} dB vs mid=${midDb} dB across 250–500 Hz)`,
    });
    recommendations.push({
      priority: 'medium',
      actionType: 'eq_attenuation',
      title: 'Attenuate 250–400 Hz low-mid buildup',
      rationale: `Low-mid band (${lowMidDb} dB) exceeds mid band (${midDb} dB) by ${round2(lowMidDb - midDb)} dB, risking vocal/bass masking`,
      targetMetric: 'tonal.low-mid-db',
      suggestedDelta: '-2.0 to -3.5 dB bell around 280-350 Hz',
      requiresApprovalOrManualAction: true,
    });
  }

  // 3. Stereo correlation & sub-bass mono compatibility check
  if (features.stereo.correlation < 0.05) {
    alerts.push({
      code: 'NEGATIVE_STEREO_CORRELATION',
      severity: 'critical',
      metric: 'stereo.correlation',
      measured: features.stereo.correlation,
      summary: `Severe phase cancellation risk (overall correlation=${features.stereo.correlation})`,
    });
    recommendations.push({
      priority: 'high',
      actionType: 'phase_polarity_check',
      title: 'Inspect L/R polarity and stereo widening plugins',
      rationale: `Overall stereo correlation (${features.stereo.correlation}) causes partial/full cancellation when summed to mono`,
      targetMetric: 'stereo.correlation',
      suggestedDelta: 'Invert phase on mismatched double or reduce Haas/widener delay',
      requiresApprovalOrManualAction: true,
    });
  }
  if (features.stereo.subWidthPct > 15) {
    alerts.push({
      code: 'SUB_STEREO_WIDTH_PHASE',
      severity: 'warning',
      metric: 'stereo.sub.width-pct',
      measured: features.stereo.subWidthPct,
      summary: `Wide sub-bass energy detected (sub.widthPct=${features.stereo.subWidthPct}%, subCorrelation=${features.stereo.subCorrelation})`,
    });
    recommendations.push({
      priority: 'medium',
      actionType: 'mono_sub_tightening',
      title: 'Mono-sum frequencies below 80 Hz',
      rationale: `Sub band side energy is ${features.stereo.subWidthPct}% (> 15% threshold)`,
      targetMetric: 'stereo.sub.width-pct',
      suggestedDelta: 'Mid/Side high-pass side channel at 80–90 Hz',
      requiresApprovalOrManualAction: true,
    });
  }

  // 4. Over-compression, silence & elevated noise floor
  if (features.silence.isEffectiveSilence) {
    alerts.push({
      code: 'SILENT_OR_TRUNCATED_RENDER',
      severity: 'critical',
      metric: 'rmsDbfs',
      measured: features.rmsDbfs,
      summary: `Render appears effectively silent (rms=${features.rmsDbfs} dBFS, silentFrameRatio=${features.silence.silentFrameRatio})`,
    });
  } else if (features.crestFactorDb < 4.5 && input.stage === 'master') {
    alerts.push({
      code: 'OVER_COMPRESSED_CREST',
      severity: 'warning',
      metric: 'dynamics.crest-factor-db',
      measured: features.crestFactorDb,
      summary: `Very low crest factor (${features.crestFactorDb} dB) indicates aggressive limiting/squashed transients`,
    });
    recommendations.push({
      priority: 'medium',
      actionType: 'limiter_relaxation',
      title: 'Relax bus compressor / master limiter input drive',
      rationale: `Crest factor dropped to ${features.crestFactorDb} dB (< 4.5 dB)`,
      targetMetric: 'dynamics.crest-factor-db',
      suggestedDelta: '+1.5 to +2.5 dB dynamic headroom recovery',
      requiresApprovalOrManualAction: true,
    });
  }

  for (const ck of checks) {
    if (ck.action !== 'keep') {
      alerts.push({
        code: 'RUBRIC_METRIC_OUT_OF_BOUNDS',
        severity: ck.metric === 'loudness.true-peak-dbtp' && ck.measured > -0.2 ? 'critical' : 'warning',
        metric: ck.metric,
        measured: ck.measured,
        summary: `Rubric check asks to ${ck.action} ${ck.metric} by ${ck.by} ${ck.unit} (measured=${ck.measured})`,
      });
    }
  }

  if (recommendations.length === 0 && alerts.length === 0) {
    recommendations.push({
      priority: 'low',
      actionType: 'keep_current_balance',
      title: 'No critical mix/master issues detected; maintain current gain staging',
      rationale: 'Loudness, crest factor, stereo phase, and spectral balance sit within healthy bounds',
      targetMetric: 'loudness.integrated-lufs',
      suggestedDelta: '0.0',
      requiresApprovalOrManualAction: true,
    });
  }

  const overallVerdict: AudioDiagnosticReport['overallVerdict'] = alerts.some((a) => a.severity === 'critical')
    ? 'CRITICAL'
    : alerts.some((a) => a.severity === 'warning')
      ? 'WARN'
      : 'PASS';

  return {
    diagnostics: {
      overallVerdict,
      stage: input.stage,
      alerts,
      checks,
      unsetMetrics,
      rubricSource: loaded.source,
    },
    recommendations,
  };
};
