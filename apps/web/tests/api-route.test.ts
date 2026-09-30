import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskResult, RunnablePlan } from '../../../core/orchestrator/ask';

// No DB: the session lookup and the entrypoint run are stubbed. The permission check, planner,
// reply formatting, reference extraction, job store and dedup are real.
vi.mock('../lib/db', () => ({ sql: {} }));
vi.mock('../../../core/runtime/deps', () => ({ createRuntimeDeps: () => ({}) }));
const run = vi.hoisted(() => ({ impl: null as null | ((plan: RunnablePlan) => Promise<AskResult>), calls: [] as { plan: RunnablePlan; projectSlug?: string }[] }));
vi.mock('../../../core/orchestrator/ask', async (actual) => ({
  ...(await actual<typeof import('../../../core/orchestrator/ask')>()),
  runPlan: (_deps: unknown, plan: RunnablePlan, options: { projectSlug?: string }) => { run.calls.push({ plan, projectSlug: options.projectSlug }); return run.impl!(plan); },
}));
const users: Record<string, { id: string; name: string; role: string; permissions: string[] }> = {
  operator: { id: 'u1', name: 'op', role: 'operator', permissions: ['system.read', 'runtime.execute'] },
  operator2: { id: 'u2', name: 'op2', role: 'operator', permissions: ['system.read', 'runtime.execute'] },
  viewer: { id: 'u3', name: 'v', role: 'viewer', permissions: ['system.read'] },
};
vi.mock('../../../governance/auth', async (actual) => ({
  ...(await actual<typeof import('../../../governance/auth')>()),
  authenticate: async (_sql: unknown, token: string) => users[token] ?? null,
}));
const { GET, POST } = await import('../app/api/[...path]/route');

const base = 'http://127.0.0.1:3000';
const ask = (body: Record<string, unknown>, { token = 'operator', origin = base } = {}) =>
  POST(new NextRequest(`${base}/api/ask`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3000', origin, cookie: `mercury_session=${token}` },
  }));
const status = (requestId: string, token = 'operator') => GET(new NextRequest(`${base}/api/ask/${requestId}`, { headers: { cookie: `mercury_session=${token}` } }));
const until = async (requestId: string, token = 'operator') => { for (let i = 0; i < 50; i++) { const b = await (await status(requestId, token)).json(); if (b.state === 'done') return b; await new Promise(r => setTimeout(r, 10)); } throw new Error('still running'); };
const RECORDS = 'Write a hook and two verses for the new X3LIUS track';
// F2: with LLM_ENGINE unset (this suite's default), the engine is off, so the spoken-skill wording
// this text would otherwise trigger (tier 1) is no longer recognised: it goes through planRequest.
const RESEARCH = 'Research the best current method for controlling dark baritone vocals in Suno.';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = { selected: [], evidence: [] } as never;
let release: () => void;
beforeEach(() => { run.calls = []; run.impl = null; });

describe('GET /api/session: exposes the claude-code engine flag (F2)', () => {
  it('reports engine: true only when LLM_ENGINE=claude-code', async () => {
    const saved = process.env.LLM_ENGINE;
    try {
      delete process.env.LLM_ENGINE;
      const off = await GET(new NextRequest(`${base}/api/session`, { headers: { cookie: 'mercury_session=operator' } }));
      expect(await off.json()).toMatchObject({ engine: false });
      process.env.LLM_ENGINE = 'claude-code';
      const on = await GET(new NextRequest(`${base}/api/session`, { headers: { cookie: 'mercury_session=operator' } }));
      expect(await on.json()).toMatchObject({ engine: true });
    } finally {
      if (saved === undefined) delete process.env.LLM_ENGINE; else process.env.LLM_ENGINE = saved;
    }
  });
});

