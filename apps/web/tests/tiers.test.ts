import { describe, expect, it } from 'vitest';
import { selectTier } from '../lib/tiers';

describe('selectTier: first match wins', () => {
  it.each([
    ['research dark vocals', {}, { kind: 'skill', skill: 'xyp-research', text: 'research dark vocals' }],
    ['dark vocals', { skill: 'xyp-research' }, { kind: 'skill', skill: 'xyp-research', text: 'dark vocals' }],
    ['dark vocals', { skill: 'rm -rf' }, { kind: 'invalid-skill' }],
    ['Claude, plan next month', {}, { kind: 'deep', text: 'plan next month' }],
    ['plan next month', { deep: true }, { kind: 'deep', text: 'plan next month' }],
    ['What did the latest research find about vocals?', {}, { kind: 'lookup' }],
    ['how many approvals are pending', {}, { kind: 'lookup' }],
    ['Status of the last workflow run?', {}, { kind: 'lookup' }],
    ['Write a hook for the latest track', {}, { kind: 'plan' }],
    ['What rhymes with orange', {}, { kind: 'plan' }],
    ['Research the best current method for vocals', {}, { kind: 'skill', skill: 'xyp-research', text: 'the best current method for vocals' }],
  ] as const)('%s', (text, opts, expected) => {
    const t = selectTier(text, opts);
    // An explicit skill keeps the whole text; a spoken one strips the name.
    if (expected.kind === 'skill' && !('skill' in opts)) expect(t).toMatchObject({ kind: 'skill', skill: expected.skill });
    else expect(t).toEqual(expected);
  });
});
