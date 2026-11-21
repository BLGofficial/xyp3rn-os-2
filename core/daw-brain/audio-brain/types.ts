import type { TraceAnalysis, TraceBand } from '../../../tech/trace/analysis.ts';
import type { TraceCheck } from '../../../tech/trace/report.ts';
import type { DawAvailability } from '../types.ts';
import type { DspChannelLayout, DspConfig } from './dsp-interfaces.ts';

export type { TraceCheck } from '../../../tech/trace/report.ts';
export type { TraceAnalysis, TraceBand } from '../../../tech/trace/analysis.ts';

export type AudioInputSourceKind =
  | 'user_file'
  | 'approved_render'
  | 'verified_daw_stream'
  | 'exported_analysis';

export type AudioAcquisitionRecord = {
  readonly sourceKind: AudioInputSourceKind;
  readonly label: string;
  readonly filePath: string | null;
  readonly streamId: string | null;
  readonly sha256BeforeRead: string;
  readonly sha256AfterRead: string;
  readonly byteSize: number | null;
  readonly acquiredAt: string;
  readonly readOnlyVerified: true;
  readonly provenance: string;
};

export type DecodedAudioBuffer = {
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly channelLayout: DspChannelLayout;
  readonly bitDepth: number | null;
  readonly encoding: 'pcm_int8' | 'pcm_int16' | 'pcm_int24' | 'pcm_int32' | 'ieee_float32' | 'stream_float';
  readonly frameCount: number;
  readonly durationSec: number;
  readonly channelData: readonly Float32Array[];
  readonly sha256: string;
};

export type AudioDspFeatures = {
  readonly samplePeakDbfs: number;
  readonly truePeakDbtp: DawAvailability<number>;
  readonly rmsDbfs: number;
  readonly crestFactorDb: number;
  readonly dynamicRangeDb: number;
  readonly dcOffset: number;
  readonly loudness: {
    readonly integratedLufs: number;
    readonly shortTermMaxLufs: number;
    readonly momentaryMaxLufs: number;
    readonly rangeLu: number;
  };
  readonly clipping: {
    readonly clippedSampleCount: number;
    readonly clippedRatio: number;
    readonly exceedsZeroDbfs: boolean;
    readonly exceedsMinusOneDbtp: boolean;
  };
  readonly silence: {
    readonly leadingSilenceSec: number;
    readonly trailingSilenceSec: number;
    readonly silentFrameRatio: number;
    readonly isEffectiveSilence: boolean;
  };
  readonly noiseFloorDbfs: number;
  readonly transients: {
    readonly transientCount: number;
    readonly transientDensityPerSec: number;
    readonly peakToAverageTransientRatio: number;
  };
  readonly spectrum: {
    readonly fftSize: number;
    readonly spectralCentroidHz: number;
    readonly spectralRolloff85Hz: number;
    readonly spectralFlatness: number;
    readonly tonalBalanceDb: Readonly<Record<import('../../../tech/trace/analysis.ts').TraceBand, number>>;
  };
  readonly stereo: {
    readonly correlation: number;
    readonly widthPct: number;
    readonly phaseCoherenceScore: number;
    readonly subCorrelation: number;
    readonly subWidthPct: number;
    readonly monoCompatibilityRisk: 'none' | 'moderate' | 'high';
    readonly bands: Readonly<
      Record<
        import('../../../tech/trace/analysis.ts').TraceBand,
        { readonly correlation: number; readonly widthPct: number }
      >
    >;
  };
};

