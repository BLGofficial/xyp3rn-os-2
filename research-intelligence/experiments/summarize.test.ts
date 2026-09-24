import { describe, expect, it } from 'vitest';
import { STUB_SCORER, summarizeExperiment } from './engine.ts';

// The gate's controlled-test and evaluation steps read this summary, so its branches are proven here
// (real scores don't exist in the DB until Phase 12's Critic).

const critic = 'critic:phase-12';
const run = (variant: 'a' | 'b', score: number | null, scored_by = critic) => ({ variant, score, scored_by });

describe('summarizeExperiment', () => {
  it('never validates stub-scored trials, and reports no means', () => {
    const s = summarizeExperiment({ status: 'complete', n_per_variant: 1 }, [run('a', null, STUB_SCORER), run('b', null, STUB_SCORER)]);
    expect(s).toMatchObject({ validated: false, means: null, scoredBy: [STUB_SCORER] });
    expect(s.reason).toMatch(/no evaluator until Phase 12/);
  });

  it('validates a complete, fully scored experiment and reports per-variant means (b = candidate)', () => {
    const s = summarizeExperiment({ status: 'complete', n_per_variant: 2 }, [run('a', 0.5), run('a', 0.7), run('b', 0.8), run('b', 0.9)]);
    expect(s).toMatchObject({ validated: true, reason: 'all trials scored', trials: { a: 2, b: 2 } });
    expect(s.means!.a).toBeCloseTo(0.6);
    expect(s.means!.b).toBeCloseTo(0.85);
  });

  it('does not validate a scored but incomplete experiment', () => {
    const s = summarizeExperiment({ status: 'running', n_per_variant: 2 }, [run('a', 0.5), run('b', 0.9)]);
    expect(s).toMatchObject({ validated: false, reason: 'not validated: experiment running, 2/4 trials' });
  });
});
