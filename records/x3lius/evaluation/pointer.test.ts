import { describe, expect, it } from 'vitest';
import { getAt, isAtOrUnder, scalarsIn, setAt, stringsIn } from './pointer.ts';

const doc = { title: 'a', sections: [{ bars: [{ text: 'one' }, { text: 'two' }] }], 'a/b': { '~k': 1 } };

describe('JSON Pointer (RFC 6901) over artifact bodies', () => {
  it('reads fields, array items and escaped keys', () => {
    expect(getAt(doc, '/sections/0/bars/1/text')).toEqual({ found: true, value: 'two' });
    expect(getAt(doc, '/a~1b/~0k')).toEqual({ found: true, value: 1 });
  });

  it('reports a missing step, a bad index, the root and a JSONPath as not found', () => {
    for (const p of ['/nope', '/sections/2', '/sections/01', '/sections/-1', '', '$.title', 'title', '/title/length']) {
      expect(getAt(doc, p), p).toEqual({ found: false });
    }
  });

  it('sets an existing field on a copy, never in place, and never creates one', () => {
    const next = setAt(doc, '/sections/0/bars/0/text', 'uno');
    expect(getAt(next, '/sections/0/bars/0/text')).toEqual({ found: true, value: 'uno' });
    expect(doc.sections[0]!.bars[0]!.text).toBe('one');
    expect(getAt(setAt(doc, '/a~1b/~0k', 2), '/a~1b/~0k')).toEqual({ found: true, value: 2 });
    expect(() => setAt(doc, '/sections/0/bars/9/text', 'x')).toThrow(/no field at \/sections\/0\/bars\/9\/text/);
  });

  it('knows what is inside what', () => {
    expect(isAtOrUnder('/sections/0/bars/0/text', '/sections/0')).toBe(true);
    expect(isAtOrUnder('/sections/0', '/sections/0')).toBe(true);
    expect(isAtOrUnder('/sections/01', '/sections/0')).toBe(false);
  });

  it('collects every string under a value', () => {
    expect(stringsIn(doc.sections)).toEqual(['one', 'two']);
    expect(stringsIn(3)).toEqual([]);
  });

  it('collects every number and true/false under a value as its JSON text', () => {
    expect(scalarsIn({ a: 1.5, b: [true, 'x', null], c: { d: 0 } })).toEqual(['1.5', 'true', '0']);
  });
});
