import type { TraceAnalysis } from '../../tech/trace/analysis.ts';

// FIXTURE: the analysis and the rubric below are synthetic ("[FIXTURE]" in every text field; the
// numbers are made up) and are admitted only into this throwaway database. The real rubric is
// operator-authored (records/x3lius/mix-rubric.yaml).
// Shared by tests/phase-11/mix-master.test.ts and tests/phase-12/critic-revision.test.ts.

export const ANALYSIS: TraceAnalysis = {
  schema: 'trace.analysis/v1',
  producer: { tool: '[FIXTURE] TRACE', version: '0.0.0' },
  subject: { stage: 'master', label: '[FIXTURE] night drive, master bounce 3' },
  audio: { sampleRateHz: 48000, durationSec: 182.5 },
  loudness: { integratedLufs: -12.3, shortTermMaxLufs: -9.1, momentaryMaxLufs: -7.4, rangeLu: 5.2, truePeakDbtp: -0.2 },
  tonalBalanceDb: { sub: -9.5, bass: -4.1, 'low-mid': -8.7, mid: -9.9, 'high-mid': -13.2, presence: -16.8, air: -19.4 },
  stereo: {
    correlation: 0.62, widthPct: 31,
    bands: {
      sub: { correlation: 0.97, widthPct: 7 }, bass: { correlation: 0.93, widthPct: 9 }, 'low-mid': { correlation: 0.81, widthPct: 18 },
      mid: { correlation: 0.64, widthPct: 30 }, 'high-mid': { correlation: 0.52, widthPct: 38 }, presence: { correlation: 0.48, widthPct: 41 }, air: { correlation: 0.41, widthPct: 44 },
    },
  },
  dynamics: { crestFactorDb: 9.8 },
};

export const RUBRIC = (integrated = '{ min: -10, max: -8 }') => `# [FIXTURE] synthetic rubric for the Phase 11 tests
mix_rubric: xyp-mix-rubric/v1
artist: X3LIUS
date: 2026-09-24
module: x3lius-mix-master
master:
  loudness.integrated-lufs: ${integrated}
  loudness.true-peak-dbtp: { max: -1 }
  loudness.range-lu: { min: 4 }
  stereo.sub.width-pct: { max: 5 }
mix:
  loudness.true-peak-dbtp: { max: -6 }
`;
