import { describe, expect, it } from 'vitest';
import {
  buildReport,
  FRESHNESS_HORIZON_DAYS,
  RELIABILITY_RULES,
  RUBRIC_VERSION,
  scoreCompleteness,
  scoreFreshness,
  scoreReliability,
  WEIGHTS,
} from './rubric.ts';

const day = 86_400_000;

describe('quality rubric', () => {
  it('weights are the user-approved 0.5 / 0.3 / 0.2 and sum to 1', () => {
    expect(WEIGHTS).toEqual({ completeness: 0.5, source_reliability: 0.3, freshness: 0.2 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(RUBRIC_VERSION).toBe('quality-v1');
  });

  it('completeness = present / expected, and names what is missing', () => {
    const c = scoreCompleteness(['role', 'context', 'task', 'output'], ['role', 'task', 'output']);
    expect(c).toMatchObject({ name: 'completeness', weight: 0.5, score: 0.75 });
    expect(c.inputs).toEqual({
      expected: ['role', 'context', 'task', 'output'],
      present: ['role', 'task', 'output'],
      missing: ['context'],
    });
  });

  it('completeness ignores "present" items that were never expected', () => {
    expect(scoreCompleteness(['a', 'b'], ['a', 'zzz']).score).toBe(0.5);
  });

  it('reliability has exactly one explicit rule per kind x origin', () => {
    const keys = RELIABILITY_RULES.map((r) => `${r.kind}/${r.origin}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      ['file', 'manual', 'url'].flatMap((k) => [`${k}/first_party`, `${k}/third_party`]).sort(),
    );
    for (const r of RELIABILITY_RULES) expect(r.rule.length).toBeGreaterThan(10);
  });

  it('reliability returns the matching rule and cites it in inputs', () => {
    const c = scoreReliability('file', 'first_party');
    expect(c).toMatchObject({ name: 'source_reliability', weight: 0.3, score: 1 });
    expect(c.inputs).toMatchObject({ kind: 'file', origin: 'first_party' });
    expect(String(c.inputs.rule)).toMatch(/first-party/i);
    expect(scoreReliability('url', 'third_party').score).toBeLessThan(scoreReliability('url', 'first_party').score);
  });

  it('freshness decays linearly over the horizon and clamps at 0', () => {
    const asOf = new Date('2026-09-24T00:00:00Z');
    expect(FRESHNESS_HORIZON_DAYS).toBe(365);
    expect(scoreFreshness(asOf, asOf).score).toBe(1);
    expect(scoreFreshness(new Date(asOf.getTime() - 73 * day), asOf).score).toBeCloseTo(0.8, 4);
    expect(scoreFreshness(new Date(asOf.getTime() - 365 * day), asOf).score).toBe(0);
    expect(scoreFreshness(new Date(asOf.getTime() - 900 * day), asOf).score).toBe(0);
    expect(scoreFreshness(new Date(asOf.getTime() - 73 * day), asOf).inputs).toMatchObject({ age_days: 73 });
  });

  it('freshness gives no credit when the document date is unknown, and says why', () => {
    const c = scoreFreshness(null, new Date('2026-09-24T00:00:00Z'));
    expect(c.score).toBe(0);
    expect(c.inputs).toMatchObject({ document_date: null });
    expect(String(c.inputs.reason)).toMatch(/no document date/i);
  });

  it('overall is the weighted sum of its criteria, rounded to 4 dp, with every input attached', () => {
    const asOf = new Date('2026-09-24T00:00:00Z');
    const report = buildReport([
      scoreCompleteness(['a', 'b', 'c'], ['a', 'b']),
      scoreReliability('url', 'third_party'),
      scoreFreshness(new Date(asOf.getTime() - 73 * day), asOf),
    ]);
    const expected = 0.5 * (2 / 3) + 0.3 * scoreReliability('url', 'third_party').score + 0.2 * 0.8;
    expect(report.rubric_version).toBe('quality-v1');
    expect(report.overall).toBe(Math.round(expected * 10_000) / 10_000);
    expect(report.criteria).toHaveLength(3);
    for (const c of report.criteria) expect(Object.keys(c.inputs).length).toBeGreaterThan(0);
  });

  it('refuses a report whose weights do not sum to 1', () => {
    expect(() => buildReport([scoreCompleteness(['a'], ['a'])])).toThrow(/weights sum/);
  });
});
