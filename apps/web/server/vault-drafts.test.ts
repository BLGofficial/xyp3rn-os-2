import { describe, expect, it } from 'vitest';
import { draftGraph, type DraftRow } from './vault-drafts.ts';

const row = (id: string, path: string, links: string[] = []): DraftRow =>
  ({ id, source_path: path, domain: 'creative', status: 'pending_approval', updated_at: new Date(0), extracted_links: links.map((target) => ({ target })) });

describe('draftGraph', () => {
  it('makes one OBSIDIAN DRAFTS node per note and a wikilink edge between notes that link by name', () => {
    const g = draftGraph([row('a', 'creative/Hook.md', ['Verse', 'Missing', 'Hook']), row('b', 'inbox/sub/Verse.md')]);
    expect(g.nodes.map((n) => [n.id, n.label, n.group])).toEqual([['obsidian:a', 'Hook', 'OBSIDIAN DRAFTS'], ['obsidian:b', 'Verse', 'OBSIDIAN DRAFTS']]);
    expect(g.links).toEqual([{ source: 'obsidian:a', target: 'obsidian:b', relation: 'wikilink' }]);
  });
});
