import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContextEngine, type ContextBundle, type ContextEngine } from '../../core/context-engine/context-engine.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 3 proof (part 2): retrieval over the real ingested build guide. Every item must trace
// back to a row and carry its score + the reason it was included.

let db: TestDb;
let engine: ContextEngine;
beforeAll(async () => {
  db = await createTestDb('phase03_context', { migrated: true });
  await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  const embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  engine = createContextEngine(db.sql, embedder);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const direct = (b: ContextBundle) => b.items.filter((i) => i.reasons.some((r) => r.kind === 'vector'));

describe('ranked retrieval on real data', () => {
  it.each([
    ['Tool Registry authorization, deny-by-default for unregistered tools', 'phase-4c-tool-registry'],
    ['assemble a Suno-ready prompt from songwriting and lyrics output', 'phase-9-meta-prompt'],
    ['append-only audit log joined to knowledge_versions and human approver', 'phase-15-meta-prompt'],
  ])('"%s" → %s among the top 3 direct hits', async (query, expected) => {
    const bundle = await engine.retrieve(query);
    expect(direct(bundle).slice(0, 3).map((i) => i.slug)).toContain(expected);
  });

  it('every item traces to a real row, with score, reasons and its source', async () => {
    const bundle = await engine.retrieve('knowledge promotion gate canonical write enforcement');
    expect(bundle.items.length).toBeGreaterThan(0);
    for (const item of bundle.items) {
      expect(['canonical_prompts', 'modules', 'sources']).toContain(item.ref.table);
      const [row] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${item.ref.table} where id = $1`, [item.ref.id]);
      expect(row!.n, `${item.ref.table}:${item.ref.id} must exist`).toBe(1);
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(item.reasons.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
      expect(item.source?.uri).toBe('XYP3RN_Agentic_OS_Build_Sequence.pdf');
    }
    const scores = bundle.items.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('adds 1-hop graph neighbours whose score is exactly parent x weight', async () => {
    const bundle = await engine.retrieve('Agent Registry scanner validator for agent.md frontmatter');
    const expanded = bundle.items.flatMap((i) => i.reasons.filter((r) => r.kind === 'graph').map((r) => ({ i, r })));
    expect(expanded.length).toBeGreaterThan(0);
    for (const { i, r } of expanded) {
      if (r.kind !== 'graph') continue;
      expect(i.score).toBeGreaterThanOrEqual(r.parentScore * r.weight - 1e-12);
      expect(r.via).toMatch(/^(relations:[0-9a-f-]{36}|fk:canonical_prompts\.module_id)$/);
    }
    for (const i of bundle.items) {
      expect(i.score).toBe(Math.max(...i.reasons.map((r) => (r.kind === 'vector' ? r.similarity : r.parentScore * r.weight))));
    }
  });

  it("reaches 4B's module (via FK) and its sequence neighbours (via precedes) in one hop", async () => {
    // Which neighbours survive the default quota of 4 depends on the exact similarity of the
    // lowest direct hits, which varies with the ONNX runtime build (Linux vs Windows). Lift the
    // quota so this checks expansion itself; the quota cut is unit-tested in rank.test.ts.
    const bundle = await engine.retrieve('Agent Registry scanner validator for agent.md frontmatter', { limits: { direct: 8, expanded: 1000 } });
    const hit = bundle.items.find((i) => i.slug === 'phase-4b-agent-registry');
    expect(hit?.reasons.some((r) => r.kind === 'vector')).toBe(true);
    const from4b = (slug: string) =>
      bundle.items.find((i) => i.slug === slug)?.reasons.find((r) => r.kind === 'graph' && r.parent.id === hit!.ref.id);
    expect(from4b('phase-4-agent-runtime-registry')).toMatchObject({ predicate: 'module_of', direction: 'out', weight: 0.6, via: 'fk:canonical_prompts.module_id' });
    expect(from4b('phase-4a-agent-runs-schema')).toMatchObject({ predicate: 'precedes', direction: 'in', via: expect.stringMatching(/^relations:/) });
    expect(from4b('phase-4c-tool-registry')).toMatchObject({ predicate: 'precedes', direction: 'out', via: expect.stringMatching(/^relations:/) });
  });
});

describe('cache (LRU 256 / 15 min, keyed on knowledge generation)', () => {
  it('serves a repeated query from cache with identical items', async () => {
    const q = 'workflow engine declarative DAG spec';
    const first = await engine.retrieve(q);
    const second = await engine.retrieve(q);
    expect(second.cache).toBe('hit');
    expect(second.items).toEqual(first.items);
    expect(second.generation).toBe(first.generation);
  });

  it('misses after any knowledge write changes the generation (no stale context)', async () => {
    const q = 'orchestrator routing by domain';
    const first = await engine.retrieve(q);
    await db.sql`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
                 select 'module', m.id::text, 'cites', 'source', s.id::text from modules m, sources s
                 where m.slug = 'phase-5-workflow-orchestration-engine' limit 1`;
    const after = await engine.retrieve(q);
    expect(after.cache).toBe('miss');
    expect(after.generation).not.toBe(first.generation);
  });
});
