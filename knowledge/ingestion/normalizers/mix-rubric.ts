import { parse as parseYaml } from 'yaml';
import { TRACE_ANALYSIS_SCHEMA_ID, TRACE_METRICS, type TraceStage } from '../../../tech/trace/analysis.ts';
import { slugify, type NormalizedDocument, type NormalizedPrompt } from '../types.ts';
import { PLACEHOLDER } from './vocal-dna.ts';

/**
 * Mix/master rubric normalizer (Phase 11, ARCHITECTURE F24). An operator-authored YAML file states
 * an artist's mix and master targets as bounds on trace.analysis/v1 metrics. It becomes ONE
 * canonical prompt in the artist's Mix/Master module (the manifest's, referenced here, never
 * redeclared), is admitted through the gate's first-party path, and is versioned like any other
 * canonical write. Each bound is a claim `<artist>.<stage>.<metric>` = `{ min?, max? }`.
 *
 * The claims are scoped `trace`, so they reach only the agent that checks a TRACE analysis
 * (x3lius-mix-master). They never appear in a lyrics or Suno prompt.
 *
 * Research candidates can add bounds the same way, one claim per candidate on its own slug.
 * The reader refuses a metric that two current rows both state.
 *
 * Strict: an unknown metric or field, a placeholder, a non-number, or min > max fails the whole
 * run. No bound is defaulted; a metric the file doesn't state is reported as unset.
 */

export const MIX_RUBRIC_NORMALIZER_ID = 'xyp-mix-rubric-v1';
export const MIX_RUBRIC_SCHEMA = 'xyp-mix-rubric/v1';
/** Model scope of every rubric claim: only the TRACE analysis check takes them. */
export const RUBRIC_SCOPE = 'trace';
export const RUBRIC_STAGES: readonly TraceStage[] = ['mix', 'master'];

const MARKER = /^mix_rubric:\s*xyp-mix-rubric\/v1\s*$/m;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_FIELDS = new Set(['mix_rubric', 'artist', 'date', 'module', ...RUBRIC_STAGES]);
const UNITS = new Map(TRACE_METRICS.map((m) => [m.id, m.unit]));

/** A rubric bound on one metric: at least one side, min ≤ max. */
export type RubricBound = { readonly min?: number; readonly max?: number };

export type MixRubricFile = {
  readonly artist: string;
  readonly date: string;
  readonly module: string;
  /** Stage → metric id → bound; only the stages the file states. */
  readonly stages: Readonly<Partial<Record<TraceStage, Readonly<Record<string, RubricBound>>>>>;
};

const fail = (message: string): never => {
  throw new Error(`mix rubric: ${message}`);
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') return fail(`${what} must be a non-empty string`);
  if (PLACEHOLDER.test(v.trim())) return fail(`${what} is a placeholder ("${v.trim()}"): give the real value`);
  return v.trim();
};