describe('POST /api/ask: access and validation', () => {
  it('denies cross-origin, anonymous and non-runtime roles before planning or running', async () => {
    expect((await ask({ request: RECORDS, requestId: randomUUID() }, { origin: 'http://evil.test' })).status).toBe(403);
    expect((await ask({ request: RECORDS, requestId: randomUUID() }, { token: 'none' })).status).toBe(401);
    expect((await ask({ request: RECORDS, requestId: randomUUID() }, { token: 'viewer' })).status).toBe(403);
    expect((await status(randomUUID(), 'viewer')).status).toBe(403);
    expect((await status(randomUUID(), 'none')).status).toBe(401);
    expect(run.calls).toHaveLength(0);
  });

  it('validates request text, request id and project slug', async () => {
    const ok = { request: RECORDS, requestId: randomUUID() };
    for (const body of [{ ...ok, request: '' }, { ...ok, request: '  ' }, { ...ok, request: 'x'.repeat(4001) }, { ...ok, request: 7 }, { request: RECORDS },
      { ...ok, requestId: 'abc' }, { ...ok, requestId: '../../etc' }, { ...ok, projectSlug: 'Bad Slug' }, { ...ok, projectSlug: '../x' }, { ...ok, projectSlug: 3 }]) {
      expect((await ask(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(run.calls).toHaveLength(0);
  });
});

describe('POST /api/ask: outcomes grounded in real results', () => {
  it('returns clarification and hold immediately, without running anything', async () => {
    const clarify = await ask({ request: 'zzz qqq', requestId: randomUUID() });
    expect(clarify.status).toBe(200);
    expect(await clarify.json()).toMatchObject({ state: 'done', action: 'clarify', status: 'clarify', reply: 'Needs clarification: no domain matched; rephrase with domain terms.' });
    const hold = await (await ask({ request: 'Audit the approval policy and access roles for governance compliance', requestId: randomUUID() })).json();
    expect(hold).toMatchObject({ state: 'done', action: 'hold', route: { domain: 'GOVERNANCE' } });
    expect(run.calls).toHaveLength(0);
  });

  it('reports running until done, then success with run ids, artifacts and required approvals (ids only)', async () => {
    run.impl = () => new Promise(res => { release = () => res({ kind: 'music', result: { status: 'success', selected: ['release'], selection, workflowRunId: uuid(9),
      outputs: { release: { artifact: { id: uuid(1), systemPrompt: 'INTERNAL PROMPT' }, schedule: { approvalId: uuid(2), payload: 'PRIVATE TOOL PAYLOAD' } } } } }); });
    const requestId = randomUUID();
    const started = await ask({ request: RECORDS, requestId, projectSlug: 'x3lius-album' });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ state: 'running', status: 'running', reply: 'Working. The run is still in progress.' });
    expect(await (await status(requestId)).json()).toMatchObject({ state: 'running' });
    release();
    const done = await until(requestId);
    expect(done).toMatchObject({ state: 'done', status: 'success', approvalRequired: true,
      reply: 'X3LIUS music system finished. Sub-domains: release. Approval required: 1 item(s) pending in Governance.',
      refs: { workflowRunId: uuid(9), artifactIds: [uuid(1)], approvalIds: [uuid(2)], agentRunIds: [] } });
    expect(JSON.stringify(done)).not.toMatch(/INTERNAL PROMPT|PRIVATE TOOL PAYLOAD/);
    expect(run.calls).toEqual([expect.objectContaining({ projectSlug: 'x3lius-album' })]);
  });

  it('reports a failed run without raw error text, and never retries a thrown run', async () => {
    run.impl = async () => ({ kind: 'research', result: { researchRunId: uuid(5), status: 'error', selected: [], workflowRunId: null, error: 'specialist step vocal-analyst failed: anthropic API error 401: key sk-live-SECRET' } });
    const a = randomUUID(); await ask({ request: RESEARCH, requestId: a });
    const failed = await until(a);
    expect(failed).toMatchObject({ status: 'error', reply: `Research run failed at specialist vocal-analyst. Details are on research run ${uuid(5)}.`, refs: { researchRunId: uuid(5) } });
    expect(JSON.stringify(failed)).not.toContain('SECRET');

    run.impl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432 password=hunter2'); };
    const b = randomUUID(); await ask({ request: RESEARCH, requestId: b });
    const thrown = await until(b);
    expect(thrown).toMatchObject({ state: 'done', status: 'error', reply: 'The request failed before completing. It was not retried; check Live Events for any runs it started.' });
    expect(JSON.stringify(thrown)).not.toContain('hunter2');
    expect(run.calls).toHaveLength(2); // one call per request: no automatic retry
  });
});

describe('POST /api/ask: identity-scoped deduplication', () => {
  it('runs a repeated submission once, rejects id reuse for other text, and scopes ids per user', async () => {
    run.impl = () => new Promise(res => { release = () => res({ kind: 'music', result: { status: 'success', selected: ['lyrics'], selection, workflowRunId: uuid(7), outputs: {} } }); });
    const requestId = randomUUID();
    expect((await ask({ request: RECORDS, requestId })).status).toBe(202);
    const dup = await ask({ request: RECORDS, requestId });
    expect(dup.status).toBe(202);
    expect(await dup.json()).toMatchObject({ duplicate: true, state: 'running' });
    expect((await ask({ request: 'Write a chorus for the X3LIUS track', requestId })).status).toBe(409);
    expect((await status(requestId, 'operator2')).status).toBe(404); // another user cannot see it
    release(); await until(requestId);
    const after = await ask({ request: RECORDS, requestId });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ duplicate: true, state: 'done', status: 'success' });
    expect(run.calls).toHaveLength(1);

    run.impl = async () => ({ kind: 'music', result: { status: 'success', selected: ['lyrics'], selection, workflowRunId: uuid(8), outputs: {} } });
    expect((await ask({ request: RECORDS, requestId }, { token: 'operator2' })).status).toBe(202); // same id, other identity: its own run
    await until(requestId, 'operator2');
    expect(run.calls).toHaveLength(2);
  });

  it('caps concurrent runs per user', async () => {
    run.impl = () => new Promise(() => {}); // never finishes
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await ask({ request: RECORDS, requestId: randomUUID() }, { token: 'operator2' })).status);
    expect(codes).toEqual([202, 202, 429]);
  });
});

describe('pnpm ask CLI: original behavior preserved', () => {
  const cli = join(import.meta.dirname, '../../../core/orchestrator/ask-cli.ts');
  const runCli = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args]).then(r => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
  it('prints route + clarify (exit 1), hold (exit 0), usage (exit 2)', async () => {
    const clarify = await runCli('zzz qqq');
    expect(clarify.code).toBe(1);
    expect(clarify.stdout).toContain('route: {"status":"unroutable"');
    expect(clarify.stdout).toContain('clarify: no domain matched; rephrase with domain terms');
    const hold = await runCli('Audit the approval policy and access roles for governance compliance');
    expect(hold.code).toBe(0);
    expect(hold.stdout).toContain('hold: no entrypoint registered for GOVERNANCE');
    const usage = await runCli();
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('usage: ask-cli.ts');
  });
});
