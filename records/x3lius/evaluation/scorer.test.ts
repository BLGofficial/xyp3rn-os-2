import { describe, expect, it } from 'vitest';
import { scoreOf } from './scorer.ts';

describe('trial score = rules passed / rules checked (spec §8)', () => {
  it('is the share of rules with no violation, to 4 decimals like experiment_runs.score', () => {
    expect(scoreOf({ checked: 4, passed: 3 })).toBe(0.75);
    expect(scoreOf({ checked: 3, passed: 2 })).toBe(0.6667);
    expect(scoreOf({ checked: 5, passed: 5 })).toBe(1);
    expect(scoreOf({ checked: 5, passed: 0 })).toBe(0);
  });

  it('is null, never 1, when no rule was checked', () => {
    expect(scoreOf({ checked: 0, passed: 0 })).toBeNull();
  });
});