export type AudioMirAnalysis = {
  readonly modelDisclaimer: string;
  readonly probabilistic: true;
  readonly tempoEstimate: {
    readonly bpm: number | null;
    readonly confidence: number;
    readonly method: 'onset_autocorrelation';
    readonly probabilistic: true;
  };
  readonly beatTracking: {
    readonly beatIntervalSec: number | null;
    readonly estimatedBeatTimesSec: readonly number[];
    readonly confidence: number;
    readonly probabilistic: true;
  };
  readonly onsetDetection: {
    readonly onsetCount: number;
    readonly onsetTimesSec: readonly number[];
    readonly onsetRatePerSec: number;
    readonly confidence: number;
    readonly probabilistic: true;
  };
  readonly chroma: Readonly<Record<string, number>>; // 12 pitch classes C..B
  readonly keyEstimate: {
    readonly key: string;
    readonly scale: 'major' | 'minor';
    readonly confidence: number;
    readonly runnerUp: string;
    readonly probabilistic: true;
  };
  readonly harmonicPercussive: {
    readonly harmonicEnergyRatio: number;
    readonly percussiveEnergyRatio: number;
    readonly classification: 'harmonic_dominant' | 'percussive_dominant' | 'balanced';
    readonly probabilistic: true;
  };
  readonly sections: ReadonlyArray<{
    readonly label: string;
    readonly startSec: number;
    readonly endSec: number;
    readonly avgRmsDb: number;
    readonly normalizedEnergy: number;
  }>;
  readonly sourceClassification: {
    readonly primaryClass:
      | 'percussive_beat'
      | 'tonal_melodic'
      | 'sub_bass_heavy'
      | 'vocal_range_focus'
      | 'full_mix_master'
      | 'sparse_or_silent';
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly evidence: readonly string[];
    readonly probabilistic: true;
  };
};

export type AudioDiagnosticAlert = {
  readonly code:
    | 'TRUE_PEAK_EXCEEDED'
    | 'HARD_SAMPLE_CLIPPING'
    | 'LOW_MID_MASKING_MUD'
    | 'SUB_STEREO_WIDTH_PHASE'
    | 'NEGATIVE_STEREO_CORRELATION'
    | 'OVER_COMPRESSED_CREST'
    | 'SILENT_OR_TRUNCATED_RENDER'
    | 'ELEVATED_NOISE_FLOOR'
    | 'RUBRIC_METRIC_OUT_OF_BOUNDS';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly metric: string;
  readonly measured: number | string;
  readonly summary: string;
};

export type AudioDiagnosticReport = {
  readonly overallVerdict: 'PASS' | 'WARN' | 'CRITICAL';
  readonly stage: 'mix' | 'master';
  readonly alerts: readonly AudioDiagnosticAlert[];
  readonly checks: readonly import('../../../tech/trace/report.ts').TraceCheck[];
  readonly unsetMetrics: readonly string[];
  readonly rubricSource: string;
};

export type AudioBrainRecommendation = {
  readonly priority: 'high' | 'medium' | 'low';
  readonly actionType:
    | 'gain_trim'
    | 'eq_attenuation'
    | 'mono_sub_tightening'
    | 'limiter_relaxation'
    | 'phase_polarity_check'
    | 'noise_gate_or_cleanup'
    | 'keep_current_balance';
  readonly title: string;
  readonly rationale: string;
  readonly targetMetric: string;
  readonly suggestedDelta: string;
  readonly requiresApprovalOrManualAction: true;
};

export type AudioBrainAnalysisReport = {
  readonly reportId: string;
  readonly analyzedAt: string;
  readonly acquisition: AudioAcquisitionRecord;
  readonly decodedInfo: {
    readonly sampleRateHz: number | null;
    readonly channels: number | null;
    readonly bitDepth: number | null;
    readonly durationSec: number | null;
    readonly encoding: string | null;
  };
  readonly dspConfig: DspConfig | null;
  readonly features: AudioDspFeatures;
  readonly mir: DawAvailability<AudioMirAnalysis>;
  readonly traceAnalysis: import('../../../tech/trace/analysis.ts').TraceAnalysis;
  readonly diagnostics: AudioDiagnosticReport;
  readonly recommendations: readonly AudioBrainRecommendation[];
  readonly limitations: readonly string[];
};
