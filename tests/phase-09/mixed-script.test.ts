import { describe, expect, it } from 'vitest';
import { mixedScriptWords } from '../../records/x3lius/creative/script-check.ts';

// A word whose letters mix Latin and Cyrillic is a homoglyph corruption, not code-switching: it
// looks right on screen but no reader (or Suno's text-to-voice) can pronounce it. Seen live
// (2026-09-24, Nemotron): lyrics bar "Пeak" (Cyrillic П + Latin "eak") and subgenre "phonк"
// (Latin + Cyrillic к). Switching languages between words stays allowed.

describe('mixedScriptWords', () => {
  it('finds each word that mixes Latin and Cyrillic letters, with its JSON path', () => {
    const body = {
      title: 'NOCTURNE БЕТОН',
      sections: [{ bars: [{ text: 'Midnight concrete veins' }, { text: 'Пeak слънцето никога не се връща' }] }],
      subgenres: ['industrial trap', 'phonк'],
    };
    expect(mixedScriptWords(body)).toEqual([
      { word: 'Пeak', path: '$.sections[0].bars[1].text' },
      { word: 'phonк', path: '$.subgenres[1]' },
    ]);
  });

  it.each([
    ['words in different scripts side by side', 'Градът спи / City sleeps'],
    ['a digit inside a word', 'X3LIUS БЕТ0Н'],
    ['apostrophes and hyphens split words', "don't code‑switching кой-то"],
    ['a canonical ref', 'canonical_prompts:ab30dc65-8670-4f5f-a4ce-a723242db6e7#x3lius.voice-reference'],
    ['accented Latin', 'café naïve'],
    ['Cyrillic with a combining stress mark', 'гра́дът'],
  ])('allows %s', (_, text) => {
    expect(mixedScriptWords({ text })).toEqual([]);
  });

  it('walks nested arrays and objects, and ignores non-strings', () => {
    expect(mixedScriptWords([{ a: 1, b: [true, null, { c: 'aБ' }] }])).toEqual([{ word: 'aБ', path: '$[0].b[2].c' }]);
    expect(mixedScriptWords(42)).toEqual([]);
  });
});
