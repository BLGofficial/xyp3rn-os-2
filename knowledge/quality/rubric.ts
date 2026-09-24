/**
 * Quality rubric for quality_reports (Phase 2). Every score ships with the inputs that
 * produced it; nothing here is a magic number without a stated rule.
 *
 * Changing a weight, a reliability score or the horizon changes what a score means, so it
 * must bump RUBRIC_VERSION in the same commit — old reports keep their old version label.
 */

export const RUBRIC_VERSION = 'quality-v1';

/**
 * User-approved weights. Completeness leads because malformed entries degrade Phase 3
 * retrieval directly; reliability next; freshness last because architecture docs age slowly.
 */
export const WEIGHTS = { completeness: 0.5, source_reliability: 0.3, freshness: 0.2 } as const;

/** Age at which a document's freshness reaches 0. Linear decay in between. */
export const FRESHNESS_HORIZON_DAYS = 365;

export type SourceKind = 'url' | 'file' | 'manual';
export type SourceOrigin = 'first_party' | 'third_party';

export type Criterion = {
  readonly name: keyof typeof WEIGHTS;
  readonly weight: number;
  readonly score: number;
  readonly inputs: Readonly<Record<string, unknown>>;
};

export type QualityReport = {
  readonly rubric_version: string;
  readonly criteria: readonly Criterion[];
  readonly overall: number;
};

/** One explicit rule per kind x origin. First-party = authored/controlled by XYP3RN. */
export const RELIABILITY_RULES: ReadonlyArray<{
  readonly kind: SourceKind;
  readonly origin: SourceOrigin;
  readonly score: number;
  readonly rule: string;
}> = [
  { kind: 'file', origin: 'first_party', score: 1.0, rule: 'First-party file: authored by XYP3RN, stable bytes, direct provenance.' },
  { kind: 'url', origin: 'first_party', score: 0.9, rule: 'First-party URL: owner-controlled, but the location can change after this checksummed copy.' },
  { kind: 'manual', origin: 'first_party', score: 0.8, rule: 'First-party manual entry: owner-typed, no underlying document to re-verify against.' },
  { kind: 'file', origin: 'third_party', score: 0.6, rule: 'Third-party file: external author, stable copy; claims need corroboration.' },
  { kind: 'url', origin: 'third_party', score: 0.5, rule: 'Third-party URL: external author and mutable location; claims need corroboration.' },
  { kind: 'manual', origin: 'third_party', score: 0.4, rule: 'Third-party manual entry: transcribed external claim with no document of record.' },
];

const DAY_MS = 86_400_000;

/**
 * Scores structural completeness: the share of expected fields actually present.
 * @param expected - fields the entry type should carry
 * @param present - fields found (anything not in `expected` is ignored)
 * @returns completeness criterion; inputs name what is missing
 */
export const scoreCompleteness = (expected: readonly string[], present: readonly string[]): Criterion => {
  const found = expected.filter((f) => present.includes(f));
  return {
    name: 'completeness',
    weight: WEIGHTS.completeness,
    score: expected.length === 0 ? 0 : found.length / expected.length,
    inputs: { expected: [...expected], present: found, missing: expected.filter((f) => !present.includes(f)) },
  };
};

/**
 * Scores source reliability from the explicit kind x origin table.
 * @param kind - how the source was acquired
 * @param origin - who authored/controls it
 * @returns reliability criterion citing the rule applied
 * @throws Error if the table has no rule for the pair (deny by default)
 */
export const scoreReliability = (kind: SourceKind, origin: SourceOrigin): Criterion => {
  const rule = RELIABILITY_RULES.find((r) => r.kind === kind && r.origin === origin);
  if (!rule) throw new Error(`no reliability rule for ${kind}/${origin}`);
  return {
    name: 'source_reliability',
    weight: WEIGHTS.source_reliability,
    score: rule.score,
    inputs: { kind, origin, rule: rule.rule },
  };
};

/**
 * Scores freshness from the document's own date. An unknown date earns no credit: freshness
 * that can't be verified isn't assumed.
 * @param documentDate - date the document states for itself, or null if none was found
 * @param asOf - evaluation time (injectable so reports are reproducible)
 * @returns freshness criterion with age and horizon in its inputs
 */
export const scoreFreshness = (documentDate: Date | null, asOf: Date): Criterion => {
  if (documentDate === null) {
    return {
      name: 'freshness',
      weight: WEIGHTS.freshness,
      score: 0,
      inputs: { document_date: null, as_of: asOf.toISOString(), reason: 'no document date found; freshness unverifiable' },
    };
  }
  const ageDays = Math.max(0, Math.floor((asOf.getTime() - documentDate.getTime()) / DAY_MS));
  return {
    name: 'freshness',
    weight: WEIGHTS.freshness,
    score: Math.min(1, Math.max(0, 1 - ageDays / FRESHNESS_HORIZON_DAYS)),
    inputs: {
      document_date: documentDate.toISOString().slice(0, 10),
      as_of: asOf.toISOString(),
      age_days: ageDays,
      horizon_days: FRESHNESS_HORIZON_DAYS,
    },
  };
};

/**
 * Combines criteria into a report. overall = sum(weight x score), rounded to 4 dp to match
 * quality_reports.overall numeric(5,4).
 * @param criteria - one of each rubric criterion
 * @returns the report row payload
 * @throws Error if the weights don't sum to 1 (a partial rubric is not a score)
 */
export const buildReport = (criteria: readonly Criterion[]): QualityReport => {
  const weightSum = criteria.reduce((a, c) => a + c.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new Error(`criteria weights sum to ${weightSum}, expected 1`);
  const overall = criteria.reduce((a, c) => a + c.weight * c.score, 0);
  return { rubric_version: RUBRIC_VERSION, criteria: [...criteria], overall: Math.round(overall * 10_000) / 10_000 };
};
