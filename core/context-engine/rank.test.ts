import { describe, expect, it } from 'vitest';
import { PREDICATE_WEIGHTS, rankContext, type Edge } from './rank.ts';

// Pure ranking formula. Inputs are hand-written refs because this tests arithmetic, not data;
// the real-data proof lives in tests/phase-03.

const p = (id: string) => ({ table: 'canonical_prompts', id }) as const;
const m = (id: string) => ({ table: 'modules', id }) as const;
const s = (id: string) => ({ table: 'sources', id }) as const;
const LIMITS = { direct: 10, expanded: 10 };

describe('rankContext', () => {
  it('scores a direct hit by its cosine similarity and says so', () => {
    const { items } = rankContext([{ ref: p('a'), similarity: 0.8 }], [], LIMITS);
    expect(items).toEqual([{ ref: p('a'), score: 0.8, reasons: [{ kind: 'vector', similarity: 0.8 }] }]);
  });

  it('scores a 1-hop neighbour as parent score x the predicate/direction weight', () => {
    const edges: Edge[] = [
      { from: p('a'), predicate: 'precedes', to: p('b'), via: 'relations:r1' },
      { from: p('a'), predicate: 'module_of', to: m('M'), via: 'fk:canonical_prompts.module_id' },
    ];
    const { items } = rankContext([{ ref: p('a'), similarity: 0.8 }], edges, LIMITS);
    const b = items.find((i) => i.ref.id === 'b')!;
    expect(b.score).toBeCloseTo(0.8 * PREDICATE_WEIGHTS.precedes.out, 12);
    expect(b.reasons).toEqual([
      { kind: 'graph', predicate: 'precedes', direction: 'out', parent: p('a'), parentScore: 0.8, weight: 0.7, via: 'relations:r1' },
    ]);
    expect(items.find((i) => i.ref.id === 'M')!.score).toBeCloseTo(0.8 * 0.6, 12);
  });

  it('uses the incoming weight when the hit is the edge object', () => {
    const edges: Edge[] = [{ from: m('X'), predicate: 'depends_on', to: m('Y'), via: 'relations:r2' }];
    const { items } = rankContext([{ ref: m('Y'), similarity: 0.5 }], edges, LIMITS);
    expect(items.find((i) => i.ref.id === 'X')!.score).toBeCloseTo(0.5 * PREDICATE_WEIGHTS.depends_on.in, 12);
  });

  it('never expands a zero-weight direction (a source fanning out to everything derived from it)', () => {
    const edges: Edge[] = [{ from: p('z'), predicate: 'derived_from', to: s('S'), via: 'relations:r3' }];
    const { items } = rankContext([{ ref: s('S'), similarity: 0.9 }], edges, LIMITS);
    expect(items.map((i) => i.ref.id)).toEqual(['S']);
  });

  it('merges an entity reached twice: keeps the max score and every reason', () => {
    const edges: Edge[] = [{ from: p('a'), predicate: 'precedes', to: p('b'), via: 'relations:r1' }];
    const { items } = rankContext(
      [
        { ref: p('a'), similarity: 0.9 },
        { ref: p('b'), similarity: 0.4 },
      ],
      edges,
      LIMITS,
    );
    const b = items.find((i) => i.ref.id === 'b')!;
    expect(b.score).toBeCloseTo(0.9 * 0.7, 12);
    expect(b.reasons.map((r) => r.kind).sort()).toEqual(['graph', 'vector']);
  });

  it('skips unknown predicates loudly (reported, never silently weighted)', () => {
    const edges: Edge[] = [{ from: p('a'), predicate: 'mystery_link', to: p('q'), via: 'relations:r9' }];
    const out = rankContext([{ ref: p('a'), similarity: 0.7 }], edges, LIMITS);
    expect(out.items.map((i) => i.ref.id)).toEqual(['a']);
    expect(out.skippedPredicates).toEqual(['mystery_link']);
  });

  it('orders by score desc with a deterministic tie-break, then applies the direct limit', () => {
    const { items } = rankContext(
      [
        { ref: p('b'), similarity: 0.5 },
        { ref: p('a'), similarity: 0.5 },
        { ref: p('c'), similarity: 0.9 },
      ],
      [],
      { direct: 2, expanded: 4 },
    );
    expect(items.map((i) => i.ref.id)).toEqual(['c', 'a']);
  });

  it('reserves expansion slots: neighbours appear even when every direct hit outscores them', () => {
    // Real gte-small similarities sit in ~0.85-0.92, so parent x weight (<= 0.8) always ranks
    // below direct hits; a single cut would silently drop the graph half of the bundle.
    const hits = ['a', 'b', 'c'].map((id) => ({ ref: p(id), similarity: 0.9 }));
    const edges: Edge[] = [
      { from: p('a'), predicate: 'module_of', to: m('M'), via: 'fk:canonical_prompts.module_id' },
      { from: p('a'), predicate: 'derived_from', to: s('S'), via: 'relations:r1' },
    ];
    const { items } = rankContext(hits, edges, { direct: 3, expanded: 1 });
    expect(items.map((i) => i.ref.id)).toEqual(['a', 'b', 'c', 'M']);
  });
});
