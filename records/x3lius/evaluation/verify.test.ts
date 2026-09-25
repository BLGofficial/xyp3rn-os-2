import { describe, expect, it } from 'vitest';
import type { ContextEntry } from '../creative/types.ts';
import { verifyReported } from './verify.ts';

const rule = (id: string, slug: string): ContextEntry => ({
  kind: 'rule', ref: `canonical_prompts:${id}`, module: 'x3lius-lyrics', slug, title: '[FIXTURE]', text: '[FIXTURE] rule', modelTag: null, score: 0.9, why: 'fixture', source: null,
});
const A = rule('11111111-1111-4111-8111-111111111111', 'fixture-city-bars');
const CODE = 'canonical_prompts:22222222-2222-4222-8222-222222222222#suno.limit.style-chars';
const BODY = { sections: [{ bars: [{ text: 'Neon rain on Canal Street' }, { text: 'second bar' }] }] };
const report = (over: Record<string, string>) => ({ ruleRef: A.ref, path: '/sections/0/bars/0/text', quote: 'Canal Street', expected: 'e', found: 'f', ...over });

describe('verifying model-reported violations', () => {
  it('keeps a violation whose rule, path and quote check out, resolving a bracketed or aliased ref', () => {
    const r = verifyReported([report({ ruleRef: `[${A.ref}]` }), report({ ruleRef: 'fixture-city-bars', path: '/sections/0/bars/1/text', quote: 'second' })], [A], new Set([CODE]), BODY);
    expect(r.unverified).toEqual([]);
    expect(r.violations).toEqual([
      { key: `${A.ref}@/sections/0/bars/0/text`, ruleRef: A.ref, method: 'model', path: '/sections/0/bars/0/text', quote: 'Canal Street', expected: 'e', found: 'f' },
      { key: `${A.ref}@/sections/0/bars/1/text`, ruleRef: A.ref, method: 'model', path: '/sections/0/bars/1/text', quote: 'second', expected: 'e', found: 'f' },
    ]);
  });

  it('accepts a quote anywhere under a section-level path', () => {
    expect(verifyReported([report({ path: '/sections/0' })], [A], new Set(), BODY).violations).toHaveLength(1);
  });

  it.each<[string, { ruleRef?: string; path?: string; quote?: string }, string]>([
    ['an unknown rule', { ruleRef: 'canonical_prompts:33333333-3333-4333-8333-333333333333' }, 'not one of the rules given'],
    ['a code-checked rule', { ruleRef: CODE }, 'the rule is checked by code, not by the model'],
    ['a missing path', { path: '/sections/0/bars/5/text' }, 'the path does not name a field of the artifact'],
    ['a JSONPath instead of a pointer', { path: '$.sections[0].bars[0].text' }, 'the path does not name a field of the artifact'],
    ['the root', { path: '' }, 'the path does not name a field of the artifact'],
    ['a quote with different case', { quote: 'canal street' }, 'the quote does not appear at that path'],
    ['a quote with different spacing', { quote: 'Canal  Street' }, 'the quote does not appear at that path'],
    ['an empty quote', { quote: '  ' }, 'the quote does not appear at that path'],
  ])('drops %s as unverified, with the reason', (_label, over, reason) => {
    const r = verifyReported([report(over)], [A], new Set([CODE]), BODY);
    expect(r.violations).toEqual([]);
    expect(r.unverified).toEqual([{ ruleRef: over.ruleRef ?? A.ref, path: over.path ?? '/sections/0/bars/0/text', quote: over.quote ?? 'Canal Street', reason }]);
  });

  it('verifies a number or true/false field by exact equality with its JSON text, never by substring', () => {
    const body = { tempoBpm: 140, flags: { live: true }, sections: [] };
    const at = (path: string, quote: string) => verifyReported([report({ path, quote })], [A], new Set(), body);
    expect(at('/tempoBpm', '140').violations).toHaveLength(1);
    expect(at('/flags', 'true').violations).toHaveLength(1);
    expect(at('/tempoBpm', '14').unverified[0]?.reason).toBe('the quote does not appear at that path');
    expect(at('/tempoBpm', '140 bpm').unverified[0]?.reason).toBe('the quote does not appear at that path');
  });

  it('merges two reports of the same violation', () => {
    expect(verifyReported([report({}), report({ quote: 'Neon' })], [A], new Set(), BODY).violations).toHaveLength(1);
  });
});
