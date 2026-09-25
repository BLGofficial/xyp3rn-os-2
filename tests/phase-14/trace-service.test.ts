import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { validateTraceReport, type TraceReport } from '../../tech/trace/report.ts';
import { startTraceServer, type TraceServer } from '../../tech/trace/server.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { insertTake } from '../helpers/records-fixture.ts';
import { ANALYSIS, RUBRIC } from '../helpers/trace-fixture.ts';

// Phase 14 proof (part 3): the TRACE API surface. A real HTTP server (port 0, 127.0.0.1) over a
// throwaway database holding the X3LIUS manifest and a [FIXTURE] mix rubric admitted through the
// gate. Every request goes over the wire; nothing here calls the handlers directly.

const TOKEN = 'fixture-token-0123456789abcdef';
let db: TestDb;
let dir: string;
let server: TraceServer;

beforeAll(async () => {
  db = await createTestDb('phase14_trace_service', { migrated: true });
  dir = mkdtempSync(join(tmpdir(), 'phase14-'));
  const rubric = join(dir, 'mix-rubric.fixture.yaml');
  writeFileSync(rubric, RUBRIC());
  for (const path of [MUSIC_SYSTEM_MANIFEST, rubric]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  const deps: DispatchDeps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
  server = await startTraceServer({ deps, token: TOKEN, port: 0 });
});
afterAll(async () => {
  await server?.close();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: { method?: string; body?: string; token?: string | null; type?: string } = {}) =>
  fetch(`${server.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
      ...(init.body !== undefined ? { 'content-type': init.type ?? 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
const post = (body: unknown, query = '', init: { token?: string | null; type?: string } = {}) =>
  call(`/v1/trace/analyses${query}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
const count = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from trace_analyses`)[0]!.n;

describe('the service boundary', () => {
  it('binds 127.0.0.1 by default and refuses to start without a token of at least 16 characters', async () => {
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    const deps = { sql: db.sql } as unknown as DispatchDeps;
    await expect(startTraceServer({ deps, token: '', port: 0 })).rejects.toThrow(/XYP_TRACE_TOKEN/);
    await expect(startTraceServer({ deps, token: 'short', port: 0 })).rejects.toThrow(/at least 16/);
  });

  it('health answers without a token and names both contract versions', async () => {
    const r = await call('/v1/trace/health', { token: null });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', contracts: ['trace.analysis/v1', 'trace.report/v1'] });
  });

  it('401 without the bearer token or with a wrong one; 415 for a non-JSON body; 413 over the size limit; 404 elsewhere', async () => {
    expect((await post(ANALYSIS, '', { token: null })).status).toBe(401);
    expect((await post(ANALYSIS, '', { token: 'wrong-token-0123456789' })).status).toBe(401);
    expect((await call('/v1/trace/analyses/22222222-2222-4222-8222-222222222222', { token: null })).status).toBe(401);
    expect((await post('stereo is wide', '', { type: 'text/plain' })).status).toBe(415);
    expect((await post(`{"pad":"${'x'.repeat(300 * 1024)}"}`)).status).toBe(413);
    expect((await call('/v1/other')).status).toBe(404);
    expect((await call('/v1/trace/analyses', { method: 'DELETE' })).status).toBe(404);
  });

  it('400 with every violation for an invalid analysis, and nothing is stored', async () => {
    const before = await count();
    const r = await post({ ...ANALYSIS, stereo: { ...ANALYSIS.stereo, correlation: 3 }, loudness: undefined });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; violations: string[] };
    expect(body.error).toMatch(/trace\.analysis\/v1/);
    expect(body.violations.join('\n')).toMatch(/loudness is required/);
    expect((await post('{"schema": ')).status).toBe(400);
    expect(await count()).toBe(before);
  });
});

describe('POST /v1/trace/analyses: record → check against the canonical rubric → link → trace.report/v1', () => {
  it('201 with a valid report; the analysis, the mix report and their link are rows', async () => {
    const r = await post(ANALYSIS);
    expect(r.status).toBe(201);
    const report = (await r.json()) as TraceReport;
    expect(validateTraceReport(report)).toEqual([]);
    expect(report.subject).toEqual({ stage: ANALYSIS.subject.stage, label: ANALYSIS.subject.label });
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => /^canonical_prompts:[0-9a-f-]{36}#x3lius\./.test(c.ref))).toBe(true);
    const [row] = await db.sql<{ body: unknown; mix_report_artifact_id: string; take_id: string | null }[]>`
      select body, mix_report_artifact_id, take_id from trace_analyses where id = ${report.analysisId}`;
    expect(row).toEqual({ body: ANALYSIS, mix_report_artifact_id: report.mixReportArtifactId, take_id: null });
    const [artifact] = await db.sql<{ schema_id: string; checks: unknown }[]>`
      select schema_id, body->'checks' as checks from creative_artifacts where id = ${report.mixReportArtifactId}`;
    expect(artifact).toEqual({ schema_id: 'x3lius.mix-report/v1', checks: report.checks });
    const steps = await db.sql<{ step_id: string; agent_name: string }[]>`
      select step_id, agent_name from agent_runs where workflow_run_id = (select workflow_run_id from agent_runs where id = (select agent_run_id from trace_analyses where id = ${report.analysisId}))
      order by created_at`;
    expect(steps).toEqual([
      { step_id: 'record', agent_name: 'tech-audio-tools' },
      { step_id: 'check', agent_name: 'x3lius-mix-master' },
      { step_id: 'link', agent_name: 'tech-audio-tools' },
    ]);

    const again = await call(`/v1/trace/analyses/${report.analysisId}`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(report);
    expect((await call('/v1/trace/analyses/22222222-2222-4222-8222-222222222222')).status).toBe(404);
    expect((await call('/v1/trace/analyses/not-a-uuid')).status).toBe(404);
  });

  it('records the Suno take a render came from; an unknown take fails the record step (422) and stores nothing', async () => {
    const { takeId } = await insertTake(db.sql);
    const r = await post(ANALYSIS, `?takeId=${takeId}`);
    expect(r.status).toBe(201);
    const { analysisId } = (await r.json()) as TraceReport;
    expect(await db.sql`select take_id from trace_analyses where id = ${analysisId}`).toEqual([{ take_id: takeId }]);
    const before = await count();
    const bad = await post(ANALYSIS, '?takeId=00000000-0000-4000-8000-000000000000');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ failedStep: 'record' });
    expect(await count()).toBe(before);
    expect((await post(ANALYSIS, '?takeId=nope')).status).toBe(400);
  });
});
