import { describe, expect, it } from 'vitest';
import { summarizeExtractive } from './extractive-summarizer.ts';

const items = [
  {
    ref: { table: 'canonical_prompts', id: '11111111-1111-1111-1111-111111111111' },
    slug: 'phase-6d-knowledge-promotion-pipeline',
    title: 'Phase 6D — Knowledge Promotion Pipeline',
    snippet:
      'You are a Staff Backend Engineer. Implement the full state machine as the ONLY path that can write to canonical_prompts. Every promotion writes a knowledge_versions row.',
    score: 0.86,
  },
  {
    ref: { table: 'modules', id: '22222222-2222-2222-2222-222222222222' },
    slug: 'phase-6-ai-music-research-intelligence',
    title: 'Phase 6 — AI Music Research Intelligence',
    snippet: 'This is the core of the source architecture. Split into four sequential sub-prompts.',
    score: 0.52,
  },
];

describe('extractive summarizer (deterministic, labelled, cited)', () => {
  it('picks the sentence with the most query-term overlap per item and cites its row', () => {
    const s = summarizeExtractive('who can write canonical prompts', items, 5);
    expect(s.method).toBe('extractive');
    expect(s.bullets[0]).toEqual({
      text: 'Implement the full state machine as the ONLY path that can write to canonical_prompts.',
      cite: { table: 'canonical_prompts', id: '11111111-1111-1111-1111-111111111111', slug: 'phase-6d-knowledge-promotion-pipeline', score: 0.86 },
      matchedTerms: ['canonical', 'prompts', 'write'],
    });
    expect(s.note).toMatch(/no LLM/i);
  });

  it('is deterministic and respects the item cap', () => {
    expect(summarizeExtractive('architecture', items, 1)).toEqual(summarizeExtractive('architecture', items, 1));
    expect(summarizeExtractive('architecture', items, 1).bullets).toHaveLength(1);
  });

  it('uses full item text when present, skips structural header lines, and quotes only complete sentences', () => {
    const s = summarizeExtractive(
      'who can write canonical prompts',
      [
        {
          ...items[0]!,
          snippet: 'You are a Staff Backend Engineer. CONTEXT {{PRIOR_PHASE_SUMMARY}} TASK Implement the full state machine … that can write to canonical',
          text: 'You are a Staff Backend Engineer.\nCONTEXT\n{{PRIOR_PHASE_SUMMARY}}\nTASK\nImplement the full state machine, in this exact order, as the ONLY path\nthat can write to canonical_prompts / modules:\n1. Gate logic: auto-approve above a threshold.',
        },
      ],
      5,
    );
    expect(s.bullets.map((b) => b.text)).toEqual(['Implement the full state machine, in this exact order, as the ONLY path that can write to canonical_prompts / modules:']);
  });

  it('never quotes a sentence cut off by snippet truncation', () => {
    const s = summarizeExtractive('write canonical', [{ ...items[0]!, snippet: 'Nothing here matches. The gate may write to canonical…' }], 5);
    expect(s.bullets).toEqual([]);
  });

  it('rejects input that is not a list of context items', () => {
    expect(() => summarizeExtractive('q', 'nope' as never, 5)).toThrow(/items must be an array of context items/);
  });
});
