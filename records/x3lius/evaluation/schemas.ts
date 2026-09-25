import { arr, int, obj, str, type JsonSchema } from '../../../core/llm/json-schema.ts';

/**
 * Phase 12 schemas: the stored critique (x3lius.critique/v1) and what the Critic and Revision
 * models may reply. The JSON-schema subset has no null, so optional fields are omitted, never null.
 */
export const CRITIQUE_SCHEMA_ID = 'x3lius.critique/v1';
export const CRITIQUE_LLM_SCHEMA_ID = 'x3lius.critique-llm/v1';
export const REVISION_LLM_SCHEMA_ID = 'x3lius.revision-llm/v1';

export type RuleMethod = 'code' | 'model';
/** A rule the Critic checked. `version` only where the source states one (mix-report checks). */
export type CheckedRule = { readonly ref: string; readonly kind: 'rule' | 'claim'; readonly method: RuleMethod; readonly version?: number };
export type Violation = {
  readonly key: string;
  readonly ruleRef: string;
  readonly method: RuleMethod;
  /** JSON Pointer into the artifact body. */
  readonly path: string;
  readonly quote: string;
  readonly expected: string;
  readonly found: string;
  readonly ruleVersion?: number;
};
export type Unverified = { readonly ruleRef: string; readonly path: string; readonly quote: string; readonly reason: string };
export type CritiqueCounts = { readonly checked: number; readonly passed: number; readonly violations: number };
export type CritiqueBody = {
  readonly artifact: { readonly id: string; readonly schemaId: string; readonly version: number; readonly agent: string };
  readonly previousCritiqueId?: string;
  readonly rules: readonly CheckedRule[];
  readonly violations: readonly Violation[];
  /** Keys of the previous critique's violations that are gone. Only the Critic marks anything resolved. */
  readonly resolved: readonly string[];
  readonly unverified: readonly Unverified[];
  readonly counts: CritiqueCounts;
};

/**
 * @param ruleRef - the rule broken
 * @param path - JSON Pointer of the field
 * @returns `ruleRef@path`: the same violation keeps its key across the versions of a loop
 */
export const violationKey = (ruleRef: string, path: string): string => `${ruleRef}@${path}`;

/** An object schema whose `optional` keys may be left out. */
const objWith = (properties: Record<string, JsonSchema>, optional: readonly string[]): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties).filter((k) => !optional.includes(k)), additionalProperties: false,
});
const METHOD: JsonSchema = { type: 'string', enum: ['code', 'model'] };

export const CRITIQUE_SCHEMA: JsonSchema = objWith({
  artifact: obj({ id: str(), schemaId: str(), version: int('Artifact version'), agent: str('Agent that wrote the version') }),
  previousCritiqueId: str('The critique of the parent version; omitted on a first pass'),
  rules: arr(objWith({
    ref: str(), kind: { type: 'string', enum: ['rule', 'claim'] }, method: METHOD, version: int('Canonical row version, where the source states it'),
  }, ['version'])),
  violations: arr(objWith({
    key: str(), ruleRef: str(), method: METHOD, path: str('JSON Pointer into the artifact body'), quote: str(), expected: str(), found: str(),
    ruleVersion: int('Canonical row version, where the source states it'),
  }, ['ruleVersion'])),
  resolved: arr(str('Key of a previous-critique violation that is gone')),
  unverified: arr(obj({ ruleRef: str(), path: str(), quote: str(), reason: str() })),
  counts: obj({ checked: int('Rules checked'), passed: int('Rules with no violation'), violations: int('Violations') }),
}, ['previousCritiqueId']);

export const CRITIQUE_LLM_SCHEMA: JsonSchema = obj({
  violations: arr(obj({
    ruleRef: str('The rule broken: its ref copied exactly from RULES'),
    path: str('JSON Pointer to the field that breaks it, e.g. /sections/1/bars/0/text'),
    quote: str('The offending words, copied exactly from that field'),
    expected: str('What the rule requires there'),
    found: str('What the artifact has instead'),
  }), 'Every rule the artifact breaks; empty when it breaks none'),
});

export const REVISION_LLM_SCHEMA: JsonSchema = obj({
  edits: arr(obj({
    path: str('JSON Pointer to the field to change: one a violation points at, or inside it'),
    replacement: str('The new value. For a number or true/false field, write it as JSON, e.g. 120 or true'),
    violationKeys: arr(str('Key of a violation this edit fixes, copied exactly from VIOLATIONS')),
  }), 'Concrete edits that fix the violations'),
});

/**
 * The checks the schema subset can't state: counts agree with the lists, keys follow their rule
 * and path, and every violation cites a rule that was checked.
 * @param b - a critique body that already satisfies CRITIQUE_SCHEMA
 * @returns violations, empty when consistent
 */
export const critiqueBodyErrors = (b: CritiqueBody): string[] => {
  const refs = new Set(b.rules.map((r) => r.ref));
  const passed = b.rules.filter((r) => !b.violations.some((v) => v.ruleRef === r.ref)).length;
  return [
    ...(b.counts.checked === b.rules.length ? [] : [`counts.checked ${b.counts.checked} is not the ${b.rules.length} rules listed`]),
    ...(b.counts.violations === b.violations.length ? [] : [`counts.violations ${b.counts.violations} is not the ${b.violations.length} violations listed`]),
    ...(b.counts.passed === passed ? [] : [`counts.passed ${b.counts.passed} is not the ${passed} rules without a violation`]),
    ...b.violations.filter((v) => v.key !== violationKey(v.ruleRef, v.path)).map((v) => `violation key ${v.key} is not ${violationKey(v.ruleRef, v.path)}`),
    ...b.violations.filter((v) => !refs.has(v.ruleRef)).map((v) => `violation cites ${v.ruleRef}, which is not a rule checked`),
  ];
};
