import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectNormalizer } from './index.ts';
import { detectRuleSet, normalizeRuleSet, parseRuleSet, RULE_SET_NORMALIZER_ID } from './rule-set.ts';

const FILE = readFileSync(join(import.meta.dirname, '../../../records/x3lius/lyrics-rules.yaml'), 'utf8');
const HEAD = 'rule_set: xyp-rule-set/v1\nartist: X3LIUS\ndate: 2026-09-25\nsource: test\n';
const one = (rule: string) => `${HEAD}rules:\n  - ${rule.trim().split('\n').join('\n    ')}\n`;

describe('rule-set normalizer (xyp-rule-set/v1): one canonical prompt per rule', () => {
  it('is selected for the operator lyrics-rules file, and for nothing else', () => {
    expect(selectNormalizer([FILE])?.id).toBe(RULE_SET_NORMALIZER_ID);
    expect(detectRuleSet(['mix_rubric: xyp-mix-rubric/v1'])).toBe(false);
  });

  it('places the 10 operator rules: 7 in x3lius-lyrics, 3 in x3lius-songwriting, all model-agnostic', () => {
    const d = normalizeRuleSet([FILE]);
    expect(d.prompts.map((p) => p.moduleSlug)).toEqual([...Array(7).fill('x3lius-lyrics'), ...Array(3).fill('x3lius-songwriting')]);
    expect(new Set(d.prompts.map((p) => p.modelTag))).toEqual(new Set(['model-agnostic']));
    expect(d.prompts.every((p) => p.tags.length === 1 && p.tags[0] === p.moduleSlug)).toBe(true);
    expect(d.relations).toHaveLength(10);
    const grounding = d.prompts.find((p) => p.slug === 'x3lius-lyrics-grounding-method')!;
    expect(grounding.body).toMatch(/^Every abstract noun or stated emotion must resolve/);
    expect(grounding.body).toContain('the 7-Eleven sign buzzing at 2 AM');
  });

  it('carries the word blacklist as a claim code can count, and no other claim', () => {
    const d = normalizeRuleSet([FILE]);
    const claims = d.prompts.flatMap((p) => ((p.structured.claims ?? []) as { topic: string; value: { maxHits: number; terms: string[] } }[]).map((c) => ({ slug: p.slug, ...c })));
    expect(claims.map((c) => [c.slug, c.topic])).toEqual([['x3lius-lyrics-word-blacklist', 'lyrics.word-blacklist']]);
    expect(claims[0]!.value.maxHits).toBe(2);
    expect(claims[0]!.value.terms).toEqual(expect.arrayContaining(['neon', 'city lights', 'lost in [x]', 'broken']));
    // Qualified words stay with the model: code can't judge "bare" or "no concrete context".
    expect(claims[0]!.value.terms.some((t) => t.includes('(') || t.startsWith('electric') || t === 'numb')).toBe(false);
  });

  it('refuses a malformed file, naming the field', () => {
    const rule = 'slug: a-rule\nmodule: x3lius-lyrics\ntitle: T\nrule: R';
    expect(() => parseRuleSet(one(rule))).not.toThrow();
    expect(() => parseRuleSet(`${HEAD}rules: []\n`)).toThrow(/rules must be a non-empty list/);
    expect(() => parseRuleSet(one(`${rule}\ncolour: red`))).toThrow(/unknown field: colour/);
    expect(() => parseRuleSet(one(rule.replace('rule: R', 'rule: REQUIRED')))).toThrow(/placeholder/);
    expect(() => parseRuleSet(one(rule.replace('x3lius-lyrics', 'X3LIUS Lyrics')))).toThrow(/not a kebab-case slug/);
    expect(() => parseRuleSet(one(`${rule}\nclaim: { topic: Word Blacklist, value: 1 }`))).toThrow(/dotted kebab-case/);
    expect(() => parseRuleSet(one(`${rule}\nclaim: { topic: lyrics.x }`))).toThrow(/claim.value is required/);
    const twice = `${HEAD}rules:\n  - { slug: a, module: m, title: T, rule: R }\n  - { slug: a, module: m, title: T, rule: R }\n`;
    expect(() => parseRuleSet(twice)).toThrow(/slug a appears twice/);
  });
});
