import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPORT_DIR, exportFileName, linkGraph, listNotes, parseNote, resolveVaultRoot } from './notes.ts';

describe('resolveVaultRoot', () => {
  it('takes the parent when given the .obsidian config folder (Windows path)', () => {
    expect(resolveVaultRoot('C:\\Users\\blago\\Desktop\\XYP3RN Obsidian Directory\\.obsidian')).toEqual({
      root: 'C:\\Users\\blago\\Desktop\\XYP3RN Obsidian Directory', adjusted: true,
    });
  });
  it('takes the parent for a POSIX path with a trailing separator', () => {
    expect(resolveVaultRoot('/home/me/Vault/.obsidian/')).toEqual({ root: '/home/me/Vault', adjusted: true });
  });
  it('keeps a vault root as given', () => {
    expect(resolveVaultRoot('/home/me/Vault')).toEqual({ root: '/home/me/Vault', adjusted: false });
  });
  it('refuses an empty path', () => {
    expect(() => resolveVaultRoot('  ')).toThrow(/empty/);
  });
});

describe('parseNote', () => {
  it('reads frontmatter, frontmatter tags, inline tags (Cyrillic too) and wikilinks', () => {
    const md = [
      '---',
      'title: Нова ера',
      'tags: [new-era, lyrics]',
      'lang: bg',
      '---',
      'Hook idea #демо and #x3lius/voice.',
      'See [[Song Ideas]], [[Studio Log|the log]], [[Release Plan#Dates]] and ![[cover.png]].',
      '```',
      '#not-a-tag [[Not A Link]]',
      '```',
    ].join('\n');
    const n = parseNote(md);
    expect(n.title).toBe('Нова ера');
    expect(n.language).toBe('bg');
    expect(n.tags).toEqual(['lyrics', 'new-era', 'x3lius/voice', 'демо'].sort());
    expect(n.wikilinks).toEqual(['Release Plan', 'Song Ideas', 'Studio Log', 'cover.png']);
  });
  it('treats a note without frontmatter as plain body, and a bad language as none', () => {
    const n = parseNote('---\nlang: Bulgarian\n---\nbody');
    expect(n.language).toBeNull();
    expect(parseNote('# Heading\ntext').title).toBeNull();
  });
  it('does not throw on broken frontmatter; it reports it', () => {
    const n = parseNote('---\ntitle: [unclosed\n---\nbody');
    expect(n.frontmatterError).toMatch(/.+/);
    expect(n.title).toBeNull();
  });
  it('reads the OS export marker', () => {
    expect(parseNote('---\nxyp3rn_id: 0b4c\nxyp3rn_kind: song\n---\n').exported).toEqual({ id: '0b4c', kind: 'song' });
    expect(parseNote('plain').exported).toBeNull();
  });
});

describe('linkGraph', () => {
  it('resolves wikilinks by name or path the way Obsidian does, and counts what does not resolve', () => {
    const g = linkGraph([
      { rel: 'Home.md', text: '[[Hook]] [[Songs/Hook]] [[Release Plan]] [[Missing]]' },
      { rel: 'Songs/Hook.md', text: '[[home]]' },
      { rel: 'Plans/Release Plan.md', text: '[[Hook]]' },
    ]);
    expect(g.notes).toBe(3);
    expect(g.links).toBe(4);
    expect(g.unresolved).toEqual([{ from: 'Home.md', target: 'Missing' }]);
    expect(g.top[0]).toEqual({ rel: 'Songs/Hook.md', backlinks: 2 });
  });
});

describe('exportFileName', () => {
  it('strips characters Windows refuses and keeps an id suffix', () => {
    expect(exportFileName('Song', 'A/B: "Night"?', '0b4c1d2e-0000-4000-8000-000000000000')).toBe(`${EXPORT_DIR}/Songs/A B Night (0b4c1d2e).md`);
  });
  it('never yields a reserved device name or a trailing dot', () => {
    expect(exportFileName('Song', 'CON', '11111111-0000-4000-8000-000000000000')).toBe(`${EXPORT_DIR}/Songs/CON_ (11111111).md`);
    expect(exportFileName('Finding', '...', '22222222-0000-4000-8000-000000000000')).toBe(`${EXPORT_DIR}/Findings/untitled (22222222).md`);
  });
});

describe('listNotes', () => {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-notes-'));
  const outside = mkdtempSync(join(tmpdir(), 'obsidian-outside-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.obsidian'));
  mkdirSync(join(root, '.trash'));
  mkdirSync(join(root, 'Songs', 'Drafts'), { recursive: true });
  writeFileSync(join(root, '.obsidian', 'app.json'), '{}');
  writeFileSync(join(root, '.trash', 'old.md'), 'gone');
  writeFileSync(join(root, 'Home.md'), 'home');
  writeFileSync(join(root, 'Songs', 'Drafts', 'Hook.md'), 'hook');
  writeFileSync(join(root, 'image.png'), 'png');
  writeFileSync(join(outside, 'secret.md'), 'outside the vault');
  let linked = true;
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));
  } catch {
    linked = false; // Windows without the symlink privilege: the rule is still exercised by the other cases.
  }

  it('lists Markdown notes with posix paths and hashes, skipping dot folders and symlinks', async () => {
    const notes = await listNotes(root);
    expect(notes.map((n) => n.rel)).toEqual(['Home.md', 'Songs/Drafts/Hook.md']);
    expect(notes[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    if (linked) expect(notes.some((n) => n.rel === 'link.md')).toBe(false);
  });
  it('refuses a root that does not exist, naming it', async () => {
    await expect(listNotes(join(root, 'missing'))).rejects.toThrow(/missing/);
  });
});
