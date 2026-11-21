import { randomUUID } from 'node:crypto';
import type { SqliteRuntimeDb } from '../../sqlite/client.ts';
import type { TraceAnalysis } from '../../../tech/trace/analysis.ts';
import type { TraceBound } from '../../../tech/trace/report.ts';
import {
  acquireExternalTraceAnalysis,
  acquireVerifiedPcmStream,
  acquireWavFileReadOnly,
  assertNoUnsupportedDawAudioTap,
  decodeWavBuffer,
} from './acquisition-decoder.ts';
import { runAudioDiagnosticsAndRecommendations } from './diagnostics-engine.ts';
import { runAudioDspAnalysis } from './dsp-analyzer.ts';
import { createDefaultDspConfig, linearToDb, type DspConfig } from './dsp-interfaces.ts';
import { runAudioMirAnalysis } from './mir-analyzer.ts';
import type {
  AudioBrainAnalysisReport,
  AudioDspFeatures,
  AudioInputSourceKind,
  DecodedAudioBuffer,
} from './types.ts';

export type AnalyzeAudioOptions = {
  readonly stage?: 'mix' | 'master' | undefined;
  readonly sourceKind?: Extract<AudioInputSourceKind, 'user_file' | 'approved_render'> | undefined;
  readonly dspConfigPatch?: Partial<DspConfig> | undefined;
  readonly rubricBounds?: Readonly<Record<string, TraceBound>> | undefined;
  readonly rubricSource?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly db?: SqliteRuntimeDb | null | undefined;
};

/**
 * XYP3RN Audio Brain — strictly analysis-only audio & DSP intelligence subsystem.
 * Separates acquisition, decoding, DSP extraction, probabilistic MIR, diagnostics,
 * and non-mutating recommendations while preserving input hashes and provenance.
 */
