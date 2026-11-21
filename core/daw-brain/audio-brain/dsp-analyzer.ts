import {
  TRACE_ANALYSIS_SCHEMA_ID,
  TRACE_BANDS,
  validateTraceAnalysis,
  type TraceAnalysis,
  type TraceBand,
} from '../../../tech/trace/analysis.ts';
import {
  applyKWeighting,
  buildWindowCoefficients,
  estimateTruePeakLinear,
  fftInPlace,
  linearToDb,
  type DspConfig,
} from './dsp-interfaces.ts';
import type { AudioDspFeatures, DecodedAudioBuffer } from './types.ts';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

const emptyBandRecord = (): Record<TraceBand, number> => ({
  sub: -60,
  bass: -60,
  'low-mid': -60,
  mid: -60,
  'high-mid': -60,
  presence: -60,
  air: -60,
});

const emptyStereoBands = (): Record<TraceBand, { readonly correlation: number; readonly widthPct: number }> => ({
  sub: { correlation: 1, widthPct: 0 },
  bass: { correlation: 1, widthPct: 0 },
  'low-mid': { correlation: 1, widthPct: 0 },
  mid: { correlation: 1, widthPct: 0 },
  'high-mid': { correlation: 1, widthPct: 0 },
  presence: { correlation: 1, widthPct: 0 },
  air: { correlation: 1, widthPct: 0 },
});

const pearsonCorrelation = (
  sumLR: number,
  sumLL: number,
  sumRR: number,
): number => {
  const denom = Math.sqrt(sumLL * sumRR);
  if (denom <= 1e-18) return 1;
  return clamp(round2(sumLR / denom), -1, 1);
};

const sideWidthPct = (sumMidSq: number, sumSideSq: number): number => {
  const tot = sumMidSq + sumSideSq;
  if (tot <= 1e-18) return 0;
  return clamp(round2((sumSideSq / tot) * 100), 0, 100);
};

/**
 * Stages 3 & 4 (Feature Extraction & DSP Analysis):
 * Measures peak, 4x true peak, RMS, crest, P95-P10 dynamic range, clipping, silence,
 * noise floor, transients, ITU-R BS.1770 loudness/LRA, FFT spectral balance over `TRACE_BANDS`,
 * and full/per-band stereo correlation + width. Produces a schema-valid `trace.analysis/v1` artifact.
 */
