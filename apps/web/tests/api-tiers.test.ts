import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskResult, RunnablePlan } from '../../../core/orchestrator/ask';

vi.mock('../lib/db', () => ({ sql: {} }));
vi.mock('../../../core/runtime/deps', () => ({ createRuntimeDeps: () => ({}) }));
type HeadlessOutcome = { ok: boolean; reply: string; sessionId?: string };
const cli = vi.hoisted(() => ({
  calls: [] as { kind: string; skill?: string; text: string; signal?: AbortSignal }[],
  hold: false,
  deferred: null as null | { promise: Promise<HeadlessOutcome> },
}));
vi.mock('../lib/claude-headless', () => {
  const wait = (signal?: AbortSignal) => new Promise<void>((res, rej) => { if (!cli.hold) return res(); signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
  return {
    runSkill: async (skill: string, text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'skill', skill, text, signal: o.signal }); if (cli.deferred) return cli.deferred.promise; await wait(o.signal); return { ok: true, reply: `ran ${skill}`, sessionId: 's1' }; },
    runDeep: async (text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'deep', text, signal: o.signal }); if (cli.deferred) return cli.deferred.promise; await wait(o.signal); return { ok: true, reply: 'deep done', sessionId: 's2' }; },
  };
});
const lookup = vi.hoisted(() => ({ calls: [] as string[], throwError: null as Error | null, hold: null as null | Promise<void> }));
vi.mock('../../../core/orchestrator/lookup', () => ({
  answerLookup: async (_sql: unknown, q: string) => {
    lookup.calls.push(q);
    if (lookup.hold) await lookup.hold;
    if (lookup.throwError) throw lookup.throwError;
    return { reply: 'Nothing stored yet about that.', source: 'none' };
  },
  summarizerFromEnv: () => undefined,
}));
const run = vi.hoisted(() => ({ impl: null as null | (() => Promise<AskResult>) }));
vi.mock('../../../core/orchestrator/ask', async (actual) => ({
  ...(await actual<typeof import('../../../core/orchestrator/ask')>()),
  runPlan: (_deps: unknown, _plan: RunnablePlan, _options: { projectSlug?: string }) => run.impl!(),
}));
vi.mock('../../../governance/auth', async (actual) => ({
  ...(await actual<typeof import('../../../governance/auth')>()),
  authenticate: async (_sql: unknown, token: string) => (token === 'operator' ? { id: 'u1', name: 'op', role: 'operator', permissions: ['system.read', 'runtime.execute'] } : token === 'viewer' ? { id: 'u3', name: 'v', role: 'viewer', permissions: ['system.read'] } : null),
}));
const { GET, POST } = await import('../app/api/[...path]/route');

const base = 'http://127.0.0.1:3000';
const headers = (token: string) => ({ 'content-type': 'application/json', host: '127.0.0.1:3000', origin: base, cookie: `mercury_session=${token}` });
const ask = (body: Record<string, unknown>, token = 'operator') => POST(new NextRequest(`${base}/api/ask`, { method: 'POST', body: JSON.stringify(body), headers: headers(token) }));
const cancel = (id: string, token = 'operator') => POST(new NextRequest(`${base}/api/ask/${id}/cancel`, { method: 'POST', body: '{}', headers: headers(token) }));
const status = (id: string) => GET(new NextRequest(`${base}/api/ask/${id}`, { headers: { cookie: 'mercury_session=operator' } }));
const until = async (id: string) => { for (let i = 0; i < 50; i++) { const b = await (await status(id)).json(); if (b.state === 'done') return b; await new Promise(r => setTimeout(r, 10)); } throw new Error('still running'); };
const untilCalled = async () => { for (let i = 0; i < 50 && lookup.calls.length === 0; i++) await new Promise(r => setTimeout(r, 5)); };
beforeEach(() => { cli.calls = []; cli.hold = false; cli.deferred = null; lookup.calls = []; lookup.throwError = null; lookup.hold = null; run.impl = null; });

