import { describe, expect, it } from 'vitest';
import { decide, MAX_REVISIONS, type Decision, type Pass } from './loop.ts';

const MIX = 'x3lius.mix-report/v1';
const pass = (violations: number, checked = 5, schemaId = 'x3lius.lyrics/v2'): Pass => ({ critiqueId: 'c', artifactId: 'a', schemaId, checked, violations });
const stop = (outcome: 'converged' | 'no_rules'): Decision => ({ kind: 'stop', outcome });
const escalate = (reason: 'studio_work' | 'iteration_cap' | 'stall'): Decision => ({ kind: 'escalate', reason });
const revise: Decision = { kind: 'revise' };

describe('loop decision after each Critic pass (spec §7, first matching row wins)', () => {
  it('caps revisions at 3', () => expect(MAX_REVISIONS).toBe(3));

  it.each<[string, Pass[], Decision]>([
    ['no rules checked', [pass(0, 0)], stop('no_rules')],
    ['no rules checked, even with a stale count', [pass(2), pass(0, 0)], stop('no_rules')],
    ['clean on the first pass', [pass(0)], stop('converged')],
    ['clean after revisions', [pass(3), pass(1), pass(0)], stop('converged')],
    ['a clean mix report', [pass(0, 4, MIX)], stop('converged')],
    ['a mix report with violations', [pass(2, 4, MIX)], escalate('studio_work')],
    ['violations on the first pass', [pass(2)], revise],
    ['fewer violations after a revision', [pass(3), pass(2)], revise],
    ['the same count after a revision', [pass(2), pass(2)], escalate('stall')],
    ['more violations after a revision', [pass(1), pass(2)], escalate('stall')],
    ['3 revisions made, still violations', [pass(4), pass(3), pass(2), pass(1)], escalate('iteration_cap')],
    ['the cap is checked before the stall rule', [pass(4), pass(3), pass(2), pass(2)], escalate('iteration_cap')],
  ])('%s', (_label, passes, expected) => {
    expect(decide(passes)).toEqual(expected);
  });

  it('takes another cap', () => {
    expect(decide([pass(3), pass(2)], 1)).toEqual(escalate('iteration_cap'));
  });
});
