import { describe, expect, it } from 'vitest';
import { LYRICS_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import type { ContextEntry } from '../creative/types.ts';
import { codeChecks, mixReportChecks } from './checks.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const claim = (topic: string, value: unknown): ContextEntry => ({
  kind: 'claim', ref: `canonical_prompts:${ID}#${topic}`, module: 'x3lius-suno', slug: 'fixture', title: '[FIXTURE]', topic, value, modelScope: 'suno-v5', source: null,
});
const rule: ContextEntry = { kind: 'rule', ref: `canonical_prompts:${ID}`, module: 'x3lius-suno', slug: 'fixture-rule', title: '[FIXTURE]', text: '[FIXTURE] rule', modelTag: null, score: 0.9, why: 'fixture', source: null };
const SUNO = {
  sunoModel: 'v5', title: 'Night', style: 'dark trap, male vocal', excludeStyles: ['pop'], lyrics: '[Verse]\nline',
  sources: [], limits: [{ field: 'style', max: 10, actual: 1, ref: 'stale' }], rulesApplied: [], ungroundedChoices: [],
};

describe('code checks', () => {
  it('checks a Suno length claim by code, measuring the text itself (never the stored limits)', () => {
    const r = codeChecks(SUNO_PROMPT_SCHEMA_ID, [claim('suno.limit.style-chars', 10), claim('suno.limit.title-chars', 80), rule], SUNO);
    expect(r.rules).toEqual([
      { ref: `canonical_prompts:${ID}#suno.limit.style-chars`, kind: 'claim', method: 'code' },
      { ref: `canonical_prompts:${ID}#suno.limit.title-chars`, kind: 'claim', method: 'code' },
    ]);
    expect(r.violations).toEqual([{
      key: `canonical_prompts:${ID}#suno.limit.style-chars@/style`, ruleRef: `canonical_prompts:${ID}#suno.limit.style-chars`, method: 'code',
      path: '/style', quote: 'dark trap, male vocal', expected: 'at most 10 characters (suno.limit.style-chars)', found: '21 characters',
    }]);
  });

  it('has no code check outside the Suno prompt, or for a limit that is not an integer', () => {
    expect(codeChecks(LYRICS_SCHEMA_ID, [claim('suno.limit.style-chars', 10)], {})).toEqual({ rules: [], violations: [] });
    expect(codeChecks(SUNO_PROMPT_SCHEMA_ID, [claim('suno.limit.style-chars', '10')], SUNO)).toEqual({ rules: [], violations: [] });
  });

  it('turns a mix report’s checks into rules, and each raise/lower into a violation', () => {
    const ref = `canonical_prompts:${ID}#x3lius.master.loudness.integrated-lufs`;
    const body = {
      checks: [
        { metric: 'loudness.integrated-lufs', unit: 'LUFS', measured: -12.3, rubric: { min: -10, max: -8 }, action: 'raise', by: 2.3, ref, version: 1 },
        { metric: 'loudness.range-lu', unit: 'LU', measured: 5.2, rubric: { min: 4 }, action: 'keep', by: 0, ref: `${ref}-2`, version: 1 },
      ],
    };
    const r = mixReportChecks(body);
    expect(r.rules).toEqual([{ ref, kind: 'claim', method: 'code', version: 1 }, { ref: `${ref}-2`, kind: 'claim', method: 'code', version: 1 }]);
    expect(r.violations).toEqual([{
      key: `${ref}@/checks/0`, ruleRef: ref, ruleVersion: 1, method: 'code', path: '/checks/0',
      quote: 'loudness.integrated-lufs -12.3 LUFS', expected: 'loudness.integrated-lufs ≥ -10 and ≤ -8 LUFS', found: '-12.3 LUFS: raise by 2.3',
    }]);
  });
});
