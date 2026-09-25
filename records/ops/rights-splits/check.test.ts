import { describe, expect, it } from 'vitest';
import type { CatalogRecord } from '../tools.ts';
import { checkRights } from './check.ts';

const record = (tracks: ReadonlyArray<CatalogRecord['tracks'][number]['splits']>): CatalogRecord => ({
  release: { id: 'r1', title: 't', artist: 'a', kind: 'single', upc: null, status: 'draft', releaseDate: null, rightsCheckRunId: null },
  tracks: tracks.map((splits, i) => ({ id: `t${i + 1}`, position: i + 1, title: `T${i + 1}`, isrc: null, takeId: `k${i + 1}`, mixReportArtifactId: null, splits })),
});

describe('checkRights', () => {
  it('passes thirds that sum to exactly 100 in thousandths (no float drift)', () => {
    const v = checkRights(record([{ version: 1, rows: [{ payee: 'a', percentage: 33.333 }, { payee: 'b', percentage: 33.333 }, { payee: 'c', percentage: 33.334 }] }]));
    expect(v.verdict).toBe('pass');
  });

  it('reports every rule, skipping the split rules when there is nothing to check', () => {
    expect(checkRights(record([])).rules).toEqual([
      { id: 'rights.release-has-tracks', status: 'flag' },
      { id: 'rights.split-set-present', status: 'skipped' },
      { id: 'rights.no-unassigned-share', status: 'skipped' },
      { id: 'rights.sum-100', status: 'skipped' },
    ]);
  });

  it('flags each track on its own: a missing set, an unassigned share, a sum the DB should never have let through', () => {
    const v = checkRights(record([
      null,
      { version: 2, rows: [{ payee: 'a', percentage: 62.5 }, { payee: null, percentage: 37.5 }] },
      { version: 1, rows: [{ payee: 'a', percentage: 90 }] },
    ]));
    expect(v.verdict).toBe('flag');
    expect(v.flags.map((f) => [f.rule, f.trackId, f.unassignedPercentage])).toEqual([
      ['rights.split-set-present', 't1', undefined],
      ['rights.no-unassigned-share', 't2', 37.5],
      ['rights.sum-100', 't3', undefined],
    ]);
  });
});
