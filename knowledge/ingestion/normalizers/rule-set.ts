import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { NormalizedDocument, NormalizedPrompt } from '../types.ts';
import { PLACEHOLDER } from './vocal-dna.ts';

/**
 * Rule-set normalizer (operator-authored craft rules). A YAML file lists rules, each placed in an
 * existing sub-domain module (the manifest's, referenced here, never redeclared). Each rule becomes
 * one canonical prompt: its rule text plus its data (examples, lists, categories) as the body, so the
 * Creative agent that reads the module and the Critic that judges its output read the same row.
 *
 * A rule may also state one claim `{ topic, value }`, for a value code can check (e.g. a word
 * blacklist the Critic counts). Every rule is model-agnostic: craft, not a model version's behaviour.
 *
 * Strict: an unknown field, a placeholder, a repeated slug, a malformed slug, module or topic fails
 * the whole run.
 */

export const RULE_SET_NORMALIZER_ID = 'xyp-rule-set-v1';
export const RULE_SET_SCHEMA = 'xyp-rule-set/v1';
export const RULE_SCOPE = 'model-agnostic';

const MARKER = /^rule_set:\s*xyp-rule-set\/v1\s*$/m;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOPIC = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_FIELDS = new Set(['rule_set', 'artist', 'date', 'source', 'rules']);
const RULE_FIELDS = new Set(['slug', 'module', 'title', 'rule', 'data', 'claim']);

export type RuleSetRule = {
  readonly slug: string;
  readonly module: string;
  readonly title: string;
  readonly rule: string;
  readonly data?: unknown;
  readonly claim?: { readonly topic: string; readonly value: unknown };
};

export type RuleSetFile = { readonly artist: string; readonly date: string; readonly source: string; readonly rules: readonly RuleSetRule[] };

const fail = (message: string): never => {
  throw new Error(`rule set: ${message}`);
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') return fail(`${what} must be a non-empty string`);
  if (PLACEHOLDER.test(v.trim())) return fail(`${what} is a placeholder ("${v.trim()}"): give the real value`);
  return v.trim();
};

const kebab = (v: unknown, what: string): string => {
  const s = text(v, what);
  return SLUG.test(s) ? s : fail(`${what} "${s}" is not a kebab-case slug`);
};

const rule = (v: unknown, i: number): RuleSetRule => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(`rules[${i}] must be a mapping`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!RULE_FIELDS.has(k)) fail(`rules[${i}]: unknown field: ${k}`);
  const slug = kebab(o.slug, `rules[${i}].slug`);
  let claim: RuleSetRule['claim'];
  if (o.claim !== undefined) {
    const c = o.claim as Record<string, unknown> | null;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return fail(`${slug}: claim must be a mapping with topic and value`);
    for (const k of Object.keys(c)) if (k !== 'topic' && k !== 'value') fail(`${slug}: claim: unknown field: ${k}`);
    const topic = text(c.topic, `${slug}: claim.topic`);
    if (!TOPIC.test(topic)) fail(`${slug}: claim.topic "${topic}" must be dotted kebab-case, e.g. lyrics.word-blacklist`);
    if (c.value === undefined || c.value === null) fail(`${slug}: claim.value is required`);
    claim = { topic, value: c.value };
  }
  return {
    slug,
    module: kebab(o.module, `${slug}: module`),
    title: text(o.title, `${slug}: title`),
    rule: text(o.rule, `${slug}: rule`),
    ...(o.data !== undefined && o.data !== null ? { data: o.data } : {}),
    ...(claim ? { claim } : {}),
  };
};

/**
 * Parses and validates a rule-set file.
 * @param source - YAML text
 * @returns the validated file
 * @throws Error naming the first invalid field
 */
export const parseRuleSet = (source: string): RuleSetFile => {
  const y = (parseYaml(source) ?? {}) as Record<string, unknown>;
  if (y.rule_set !== RULE_SET_SCHEMA) fail(`rule_set must be ${RULE_SET_SCHEMA}`);
  for (const k of Object.keys(y)) if (!TOP_FIELDS.has(k)) fail(`unknown field: ${k}`);
  const date = typeof y.date === 'string' ? y.date : y.date instanceof Date ? y.date.toISOString().slice(0, 10) : '';
  if (!DATE.test(date)) fail('date must be YYYY-MM-DD');
  if (!Array.isArray(y.rules) || y.rules.length === 0) fail('rules must be a non-empty list');
  const rules = (y.rules as unknown[]).map(rule);
  const seen = new Set<string>();
  const topics = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.slug)) fail(`slug ${r.slug} appears twice`);
    seen.add(r.slug);
    if (r.claim && topics.has(r.claim.topic)) fail(`claim topic ${r.claim.topic} appears twice`);
    if (r.claim) topics.add(r.claim.topic);
  }
  return { artist: text(y.artist, 'artist'), date, source: text(y.source, 'source'), rules };
};

/**
 * @param pages - extracted text; a rule-set file is a single text page
 * @returns true for a rule-set file
 */
export const detectRuleSet = (pages: readonly string[]): boolean => pages.length === 1 && MARKER.test(pages[0]!);

/**
 * Normalizes a rule-set file into one canonical prompt per rule.
 * @param pages - single-page file text
 * @returns canonical-ready document (no modules: every module is the manifest's)
 */
export const normalizeRuleSet = (pages: readonly string[]): NormalizedDocument => {
  const f = parseRuleSet(pages[0] ?? '');
  const prompts: NormalizedPrompt[] = f.rules.map((r) => ({
    moduleSlug: r.module,
    slug: r.slug,
    title: r.title,
    body: r.data === undefined ? r.rule : `${r.rule}\n\n${stringifyYaml(r.data).trimEnd()}`,
    structured: {
      schema: RULE_SET_SCHEMA,
      ...(r.data !== undefined ? { data: r.data } : {}),
      ...(r.claim ? { claims: [{ topic: r.claim.topic, value: r.claim.value, model_scope: RULE_SCOPE }] } : {}),
    },
    modelTag: RULE_SCOPE,
    tags: [r.module],
    completeness: { expected: ['title', 'rule'], present: ['title', 'rule'] },
  }));
  return {
    normalizer: RULE_SET_NORMALIZER_ID,
    title: `${f.artist} rule set (${f.source})`,
    documentDate: f.date,
    metadata: { rule_set: RULE_SET_SCHEMA, artist: f.artist, source: f.source, modules: [...new Set(f.rules.map((r) => r.module))] },
    modules: [],
    prompts,
    relations: prompts.map((p) => ({ subject: { type: 'canonical_prompt' as const, slug: p.slug }, predicate: 'derived_from', object: { type: 'source' as const } })),
    coverage: { expected: f.rules.map((r) => r.slug), present: prompts.map((p) => p.slug) },
  };
};
