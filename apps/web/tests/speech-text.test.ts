import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, speechChunks, speechText } from '../lib/speech-text';

describe('speechText: speak the meaning, not the markup', () => {
  it('keeps uncertainty, errors and approval requirements verbatim', () => {
    for (const reply of ['Needs clarification: ambiguous between RECORDS and TECH (margin 1); say which.',
      'X3LIUS music system finished. Sub-domains: release. Approval required: 1 item(s) pending in Governance.',
      'The request failed before completing. It was not retried; check Live Events for any runs it started.']) {
      expect(speechText(reply)).toBe(reply);
    }
  });

  it('replaces ids, URLs, secrets, markup and payloads', () => {
    expect(speechText('X3LIUS music system failed at mix. Details are on workflow run 22222222-2222-4222-8222-222222222222.'))
      .toBe('X3LIUS music system failed at mix. Details are on workflow run (ID on screen).');
    expect(speechText('See https://example.com/runs/1?x=2 now')).toBe('See (link on screen) now');
    expect(speechText('key sk-live-abcdef1234567890 and Bearer abc.def and ghp_abcdefghijklmnop')).toBe('key (hidden value) and (hidden value) and (hidden value)');
    expect(speechText('hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 done')).toBe('hash (hidden value) done');
    expect(speechText('**Done** with `code` and <b>bold</b> # heading')).toBe('Done with code and bold heading');
    expect(speechText('Result {"prompt":"SYSTEM: you are","tool":{"args":[1,2]}} ok')).toBe('Result (details omitted) ok');
    expect(speechText('```json\n{"a":1}\n```\nFinished.')).toBe('(code omitted) Finished.');
    expect(speechText('- first\n- second')).toBe('first second');
  });
});

describe('speechChunks: bounded, ordered, only when needed', () => {
  it('returns one chunk when the text fits, none when empty', () => {
    expect(speechChunks('Short reply.')).toEqual(['Short reply.']);
    expect(speechChunks('')).toEqual([]);
  });

  it('splits long text at sentence boundaries, in order, each within the bound', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains one finding in plain words.`);
    const chunks = speechChunks(sentences.join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks.join(' ')).toBe(sentences.join(' '));
  });

  it('hard-splits a single overlong sentence at word boundaries', () => {
    const chunks = speechChunks(Array.from({ length: 300 }, () => 'word').join(' '), 100);
    expect(chunks.every(c => c.length <= 100)).toBe(true);
    expect(chunks.join(' ').split(/\s+/)).toHaveLength(300);
  });
});
