import { describe, expect, it } from 'vitest';
import { decideVersion } from './write-normalized.ts';

describe('decideVersion (canonical writes never overwrite in place)', () => {
  it('inserts version 1 for a slug never seen', () => {
    expect(decideVersion(undefined)).toEqual({ action: 'insert', version: 1 });
  });

  it('reuses the latest row when its content is identical', () => {
    expect(decideVersion({ id: 'abc', version: 3, same: true })).toEqual({ action: 'reuse', id: 'abc' });
  });

  it('appends latest+1 when content changed — the old version stays', () => {
    expect(decideVersion({ id: 'abc', version: 3, same: false })).toEqual({ action: 'insert', version: 4 });
  });
});
