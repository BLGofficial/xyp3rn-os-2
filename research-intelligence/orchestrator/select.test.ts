import { describe, expect, it } from 'vitest';
import { parseScope, planResearch, selectSpecialists, SELECTION_THRESHOLD } from './select.ts';

// Pure selection mechanics. Inputs are two hand-written scopes because this tests the scoring
// rule; the real 20-specialist roster is exercised in tests/phase-06b.

const SUNO = parseScope(
  'suno-researcher',
  'Gathers evidence on how Suno interprets prompts, per model version.\n\nKeywords: suno (3), style prompt (2), model version (1)',
);
const VOCAL = parseScope(
  'ai-vocal-systems-researcher',
  'Gathers evidence on AI vocal synthesis behaviour: timbre, register, delivery.\n\nKeywords: vocal (3), baritone (2), timbre (2)',
);
const MIX = parseScope('mix-master-ai-tooling-researcher', 'Gathers evidence on AI mixing and mastering tools.\n\nKeywords: mix (3), master (3), loudness (2)');

describe('parseScope', () => {
  it('reads the one-sentence scope and the weighted keywords', () => {
    expect(SUNO).toEqual({
      name: 'suno-researcher',
      sentence: 'Gathers evidence on how Suno interprets prompts, per model version.',
      keywords: [['suno', 3], ['style prompt', 2], ['model version', 1]],
    });
  });

  it('rejects a scope that is not exactly one sentence or has no keywords', () => {
    expect(() => parseScope('x', 'One. Two.\n\nKeywords: a (1)')).toThrow(/exactly one sentence/);
    expect(() => parseScope('x', 'One sentence only.')).toThrow(/Keywords: line/);
    expect(() => parseScope('x', 'One sentence only.\n\nKeywords: a')).toThrow(/term \(weight\)/);
  });
});

describe('selectSpecialists', () => {
  it('activates only specialists at or above the threshold, each with its matched terms', () => {
    const r = selectSpecialists('How do I control dark baritone vocals in Suno?', [SUNO, VOCAL, MIX]);
    expect(r.selected.map((s) => s.name)).toEqual(['ai-vocal-systems-researcher', 'suno-researcher']);
    expect(r.selected[0]).toEqual({ name: 'ai-vocal-systems-researcher', score: 5, matched: ['baritone', 'vocal'] });
    expect(r.notSelected).toEqual([{ name: 'mix-master-ai-tooling-researcher', score: 0, matched: [] }]);
    expect(SELECTION_THRESHOLD).toBe(3);
  });

  it('selects nobody (and says so) rather than activating everyone when nothing matches', () => {
    const r = selectSpecialists('What should we eat tonight?', [SUNO, VOCAL, MIX]);
    expect(r.selected).toEqual([]);
  });
});

describe('planResearch', () => {
  it('emits a workflow plan with one independent step per selected specialist', () => {
    const plan = planResearch('How do I control dark baritone vocals in Suno?', [SUNO, VOCAL, MIX]);
    expect(plan.workflow.steps).toEqual([
      { id: 'ai-vocal-systems-researcher', agent: 'ai-vocal-systems-researcher', input: { question: 'How do I control dark baritone vocals in Suno?' } },
      { id: 'suno-researcher', agent: 'suno-researcher', input: { question: 'How do I control dark baritone vocals in Suno?' } },
    ]);
    expect(plan.workflow.name).toBe('research-specialists');
  });
});
