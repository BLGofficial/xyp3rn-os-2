import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { issueSession, SESSION_COOKIE } from '../../../../lib/session';

const secret = 'fixture-http-session-0123456789';
const before = process.env.XYP_WEB_TOKEN;
afterEach(() => { if (before === undefined) delete process.env.XYP_WEB_TOKEN; else process.env.XYP_WEB_TOKEN = before; });
async function request(path: string, body?: string, origin = 'http://localhost:3198') {
  process.env.XYP_WEB_TOKEN = secret;
  return new NextRequest(`http://localhost:3198/api/studio/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${await issueSession(secret, Date.now())}`, origin, host: 'localhost:3198', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });
}
describe('authenticated Studio HTTP boundary', () => {
  it('refuses missing session on reads and writes', async () => {
    process.env.XYP_WEB_TOKEN = secret;
    const r = new NextRequest('http://localhost:3198/api/studio/status');
    expect((await GET(r, { params: Promise.resolve({ operation: 'status' }) })).status).toBe(401);
    expect((await POST(r, { params: Promise.resolve({ operation: 'capture' }) })).status).toBe(401);
  });
  it('returns only public availability to the owner', async () => {
    const result = await GET(await request('status'), { params: Promise.resolve({ operation: 'status' }) });
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('private, no-store');
    const body = await result.json(); expect(Object.keys(body).sort()).toEqual(['speech', 'transcription']);
    expect(JSON.stringify(body)).not.toContain(secret);
  });
  it('rejects cross-origin writes before parsing or saving', async () => {
    expect((await POST(await request('capture', '{}', 'https://attacker.example'), { params: Promise.resolve({ operation: 'capture' }) })).status).toBe(403);
  });
  it('accepts the actual origin when Next normalizes the internal request hostname', async () => {
    const r = await request('speak', 'null', 'http://127.0.0.1:3198');
    r.headers.set('host', '127.0.0.1:3198');
    expect((await POST(r, { params: Promise.resolve({ operation: 'speak' }) })).status).toBe(400);
  });
  it('rejects invalid JSON, non-object speech input and unknown operations', async () => {
    expect((await POST(await request('speak', '{'), { params: Promise.resolve({ operation: 'speak' }) })).status).toBe(400);
    expect((await POST(await request('speak', 'null'), { params: Promise.resolve({ operation: 'speak' }) })).status).toBe(400);
    expect((await POST(await request('approve', '{}'), { params: Promise.resolve({ operation: 'approve' }) })).status).toBe(404);
  });
});
