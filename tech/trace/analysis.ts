import { num, obj, str, validateJson, type JsonSchema } from '../../core/llm/json-schema.ts';

/**
 * trace.analysis/v1: the TRACE boundary contract (Phase 11, owned by TECH, ARCHITECTURE F24).
 *
 * This file is the only definition of what a TRACE-shaped mix analysis is. X3LIUS Mix/Master reads
 * it (Phase 11), and the Phase 14 TRACE integration implements it. A change is a new id
 * (`trace.analysis/v2`) next to this one, never an edit in place.
 *
 * The analysis covers one render of one track, either the mix bus or the master:
 * - loudness per ITU-R BS.1770 / EBU R128: integrated, short-term max and momentary max in LUFS,
 *   loudness range in LU, and true peak in dBTP;
 * - tonal balance: each band's energy relative to the full-band energy, in dB (≤ 0), over the
 *   fixed bands below;
 * - stereo: L/R correlation (−1..1) and width, meaning side energy as a percentage of mid + side
 *   energy (0 = mono, 100 = all side), for the full band and for each band;
 * - dynamics: crest factor (sample peak over RMS) in dB.
 */

export const TRACE_ANALYSIS_SCHEMA_ID = 'trace.analysis/v1';

/** The fixed tonal bands (Hz, low edge inclusive). Part of the contract: v1 never changes them. */
export const TRACE_BANDS = [
  { band: 'sub', lowHz: 20, highHz: 60 },
  { band: 'bass', lowHz: 60, highHz: 250 },
  { band: 'low-mid', lowHz: 250, highHz: 500 },
  { band: 'mid', lowHz: 500, highHz: 2000 },
  { band: 'high-mid', lowHz: 2000, highHz: 4000 },
  { band: 'presence', lowHz: 4000, highHz: 6000 },
  { band: 'air', lowHz: 6000, highHz: 20000 },
] as const;

export type TraceBand = (typeof TRACE_BANDS)[number]['band'];
export type TraceStage = 'mix' | 'master';
type Stereo = { readonly correlation: number; readonly widthPct: number };

export type TraceAnalysis = {
  readonly schema: typeof TRACE_ANALYSIS_SCHEMA_ID;
  /** What produced the numbers, e.g. `{ tool: 'TRACE', version: '1.0.0' }`. */
  readonly producer: { readonly tool: string; readonly version: string };
  readonly subject: { readonly stage: TraceStage; readonly label: string };
  readonly audio: { readonly sampleRateHz: number; readonly durationSec: number };
  readonly loudness: {
    readonly integratedLufs: number;
    readonly shortTermMaxLufs: number;
    readonly momentaryMaxLufs: number;
    readonly rangeLu: number;
    readonly truePeakDbtp: number;
  };
  readonly tonalBalanceDb: Readonly<Record<TraceBand, number>>;
  readonly stereo: Stereo & { readonly bands: Readonly<Record<TraceBand, Stereo>> };
  readonly dynamics: { readonly crestFactorDb: number };
};

const byBand = (schema: JsonSchema, description: string): JsonSchema =>
  obj(Object.fromEntries(TRACE_BANDS.map((b) => [b.band, schema])), description);
const STEREO = { correlation: num('L/R correlation, −1..1'), widthPct: num('Side energy as % of mid + side energy, 0..100') };

export const TRACE_ANALYSIS_SCHEMA: JsonSchema = obj({
  schema: { type: 'string', enum: [TRACE_ANALYSIS_SCHEMA_ID] },
  producer: obj({ tool: str('What measured it, e.g. TRACE'), version: str('Its version') }),
  subject: obj({ stage: { type: 'string', enum: ['mix', 'master'] }, label: str('Which render, e.g. track title and bounce') }),
  audio: obj({ sampleRateHz: { type: 'integer', description: 'Sample rate in Hz' }, durationSec: num('Length in seconds') }),
  loudness: obj({
    integratedLufs: num('Integrated loudness, LUFS'),
    shortTermMaxLufs: num('Maximum short-term (3 s) loudness, LUFS'),
    momentaryMaxLufs: num('Maximum momentary (400 ms) loudness, LUFS'),
    rangeLu: num('Loudness range, LU'),
    truePeakDbtp: num('True peak, dBTP'),
  }),
  tonalBalanceDb: byBand(num('Band energy relative to full-band energy, dB (≤ 0)'), 'One entry per TRACE band'),
  stereo: obj({ ...STEREO, bands: byBand(obj(STEREO), 'One entry per TRACE band') }),
  dynamics: obj({ crestFactorDb: num('Sample peak over RMS, dB') }),
});

