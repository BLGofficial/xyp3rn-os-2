import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db', () => ({ sql: {} }));
vi.mock('../../../core/runtime/deps', () => ({ createRuntimeDeps: () => ({}) }));
const cli = vi.hoisted(() => ({ calls: [] as { kind: string; skill?: string; text: string; signal?: AbortSignal }[], hold: false }));
vi.mock('../lib/claude-headless', () => {
  const wait = (signal?: AbortSignal) => new Promise<void>((res, rej) => { if (!cli.hold) return res(); signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
  return {
    runSkill: async (skill: string, text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'skill', skill, text, signal: o.signal }); await wait(o.signal); return { ok: true, reply: `ran ${skill}`, sessionId: 's1' }; },
    runDeep: async (text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'deep', text, signal: o.signal }); await wait(o.signal); return { ok: true, reply: 'deep done', sessionId: 's2' }; },
  };
});
const lookup = vi.hoisted(() => ({ calls: [] as string[], throwError: null as Error | null }));
vi.mock('../../../core/orchestrator/lookup', () => ({ answerLookup: async (_sql: unknown, q: string) => { lookup.calls.push(q); if (lookup.throwError) throw lookup.throwError; return { reply: 'Nothing stored yet about that.', source: 'none' }; }, summarizerFromEnv: () => undefined }));
vi.mock('../../../governance/auth', async (actual) => ({
  ...(await actual<typeof import('../../../governance/auth')>()),
  authenticate: async (_sql: unknown, token: string) => (token === 'operator' ? { id: 'u1', name: 'op', role: 'operator', permissions: ['system.read', 'runtime.execute'] } : token === 'viewer' ? { id: 'u3', name: 'v', role: 'viewer', permissions: ['system.read'] } : null),
}));
const { GET, POST } = await import('../app/api/[...path]/route');

const base = 'http://127.0.0.1:3000';
const headers = (token: string) => ({ 'content-type': 'application/json', host: '127.0.0.1:3000', origin: base, cookie: `mercury_session=${token}` });
const ask = (body: Record<string, unknown>, token = 'operator') => POST(new NextRequest(`${base}/api/ask`, { method: 'POST', body: JSON.stringify(body), headers: headers(token) }));
const cancel = (id: string, token = 'operator') => POST(new NextRequest(`${base}/api/ask/${id}/cancel`, { method: 'POST', body: '{}', headers: headers(token) }));
const until = async (id: string) => { for (let i = 0; i < 50; i++) { const b = await (await GET(new NextRequest(`${base}/api/ask/${id}`, { headers: { cookie: 'mercury_session=operator' } }))).json(); if (b.state === 'done') return b; await new Promise(r => setTimeout(r, 10)); } throw new Error('still running'); };
beforeEach(() => { cli.calls = []; cli.hold = false; lookup.calls = []; lookup.throwError = null; });

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
    lookup.throwError = new Error('SECRET MODEL TEXT');
    const r = await ask({ request: 'What did the latest research find?', requestId: randomUUID() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ state: 'done', action: 'lookup', status: 'error', reply: 'Could not read stored data right now. Try again, or send it as a normal request.' });
    expect(JSON.stringify(body)).not.toContain('SECRET MODEL TEXT');
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

  it('keeps the planRequest path for everything else', async () => {
    const r = await ask({ request: 'zzz qqq', requestId: randomUUID() });
    expect(await r.json()).toMatchObject({ action: 'clarify' });
    expect(cli.calls).toHaveLength(0);
  });
});
