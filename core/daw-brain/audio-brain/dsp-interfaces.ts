export type DspPrecision = 'float32' | 'float64';
export type DspChannelLayout = 'mono' | 'stereo';
export type DspWindowType = 'hann' | 'hamming' | 'blackman_harris' | 'rectangular';
export type DspNormalizationMode = 'none' | 'peak_unity' | 'window_coherent_gain';

export type DspTolerances = {
  readonly loudnessLufsTolerance: number;
  readonly truePeakDbtpTolerance: number;
  readonly frequencyHzTolerance: number;
  readonly sampleRateMismatchAllowed: boolean;
};

export type DspConfig = {
  readonly sampleRateHz: number;
  readonly channelLayout: DspChannelLayout;
  readonly bufferSize: number;
  readonly precision: DspPrecision;
  readonly latencySamples: number;
  readonly window: DspWindowType;
  readonly hopSize: number;
  readonly overlapRatio: number;
  readonly fftSize: number;
  readonly normalization: DspNormalizationMode;
  readonly tolerances: DspTolerances;
};

export interface DspProcessor<TInput, TOutput> {
  readonly name: string;
  getConfig(): DspConfig;
  configure(patch: Partial<DspConfig>): void;
  process(input: TInput): TOutput;
  reset(): void;
}

export const createDefaultDspConfig = (
  sampleRateHz: number,
  channelLayout: DspChannelLayout,
): DspConfig => ({
  sampleRateHz,
  channelLayout,
  bufferSize: 4096,
  precision: 'float64',
  latencySamples: 4096,
  window: 'hann',
  hopSize: 2048,
  overlapRatio: 0.5,
  fftSize: 4096,
  normalization: 'window_coherent_gain',
  tolerances: {
    loudnessLufsTolerance: 0.5,
    truePeakDbtpTolerance: 0.25,
    frequencyHzTolerance: sampleRateHz / 4096,
    sampleRateMismatchAllowed: false,
  },
});

export const buildWindowCoefficients = (
  size: number,
  windowType: DspWindowType,
): { readonly coeffs: Float64Array; readonly coherentGain: number; readonly powerSum: number } => {
  const coeffs = new Float64Array(size);
  let sum = 0;
  let powerSum = 0;
  const denom = Math.max(1, size - 1);

  for (let i = 0; i < size; i += 1) {
    let w = 1;
    if (windowType === 'hann') {
      w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
    } else if (windowType === 'hamming') {
      w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / denom);
    } else if (windowType === 'blackman_harris') {
      const a = (2 * Math.PI * i) / denom;
      w = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    }
    coeffs[i] = w;
    sum += w;
    powerSum += w * w;
  }

  return {
    coeffs,
    coherentGain: sum > 0 ? sum / size : 1,
    powerSum: powerSum > 0 ? powerSum : size,
  };
};

/**
 * In-place radix-2 Cooley-Tukey FFT (`size` must be a power of 2).
 */
export const fftInPlace = (re: Float64Array, im: Float64Array): void => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wLenCos = Math.cos(ang);
    const wLenSin = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wCos = 1;
      let wSin = 0;
      for (let j = 0; j < half; j += 1) {
        const evenIdx = i + j;
        const oddIdx = evenIdx + half;
        const tRe = wCos * re[oddIdx]! - wSin * im[oddIdx]!;
        const tIm = wCos * im[oddIdx]! + wSin * re[oddIdx]!;
        re[oddIdx] = re[evenIdx]! - tRe;
        im[oddIdx] = im[evenIdx]! - tIm;
        re[evenIdx] = re[evenIdx]! + tRe;
        im[evenIdx] = im[evenIdx]! + tIm;
        const nextCos = wCos * wLenCos - wSin * wLenSin;
        wSin = wCos * wLenSin + wSin * wLenCos;
        wCos = nextCos;
      }
    }
  }
};

type BiquadCoeffs = {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
};

const computeKWeightBiquads = (sampleRateHz: number): readonly [BiquadCoeffs, BiquadCoeffs] => {
  // Stage 1: +4 dB high-shelf pre-filter calibrated around ~1681.97 Hz (ITU-R BS.1770-4 sample-rate scaled)
  const f0Pre = 1681.974450955533;
  const gPre = 3.999843853973347;
  const qPre = 0.7071752369554196;
  const kPre = Math.tan((Math.PI * f0Pre) / sampleRateHz);
  const vh = Math.pow(10, gPre / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0Pre = 1 + kPre / qPre + kPre * kPre;
  const stage1: BiquadCoeffs = {
    b0: (vh + (vb * kPre) / qPre + kPre * kPre) / a0Pre,
    b1: (2 * (kPre * kPre - vh)) / a0Pre,
    b2: (vh - (vb * kPre) / qPre + kPre * kPre) / a0Pre,
    a1: (2 * (kPre * kPre - 1)) / a0Pre,
    a2: (1 - kPre / qPre + kPre * kPre) / a0Pre,
  };

  // Stage 2: RLB high-pass weighting (~38.135 Hz)
  const f0Rlb = 38.13547087602444;
  const qRlb = 0.5003270373238773;
  const kRlb = Math.tan((Math.PI * f0Rlb) / sampleRateHz);
  const a0Rlb = 1 + kRlb / qRlb + kRlb * kRlb;
  const stage2: BiquadCoeffs = {
    b0: 1 / a0Rlb,
    b1: -2 / a0Rlb,
    b2: 1 / a0Rlb,
    a1: (2 * (kRlb * kRlb - 1)) / a0Rlb,
    a2: (1 - kRlb / qRlb + kRlb * kRlb) / a0Rlb,
  };

  return [stage1, stage2];
};

const runBiquad = (samples: Float32Array, c: BiquadCoeffs): Float64Array => {
  const out = new Float64Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i] ?? 0;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
};

/**
 * Applies ITU-R BS.1770-4 two-stage K-weighting per channel.
 */
export const applyKWeighting = (
  channels: readonly Float32Array[],
  sampleRateHz: number,
): readonly Float64Array[] => {
  const [stage1, stage2] = computeKWeightBiquads(sampleRateHz);
  return channels.map((ch) => {
    const mid = runBiquad(ch, stage1);
    const out = new Float64Array(mid.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < mid.length; i += 1) {
      const x0 = mid[i] ?? 0;
      const y0 = stage2.b0 * x0 + stage2.b1 * x1 + stage2.b2 * x2 - stage2.a1 * y1 - stage2.a2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  });
};

/**
 * 4x cubic Catmull-Rom oversampled intersample true-peak estimator (`dBTP`).
 */
export const estimateTruePeakLinear = (channels: readonly Float32Array[]): number => {
  let maxAbs = 0;
  for (const ch of channels) {
    const n = ch.length;
    for (let i = 0; i < n; i += 1) {
      const s = Math.abs(ch[i] ?? 0);
      if (s > maxAbs) maxAbs = s;
      if (i >= 1 && i + 2 < n) {
        const y0 = ch[i - 1]!;
        const y1 = ch[i]!;
        const y2 = ch[i + 1]!;
        const y3 = ch[i + 2]!;
        for (const t of [0.25, 0.5, 0.75] as const) {
          const t2 = t * t;
          const t3 = t2 * t;
          const v =
            0.5 *
            (2 * y1 +
              (-y0 + y2) * t +
              (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
              (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
          const av = Math.abs(v);
          if (av > maxAbs) maxAbs = av;
        }
      }
    }
  }
  return maxAbs;
};

export const linearToDb = (linear: number, floorDb = -120): number =>
  linear <= 1e-12 ? floorDb : Number((20 * Math.log10(linear)).toFixed(2));
