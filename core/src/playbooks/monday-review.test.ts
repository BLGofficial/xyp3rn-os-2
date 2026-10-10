import { describe, expect, it } from 'vitest';
import { MONDAY_REVIEW, runMondayReview, spokenSummary } from './monday-review.ts';

// A scripted read-only transaction: rows come back in the order the sweep queries (inbox, splits, trace, queue).
const sqlWith = (...results: unknown[][]) => {
  let at = 0;
  const tx = Object.assign(async () => results[at++], { unsafe: async () => [] });
  return { begin: async (_mode: string, fn: (t: typeof tx) => unknown) => fn(tx) } as never;
};

describe('monday review', () => {
  it('matches the spoken trigger and nothing looser', () => {
    expect(MONDAY_REVIEW.test('Run monday review')).toBe(true);
    expect(MONDAY_REVIEW.test('please run my Monday review now')).toBe(true);
    expect(MONDAY_REVIEW.test('what happened on monday')).toBe(false);
  });

  it('flags each of the four checks that needs the owner', async () => {
    const r = await runMondayReview(sqlWith(
      [{ n: 2, paths: ['inbox/a.md', 'inbox/b.md'] }],
      [{ checked: 3, bad: [{ track: 't1', version: 1, sum: '99' }] }],
      [{ total: 4, unlinked: 1, latest: null }],
      [{ item_type: 'knowledge_candidate', n: 3, oldest: new Date('2026-10-01T00:00:00Z') }],
    ));
    expect(r.attention).toBe(4);
    expect(r.steps.map((s) => s.status)).toEqual(['attention', 'attention', 'attention', 'attention']);
    expect(r.steps[1]!.items).toEqual(['t1 v1: 99']);
    expect(spokenSummary(r)).toMatch(/^4 of 4 checks need you\./);
  });

  it('reports clear when nothing is waiting', async () => {
    const r = await runMondayReview(sqlWith([{ n: 0, paths: [] }], [{ checked: 0, bad: [] }], [{ total: 0, unlinked: 0, latest: null }], []));
    expect(r.attention).toBe(0);
    expect(spokenSummary(r)).toBe('All four checks are clear.');
  });
});
