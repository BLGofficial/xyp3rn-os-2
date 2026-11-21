import { buildWindowCoefficients, fftInPlace, linearToDb } from './dsp-interfaces.ts';
import type { AudioDspFeatures, AudioMirAnalysis, DecodedAudioBuffer } from './types.ts';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

// Krumhansl-Schmuckler tonal key profiles (normalized correlation weights)
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const pearsonVec = (a: readonly number[], b: readonly number[]): number => {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let dA = 0;
  let dB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]! - meanA;
    const y = b[i]! - meanB;
    num += x * y;
    dA += x * x;
    dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom <= 1e-12 ? 0 : num / denom;
};

/**
 * Stage 5 (Musical Information Retrieval):
 * Deterministic-seed probabilistic heuristics for onset/tempo/beat/chroma/key/HPR/sections/source.
 * Every field carries explicit `probabilistic: true` and `confidence` [0..1].
 */
export const runAudioMirAnalysis = (
  decoded: DecodedAudioBuffer,
  features: AudioDspFeatures,
): AudioMirAnalysis => {
  const { sampleRateHz, frameCount, channelData, durationSec } = decoded;
  const left = channelData[0]!;
  const right = decoded.channels === 2 ? channelData[1]! : left;

  const fftSize = 2048;
  const hopSize = 512;
  const hopSec = hopSize / sampleRateHz;
  const halfBins = fftSize >> 1;
  const { coeffs: win } = buildWindowCoefficients(fftSize, 'hann');

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const prevMag = new Float64Array(halfBins);

  const fluxEnvelope: number[] = [];
  const frameRmsList: number[] = [];
  const chromaAccum = new Float64Array(12);
  let totalSpectralChange = 0;
  let totalSpectralEnergy = 0;

  for (let start = 0; start < frameCount; start += hopSize) {
    let fSq = 0;
    for (let k = 0; k < fftSize; k += 1) {
      const idx = start + k;
      const s = idx < frameCount ? ((left[idx] ?? 0) + (right[idx] ?? 0)) * 0.5 : 0;
      fSq += s * s;
      re[k] = s * win[k]!;
      im[k] = 0;
    }
    frameRmsList.push(linearToDb(Math.sqrt(fSq / fftSize)));
    fftInPlace(re, im);

    let flux = 0;
    let frameSpecEnergy = 0;
    for (let b = 1; b < halfBins; b += 1) {
      const mag = Math.sqrt(re[b]! * re[b]! + im[b]! * im[b]!);
      frameSpecEnergy += mag * mag;
      const diff = mag - prevMag[b]!;
      if (diff > 0) flux += diff;
      prevMag[b] = mag;

      const hz = (b * sampleRateHz) / fftSize;
      if (hz >= 55 && hz <= 4000 && mag > 1e-6) {
        const midiNote = 69 + 12 * Math.log2(hz / 440);
        const pc = ((Math.round(midiNote) % 12) + 12) % 12;
        chromaAccum[pc]! += mag * mag;
      }
    }
    fluxEnvelope.push(flux);
    totalSpectralChange += flux;
    totalSpectralEnergy += Math.sqrt(frameSpecEnergy);
    if (start + fftSize >= frameCount) break;
  }

  // Onset peak picking over adaptive local mean threshold
  const onsetTimesSec: number[] = [];
  const winRadius = 4;
  const maxFlux = fluxEnvelope.length > 0 ? Math.max(...fluxEnvelope) : 0;
  const minAbsFloor = maxFlux * 0.12;
  const minInterOnsetSteps = Math.max(1, Math.round(0.08 / hopSec));
  let lastOnsetStep = -minInterOnsetSteps;

  for (let i = 1; i < fluxEnvelope.length - 1; i += 1) {
    const val = fluxEnvelope[i]!;
    if (val < minAbsFloor) continue;
    if (val < fluxEnvelope[i - 1]! || val < fluxEnvelope[i + 1]!) continue;

    let localSum = 0;
    let cnt = 0;
    for (let w = Math.max(0, i - winRadius); w <= Math.min(fluxEnvelope.length - 1, i + winRadius); w += 1) {
      localSum += fluxEnvelope[w]!;
      cnt += 1;
    }
    const localMean = localSum / Math.max(1, cnt);
    if (val > localMean * 1.45 && i - lastOnsetStep >= minInterOnsetSteps) {
      onsetTimesSec.push(round3(i * hopSec));
      lastOnsetStep = i;
    }
  }

  // Autocorrelation tempo estimation across 60..180 BPM
  let bestBpm: number | null = null;
  let bestBpmScore = 0;
  let secondBpmScore = 0;
  if (fluxEnvelope.length >= 16 && durationSec >= 1.5 && !features.silence.isEffectiveSilence) {
    const meanFlux = fluxEnvelope.reduce((a, b) => a + b, 0) / fluxEnvelope.length;
    const centered = fluxEnvelope.map((v) => v - meanFlux);
    const minLag = Math.max(2, Math.floor(60 / (180 * hopSec)));
    const maxLag = Math.min(centered.length - 2, Math.ceil(60 / (60 * hopSec)));

    let zeroLag = 0;
    for (let i = 0; i < centered.length; i += 1) zeroLag += centered[i]! * centered[i]!;

    if (zeroLag > 1e-12) {
      for (let lag = minLag; lag <= maxLag; lag += 1) {
        let corr = 0;
        for (let i = 0; i + lag < centered.length; i += 1) {
          corr += centered[i]! * centered[i + lag]!;
        }
        const norm = corr / zeroLag;
        if (norm > bestBpmScore) {
          secondBpmScore = bestBpmScore;
          bestBpmScore = norm;
          bestBpm = round2(60 / (lag * hopSec));
        } else if (norm > secondBpmScore) {
          secondBpmScore = norm;
        }
      }
    }
  }

  const bpmConfidence =
    bestBpm !== null
      ? clamp(round2(Math.max(0, bestBpmScore) * 0.9 + Math.max(0, bestBpmScore - secondBpmScore) * 0.4), 0.1, 0.95)
      : 0;

  const beatIntervalSec = bestBpm ? round3(60 / bestBpm) : null;
  const firstOnset = onsetTimesSec[0] ?? 0;
  const estimatedBeatTimesSec: number[] = [];
  if (beatIntervalSec && beatIntervalSec > 0.1 && bestBpm !== null && bpmConfidence >= 0.2) {
    for (let t = firstOnset; t < durationSec && estimatedBeatTimesSec.length < 256; t += beatIntervalSec) {
      estimatedBeatTimesSec.push(round3(t));
    }
  }

  // Normalized 12-bin Chroma + Krumhansl Key estimation
  const maxChroma = Math.max(...chromaAccum, 1e-12);
  const chromaNorm: number[] = [];
  const chromaRecord: Record<string, number> = {};
  for (let i = 0; i < 12; i += 1) {
    const val = round3(chromaAccum[i]! / maxChroma);
    chromaNorm.push(val);
    chromaRecord[PITCH_NAMES[i]!] = val;
  }

  const keyScores: Array<{ readonly key: string; readonly scale: 'major' | 'minor'; readonly r: number }> = [];
  for (let root = 0; root < 12; root += 1) {
    const rotated = Array.from({ length: 12 }, (_, idx) => chromaNorm[(idx + root) % 12]!);
    keyScores.push({ key: PITCH_NAMES[root]!, scale: 'major', r: pearsonVec(rotated, MAJOR_PROFILE) });
    keyScores.push({ key: PITCH_NAMES[root]!, scale: 'minor', r: pearsonVec(rotated, MINOR_PROFILE) });
  }
  keyScores.sort((a, b) => b.r - a.r);
  const topKey = keyScores[0]!;
  const secondKey = keyScores[1]!;
  const keyConfidence = features.silence.isEffectiveSilence
    ? 0
    : clamp(round2(Math.max(0, topKey.r) * 0.75 + Math.max(0, topKey.r - secondKey.r) * 1.1), 0.05, 0.94);

  // Harmonic vs Percussive balance heuristic
  const fluxToEnergy =
    totalSpectralEnergy > 1e-9 ? totalSpectralChange / totalSpectralEnergy : 0;
  const percussiveEnergyRatio = clamp(round2(fluxToEnergy * 0.45 + Math.min(0.45, features.transients.transientDensityPerSec * 0.08)), 0.05, 0.95);
  const harmonicEnergyRatio = round2(1 - percussiveEnergyRatio);
  const hprClass: AudioMirAnalysis['harmonicPercussive']['classification'] =
    harmonicEnergyRatio >= 0.6
      ? 'harmonic_dominant'
      : percussiveEnergyRatio >= 0.6
        ? 'percussive_dominant'
        : 'balanced';

  // Energy sections (divide into 4 balanced windows or fewer for short audio)
  const sectionCount = durationSec >= 8 ? 4 : durationSec >= 2 ? 2 : 1;
  const secFrames = Math.max(1, Math.floor(frameRmsList.length / sectionCount));
  const sections: Array<{
    readonly label: string;
    readonly startSec: number;
    readonly endSec: number;
    readonly avgRmsDb: number;
    readonly normalizedEnergy: number;
  }> = [];

  for (let s = 0; s < sectionCount; s += 1) {
    const startIdx = s * secFrames;
    const endIdx = s === sectionCount - 1 ? frameRmsList.length : (s + 1) * secFrames;
    const slice = frameRmsList.slice(startIdx, endIdx);
    const avgDb =
      slice.length > 0 ? round2(slice.reduce((a, b) => a + b, 0) / slice.length) : -120;
    const normEnergy = clamp(round2((avgDb + 60) / 60), 0, 1);
    const label =
      sectionCount === 1
        ? 'full_segment'
        : s === 0 && avgDb < features.rmsDbfs - 4
          ? 'intro_low_energy'
          : s === sectionCount - 1 && avgDb < features.rmsDbfs - 4
            ? 'outro_fade'
            : normEnergy >= 0.7
              ? `section_${s + 1}_high_energy`
              : `section_${s + 1}_steady`;
    sections.push({
      label,
      startSec: round2(startIdx * hopSec),
      endSec: round2(Math.min(durationSec, endIdx * hopSec)),
      avgRmsDb: avgDb,
      normalizedEnergy: normEnergy,
    });
  }

  // Probabilistic source classification
  const probs: Record<string, number> = {
    percussive_beat: 0.1,
    tonal_melodic: 0.1,
    sub_bass_heavy: 0.1,
    vocal_range_focus: 0.1,
    full_mix_master: 0.1,
    sparse_or_silent: features.silence.isEffectiveSilence ? 0.95 : 0.05,
  };
  const evidence: string[] = [];

  if (!features.silence.isEffectiveSilence) {
    const midEnergy = features.spectrum.tonalBalanceDb.mid;
    const subEnergy = Math.max(features.spectrum.tonalBalanceDb.sub, features.spectrum.tonalBalanceDb.bass);
    probs.percussive_beat = clamp(round2(percussiveEnergyRatio * 0.8 + (features.crestFactorDb >= 9 ? 0.2 : 0)), 0.05, 0.95);
    probs.tonal_melodic = clamp(round2(harmonicEnergyRatio * 0.75 + (keyConfidence > 0.5 ? 0.2 : 0)), 0.05, 0.95);
    probs.sub_bass_heavy = clamp(round2(subEnergy >= -4 ? 0.85 : subEnergy >= -10 ? 0.45 : 0.1), 0.05, 0.95);
    probs.vocal_range_focus = clamp(round2(midEnergy >= -4 ? 0.75 : 0.2), 0.05, 0.95);
    probs.full_mix_master = clamp(
      round2(
        (features.spectrum.tonalBalanceDb.sub > -18 &&
          features.spectrum.tonalBalanceDb.mid > -12 &&
          features.spectrum.tonalBalanceDb.air > -24
          ? 0.85
          : 0.25),
      ),
      0.05,
      0.95,
    );
    evidence.push(
      `HPR=${hprClass} (${harmonicEnergyRatio}/${percussiveEnergyRatio})`,
      `crest=${features.crestFactorDb}dB, centroid=${features.spectrum.spectralCentroidHz}Hz`,
    );
  } else {
    evidence.push(`Effective silence detected (rms=${features.rmsDbfs}dBFS)`);
  }

  const rankedClasses = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const primaryClass = rankedClasses[0]![0] as AudioMirAnalysis['sourceClassification']['primaryClass'];
  const primaryConf = rankedClasses[0]![1];

  return {
    modelDisclaimer: 'Probabilistic DSP-heuristic MIR estimates; inspect musical context before treating BPM, key, or stem role as ground truth',
    probabilistic: true,
    tempoEstimate: {
      bpm: bestBpm,
      confidence: bpmConfidence,
      method: 'onset_autocorrelation',
      probabilistic: true,
    },
    beatTracking: {
      beatIntervalSec,
      estimatedBeatTimesSec,
      confidence: bpmConfidence,
      probabilistic: true,
    },
    onsetDetection: {
      onsetCount: onsetTimesSec.length,
      onsetTimesSec,
      onsetRatePerSec: round2(onsetTimesSec.length / Math.max(0.05, durationSec)),
      confidence: features.silence.isEffectiveSilence ? 0 : clamp(round2(0.55 + Math.min(0.4, onsetTimesSec.length * 0.03)), 0.1, 0.95),
      probabilistic: true,
    },
    chroma: chromaRecord,
    keyEstimate: {
      key: topKey.key,
      scale: topKey.scale,
      confidence: keyConfidence,
      runnerUp: `${secondKey.key} ${secondKey.scale}`,
      probabilistic: true,
    },
    harmonicPercussive: {
      harmonicEnergyRatio,
      percussiveEnergyRatio,
      classification: hprClass,
      probabilistic: true,
    },
    sections,
    sourceClassification: {
      primaryClass,
      confidence: primaryConf,
      probabilities: probs,
      evidence,
      probabilistic: true,
    },
  };
};