export class AudioBrain {
  analyzeAudioFile(filePath: string, options: AnalyzeAudioOptions = {}): AudioBrainAnalysisReport {
    const stage = options.stage ?? 'master';
    const { bytes, acquisition } = acquireWavFileReadOnly(filePath, options.sourceKind ?? 'user_file');
    const decoded = decodeWavBuffer(bytes);
    return this.#runPcmPipeline({
      acquisition,
      decoded,
      stage,
      options,
    });
  }

  analyzeVerifiedStream(
    streamInput: {
      readonly streamId: string;
      readonly label: string;
      readonly sampleRateHz: number;
      readonly channelData: readonly Float32Array[];
    },
    options: AnalyzeAudioOptions = {},
  ): AudioBrainAnalysisReport {
    const { decoded, acquisition } = acquireVerifiedPcmStream(streamInput);
    return this.#runPcmPipeline({
      acquisition,
      decoded,
      stage: options.stage ?? 'mix',
      options,
    });
  }

  analyzeExternalTrace(
    tracePayload: unknown,
    options: AnalyzeAudioOptions & { readonly label?: string | undefined } = {},
  ): AudioBrainAnalysisReport {
    const { trace, acquisition } = acquireExternalTraceAnalysis(tracePayload, options.label);
    const stage = options.stage ?? trace.subject.stage;

    // Derive honest partial DSP view directly from TraceAnalysis without inventing waveform-only fields
    const features: AudioDspFeatures = {
      samplePeakDbfs: Math.min(0, trace.loudness.truePeakDbtp),
      truePeakDbtp: { status: 'available', value: trace.loudness.truePeakDbtp },
      rmsDbfs: Number((trace.loudness.integratedLufs - 0.5).toFixed(2)),
      crestFactorDb: trace.dynamics.crestFactorDb,
      dynamicRangeDb: trace.loudness.rangeLu,
      dcOffset: 0,
      loudness: {
        integratedLufs: trace.loudness.integratedLufs,
        shortTermMaxLufs: trace.loudness.shortTermMaxLufs,
        momentaryMaxLufs: trace.loudness.momentaryMaxLufs,
        rangeLu: trace.loudness.rangeLu,
      },
      clipping: {
        clippedSampleCount: 0,
        clippedRatio: 0,
        exceedsZeroDbfs: trace.loudness.truePeakDbtp >= 0,
        exceedsMinusOneDbtp: trace.loudness.truePeakDbtp > -1.0,
      },
      silence: {
        leadingSilenceSec: 0,
        trailingSilenceSec: 0,
        silentFrameRatio: 0,
        isEffectiveSilence: trace.loudness.integratedLufs <= -65,
      },
      noiseFloorDbfs: -90,
      transients: {
        transientCount: 0,
        transientDensityPerSec: 0,
        peakToAverageTransientRatio: 0,
      },
      spectrum: {
        fftSize: 0,
        spectralCentroidHz: 0,
        spectralRolloff85Hz: 0,
        spectralFlatness: 0,
        tonalBalanceDb: trace.tonalBalanceDb,
      },
      stereo: {
        correlation: trace.stereo.correlation,
        widthPct: trace.stereo.widthPct,
        phaseCoherenceScore: Math.round(((trace.stereo.correlation + 1) * 50) * 100) / 100,
        subCorrelation: trace.stereo.bands.sub.correlation,
        subWidthPct: trace.stereo.bands.sub.widthPct,
        monoCompatibilityRisk:
          trace.stereo.correlation < 0.05 || trace.stereo.bands.sub.correlation < 0.1
            ? 'high'
            : trace.stereo.bands.sub.widthPct > 15
              ? 'moderate'
              : 'none',
        bands: trace.stereo.bands,
      },
    };

    const { diagnostics, recommendations } = runAudioDiagnosticsAndRecommendations({
      stage,
      features,
      traceAnalysis: trace,
      rubricBounds: options.rubricBounds,
      rubricSource: options.rubricSource,
    });

    const report: AudioBrainAnalysisReport = {
      reportId: `audiorep-${randomUUID().slice(0, 8)}`,
      analyzedAt: new Date().toISOString(),
      acquisition,
      decodedInfo: {
        sampleRateHz: trace.audio.sampleRateHz,
        channels: null,
        bitDepth: null,
        durationSec: trace.audio.durationSec,
        encoding: 'external_trace_v1',
      },
      dspConfig: null,
      features,
      mir: {
        status: 'unavailable',
        reason: 'External trace.analysis/v1 JSON contains acoustic metrics only; raw PCM needed for MIR tempo/key/onset inference',
      },
      traceAnalysis: trace,
      diagnostics,
      recommendations,
      limitations: [
        'MIR (tempo, key, chroma, onsets, HPR) unavailable without decoded PCM samples',
        'Sample-level DC offset and transient counts unavailable in trace.analysis/v1 summaries',
      ],
    };

    this.#persistIfConfigured(options.db, options.sessionId, 'trace_vst', acquisition.sha256BeforeRead, trace, report);
    return report;
  }

  /**
   * Explicitly refuses unsupported direct internal FL Studio audio buffer access.
   */
  refuseInternalDawBufferTap(sourceDescription: string): never {
    return assertNoUnsupportedDawAudioTap(sourceDescription);
  }

  formatMarkdownReport(report: AudioBrainAnalysisReport): string {
    const mirSummary =
      report.mir.status === 'available'
        ? `- **MIR (Probabilistic):** BPM=${String(report.mir.value.tempoEstimate.bpm ?? 'n/a')} (conf=${report.mir.value.tempoEstimate.confidence}), Key=${report.mir.value.keyEstimate.key} ${report.mir.value.keyEstimate.scale} (conf=${report.mir.value.keyEstimate.confidence}), HPR=${report.mir.value.harmonicPercussive.classification}, Source=${report.mir.value.sourceClassification.primaryClass}`
        : `- **MIR:** Unavailable — ${report.mir.reason}`;

    return [
      `# Audio Brain Analysis Report — ${report.acquisition.label}`,
      '',
      `- **Report ID:** \`${report.reportId}\` · **Verdict:** \`${report.diagnostics.overallVerdict}\` (${report.diagnostics.stage})`,
      `- **Source:** \`${report.acquisition.sourceKind}\` · **SHA-256:** \`${report.acquisition.sha256BeforeRead}\``,
      `- **Audio:** ${String(report.decodedInfo.sampleRateHz ?? 'n/a')} Hz, ${String(report.decodedInfo.channels ?? 'n/a')} ch, ${String(report.decodedInfo.durationSec?.toFixed(2) ?? 'n/a')}s`,
      `- **Loudness & Dynamics:** ${report.features.loudness.integratedLufs} LUFS, True Peak=${report.features.truePeakDbtp.status === 'available' ? `${report.features.truePeakDbtp.value} dBTP` : report.features.truePeakDbtp.reason}, Crest=${report.features.crestFactorDb} dB, LRA=${report.features.loudness.rangeLu} LU`,
      `- **Stereo:** corr=${report.features.stereo.correlation}, width=${report.features.stereo.widthPct}%, subWidth=${report.features.stereo.subWidthPct}%`,
      mirSummary,
      '',
      '## Alerts',
      ...(report.diagnostics.alerts.length > 0
        ? report.diagnostics.alerts.map((a) => `- **[${a.severity.toUpperCase()}] ${a.code}**: ${a.summary}`)
        : ['- None']),
      '',
      '## Recommendations (Analysis-Only)',
      ...report.recommendations.map((r) => `- **[${r.priority.toUpperCase()}] ${r.title}** (${r.suggestedDelta}): ${r.rationale}`),
      '',
      '## Limitations',
      ...(report.limitations.length > 0 ? report.limitations.map((l) => `- ${l}`) : ['- None']),
    ].join('\n');
  }

  #runPcmPipeline(params: {
    readonly acquisition: AudioBrainAnalysisReport['acquisition'];
    readonly decoded: DecodedAudioBuffer;
    readonly stage: 'mix' | 'master';
    readonly options: AnalyzeAudioOptions;
  }): AudioBrainAnalysisReport {
    const baseCfg = createDefaultDspConfig(params.decoded.sampleRateHz, params.decoded.channelLayout);
    const dspConfig: DspConfig = {
      ...baseCfg,
      ...params.options.dspConfigPatch,
      tolerances: {
        ...baseCfg.tolerances,
        ...params.options.dspConfigPatch?.tolerances,
      },
    };

    const { features, traceAnalysis } = runAudioDspAnalysis(params.decoded, dspConfig, {
      stage: params.stage,
      label: params.acquisition.label,
    });
    const mirValue = runAudioMirAnalysis(params.decoded, features);
    const { diagnostics, recommendations } = runAudioDiagnosticsAndRecommendations({
      stage: params.stage,
      features,
      traceAnalysis,
      rubricBounds: params.options.rubricBounds,
      rubricSource: params.options.rubricSource,
    });

    const limitations: string[] = [];
    if (params.decoded.channels === 1) {
      limitations.push('Mono source audio: stereo width and L/R correlation trivially 0% / +1.0');
    }
    if (params.decoded.durationSec < 1.5) {
      limitations.push(`Short clip duration (${params.decoded.durationSec.toFixed(2)}s): autocorrelation tempo & LRA reliability reduced`);
    }
    void linearToDb;

    const report: AudioBrainAnalysisReport = {
      reportId: `audiorep-${randomUUID().slice(0, 8)}`,
      analyzedAt: new Date().toISOString(),
      acquisition: params.acquisition,
      decodedInfo: {
        sampleRateHz: params.decoded.sampleRateHz,
        channels: params.decoded.channels,
        bitDepth: params.decoded.bitDepth,
        durationSec: Number(params.decoded.durationSec.toFixed(3)),
        encoding: params.decoded.encoding,
      },
      dspConfig,
      features,
      mir: { status: 'available', value: mirValue },
      traceAnalysis,
      diagnostics,
      recommendations,
      limitations,
    };

    this.#persistIfConfigured(
      params.options.db,
      params.options.sessionId,
      'bounce_wav',
      params.acquisition.sha256BeforeRead,
      traceAnalysis,
      report,
    );
    return report;
  }

  #persistIfConfigured(
    db: SqliteRuntimeDb | null | undefined,
    sessionId: string | null | undefined,
    sourceKind: 'bounce_wav' | 'trace_vst',
    sourceSha256: string,
    traceAnalysis: TraceAnalysis,
    report: AudioBrainAnalysisReport,
  ): void {
    if (!db || !db.isOpen) return;
    db.recordDawAudioAnalysis({
      sessionId: sessionId ?? null,
      sourceKind,
      sourceSha256,
      traceAnalysis: { ...traceAnalysis },
      traceReport: {
        verdict: report.diagnostics.overallVerdict,
        stage: report.diagnostics.stage,
        checks: report.diagnostics.checks,
        unset: report.diagnostics.unsetMetrics,
        alertCount: report.diagnostics.alerts.length,
      },
    });
    // Record sanitized audio analysis telemetry without logging raw audio samples or credentials
    db.appendEvent({
      eventType: 'daw.audio.analyzed',
      domain: 'TECH',
      actor: 'audio-brain',
      targetPath: sessionId ? `daw://session/${sessionId}` : null,
      checksumSha256: sourceSha256,
      payload: {
        reportId: report.reportId,
        sourceKind,
        stage: report.diagnostics.stage,
        verdict: report.diagnostics.overallVerdict,
        durationSec: report.decodedInfo.durationSec,
        sampleRateHz: report.decodedInfo.sampleRateHz,
        alertCount: report.diagnostics.alerts.length,
      },
    });
  }
}