const bound = (v: unknown, what: string): number => {
  if (typeof v === 'string' && PLACEHOLDER.test(v.trim())) return fail(`${what} is a placeholder ("${v.trim()}"): give the real value`);
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} must be a number`);
};

/**
 * Validates one bound, wherever it comes from: the operator file, or a canonical claim read back.
 * @param v - `{ min?, max? }`
 * @param what - name for messages
 * @returns the bound
 * @throws Error when neither side is given, a side isn't a number, a field is unknown, or min > max
 */
export const parseRubricBound = (v: unknown, what: string): RubricBound => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(`${what} must be a mapping with min and/or max`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'min' && k !== 'max') fail(`${what}: unknown field: ${k}`);
  if (o.min === undefined && o.max === undefined) fail(`${what} needs min, max or both`);
  const b: RubricBound = {
    ...(o.min !== undefined ? { min: bound(o.min, `${what}.min`) } : {}),
    ...(o.max !== undefined ? { max: bound(o.max, `${what}.max`) } : {}),
  };
  if (b.min !== undefined && b.max !== undefined && b.min > b.max) fail(`${what}: min ${b.min} is above max ${b.max}`);
  return b;
};

const stage = (v: unknown, name: TraceStage): Record<string, RubricBound> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) {
    return fail(`${name} must be a mapping of trace.analysis/v1 metric ids to bounds`);
  }
  return Object.fromEntries(Object.entries(v).map(([metric, b]) => {
    if (!UNITS.has(metric)) fail(`${name}: ${metric} is not a ${TRACE_ANALYSIS_SCHEMA_ID} metric`);
    return [metric, parseRubricBound(b, `${name}.${metric}`)];
  }));
};

/**
 * Parses and validates a rubric file.
 * @param source - YAML text
 * @returns the validated file
 * @throws Error naming the first invalid field
 */
export const parseMixRubric = (source: string): MixRubricFile => {
  const y = (parseYaml(source) ?? {}) as Record<string, unknown>;
  if (y.mix_rubric !== MIX_RUBRIC_SCHEMA) fail(`mix_rubric must be ${MIX_RUBRIC_SCHEMA}`);
  for (const k of Object.keys(y)) if (!TOP_FIELDS.has(k)) fail(`unknown field: ${k}`);
  const date = typeof y.date === 'string' ? y.date : y.date instanceof Date ? y.date.toISOString().slice(0, 10) : '';
  if (!DATE.test(date)) fail('date must be YYYY-MM-DD');
  const module = text(y.module, 'module');
  if (!SLUG.test(module)) fail(`module "${module}" is not a kebab-case slug`);
  const stated = RUBRIC_STAGES.filter((s) => y[s] !== undefined);
  if (stated.length === 0) fail(`state at least one stage: ${RUBRIC_STAGES.join(' or ')}`);
  return { artist: text(y.artist, 'artist'), date, module, stages: Object.fromEntries(stated.map((s) => [s, stage(y[s], s)])) };
};

/**
 * @param pages - extracted text; a rubric file is a single text page
 * @returns true for a mix rubric file
 */
export const detectMixRubric = (pages: readonly string[]): boolean => pages.length === 1 && MARKER.test(pages[0]!);

const boundText = (metric: string, b: RubricBound): string => {
  const u = UNITS.get(metric)!;
  if (b.min !== undefined && b.max !== undefined) return `${metric} ${b.min} to ${b.max} ${u}`;
  return b.min !== undefined ? `${metric} at least ${b.min} ${u}` : `${metric} at most ${b.max} ${u}`;
};

/**
 * Normalizes a rubric file into its one canonical prompt.
 * @param pages - single-page file text
 * @returns canonical-ready document (no modules: the Mix/Master module is the manifest's)
 */
export const normalizeMixRubric = (pages: readonly string[]): NormalizedDocument => {
  const r = parseMixRubric(pages[0] ?? '');
  const artist = slugify(r.artist);
  const slug = `${artist}-mix-rubric`;
  const stated = RUBRIC_STAGES.filter((s) => r.stages[s]);
  const entries = stated.flatMap((s) => Object.entries(r.stages[s]!).map(([metric, b]) => ({ stage: s, metric, b })));
  const prompt: NormalizedPrompt = {
    moduleSlug: r.module,
    slug,
    title: `${r.artist} Mix/Master Rubric`,
    body: [
      `${r.artist} mix/master rubric, measured as ${TRACE_ANALYSIS_SCHEMA_ID}.`,
      ...stated.map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}: ${Object.entries(r.stages[s]!).map(([m, b]) => boundText(m, b)).join('; ')}.`),
    ].join('\n'),
    structured: {
      schema: MIX_RUBRIC_SCHEMA,
      analysis: TRACE_ANALYSIS_SCHEMA_ID,
      claims: entries.map((e) => ({ topic: `${artist}.${e.stage}.${e.metric}`, value: e.b, model_scope: RUBRIC_SCOPE })),
    },
    modelTag: RUBRIC_SCOPE,
    tags: [r.module],
    completeness: { expected: [...RUBRIC_STAGES], present: stated },
  };
  return {
    normalizer: MIX_RUBRIC_NORMALIZER_ID,
    title: prompt.title,
    documentDate: r.date,
    metadata: { mix_rubric: MIX_RUBRIC_SCHEMA, artist: r.artist, module: r.module, analysis: TRACE_ANALYSIS_SCHEMA_ID },
    modules: [],
    prompts: [prompt],
    relations: [{ subject: { type: 'canonical_prompt', slug }, predicate: 'derived_from', object: { type: 'source' } }],
    coverage: { expected: [...RUBRIC_STAGES], present: stated },
  };
};