export const runAudioDspAnalysis = (
  decoded: DecodedAudioBuffer,
  dspConfig: DspConfig,
  subject: { readonly stage: 'mix' | 'master'; readonly label: string },
): { readonly features: AudioDspFeatures; readonly traceAnalysis: TraceAnalysis } => {
  const { sampleRateHz, frameCount, channelData, channels } = decoded;
  const left = channelData[0]!;
  const right = channels === 2 ? channelData[1]! : left;

  // 1. Sample peak, RMS, DC offset, clipping, stereo sum accumulators
  let samplePeak = 0;
  let clippedSamples = 0;
  let sumSq = 0;
  let sumSamples = 0;
  let sumLR = 0;
  let sumLL = 0;
  let sumRR = 0;
  let sumMidSq = 0;
  let sumSideSq = 0;

  for (let i = 0; i < frameCount; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > samplePeak) samplePeak = al;
    if (ar > samplePeak) samplePeak = ar;
    if (al >= 0.9999) clippedSamples += 1;
    if (channels === 2 && ar >= 0.9999) clippedSamples += 1;

    sumSq += (l * l + r * r) / 2;
    sumSamples += (l + r) / 2;
    sumLR += l * r;
    sumLL += l * l;
    sumRR += r * r;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    sumMidSq += mid * mid;
    sumSideSq += side * side;
  }

  const totalSamples = frameCount * channels;
  const meanRms = Math.sqrt(sumSq / Math.max(1, frameCount));
  const samplePeakDbfs = linearToDb(samplePeak);
  const rmsDbfs = linearToDb(meanRms);
  const crestFactorDb = Math.max(0, round2(samplePeakDbfs - rmsDbfs));
  const dcOffset = round2(sumSamples / Math.max(1, frameCount));

  // True Peak (4x cubic oversampling)
  const truePeakLinear = estimateTruePeakLinear(channelData);
  const truePeakDbtpValue = linearToDb(truePeakLinear);

  // 2. Short-window (50 ms) silence, noise floor, dynamic range, and transient tracking
  const frameLen50 = Math.max(128, Math.round(sampleRateHz * 0.05));
  const frameRmsDb: number[] = [];
  const framePeakLin: number[] = [];
  for (let start = 0; start < frameCount; start += frameLen50) {
    const end = Math.min(frameCount, start + frameLen50);
    let fSq = 0;
    let fPk = 0;
    for (let i = start; i < end; i += 1) {
      const m = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
      fSq += m * m;
      const am = Math.abs(m);
      if (am > fPk) fPk = am;
    }
    const rDb = linearToDb(Math.sqrt(fSq / Math.max(1, end - start)));
    frameRmsDb.push(rDb);
    framePeakLin.push(fPk);
  }

  const sortedRms = [...frameRmsDb].sort((a, b) => a - b);
  const p10Db = sortedRms[Math.floor(sortedRms.length * 0.1)] ?? -120;
  const p95Db = sortedRms[Math.min(sortedRms.length - 1, Math.floor(sortedRms.length * 0.95))] ?? -120;
  const dynamicRangeDb = Math.max(0, round2(p95Db - p10Db));
  const noiseFloorDbfs = round2(p10Db);

  const silenceThresholdDb = -60;
  const silentFrames = frameRmsDb.filter((db) => db <= silenceThresholdDb).length;
  const silentFrameRatio = round2(silentFrames / Math.max(1, frameRmsDb.length));

  let leadingSilentFrames = 0;
  while (leadingSilentFrames < frameRmsDb.length && (frameRmsDb[leadingSilentFrames] ?? -120) <= silenceThresholdDb) {
    leadingSilentFrames += 1;
  }
  let trailingSilentFrames = 0;
  while (
    trailingSilentFrames < frameRmsDb.length &&
    (frameRmsDb[frameRmsDb.length - 1 - trailingSilentFrames] ?? -120) <= silenceThresholdDb
  ) {
    trailingSilentFrames += 1;
  }
  const frameStepSec = frameLen50 / sampleRateHz;
  const leadingSilenceSec = round2(leadingSilentFrames * frameStepSec);
  const trailingSilenceSec = round2(trailingSilentFrames * frameStepSec);

  let transientCount = 0;
  let transientRatioSum = 0;
  for (let idx = 1; idx < frameRmsDb.length; idx += 1) {
    const prevLin = Math.pow(10, (frameRmsDb[idx - 1] ?? -120) / 20);
    const curLin = Math.pow(10, (frameRmsDb[idx] ?? -120) / 20);
    const jumpDb = (frameRmsDb[idx] ?? -120) - (frameRmsDb[idx - 1] ?? -120);
    if (jumpDb > 6 && (framePeakLin[idx] ?? 0) > 0.05) {
      transientCount += 1;
    }
    if (prevLin > 1e-6) {
      transientRatioSum += curLin / prevLin;
    }
  }
  const peakToAverageTransientRatio = round2(transientRatioSum / Math.max(1, frameRmsDb.length - 1));

  // 3. ITU-R BS.1770 K-Weighted Loudness (400 ms momentary blocks, 100 ms step; 3s short-term)
  const kWeighted = applyKWeighting(channelData, sampleRateHz);
  const kLeft = kWeighted[0]!;
  const kRight = channels === 2 ? kWeighted[1]! : kLeft;

  const block400Samples = Math.max(64, Math.round(sampleRateHz * 0.4));
  const step100Samples = Math.max(32, Math.round(sampleRateHz * 0.1));
  const momentaryLufsList: number[] = [];

  for (let start = 0; start + block400Samples <= frameCount || (start === 0 && frameCount > 0); start += step100Samples) {
    const end = Math.min(frameCount, start + block400Samples);
    let eL = 0;
    let eR = 0;
    const count = Math.max(1, end - start);
    for (let i = start; i < end; i += 1) {
      const kl = kLeft[i] ?? 0;
      const kr = kRight[i] ?? 0;
      eL += kl * kl;
      eR += kr * kr;
    }
    const meanPower = channels === 2 ? (eL + eR) / count : eL / count;
    const lufs = meanPower > 1e-12 ? -0.691 + 10 * Math.log10(meanPower) : -70;
    momentaryLufsList.push(lufs);
    if (end === frameCount) break;
  }

  const aboveAbs = momentaryLufsList.filter((l) => l > -70);
  const absPowMean =
    aboveAbs.length > 0
      ? aboveAbs.reduce((acc, l) => acc + Math.pow(10, (l + 0.691) / 10), 0) / aboveAbs.length
      : 0;
  const ungatedIntegrated = absPowMean > 1e-12 ? -0.691 + 10 * Math.log10(absPowMean) : -70;
  const relGateThreshold = ungatedIntegrated - 10;
  const gatedBlocks = aboveAbs.filter((l) => l >= relGateThreshold);
  const gatedPowMean =
    gatedBlocks.length > 0
      ? gatedBlocks.reduce((acc, l) => acc + Math.pow(10, (l + 0.691) / 10), 0) / gatedBlocks.length
      : absPowMean;
  const integratedLufs = round2(gatedPowMean > 1e-12 ? -0.691 + 10 * Math.log10(gatedPowMean) : -70);
  const momentaryMaxLufs = round2(
    momentaryLufsList.length > 0 ? Math.max(...momentaryLufsList) : integratedLufs,
  );

  // Short-term 3s rolling mean over 100ms blocks (~30 steps)
  const stWindowBlocks = Math.min(momentaryLufsList.length, 30);
  let shortTermMaxLufs = momentaryMaxLufs;
  const shortTermSeries: number[] = [];
  if (stWindowBlocks > 0) {
    shortTermMaxLufs = -120;
    for (let i = 0; i <= momentaryLufsList.length - stWindowBlocks; i += 1) {
      let powSum = 0;
      for (let j = 0; j < stWindowBlocks; j += 1) {
        const l = momentaryLufsList[i + j] ?? -70;
        powSum += l > -70 ? Math.pow(10, (l + 0.691) / 10) : 0;
      }
      const stLufs = powSum > 1e-12 ? -0.691 + 10 * Math.log10(powSum / stWindowBlocks) : -70;
      shortTermSeries.push(stLufs);
      if (stLufs > shortTermMaxLufs) shortTermMaxLufs = stLufs;
    }
    shortTermMaxLufs = round2(shortTermMaxLufs);
  }
  const stValid = shortTermSeries.filter((l) => l > -70).sort((a, b) => a - b);
  const rangeLu =
    stValid.length >= 2
      ? Math.max(
          0,
          round2(
            (stValid[Math.floor(stValid.length * 0.95)] ?? 0) -
              (stValid[Math.floor(stValid.length * 0.1)] ?? 0),
          ),
        )
      : 0;

  // 4. Windowed FFT Spectrum + TRACE_BANDS Tonal Balance & Band Stereo Metrics
  const fftSize = dspConfig.fftSize;
  const hopSize = dspConfig.hopSize;
  const { coeffs: win } = buildWindowCoefficients(fftSize, dspConfig.window);
  const halfBins = fftSize >> 1;
  const avgMag = new Float64Array(halfBins);
  const bandPowerSum = new Float64Array(TRACE_BANDS.length);
  const bandLR = new Float64Array(TRACE_BANDS.length);
  const bandLL = new Float64Array(TRACE_BANDS.length);
  const bandRR = new Float64Array(TRACE_BANDS.length);
  const bandMidSq = new Float64Array(TRACE_BANDS.length);
  const bandSideSq = new Float64Array(TRACE_BANDS.length);

  const binHz = sampleRateHz / fftSize;
  const binBandIdx = new Int8Array(halfBins);
  for (let b = 0; b < halfBins; b += 1) {
    const hz = b * binHz;
    let found = -1;
    for (let bi = 0; bi < TRACE_BANDS.length; bi += 1) {
      const tb = TRACE_BANDS[bi]!;
      if (hz >= tb.lowHz && hz < tb.highHz) {
        found = bi;
        break;
      }
    }
    binBandIdx[b] = found;
  }

  const reL = new Float64Array(fftSize);
  const imL = new Float64Array(fftSize);
  const reR = new Float64Array(fftSize);
  const imR = new Float64Array(fftSize);

  let fftFrames = 0;
  let totalFullSpecPower = 0;

  for (let start = 0; start < frameCount; start += hopSize) {
    fftFrames += 1;
    for (let k = 0; k < fftSize; k += 1) {
      const idx = start + k;
      const w = win[k]!;
      reL[k] = idx < frameCount ? (left[idx] ?? 0) * w : 0;
      imL[k] = 0;
      if (channels === 2) {
        reR[k] = idx < frameCount ? (right[idx] ?? 0) * w : 0;
        imR[k] = 0;
      }
    }
    fftInPlace(reL, imL);
    if (channels === 2) fftInPlace(reR, imR);

    for (let b = 1; b < halfBins; b += 1) {
      const lr = reL[b]!;
      const li = imL[b]!;
      const pL = lr * lr + li * li;
      const rr = channels === 2 ? reR[b]! : lr;
      const ri = channels === 2 ? imR[b]! : li;
      const pR = rr * rr + ri * ri;
      const pMono = (pL + pR) * 0.5;
      avgMag[b]! += Math.sqrt(pMono);

      const bi = binBandIdx[b]!;
      if (bi >= 0) {
        totalFullSpecPower += pMono;
        bandPowerSum[bi]! += pMono;
        bandLL[bi]! += pL;
        bandRR[bi]! += pR;
        bandLR[bi]! += lr * rr + li * ri;
        const mRe = (lr + rr) * 0.5;
        const mIm = (li + ri) * 0.5;
        const sRe = (lr - rr) * 0.5;
        const sIm = (li - ri) * 0.5;
        bandMidSq[bi]! += mRe * mRe + mIm * mIm;
        bandSideSq[bi]! += sRe * sRe + sIm * sIm;
      }
    }
    if (start + fftSize >= frameCount) break;
  }

  let magSum = 0;
  let weightedFreqSum = 0;
  let logMagSum = 0;
  let activeBins = 0;
  for (let b = 1; b < halfBins; b += 1) {
    const m = avgMag[b]! / Math.max(1, fftFrames);
    magSum += m;
    weightedFreqSum += b * binHz * m;
    if (m > 1e-12) {
      logMagSum += Math.log(m);
      activeBins += 1;
    }
  }
  const spectralCentroidHz = magSum > 1e-12 ? round2(weightedFreqSum / magSum) : 0;
  let cumMag = 0;
  let spectralRolloff85Hz = 0;
  for (let b = 1; b < halfBins; b += 1) {
    cumMag += avgMag[b]! / Math.max(1, fftFrames);
    if (cumMag >= 0.85 * magSum) {
      spectralRolloff85Hz = round2(b * binHz);
      break;
    }
  }
  const geomMean = activeBins > 0 ? Math.exp(logMagSum / activeBins) : 0;
  const arithMean = activeBins > 0 ? magSum / activeBins : 0;
  const spectralFlatness = arithMean > 1e-12 ? clamp(round2(geomMean / arithMean), 0, 1) : 0;

  const tonalBalanceDb = emptyBandRecord();
  const stereoBands = emptyStereoBands();

  for (let bi = 0; bi < TRACE_BANDS.length; bi += 1) {
    const bandName = TRACE_BANDS[bi]!.band;
    const p = bandPowerSum[bi]!;
    // Band energy relative to full-band energy in dB (strictly <= 0 as required by `validateTraceAnalysis`)
    const relDb =
      totalFullSpecPower > 1e-18 && p > 1e-18
        ? Math.min(0, round2(10 * Math.log10(p / totalFullSpecPower)))
        : -60;
    tonalBalanceDb[bandName] = relDb;
    stereoBands[bandName] = {
      correlation: channels === 1 ? 1 : pearsonCorrelation(bandLR[bi]!, bandLL[bi]!, bandRR[bi]!),
      widthPct: channels === 1 ? 0 : sideWidthPct(bandMidSq[bi]!, bandSideSq[bi]!),
    };
  }

  const overallCorr = channels === 1 ? 1 : pearsonCorrelation(sumLR, sumLL, sumRR);
  const overallWidth = channels === 1 ? 0 : sideWidthPct(sumMidSq, sumSideSq);
  const phaseCoherenceScore = clamp(round2((overallCorr + 1) * 50), 0, 100);
  const subCorr = stereoBands.sub.correlation;
  const subWidth = stereoBands.sub.widthPct;

  const monoCompatibilityRisk: AudioDspFeatures['stereo']['monoCompatibilityRisk'] =
    overallCorr < 0.05 || subCorr < 0.1
      ? 'high'
      : overallCorr < 0.3 || subWidth > 15
        ? 'moderate'
        : 'none';

  const features: AudioDspFeatures = {
    samplePeakDbfs,
    truePeakDbtp: { status: 'available', value: truePeakDbtpValue },
    rmsDbfs,
    crestFactorDb,
    dynamicRangeDb,
    dcOffset,
    loudness: {
      integratedLufs,
      shortTermMaxLufs,
      momentaryMaxLufs,
      rangeLu,
    },
    clipping: {
      clippedSampleCount: clippedSamples,
      clippedRatio: round2(clippedSamples / Math.max(1, totalSamples)),
      exceedsZeroDbfs: samplePeakDbfs >= -0.01,
      exceedsMinusOneDbtp: truePeakDbtpValue > -1.0,
    },
    silence: {
      leadingSilenceSec,
      trailingSilenceSec,
      silentFrameRatio,
      isEffectiveSilence: rmsDbfs <= -65,
    },
    noiseFloorDbfs,
    transients: {
      transientCount,
      transientDensityPerSec: round2(transientCount / Math.max(0.01, decoded.durationSec)),
      peakToAverageTransientRatio,
    },
    spectrum: {
      fftSize,
      spectralCentroidHz,
      spectralRolloff85Hz,
      spectralFlatness,
      tonalBalanceDb,
    },
    stereo: {
      correlation: overallCorr,
      widthPct: overallWidth,
      phaseCoherenceScore,
      subCorrelation: subCorr,
      subWidthPct: subWidth,
      monoCompatibilityRisk,
      bands: stereoBands,
    },
  };

  const traceAnalysis: TraceAnalysis = {
    schema: TRACE_ANALYSIS_SCHEMA_ID,
    producer: { tool: 'XYP3RN-AudioBrain', version: '1.0.0' },
    subject,
    audio: {
      sampleRateHz,
      durationSec: Number(decoded.durationSec.toFixed(3)),
    },
    loudness: {
      integratedLufs,
      shortTermMaxLufs,
      momentaryMaxLufs,
      rangeLu,
      truePeakDbtp: truePeakDbtpValue,
    },
    tonalBalanceDb,
    stereo: {
      correlation: overallCorr,
      widthPct: overallWidth,
      bands: stereoBands,
    },
    dynamics: { crestFactorDb },
  };

  const traceViolations = validateTraceAnalysis(traceAnalysis);
  if (traceViolations.length > 0) {
    throw new Error(`Internal Audio Brain trace.analysis/v1 invariant failure: ${traceViolations.join('; ')}`);
  }

  return { features, traceAnalysis };
};
