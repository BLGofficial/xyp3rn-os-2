import { describe, expect, it } from 'vitest';
import { selectTier } from '../lib/tiers';

describe('selectTier: first match wins', () => {
  it.each([
    ['research dark vocals', { engine: true }, { kind: 'skill', skill: 'xyp-research', text: 'research dark vocals' }],
    ['dark vocals', { skill: 'xyp-research', engine: true }, { kind: 'skill', skill: 'xyp-research', text: 'dark vocals' }],
    ['dark vocals', { skill: 'rm -rf', engine: true }, { kind: 'invalid-skill' }],
    ['Claude, plan next month', { engine: true }, { kind: 'deep', text: 'plan next month' }],
    ['plan next month', { deep: true, engine: true }, { kind: 'deep', text: 'plan next month' }],
    ['What did the latest research find about vocals?', {}, { kind: 'lookup' }],
    ['how many approvals are pending', {}, { kind: 'lookup' }],
    ['Status of the last workflow run?', {}, { kind: 'lookup' }],
    ['Write a hook for the latest track', {}, { kind: 'plan' }],
    ['What rhymes with orange', {}, { kind: 'plan' }],
    ['Research the best current method for vocals', { engine: true }, { kind: 'skill', skill: 'xyp-research', text: 'the best current method for vocals' }],
    // F3: tier 2 is narrowed to the spec keyword list (latest/last/status/pending/findings/releases/
    // approvals, or "what did"). A bare "research"/"run(s)"/"workflow(s)" mention no longer qualifies.
    ['What research method works best for dark vocals?', {}, { kind: 'plan' }],
    ['Which workflow should I use for a new single?', {}, { kind: 'plan' }],
    ['Is research on Suno v5 worth doing?', {}, { kind: 'plan' }],
  ] as const)('%s', (text, opts, expected) => {
    const t = selectTier(text, opts);
    // An explicit skill keeps the whole text; a spoken one strips the name.
    if (expected.kind === 'skill' && !('skill' in opts)) expect(t).toMatchObject({ kind: 'skill', skill: expected.skill });
    else expect(t).toEqual(expected);
  });
});

describe('selectTier: skill/deep tiers require LLM_ENGINE=claude-code (F2)', () => {
  it('with the engine off, a spoken skill name and the "Claude," trigger are just text', () => {
    // "research dark vocals" would spawn tier 1 with the engine on (case above); with it off, the
    // spoken skill name is not recognised and the request falls through to plan (no question opener).
    expect(selectTier('research dark vocals', {})).toEqual({ kind: 'plan' });
    // "Claude, plan next month" would be tier 3 with the engine on (case above); with it off, the
    // deep trigger is not recognised either, and the text still is not a lookup question.
    expect(selectTier('Claude, plan next month', {})).toEqual({ kind: 'plan' });
  });

  it('with the engine off, an explicit skill or deep:true is refused outright, not silently downgraded', () => {
    expect(selectTier('dark vocals', { skill: 'xyp-research' })).toEqual({ kind: 'engine-off' });
    expect(selectTier('dark vocals', { skill: 'xyp-research', engine: false })).toEqual({ kind: 'engine-off' });
    expect(selectTier('plan the release', { deep: true })).toEqual({ kind: 'engine-off' });
    expect(selectTier('plan the release', { deep: true, engine: false })).toEqual({ kind: 'engine-off' });
  });
});
