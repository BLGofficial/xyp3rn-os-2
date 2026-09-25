import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff.ts';

// AOS-01 §9: /vault/lineages/[id] shows what changed between two versions of the lyrics.

describe('lineDiff', () => {
  it('keeps common lines, marks removed and added ones, in order', () => {
    expect(lineDiff(['[Verse 1]', 'Night city lights', 'Neon on the glass'], ['[Verse 1]', 'Night city lights', 'Neon rain on the glass', '[Chorus]'])).toEqual([
      { op: ' ', line: '[Verse 1]' }, { op: ' ', line: 'Night city lights' },
      { op: '-', line: 'Neon on the glass' }, { op: '+', line: 'Neon rain on the glass' }, { op: '+', line: '[Chorus]' },
    ]);
  });

  it('identical and empty inputs', () => {
    expect(lineDiff(['a', 'b'], ['a', 'b']).every((d) => d.op === ' ')).toBe(true);
    expect(lineDiff([], ['a'])).toEqual([{ op: '+', line: 'a' }]);
    expect(lineDiff(['a'], [])).toEqual([{ op: '-', line: 'a' }]);
  });
});
