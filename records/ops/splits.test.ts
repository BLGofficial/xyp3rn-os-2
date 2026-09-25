import { describe, expect, it } from 'vitest';
import { parseSplitsFile } from './splits.ts';

describe('splits file (pnpm records splits)', () => {
  it('accepts two decimals (33.33, which is 3332.9999999999995 × 100 in floating point)', () => {
    expect(parseSplitsFile('splits:\n  - { payee: A, role: writer, percentage: 33.33 }\n')).toEqual([{ payee: 'A', role: 'writer', percentage: 33.33 }]);
  });

  it('reads payee, role and percentage rows', () => {
    expect(parseSplitsFile('splits:\n  - { payee: X3LIUS, role: writer, percentage: 50 }\n  - { payee: UNASSIGNED, role: publisher, percentage: 50 }\n'))
      .toEqual([{ payee: 'X3LIUS', role: 'writer', percentage: 50 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 50 }]);
  });

  it.each([
    ['a percent string', '{ payee: A, role: writer, percentage: "50%" }', /splits\[0\]\.percentage must be a number/],
    ['three decimals', '{ payee: A, role: writer, percentage: 33.333 }', /at most 2 decimals/],
    ['a negative', '{ payee: A, role: writer, percentage: -5 }', /above 0 and at most 100/],
    ['an unknown role', '{ payee: A, role: composer, percentage: 100 }', /role must be one of writer, producer, performer, publisher, other/],
    ['a blank payee', '{ payee: " ", role: writer, percentage: 100 }', /payee must be a non-empty string/],
    ['an unknown field', '{ payee: A, role: writer, percentage: 100, share: 1 }', /unknown field: share/],
  ])('refuses %s, naming the field', (_, row, why) => {
    expect(() => parseSplitsFile(`splits:\n  - ${row}\n`)).toThrow(why);
  });

  it('refuses a file with no splits list', () => {
    expect(() => parseSplitsFile('payees: []')).toThrow(/splits must be a non-empty list/);
  });
});
