import { describe, expect, it } from 'vitest';
import { createLongTermMemory, createRunMemory, resolveBindings } from './memory.ts';

describe('short-term memory (one workflow run, in-process, discarded at run end)', () => {
  it('recalls a step output by path', () => {
    const m = createRunMemory({ query: 'q' });
    m.remember('retrieve', { items: [{ slug: 'a' }, { slug: 'b' }] });
    expect(m.recall('input.query')).toBe('q');
    expect(m.recall('steps.retrieve.output.items')).toEqual([{ slug: 'a' }, { slug: 'b' }]);
    expect(m.recall('steps.retrieve.output.items.1.slug')).toBe('b');
  });

  it('fails loudly on a path that does not exist (no silent undefined)', () => {
    const m = createRunMemory({ query: 'q' });
    expect(() => m.recall('steps.retrieve.output.items')).toThrow(/no output recorded for step retrieve/);
    m.remember('retrieve', { items: [] });
    expect(() => m.recall('steps.retrieve.output.missing')).toThrow(/path steps\.retrieve\.output\.missing does not resolve/);
  });

  it('is isolated per run and write-once per step', () => {
    const a = createRunMemory({});
    const b = createRunMemory({});
    a.remember('s', 1);
    expect(() => b.recall('steps.s.output')).toThrow();
    expect(() => a.remember('s', 2)).toThrow(/step s already has an output/);
  });

  it('resolves $from bindings inside nested inputs', () => {
    const m = createRunMemory({ query: 'dark baritone' });
    m.remember('retrieve', { items: [1, 2] });
    expect(resolveBindings({ q: { $from: 'input.query' }, nested: { items: { $from: 'steps.retrieve.output.items' }, k: 3 } }, m)).toEqual({
      q: 'dark baritone',
      nested: { items: [1, 2], k: 3 },
    });
  });
});

describe('long-term memory (delegates to the Phase 3 Context Engine; read-only)', () => {
  it('exposes recall only — there is no write path into long-term memory', async () => {
    const calls: string[] = [];
    const ltm = createLongTermMemory({
      retrieve: async (query) => {
        calls.push(query);
        return { query, items: [] } as never;
      },
    });
    expect(Object.keys(ltm)).toEqual(['recall']);
    await ltm.recall('suno vocal rules');
    expect(calls).toEqual(['suno vocal rules']);
  });
});