describe('POST /api/ask tiers', () => {
  it('tier 1: button skill and spoken skill run the skill with the session id', async () => {
    const id = randomUUID();
    expect((await ask({ request: 'dark vocals', requestId: id, skill: 'xyp-research' })).status).toBe(202);
    expect(await until(id)).toMatchObject({ action: 'skill', status: 'success', reply: 'ran xyp-research', sessionId: 's1' });
    const id2 = randomUUID();
    await ask({ request: 'music, write a verse', requestId: id2 });
    await until(id2);
    expect(cli.calls.map(c => [c.skill, c.text])).toEqual([['xyp-research', 'dark vocals'], ['xyp-music', 'write a verse']]);
  });

  it('rejects an unknown skill name without running anything', async () => {
    expect((await ask({ request: 'x', requestId: randomUUID(), skill: '../../evil' })).status).toBe(400);
    expect(cli.calls).toHaveLength(0);
  });

  it('tier 2: answers immediately from lookup, starts nothing', async () => {
    const r = await ask({ request: 'What did the latest research find?', requestId: randomUUID() });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: 'done', action: 'lookup', reply: 'Nothing stored yet about that.' });
    expect(lookup.calls).toEqual(['What did the latest research find?']);
    expect(cli.calls).toHaveLength(0);
  });

  it('tier 2: a lookup error never leaks the underlying error text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      lookup.throwError = new Error('SECRET MODEL TEXT');
      const r = await ask({ request: 'What did the latest research find?', requestId: randomUUID() });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ state: 'done', action: 'lookup', status: 'error', reply: 'Could not read stored data right now. Try again, or send it as a normal request.' });
      expect(JSON.stringify(body)).not.toContain('SECRET MODEL TEXT');
      // The underlying text is logged server-side only, never returned to the client.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mercury api lookup'), 'SECRET MODEL TEXT');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('tier 2: a lookup awaiting its answer never overwrites a job a concurrent deep request already claimed', async () => {
    cli.hold = true;
    let release!: () => void;
    lookup.hold = new Promise<void>((res) => { release = res; });
    const id = randomUUID();
    const lookupPromise = ask({ request: 'What did the latest research find?', requestId: id });
    await untilCalled();
    expect(lookup.calls).toEqual(['What did the latest research find?']);
    expect((await ask({ request: 'plan the release', requestId: id, deep: true })).status).toBe(202);
    expect(await status(id).then(r => r.json())).toMatchObject({ state: 'running', action: 'deep' });
    release();
    expect((await lookupPromise).status).toBe(409);
    // The deep job the concurrent request registered is untouched: still running, still cancellable.
    expect(await status(id).then(r => r.json())).toMatchObject({ state: 'running', action: 'deep' });
    expect((await cancel(id)).status).toBe(200);
  });

  it('tier 3: one deep job at a time, cancel aborts it, other users cannot cancel', async () => {
    cli.hold = true;
    const id = randomUUID();
    expect((await ask({ request: 'plan the release', requestId: id, deep: true })).status).toBe(202);
    expect((await ask({ request: 'Claude, another', requestId: randomUUID() })).status).toBe(429);
    expect((await cancel(id, 'viewer')).status).toBe(403);
    expect((await cancel(randomUUID())).status).toBe(404);
    expect((await cancel(id)).status).toBe(200);
    expect(cli.calls[0]!.signal!.aborted).toBe(true);
    expect(await until(id)).toMatchObject({ state: 'done', status: 'cancelled' });
    expect((await cancel(id)).status).toBe(404);
  });

  it('a cancelled deep job ignores a late resolution from the underlying run', async () => {
    let resolveLate!: (v: HeadlessOutcome) => void;
    cli.deferred = { promise: new Promise<HeadlessOutcome>((res) => { resolveLate = res; }) };
    const id = randomUUID();
    expect((await ask({ request: 'plan the release', requestId: id, deep: true })).status).toBe(202);
    expect((await cancel(id)).status).toBe(200);
    resolveLate({ ok: true, reply: 'late' });
    await new Promise((r) => setTimeout(r, 20)); // let the late .then callback, if any, run
    const body = await status(id).then(r => r.json());
    expect(body).toMatchObject({ state: 'done', status: 'cancelled' });
    expect(body.reply).not.toBe('late');
  });

  it('cancelling a running plan job is refused: it would free the slot while runPlan kept going', async () => {
    run.impl = () => new Promise(() => {}); // never resolves, as if still running
    const id = randomUUID();
    expect((await ask({ request: 'Write a hook and two verses for the new X3LIUS track', requestId: id })).status).toBe(202);
    expect((await status(id).then(r => r.json()))).toMatchObject({ state: 'running', action: 'run-service' });
    expect((await cancel(id)).status).toBe(409);
    expect(await status(id).then(r => r.json())).toMatchObject({ state: 'running' });
  });

  it('keeps the planRequest path for everything else', async () => {
    const r = await ask({ request: 'zzz qqq', requestId: randomUUID() });
    expect(await r.json()).toMatchObject({ action: 'clarify' });
    expect(cli.calls).toHaveLength(0);
  });
});
