import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { issueSession } from '../../../lib/session';

const secret = 'fixture-tasks-session-0123456789', before = process.env.XYP_WEB_TOKEN;
afterEach(() => { if (before === undefined) delete process.env.XYP_WEB_TOKEN; else process.env.XYP_WEB_TOKEN = before; });
async function request(body: string, origin = 'http://localhost:3198', type = 'application/json') {
  process.env.XYP_WEB_TOKEN = secret;
  return new NextRequest('http://localhost:3198/api/tasks', { method: 'POST', headers: { cookie: `xyp_session=${await issueSession(secret, Date.now())}`, origin, host: 'localhost:3198', 'Content-Type': type }, body });
}
describe('task HTTP boundary', () => {
  it('requires a session for reads and execution', async () => {
    const r = new NextRequest('http://localhost:3198/api/tasks');
    expect((await GET(r)).status).toBe(401); expect((await POST(r)).status).toBe(401);
  });
  it('refuses cross-origin writes and invalid bodies before loading a runner', async () => {
    expect((await POST(await request('{}', 'https://attacker.example'))).status).toBe(403);
    expect((await POST(await request('{}', 'http://localhost:3198', 'text/plain'))).status).toBe(415);
    expect((await POST(await request('{'))).status).toBe(400);
    expect((await POST(await request('x'.repeat(40001)))).status).toBe(400);
  });
});
