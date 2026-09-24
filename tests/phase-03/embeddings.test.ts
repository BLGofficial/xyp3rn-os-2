import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { composePromptInput } from '../../knowledge/vector-retrieval/compose.ts';
import { EMBEDDING_DIM, EMBEDDING_MODEL, loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { asRole, createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 3 proof (part 1): real Phase 2 data gets real gte-small embeddings — no fixtures.

let db: TestDb;
let embedder: Embedder;
beforeAll(async () => {
  db = await createTestDb('phase03_embed', { migrated: true });
  const ing = await ingestSource(db.sql, {
    kind: 'file',
    path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'),
    origin: 'first_party',
  });
  expect(ing.status).toBe('success');
  embedder = await loadEmbedder();
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('embedder', () => {
  it(`is ${EMBEDDING_MODEL}, ${EMBEDDING_DIM}-dim, unit-normalized and deterministic`, async () => {
    expect(embedder.model).toBe('Supabase/gte-small');
    const [a, b] = await embedder.embed(['Tool Registry deny-by-default', 'Tool Registry deny-by-default']);
    expect(a!.vector).toHaveLength(384);
    expect(a!.vector).toEqual(b!.vector);
    expect(Math.hypot(...a!.vector)).toBeCloseTo(1, 5);
  });

  it('reports truncation instead of hiding it', async () => {
    const [long] = await embedder.embed(['word '.repeat(700)]);
    expect(long).toMatchObject({ truncated: true });
    expect(long!.tokens).toBeGreaterThan(512);
  });
});

describe('embedding pipeline', () => {
  it('embeds every canonical prompt and source, recording model + input hash + truncation', async () => {
    const stats = await embedPending(db.sql, embedder);
    expect(stats).toMatchObject({
      model: 'Supabase/gte-small',
      canonical_prompts: { embedded: 31, skipped: 0 },
      sources: { embedded: 1, skipped: 0 },
    });
    const rows = await db.sql<{ n: number }[]>`
      select count(*)::int as n from canonical_prompts
      where embedding is not null and extensions.vector_dims(embedding) = 384
        and embedding_model = 'Supabase/gte-small' and embedding_input_sha256 ~ '^[0-9a-f]{64}$'
        and embedding_truncated is not null and embedded_at is not null`;
    expect(rows[0]!.n).toBe(31);
  });

  it('is idempotent: unchanged input hash → nothing re-embedded', async () => {
    const stats = await embedPending(db.sql, embedder);
    expect(stats).toMatchObject({ canonical_prompts: { embedded: 0, skipped: 31 }, sources: { embedded: 0, skipped: 1 } });
  });

  it('embeds structure, not the raw blob: title, role, task and constraints', async () => {
    const [row] = await db.sql<{ title: string; body: string; structured: Record<string, unknown> }[]>`
      select title, body, structured from canonical_prompts where slug = 'phase-4c-tool-registry'`;
    const input = composePromptInput(row!);
    expect(input.startsWith('Phase 4C — Tool Registry\n')).toBe(true);
    expect(input).toContain('You are a Staff Platform Engineer.');
    expect(input).toMatch(/Deny-by-default/);
  });

  it('has an HNSW cosine index on both embedding columns', async () => {
    const idx = await db.sql<{ tablename: string; indexdef: string }[]>`
      select tablename, indexdef from pg_indexes where schemaname = 'public' and indexdef ilike '%hnsw%' order by 1`;
    expect(idx.map((i) => i.tablename)).toEqual(['canonical_prompts', 'sources']);
    for (const i of idx) expect(i.indexdef).toMatch(/vector_cosine_ops/);
  });
});

describe('grants', () => {
  it('xyp_embedder may write embedding columns only (content stays untouchable)', async () => {
    await asRole(db.sql, 'xyp_embedder', (tx) => tx`update canonical_prompts set embedded_at = now() where slug = 'phase-0-meta-prompt'`);
    await expectPgError(() => asRole(db.sql, 'xyp_embedder', (tx) => tx`update canonical_prompts set body = 'x'`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_embedder', (tx) => tx`update sources set title = 'x'`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_embedder', (tx) => tx`delete from canonical_prompts`), '42501');
  });

  it('xyp_runtime is read-only', async () => {
    const rows = await asRole(db.sql, 'xyp_runtime', (tx) => tx`select id from canonical_prompts`);
    expect(rows).toHaveLength(31);
    await expectPgError(() => asRole(db.sql, 'xyp_runtime', (tx) => tx`update canonical_prompts set embedded_at = now()`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_runtime', (tx) => tx`insert into tags (slug, label) values ('x', 'x')`), '42501');
  });
});
