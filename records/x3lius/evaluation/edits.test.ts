import { describe, expect, it } from 'vitest';
import { LYRICS_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { applyEdits, rederive } from './edits.ts';
import { violationKey, type Violation } from './schemas.ts';

const REF = 'canonical_prompts:11111111-1111-4111-8111-111111111111';
const v = (path: string): Violation => ({ key: violationKey(REF, path), ruleRef: REF, method: 'model', path, quote: 'q', expected: 'e', found: 'f' });
const LYR = {
  sections: [{ sectionId: 'v1', kind: 'verse', flag: true, bars: [{ n: 1, text: 'old one' }, { n: 2, text: 'old two' }] }],
  instrumental: [], sources: [{ role: 'structure', artifactId: 'a', schemaId: 's', version: 1 }], rulesApplied: [], ungroundedChoices: [],
};
const LYR_ID = LYRICS_SCHEMA_ID;
const bar0 = v('/sections/0/bars/0/text');
const section = v('/sections/0');

describe('applying revision edits', () => {
  it('replaces a violated field, and a field inside a violated section, on a copy', () => {
    const next = applyEdits(LYR_ID, LYR, [
      { path: '/sections/0/bars/0/text', replacement: 'Neon on Canal Street', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/1/n', replacement: '3', violationKeys: [section.key] },
      { path: '/sections/0/flag', replacement: 'false', violationKeys: [section.key] },
    ], [bar0, section]);
    expect(next.sections).toEqual([{ sectionId: 'v1', kind: 'verse', flag: false, bars: [{ n: 1, text: 'Neon on Canal Street' }, { n: 3, text: 'old two' }] }]);
    expect(LYR.sections[0]!.bars[0]!.text).toBe('old one');
  });

  it.each([
    ['no edits at all', [], [bar0], /no edits: nothing to revise/],
    ['an edit citing no violation', [{ path: '/sections/0/bars/0/text', replacement: 'x', violationKeys: [] }], [bar0], /edit 0 \(\/sections\/0\/bars\/0\/text\) cites no violation/],
    ['an edit citing a key this critique lacks', [{ path: '/sections/0/bars/0/text', replacement: 'x', violationKeys: ['nope'] }], [bar0], /cites nope, which is not a violation of this critique/],
    ['a path that is not a field', [{ path: '/sections/0/bars/7/text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /names no field of the artifact/],
    ['a JSONPath', [{ path: '$.sections[0].bars[0].text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /names no field of the artifact/],
    ['a field code derives', [{ path: '/sources/0/artifactId', replacement: 'x', violationKeys: [bar0.key] }], [bar0, v('/sources')], /targets a field code derives/],
    ['a field no violation points to', [{ path: '/sections/0/bars/1/text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /is not at or inside a field a violation points to/],
    ['a whole object', [{ path: '/sections/0/bars/0', replacement: 'x', violationKeys: [v('/sections/0/bars/0').key] }], [v('/sections/0/bars/0')], /replaces an object or list, not a text, number or true\/false field/],
    ['text for a number', [{ path: '/sections/0/bars/0/n', replacement: '120 bpm', violationKeys: [section.key] }], [section], /"120 bpm" is not a number/],
    ['text for a true/false field', [{ path: '/sections/0/flag', replacement: 'yes', violationKeys: [section.key] }], [section], /"yes" is not true or false/],
    ['emptying a text field', [{ path: '/sections/0/bars/0/text', replacement: '  ', violationKeys: [bar0.key] }], [bar0], /empties a text field/],
    ['a no-op', [{ path: '/sections/0/bars/0/text', replacement: 'old one', violationKeys: [bar0.key] }], [bar0], /changes nothing/],
    ['two edits of one field', [
      { path: '/sections/0/bars/0/text', replacement: 'a', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/0/text', replacement: 'b', violationKeys: [bar0.key] },
    ], [bar0], /edit 1 \(\/sections\/0\/bars\/0\/text\) repeats a field edit 0 changes/],
  ])('refuses %s, and applies nothing', (_label, edits, violations, message) => {
    expect(() => applyEdits(LYR_ID, LYR, edits, violations)).toThrow(message);
  });

  it('refuses the whole revision when any edit is refused, naming each', () => {
    expect(() => applyEdits(LYR_ID, LYR, [
      { path: '/sections/0/bars/0/text', replacement: 'fine', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/1/text', replacement: 'x', violationKeys: [bar0.key] },
    ], [bar0])).toThrow(/^revision refused: edit 1 /);
  });

  it('never edits a Suno prompt’s lyrics, limits or target model: those are rendered or measured', () => {
    const suno = { sunoModel: 'v5', title: 't', style: 's', excludeStyles: [], lyrics: 'l', sources: [], limits: [], rulesApplied: [], ungroundedChoices: [] };
    for (const path of ['/lyrics', '/sunoModel']) {
      expect(() => applyEdits(SUNO_PROMPT_SCHEMA_ID, suno, [{ path, replacement: 'x', violationKeys: [v(path).key] }], [v(path)])).toThrow(/targets a field code derives/);
    }
  });

  it('re-derives a Suno prompt’s measured lengths after an edit', () => {
    const suno = { sunoModel: 'v5', title: 'Night Title', style: 's', excludeStyles: [], lyrics: 'l', sources: [], limits: [{ field: 'title', max: 80, actual: 3, ref: REF }], rulesApplied: [], ungroundedChoices: [] };
    expect(rederive(SUNO_PROMPT_SCHEMA_ID, suno).limits).toEqual([{ field: 'title', max: 80, actual: 11, ref: REF }]);
    expect(rederive(LYRICS_SCHEMA_ID, LYR)).toBe(LYR);
  });
});
