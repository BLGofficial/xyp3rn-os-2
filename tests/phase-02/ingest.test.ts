import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../core/db/client.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 2 end-to-end proof against the one real source: the uploaded build guide PDF.

const PDF_PATH = join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf');
const PDF_BYTES = readFileSync(PDF_PATH);
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');
const AS_OF = new Date('2026-09-24T00:00:00Z');
const KNOWLEDGE_TABLES = [
  'sources',
  'modules',
  'canonical_prompts',
  'prompt_variants',
  'tags',
  'prompt_tags',
  'relations',
  'quality_reports',
];

/** Row-level fingerprint of every knowledge table: any insert/update/delete changes it. */
const fingerprint = async (sql: Sql) => {
  const out: Record<string, string> = {};
  for (const t of KNOWLEDGE_TABLES) {
    const [r] = await sql.unsafe<{ fp: string }[]>(
      `select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as fp
       from public.${t} x`,
    );
    out[t] = r!.fp;
  }
  return out;
};

const count = async (sql: Sql, table: string) =>
  (await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${table}`))[0]!.n;

describe('ingestion of the real build guide', () => {
  let db: TestDb;
  let server: Server;
  let pdfUrl: string;

  beforeAll(async () => {
    db = await createTestDb('phase02_ingest', { migrated: true });
    // Serves the same real bytes over HTTP to prove content-addressing across source kinds.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF_BYTES);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    pdfUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/build-sequence.pdf`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await db?.drop();
  });

  it('first ingest: registers the source and normalizes 19 modules + 31 prompts', async () => {
    const result = await ingestSource(db.sql, { kind: 'file', path: PDF_PATH, origin: 'first_party' }, { asOf: AS_OF });
    expect(result.status).toBe('success');
    expect(result.stats).toMatchObject({
      normalizer: 'xyp-build-sequence-v1',
      pages: 22,
      modules: { inserted: 19, reused: 0 },
      prompts: { inserted: 31, reused: 0 },
    });

    const [src] = await db.sql<{ checksum_sha256: string; kind: string; metadata: { origin: string } }[]>`
      select checksum_sha256, kind, metadata from sources`;
    expect(src).toMatchObject({ checksum_sha256: PDF_SHA, kind: 'file', metadata: { origin: 'first_party' } });

    expect(await count(db.sql, 'modules')).toBe(19);
    expect(await count(db.sql, 'canonical_prompts')).toBe(31);
    // F1: every canonical row is marked bootstrap and traces to the source
    expect(
      await db.sql`select 1 from canonical_prompts where promoted_via <> 'bootstrap' or source_id is null`,
    ).toHaveLength(0);
    expect(await db.sql`select 1 from modules where promoted_via <> 'bootstrap' or source_id is null`).toHaveLength(0);
    expect(await db.sql`select 1 from relations_dangling`).toHaveLength(0);

    const [run] = await db.sql<{ status: string; completed_at: Date | null }[]>`
      select status, completed_at from ingestion_runs where id = ${result.runId}`;
    expect(run!.status).toBe('success');
    expect(run!.completed_at).not.toBeNull();
  });

  it('scores the source and every prompt with the 0.5/0.3/0.2 rubric, inputs attached', async () => {
    expect(await count(db.sql, 'quality_reports')).toBe(1 + 31);
    const [r] = await db.sql<{ overall: string; criteria: { name: string; weight: number; score: number; inputs: Record<string, unknown> }[] }[]>`
      select overall, criteria from quality_reports where source_id is not null`;
    expect(r!.criteria.map((c) => [c.name, c.weight])).toEqual([
      ['completeness', 0.5],
      ['source_reliability', 0.3],
      ['freshness', 0.2],
    ]);
    const [completeness, reliability, freshness] = r!.criteria;
    expect(completeness!.score).toBe(1); // all 21 TOC entries parsed
    expect(reliability!.score).toBe(1); // first-party file
    expect(freshness!.inputs).toMatchObject({ document_date: '2026-09-01', age_days: 23 });
    const expected = 0.5 * 1 + 0.3 * 1 + 0.2 * (1 - 23 / 365);
    expect(Number(r!.overall)).toBeCloseTo(expected, 4);
  });

  it('re-ingest of the unchanged file is a no-op: knowledge tables byte-identical, run logged as noop', async () => {
    const before = await fingerprint(db.sql);
    const runsBefore = await count(db.sql, 'ingestion_runs');
    const result = await ingestSource(db.sql, { kind: 'file', path: PDF_PATH, origin: 'first_party' }, { asOf: AS_OF });
    expect(result.status).toBe('noop');
    expect(await fingerprint(db.sql)).toEqual(before);
    expect(await count(db.sql, 'ingestion_runs')).toBe(runsBefore + 1);
  });

  it('the same bytes fetched by URL are the same source (content-addressed) → noop', async () => {
    const before = await fingerprint(db.sql);
    const result = await ingestSource(db.sql, { kind: 'url', url: pdfUrl, origin: 'first_party' }, { asOf: AS_OF });
    expect(result.status).toBe('noop');
    expect(await fingerprint(db.sql)).toEqual(before);
  });

  it('a source no normalizer understands fails loudly and writes nothing but its error run', async () => {
    const before = await fingerprint(db.sql);
    const result = await ingestSource(
      db.sql,
      { kind: 'manual', title: 'Studio note', text: 'Kick at -6 dBFS before the limiter.', origin: 'first_party' },
      { asOf: AS_OF },
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no normalizer/i);
    expect(await fingerprint(db.sql)).toEqual(before);
    const [run] = await db.sql<{ status: string; error_detail: string }[]>`
      select status, error_detail from ingestion_runs where id = ${result.runId}`;
    expect(run).toMatchObject({ status: 'error', error_detail: expect.stringMatching(/no normalizer/i) });
  });

  it('never leaves a run in running state', async () => {
    expect(await db.sql`select 1 from ingestion_runs where status = 'running'`).toHaveLength(0);
  });
});

describe('race: two concurrent ingestions of the same bytes', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb('phase02_race', { migrated: true });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('collapse to one source + one normalization: one success, one noop', async () => {
    const input = { kind: 'file', path: PDF_PATH, origin: 'first_party' } as const;
    const results = await Promise.all([
      ingestSource(db.sql, input, { asOf: AS_OF }),
      ingestSource(db.sql, input, { asOf: AS_OF }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['noop', 'success']);
    // Prove the runs genuinely overlapped (not accidentally sequential): each started before
    // the other finished.
    const [a, b] = await db.sql<{ started_at: Date; completed_at: Date }[]>`
      select started_at, completed_at from ingestion_runs order by started_at`;
    expect(b!.started_at.getTime()).toBeLessThan(a!.completed_at.getTime());
    expect(await count(db.sql, 'sources')).toBe(1);
    expect(await count(db.sql, 'modules')).toBe(19);
    expect(await count(db.sql, 'canonical_prompts')).toBe(31);
    expect(await count(db.sql, 'quality_reports')).toBe(32);
  });
});