/** One measured value under the id a rubric claim names it by (`x3lius.<stage>.<id>`). */
export type TraceMetric = { readonly id: string; readonly unit: string; readonly value: number };

const METRICS: readonly { readonly id: string; readonly unit: string; readonly read: (a: TraceAnalysis) => number }[] = [
  { id: 'loudness.integrated-lufs', unit: 'LUFS', read: (a) => a.loudness.integratedLufs },
  { id: 'loudness.short-term-max-lufs', unit: 'LUFS', read: (a) => a.loudness.shortTermMaxLufs },
  { id: 'loudness.momentary-max-lufs', unit: 'LUFS', read: (a) => a.loudness.momentaryMaxLufs },
  { id: 'loudness.range-lu', unit: 'LU', read: (a) => a.loudness.rangeLu },
  { id: 'loudness.true-peak-dbtp', unit: 'dBTP', read: (a) => a.loudness.truePeakDbtp },
  ...TRACE_BANDS.map((b) => ({ id: `tonal.${b.band}-db`, unit: 'dB', read: (a: TraceAnalysis) => a.tonalBalanceDb[b.band] })),
  { id: 'stereo.correlation', unit: 'r', read: (a) => a.stereo.correlation },
  { id: 'stereo.width-pct', unit: '%', read: (a) => a.stereo.widthPct },
  ...TRACE_BANDS.flatMap((b) => [
    { id: `stereo.${b.band}.correlation`, unit: 'r', read: (a: TraceAnalysis) => a.stereo.bands[b.band].correlation },
    { id: `stereo.${b.band}.width-pct`, unit: '%', read: (a: TraceAnalysis) => a.stereo.bands[b.band].widthPct },
  ]),
  { id: 'dynamics.crest-factor-db', unit: 'dB', read: (a) => a.dynamics.crestFactorDb },
];

/** Every metric id with its unit, in contract order. */
export const TRACE_METRICS: readonly { readonly id: string; readonly unit: string }[] = METRICS.map(({ id, unit }) => ({ id, unit }));

/**
 * @param a - a valid analysis
 * @returns every metric of the contract, in contract order
 */
export const traceMetrics = (a: TraceAnalysis): TraceMetric[] => METRICS.map((m) => ({ id: m.id, unit: m.unit, value: m.read(a) }));

const within = (v: number, min: number, max: number) => v >= min && v <= max;

/**
 * Validates a value against trace.analysis/v1: shape (schema), then ranges the shape can't state.
 * @param value - parsed JSON
 * @param path - prefix for messages (default `$`)
 * @returns every violation, empty when valid
 */
export const validateTraceAnalysis = (value: unknown, path = '$'): string[] => {
  const shape = validateJson(TRACE_ANALYSIS_SCHEMA, value, path);
  if (shape.length > 0) return shape;
  const a = value as TraceAnalysis;
  const stereo = (s: Stereo, at: string) => [
    ...(within(s.correlation, -1, 1) ? [] : [`${at}.correlation must be from -1 to 1`]),
    ...(within(s.widthPct, 0, 100) ? [] : [`${at}.widthPct must be from 0 to 100`]),
  ];
  const blank = ([at, v]: readonly [string, string]) => v.trim() === '';
  return [
    ...([['producer.tool', a.producer.tool], ['producer.version', a.producer.version], ['subject.label', a.subject.label]] as const)
      .filter(blank).map(([at]) => `${path}.${at} must not be empty`),
    ...(a.audio.sampleRateHz > 0 ? [] : [`${path}.audio.sampleRateHz must be positive`]),
    ...(a.audio.durationSec > 0 ? [] : [`${path}.audio.durationSec must be positive`]),
    ...(a.loudness.rangeLu >= 0 ? [] : [`${path}.loudness.rangeLu must not be negative`]),
    ...TRACE_BANDS.filter((b) => a.tonalBalanceDb[b.band] > 0).map((b) => `${path}.tonalBalanceDb.${b.band} must be ≤ 0 (a band can't hold more than the full band)`),
    ...stereo(a.stereo, `${path}.stereo`),
    ...TRACE_BANDS.flatMap((b) => stereo(a.stereo.bands[b.band], `${path}.stereo.bands.${b.band}`)),
    ...(a.dynamics.crestFactorDb >= 0 ? [] : [`${path}.dynamics.crestFactorDb must not be negative`]),
  ];
};
