import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianExporterService, slugTitle, type CanonicalLyricRecord } from './exporter.ts';
import { parseObsidianNote } from './parser.ts';

const SHA = 'a'.repeat(64);
const record: CanonicalLyricRecord = {
  artifactId: '11111111-1111-1111-1111-111111111111', lineageId: '22222222-2222-2222-2222-222222222222', version: 2,
  title: 'Cold Concrete!', artist: 'X3LIUS', genre: 'drill', language: 'en', sourceSha256: SHA,
  sections: [
    { label: 'Verse 1', bars: [{ n: 1, text: 'first bar' }, { n: 2, text: 'second bar' }] },
    { label: 'Chorus', bars: [{ n: 1, text: 'hook line' }] },
  ],
};

let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), 'obs-export-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe('ObsidianExporterService.exportApprovedLyric', () => {
  it('writes a canonical, read-only note with frontmatter, sections and profile wikilinks', async () => {
    const { path, result } = await new ObsidianExporterService(vault).exportApprovedLyric(record);
    expect(result).toBe('written');
    expect(path.endsWith(join('canonical', 'lyrics', 'Cold-Concrete_2.md'))).toBe(true);
    const text = await readFile(path, 'utf8');
    const note = parseObsidianNote(text);
    expect(note.frontmatter).toMatchObject({ type: 'lyrics', domain: 'canonical', status: 'canonical', source_sha256: SHA, version: 2 });
    expect(text).toContain('## VERSE 1\n\nfirst bar\nsecond bar');
    expect(text).toContain('## CHORUS');
    expect(note.wikilinks.map((l) => l.target)).toEqual(['X3LIUS Vocal DNA', 'Genre Recipe - drill']);
    expect((await stat(path)).mode & 0o222).toBe(0); // nobody may write: 0444 (read-only attribute on Windows)
  });

  it('is idempotent for the same source and refuses a different source at the same path', async () => {
    const svc = new ObsidianExporterService(vault);
    await svc.exportApprovedLyric(record);
    expect((await svc.exportApprovedLyric(record)).result).toBe('unchanged');
    await expect(svc.exportApprovedLyric({ ...record, sourceSha256: 'b'.repeat(64) })).rejects.toThrow(/refusing to overwrite/);
  });
});

describe('slugTitle', () => {
  it('keeps letters of any script and falls back when nothing is left', () => {
    expect(slugTitle('Студен бетон / 2')).toBe('Студен-бетон-2');
    expect(slugTitle('???')).toBe('untitled');
  });
});
