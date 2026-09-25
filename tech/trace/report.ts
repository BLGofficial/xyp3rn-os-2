import { arr, int, num, obj, str, validateJson, type JsonSchema } from '../../core/llm/json-schema.ts';
import type { TraceAnalysis, TraceStage } from './analysis.ts';

/**
 * trace.report/v1: what the OS answers TRACE with (Phase 14, owned by TECH, ARCHITECTURE F24).
 *
 * For one trace.analysis/v1, the report lists every metric the canonical mix/master rubric bounds,
 * as a check (keep, raise or lower, by how much, and the rubric claim that says so), and every
 * metric no claim bounds (unset). The check defined here is the one X3LIUS Mix/Master computes and
 * the one its x3lius.mix-report/v1 artifact stores: one definition, imported by both. A change is a
 * new id (trace.report/v2) next to this one, never an edit in place.
 */

export const TRACE_REPORT_SCHEMA_ID = 'trace.report/v1';

/** The three things a check can ask for. */
export const TRACE_ACTIONS = ['keep', 'raise', 'lower'] as const;
export type TraceAction = (typeof TRACE_ACTIONS)[number];
/** A rubric range: either end may be open. */
export type TraceBound = { readonly min?: number; readonly max?: number };
export type TraceCheck = {
  readonly metric: string;
  readonly unit: string;
  readonly measured: number;
  readonly rubric: TraceBound;
  readonly action: TraceAction;
  /** Distance to the nearest bound, in `unit`; 0 when kept. */
  readonly by: number;
  /** The rubric claim: `canonical_prompts:<id>#<topic>`. */
  readonly ref: string;
  /** Version of that canonical row. */
  readonly version: number;
};

export type TraceReport = {
  readonly schema: typeof TRACE_REPORT_SCHEMA_ID;
  /** trace_analyses.id: the stored measurement this report answers. */
  readonly analysisId: string;
  readonly subject: { readonly stage: TraceStage; readonly label: string };
  readonly checks: readonly TraceCheck[];
  readonly unset: readonly string[];
  /** How many rubric claims were in force for this stage. */
  readonly rubricClaims: number;
  /** The x3lius.mix-report/v1 artifact holding the same checks, with their provenance. */
  readonly mixReportArtifactId: string;
};

// The one JSON Schema subset with optional keys: `required: []` (never sent to a model).
export const TRACE_BOUND_SCHEMA: JsonSchema = {
  type: 'object', properties: { min: num('Lowest value in range'), max: num('Highest value in range') }, required: [], additionalProperties: false,
};

export const TRACE_CHECK_SCHEMA: JsonSchema = obj({
  metric: str('A trace.analysis/v1 metric id, e.g. loudness.integrated-lufs'),
  unit: str('The metric\'s unit'),
  measured: num('The analysis value'),
  rubric: TRACE_BOUND_SCHEMA,
  action: { type: 'string', enum: [...TRACE_ACTIONS] },
  by: num('How far to move it to reach the nearest bound, in unit (0 when kept)'),
  ref: str('The rubric claim: canonical_prompts:<id>#<topic>'),
  version: int('Version of that canonical row'),
});

export const TRACE_REPORT_SCHEMA: JsonSchema = obj({
  schema: { type: 'string', enum: [TRACE_REPORT_SCHEMA_ID] },
  analysisId: str('The stored analysis (uuid)'),
  subject: obj({ stage: { type: 'string', enum: ['mix', 'master'] }, label: str('Which render') }),
  checks: arr(TRACE_CHECK_SCHEMA, 'One per metric the rubric bounds, in contract order'),
  unset: arr(str('A metric no rubric claim bounds: reported, never defaulted')),
  rubricClaims: int('Rubric claims in force for this stage'),
  mixReportArtifactId: str('The x3lius.mix-report/v1 artifact (uuid)'),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^canonical_prompts:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#\S+$/;

/**
 * Validates a value against trace.report/v1: shape, then what the shape can't state (uuids, rule refs,
 * versions, counts). Both passes run, so every violation is named at once.
 * @param value - parsed JSON
 * @param path - prefix for messages (default `$`)
 * @returns every violation, empty when valid
 */
export const validateTraceReport = (value: unknown, path = '$'): string[] => {
  const shape = validateJson(TRACE_REPORT_SCHEMA, value, path);
  const r = (value ?? {}) as Partial<Record<keyof TraceReport, unknown>>;
  const checks = Array.isArray(r.checks) ? (r.checks as Partial<TraceCheck>[]) : [];
  return [
    ...shape,
    ...(['analysisId', 'mixReportArtifactId'] as const)
      .filter((k) => typeof r[k] === 'string' && !UUID.test(r[k] as string)).map((k) => `${path}.${k} must be a uuid`),
    ...checks.flatMap((c, i) => [
      ...(typeof c?.ref === 'string' && !REF.test(c.ref) ? [`${path}.checks[${i}].ref must be canonical_prompts:<uuid>#<topic>`] : []),
      ...(typeof c?.version === 'number' && c.version < 1 ? [`${path}.checks[${i}].version must be at least 1`] : []),
      ...(typeof c?.by === 'number' && c.by < 0 ? [`${path}.checks[${i}].by must not be negative`] : []),
    ]),
    ...(typeof r.rubricClaims === 'number' && r.rubricClaims < 0 ? [`${path}.rubricClaims must not be negative`] : []),
  ];
};

/**
 * @param a - the stored analysis id and body, and the checks Mix/Master computed for it
 * @returns the report TRACE receives
 */
export const buildTraceReport = (a: {
  readonly analysisId: string; readonly analysis: TraceAnalysis; readonly checks: readonly TraceCheck[];
  readonly unset: readonly string[]; readonly rubricClaims: number; readonly mixReportArtifactId: string;
}): TraceReport => ({
  schema: TRACE_REPORT_SCHEMA_ID,
  analysisId: a.analysisId,
  subject: { stage: a.analysis.subject.stage, label: a.analysis.subject.label },
  checks: a.checks,
  unset: a.unset,
  rubricClaims: a.rubricClaims,
  mixReportArtifactId: a.mixReportArtifactId,
});
