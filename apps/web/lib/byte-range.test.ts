import { describe, expect, it } from 'vitest';
import { parseRange } from './byte-range.ts';

// The Vault raw route answers 206 for these; the audio player seeks with them.
describe('parseRange', () => {
  it('reads a closed, an open-ended and a suffix range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual([0, 99]);
    expect(parseRange('bytes=500-', 1000)).toEqual([500, 999]);
    expect(parseRange('bytes=-200', 1000)).toEqual([800, 999]);
  });
  it('clamps an end past the body and refuses a start past it', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual([900, 999]);
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=50-10', 1000)).toBe('unsatisfiable');
  });
  it('ignores a missing, malformed or multi-range header', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
  });
});
