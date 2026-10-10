import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractWikilinks, parseObsidianNote } from './parser.ts';

const NOTE = `---
type: lyric_draft
domain: creative
tags: [rap, "#draft"]
author: xyp3rn
status: draft
---

Verse ties to [[Studio Log]] and [[Songs/Hook#Chorus|the hook]].
Embed: ![[cover.png]]
\`[[not a link]]\`
`;

describe('parseObsidianNote', () => {
  it('extracts YAML metadata and tags', () => {
    const n = parseObsidianNote(NOTE);
    expect(n.frontmatter).toMatchObject({ type: 'lyric_draft', domain: 'creative', author: 'xyp3rn', status: 'draft' });
    expect(n.frontmatter.tags).toEqual(['rap', 'draft']);
    expect(n.frontmatterError).toBeNull();
    expect(n.body.startsWith('\nVerse')).toBe(true);
  });

  it('extracts multiple wikilinks with target, heading, alias and embed flag', () => {
    const links = parseObsidianNote(NOTE).wikilinks;
    expect(links.map((l) => l.target)).toEqual(['Studio Log', 'Songs/Hook', 'cover.png']);
    expect(links[1]).toMatchObject({ heading: 'Chorus', alias: 'the hook', embed: false });
    expect(links[2]!.embed).toBe(true);
  });

  it('hashes the entire raw file, frontmatter included', () => {
    const expected = createHash('sha256').update(NOTE, 'utf8').digest('hex');
    expect(parseObsidianNote(NOTE).sha256).toBe(expected);
    expect(parseObsidianNote(NOTE + ' ').sha256).not.toBe(expected);
  });

  it('survives broken or missing frontmatter', () => {
    expect(parseObsidianNote('---\na: [\n---\nhi [[X]]').frontmatterError).not.toBeNull();
    const bare = parseObsidianNote('no fm [[A|b]]');
    expect(bare.frontmatter.tags).toEqual([]);
    expect(extractWikilinks('[[A|b]]')[0]).toMatchObject({ target: 'A', alias: 'b' });
  });
});
