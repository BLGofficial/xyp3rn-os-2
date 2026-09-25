import { describe, expect, it } from 'vitest';
import { checkSchedulable, UNASSIGNED, type ReleaseView } from './schedulable.ts';

const rel = (over: Partial<ReleaseView> = {}): ReleaseView => ({
  id: 'r', title: 'R', status: 'draft', releaseDate: '2026-12-01',
  tracks: [{ id: 't1', position: 1, title: 'One', splits: [{ payee: 'A', role: 'writer', percentage: 60 }, { payee: 'B', role: 'producer', percentage: 40 }] }],
  ...over,
});

describe('checkSchedulable (the Rights agent report; Calendar runs it before proposing)', () => {
  it('passes a draft with a date and every track at 100 with no UNASSIGNED', () => {
    expect(checkSchedulable(rel())).toEqual({
      schedulable: true, problems: [],
      tracks: [{ trackId: 't1', position: 1, total: 100, unassigned: 0, problems: [], notes: [] }],
    });
  });

  it('names every blocking problem, per track and for the release', () => {
    const r = checkSchedulable(rel({
      status: 'scheduled', releaseDate: null,
      tracks: [
        { id: 't1', position: 1, title: 'One', splits: [] },
        { id: 't2', position: 2, title: 'Two', splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: UNASSIGNED, role: 'publisher', percentage: 25 }] },
      ],
    }));
    expect(r.schedulable).toBe(false);
    expect(r.problems).toEqual(['release is scheduled, not draft', 'no release date']);
    expect(r.tracks.map((t) => t.problems)).toEqual([['no splits entered'], ['UNASSIGNED share of 25%']]);
    expect(r.tracks[1]).toMatchObject({ total: 100, unassigned: 25 });
  });

  it('refuses a release with no tracks, and sums in cents (33.33 + 33.33 + 33.34 = 100)', () => {
    expect(checkSchedulable(rel({ tracks: [] })).problems).toEqual(['no tracks']);
    const thirds = rel({ tracks: [{ id: 't', position: 1, title: 'T', splits: [33.33, 33.33, 33.34].map((p, i) => ({ payee: `P${i}`, role: 'writer', percentage: p })) }] });
    expect(checkSchedulable(thirds).tracks[0]!.total).toBe(100);
  });

  it('can leave the date out: the Rights agent judges rights, the Calendar agent supplies the date', () => {
    expect(checkSchedulable(rel({ releaseDate: null }), { requireDate: false })).toMatchObject({ schedulable: true, problems: [] });
    expect(checkSchedulable(rel({ releaseDate: null }))).toMatchObject({ schedulable: false, problems: ['no release date'] });
  });

  it('notes, without blocking, a payee listed under two roles', () => {
    const r = checkSchedulable(rel({ tracks: [{ id: 't', position: 1, title: 'T', splits: [{ payee: 'A', role: 'writer', percentage: 50 }, { payee: 'A', role: 'producer', percentage: 50 }] }] }));
    expect(r).toMatchObject({ schedulable: true });
    expect(r.tracks[0]!.notes).toEqual(['A is listed as writer and producer']);
  });
});
