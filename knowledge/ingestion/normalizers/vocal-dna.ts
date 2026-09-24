import { parse as parseYaml } from 'yaml';
import { slugify, type NormalizedDocument, type NormalizedPrompt } from '../types.ts';

/**
 * Vocal DNA normalizer (Phase 10). An operator-authored YAML file states an artist's vocal
 * signature as structure, not prose: tone, register, delivery and ad-libs as lists of
 * descriptors, plus the RVC/Applio voice model and the settings the operator actually uses.
 * It becomes ONE canonical prompt in the artist's Vocal DNA module (declared by the module
 * manifest, referenced here, never redeclared), admitted through the gate's first-party path and
 * versioned like any canonical write. Consumers read its claims, never a copy:
 * - `<artist>.vocal.{tone,register,delivery,adlibs}` — model-agnostic, so every creative agent
 *   and the Suno formula receive them;
 * - `<artist>.vocal.rvc` — scoped `rvc`, so only the RVC post-processing step takes it.
 * Strict: a missing, empty, unknown or out-of-range field fails the whole ingestion run. No
 * value is ever defaulted here; an RVC setting the file doesn't state stays unstated.
 */

export const VOCAL_DNA_NORMALIZER_ID = 'xyp-vocal-dna-v1';
export const VOCAL_DNA_SCHEMA = 'xyp-vocal-dna/v1';
/** Model scope of the RVC settings claim: consumers other than the RVC step leave it out. */
export const RVC_SCOPE = 'rvc';

const MARKER = /^vocal_dna:\s*xyp-vocal-dna\/v1\s*$/m;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ATTRIBUTES = ['tone', 'register', 'delivery', 'adlibs'] as const;
const TOP_FIELDS = new Set(['vocal_dna', 'artist', 'date', 'module', ...ATTRIBUTES, 'rvc']);
const RVC_ENGINES = ['applio', 'rvc'] as const;
/** Optional RVC/Applio inference settings, in the order a job spec lists them. */
export const RVC_OPTIONAL = ['index', 'pitch', 'index_rate', 'protect', 'f0_method', 'rms_mix_rate'] as const;

export type RvcSettings = {
  readonly engine: (typeof RVC_ENGINES)[number];
  readonly model: string;
  readonly index?: string;
  readonly pitch?: number;
  readonly index_rate?: number;
  readonly protect?: number;
  readonly f0_method?: string;
  readonly rms_mix_rate?: number;
};

export type VocalDnaFile = {
  readonly artist: string;
  readonly date: string;
  readonly module: string;
  readonly tone: readonly string[];
  readonly register: readonly string[];
  readonly delivery: readonly string[];
  readonly adlibs: readonly string[];
  readonly rvc: RvcSettings;
};

const fail = (message: string): never => {
  throw new Error(`vocal DNA: ${message}`);
};

const text = (v: unknown, what: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : fail(`${what} must be a non-empty string`);

const descriptors = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.length === 0) return fail(`${what} must be a non-empty list of descriptors`);
  return v.map((x, i) => text(x, `${what}[${i}]`));
};

const inRange = (v: unknown, what: string, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(`${what} must be a number from ${min} to ${max}`);

const rvcSettings = (v: unknown): RvcSettings => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail('rvc must be a mapping with engine and model');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'engine' && k !== 'model' && !(RVC_OPTIONAL as readonly string[]).includes(k)) fail(`rvc: unknown field: ${k}`);
  const engine = o.engine;
  if (!RVC_ENGINES.includes(engine as RvcSettings['engine'])) fail(`rvc.engine must be one of ${RVC_ENGINES.join(', ')}`);
  const pitch = o.pitch;
  if (pitch !== undefined && !(Number.isInteger(pitch) && (pitch as number) >= -24 && (pitch as number) <= 24)) fail('rvc.pitch must be a whole number of semitones from -24 to 24');
  return {
    engine: engine as RvcSettings['engine'],
    model: text(o.model, 'rvc.model'),
    ...(o.index !== undefined ? { index: text(o.index, 'rvc.index') } : {}),
    ...(pitch !== undefined ? { pitch: pitch as number } : {}),
    ...(o.index_rate !== undefined ? { index_rate: inRange(o.index_rate, 'rvc.index_rate', 0, 1) } : {}),
    ...(o.protect !== undefined ? { protect: inRange(o.protect, 'rvc.protect', 0, 0.5) } : {}),
    ...(o.f0_method !== undefined ? { f0_method: text(o.f0_method, 'rvc.f0_method') } : {}),
    ...(o.rms_mix_rate !== undefined ? { rms_mix_rate: inRange(o.rms_mix_rate, 'rvc.rms_mix_rate', 0, 1) } : {}),
  };
};

