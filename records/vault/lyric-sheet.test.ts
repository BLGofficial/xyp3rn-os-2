import { describe, expect, it } from 'vitest';
import { parseLyricSheet, sheetText } from './lyric-sheet.ts';

// AOS-01: a lyric sheet (the owner's text) becomes x3lius.lyrics/v2 sections. Section tags map to
// the existing section kinds; any other bracketed line is a direction (never sung, F21); without
// tags, stanzas separated by blank lines are verses. A tagged section with no sung lines is
// instrumental: v2 lists it by id only, outside `sections` (the Suno renderer skips it).

describe('parseLyricSheet', () => {
  it('maps Suno-style section tags to kinds, numbers verses, keeps other tags as directions', () => {
    const p = parseLyricSheet('[Intro]\n\n[Verse 1]\nNight city lights\nNeon on the glass\n\n[Pre-Chorus]\nHold on\n[Chorus]\n[Guitar solo]\nWe run tonight\n\n[Verse 2]\nSecond verse\n[Outro]\n', 'en');
    expect(p.sections.map((s) => [s.sectionId, s.kind, s.label])).toEqual([
      ['s2', 'verse', 'Verse 1'], ['s3', 'pre-chorus', 'Pre-Chorus'], ['s4', 'chorus', 'Chorus'], ['s5', 'verse', 'Verse 2'],
    ]);
    expect(p.sections[0]).toEqual({
      sectionId: 's2', kind: 'verse', label: 'Verse 1', rhymeScheme: '', devices: [], directions: [],
      bars: [
        { n: 1, text: 'Night city lights', language: 'en', rhymeTag: '' },
        { n: 2, text: 'Neon on the glass', language: 'en', rhymeTag: '' },
      ],
    });
    expect(p.sections[2]!.directions).toEqual(['Guitar solo']);
    expect(p.instrumental).toEqual(['s1', 's6']);
    expect(p.warnings).toEqual([]);
  });

  it('v2 cannot hold directions on an instrumental section: they are reported, not silently lost', () => {
    const p = parseLyricSheet('[Intro]\n[Guitar solo]\n[Verse]\nhello', 'en');
    expect(p.instrumental).toEqual(['s1']);
    expect(p.warnings).toEqual(['s1 (Intro) has no sung lines, so it is instrumental; its directions "Guitar solo" stay only in the sheet']);
  });

  it('untagged lines before the first tag are a verse of their own', () => {
    const p = parseLyricSheet('opening line\n[Chorus]\nhook line', 'en');
    expect(p.sections.map((s) => [s.sectionId, s.kind, s.label])).toEqual([['s1', 'verse', 'Verse 1'], ['s2', 'chorus', 'Chorus']]);
  });

  it('reads tag variants: case, spacing, numbers, Hook, Bridge, Post-Chorus, Breakdown', () => {
    const kinds = parseLyricSheet('[CHORUS]\na\n[pre chorus]\nb\n[Post-Chorus]\nc\n[Hook 2]\nd\n[Bridge]\ne\n[Break]\nf', 'und').sections.map((s) => s.kind);
    expect(kinds).toEqual(['chorus', 'pre-chorus', 'post-chorus', 'hook', 'bridge', 'breakdown']);
  });

  it('with no section tags, stanzas separated by blank lines are verses; CRLF and trailing spaces are handled', () => {
    const p = parseLyricSheet('line one  \r\nline two\r\n\r\n\r\nline three\r\n', 'bg');
    expect(p.sections.map((s) => [s.kind, s.label, s.bars.map((b) => b.text)])).toEqual([
      ['verse', 'Verse 1', ['line one', 'line two']], ['verse', 'Verse 2', ['line three']],
    ]);
    expect(p.sections[0]!.bars[0]!.language).toBe('bg');
  });

  it('a direction before the first section belongs to it; a sheet with no sung line is refused', () => {
    expect(parseLyricSheet('[Whispered]\n[Verse]\nhello', 'en').sections[0]).toMatchObject({ kind: 'verse', directions: ['Whispered'] });
    expect(() => parseLyricSheet(' \n\n', 'en')).toThrow(/no lyrics/);
    expect(() => parseLyricSheet('[Intro]\n[Outro]', 'en')).toThrow(/no lyrics/);
  });
});

describe('sheetText', () => {
  it('renders sung sections back as a sheet the parser reads to the same sections (the UI edits this text)', () => {
    const p = parseLyricSheet('[Verse 1]\n[Whispered]\nNight city lights\nNeon on the glass\n\n[Chorus]\nWe run tonight\n', 'en');
    const text = sheetText(p);
    expect(text).toBe('[Verse 1]\n[Whispered]\nNight city lights\nNeon on the glass\n\n[Chorus]\nWe run tonight');
    expect(parseLyricSheet(text, 'en').sections).toEqual(p.sections);
  });
});
