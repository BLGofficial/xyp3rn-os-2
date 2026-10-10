import { describe, expect, it } from 'vitest';
import { toRow } from './watcher.ts';

describe('toRow', () => {
  const raw = '---\ntype: lyric_draft\ntags: [a]\ndate: 2026-10-10\n---\nSee [[Hook|the hook]].\n';

  it('maps a note to its staging row; domain falls back to the top folder', () => {
    const r = toRow('creative/x.md', raw);
    expect(r).toMatchObject({ domain: 'creative', sourcePath: 'creative/x.md', rawContent: raw });
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.metadata).toMatchObject({ type: 'lyric_draft', tags: ['a'] });
    expect(r.extractedLinks).toMatchObject([{ target: 'Hook', alias: 'the hook' }]);
  });

  it('prefers frontmatter domain', () => {
    expect(toRow('inbox/y.md', '---\ndomain: research\n---\nx').domain).toBe('research');
  });
});