/**
 * Parses and validates a Vocal DNA file.
 * @param source - YAML text
 * @returns the validated file
 * @throws Error naming the first invalid field
 */
export const parseVocalDna = (source: string): VocalDnaFile => {
  const y = (parseYaml(source) ?? {}) as Record<string, unknown>;
  if (y.vocal_dna !== VOCAL_DNA_SCHEMA) fail(`vocal_dna must be ${VOCAL_DNA_SCHEMA}`);
  for (const k of Object.keys(y)) if (!TOP_FIELDS.has(k)) fail(`unknown field: ${k}`);
  const date = typeof y.date === 'string' ? y.date : y.date instanceof Date ? y.date.toISOString().slice(0, 10) : '';
  if (!DATE.test(date)) fail('date must be YYYY-MM-DD');
  const module = text(y.module, 'module');
  if (!SLUG.test(module)) fail(`module "${module}" is not a kebab-case slug`);
  return {
    artist: text(y.artist, 'artist'),
    date,
    module,
    tone: descriptors(y.tone, 'tone'),
    register: descriptors(y.register, 'register'),
    delivery: descriptors(y.delivery, 'delivery'),
    adlibs: descriptors(y.adlibs, 'adlibs'),
    rvc: rvcSettings(y.rvc),
  };
};

/**
 * @param pages - extracted text; a Vocal DNA file is a single text page
 * @returns true for a Vocal DNA file
 */
export const detectVocalDna = (pages: readonly string[]): boolean => pages.length === 1 && MARKER.test(pages[0]!);

/**
 * Normalizes a Vocal DNA file into its one canonical prompt.
 * @param pages - single-page file text
 * @returns canonical-ready document (no modules: the Vocal DNA module is the manifest's)
 */
export const normalizeVocalDna = (pages: readonly string[]): NormalizedDocument => {
  const v = parseVocalDna(pages[0] ?? '');
  const ns = `${slugify(v.artist)}.vocal`;
  const slug = `${slugify(v.artist)}-vocal-dna`;
  const lines = { tone: 'Tone', register: 'Register', delivery: 'Delivery', adlibs: 'Ad-libs' } as const;
  const prompt: NormalizedPrompt = {
    moduleSlug: v.module,
    slug,
    title: `${v.artist} Vocal DNA`,
    // What retrieval returns as rule text: the vocal signature only. The RVC settings stay in their
    // own claim, scoped to the one consumer that uses them.
    body: [`${v.artist} vocal signature.`, ...ATTRIBUTES.map((a) => `${lines[a]}: ${v[a].join('; ')}.`)].join('\n'),
    structured: {
      schema: VOCAL_DNA_SCHEMA,
      claims: [
        ...ATTRIBUTES.map((a) => ({ topic: `${ns}.${a}`, value: [...v[a]], model_scope: 'model-agnostic' })),
        { topic: `${ns}.rvc`, value: v.rvc, model_scope: RVC_SCOPE },
      ],
    },
    modelTag: 'model-agnostic',
    tags: [v.module],
    completeness: { expected: [...ATTRIBUTES, 'rvc'], present: [...ATTRIBUTES, 'rvc'] },
  };
  return {
    normalizer: VOCAL_DNA_NORMALIZER_ID,
    title: prompt.title,
    documentDate: v.date,
    metadata: { vocal_dna: VOCAL_DNA_SCHEMA, artist: v.artist, module: v.module },
    modules: [],
    prompts: [prompt],
    relations: [{ subject: { type: 'canonical_prompt', slug }, predicate: 'derived_from', object: { type: 'source' } }],
    coverage: { expected: [...ATTRIBUTES, 'rvc'], present: [...ATTRIBUTES, 'rvc'] },
  };
};
