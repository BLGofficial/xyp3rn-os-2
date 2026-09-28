import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// No DB: the session lookup is stubbed, the permission check stays real.
vi.mock('../lib/db', () => ({ sql: {} }));
vi.mock('../../../governance/auth', async (actual) => ({
  ...(await actual<typeof import('../../../governance/auth')>()),
  authenticate: async (_sql: unknown, token: string) =>
    token === 'viewer' ? { id: '2', name: 'v', role: 'viewer', permissions: ['system.read'] }
      : token === 'noperm' ? { id: '3', name: 'n', role: 'none', permissions: [] } : null,
}));
const speech = await import('../app/api/speech/route');
const status = await import('../app/api/speech/status/route');
const voices = await import('../app/api/speech/voices/route');
const { MAX_WAV_BYTES } = await import('../lib/kokoro');

// Fake Kokoro-FastAPI on loopback. `mode` picks how /v1/audio/speech behaves.
const wav = (() => { const b = Buffer.alloc(44 + 4800); b.write('RIFF', 0); b.writeUInt32LE(36 + 4800, 4); b.write('WAVEfmt ', 8); b.write('data', 36); return b; })();
let mode: 'ok' | 'slow' | 'hang' | 'huge' | 'notwav' | 'error500' | 'reject400' = 'ok';
let hits = 0; let last: { headers: IncomingMessage['headers']; body: unknown } | null = null; let closedEarly = 0;
const upstream: Server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"healthy"}');
    // Kokoro-FastAPI 0.9.0 shape (objects); a plain-string entry covers older releases.
    if (req.url === '/v1/audio/voices') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ voices: [{ id: 'af_heart', name: 'af_heart', overall_grade: 'A' }, 'bf_emma', { id: 'zz_unlisted' }, null] }));
    hits++; last = { headers: req.headers, body: JSON.parse(raw) };
    res.on('close', () => { if (!res.writableEnded) closedEarly++; });
    if (mode === 'hang') return;
    if (mode === 'slow') return void setTimeout(() => res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav), 400);
    if (mode === 'error500') return void res.writeHead(500).end('internal detail: /secret/path');
    if (mode === 'reject400') return void res.writeHead(400).end('{"detail":"voice not found"}');
    if (mode === 'notwav') return void res.writeHead(200, { 'content-type': 'audio/wav' }).end('<html>not audio</html>');
    if (mode === 'huge') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.write(wav); const chunk = Buffer.alloc(1024 * 1024); for (let i = 0; i <= MAX_WAV_BYTES / chunk.length; i++) res.write(chunk); return void res.end(); }
    res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav);
  });
});
let url = '';
beforeAll(async () => { await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`; });
afterAll(() => new Promise<void>(r => upstream.close(() => r())));
beforeEach(() => { mode = 'ok'; hits = 0; last = null; closedEarly = 0; process.env.KOKORO_URL = url; process.env.KOKORO_API_KEY = 'test-secret'; process.env.KOKORO_TIMEOUT_MS = '1500'; });

const origin = 'http://127.0.0.1:3000';
const post = (body: unknown, { token = 'viewer', from = origin as string | null, type = 'application/json', signal }: { token?: string; from?: string | null; type?: string; signal?: AbortSignal } = {}) =>
  speech.POST(new NextRequest(`${origin}/api/speech`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...(signal ? { signal } : {}),
    headers: { 'content-type': type, host: '127.0.0.1:3000', cookie: `mercury_session=${token}`, ...(from ? { origin: from } : {}) },
  }));
const get = (route: typeof status | typeof voices, token = 'viewer') => route.GET(new NextRequest(`${origin}/api/speech/x`, { headers: { cookie: `mercury_session=${token}` } }));
const valid = { text: 'Research run finished.', voice: 'bf_emma', speed: 1.25, format: 'wav' };

describe('speech bridge: session, origin, validation', () => {
  it('rejects unauthenticated and unpermitted callers on every route', async () => {
    for (const r of [await post(valid, { token: 'none' }), await get(status, 'none'), await get(voices, 'none')]) expect(r.status).toBe(401);
    expect((await post(valid, { token: 'noperm' })).status).toBe(403);
    expect(hits).toBe(0);
  });

  it('rejects cross-origin and origin-less synthesis before auth', async () => {
    expect((await post(valid, { from: 'http://evil.test' })).status).toBe(403);
    expect((await post(valid, { from: null })).status).toBe(403);
    expect(hits).toBe(0);
  });

  it('validates text, voice, speed, format, content type and body size', async () => {
    const bad = [
      { ...valid, text: '' }, { ...valid, text: '   ' }, { ...valid, text: 'x'.repeat(2001) }, { ...valid, text: 42 },
      { ...valid, voice: 'am_adam' }, { ...valid, voice: '../etc' }, { text: 'hi' },
      { ...valid, speed: 0.4 }, { ...valid, speed: 2.1 }, { ...valid, speed: '1' }, { ...valid, speed: Number.NaN },
      { ...valid, format: 'mp3' },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await post(valid, { type: 'text/plain' })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ ...valid, pad: 'x'.repeat(17 * 1024) })).status).toBe(400);
    expect(hits).toBe(0);
  });
});

describe('speech bridge: upstream behavior', () => {
  it('synthesizes a complete WAV, sending the credential only upstream', async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(wav)).toBe(true);
    expect(last!.body).toEqual({ model: 'kokoro', input: 'Research run finished.', voice: 'bf_emma', speed: 1.25, response_format: 'wav', stream: false });
    expect(last!.headers.authorization).toBe('Bearer test-secret');
    expect(JSON.stringify([...res.headers])).not.toContain('test-secret');
    expect((await post({ text: 'Defaults apply.', voice: 'af_heart' })).status).toBe(200);
    expect(last!.body).toMatchObject({ speed: 1, response_format: 'wav' });
  });

  it('reports readiness and only allowlisted installed voices', async () => {
    expect(await (await get(status)).json()).toEqual({ ready: true });
    expect(await (await get(voices)).json()).toEqual({ voices: ['af_heart', 'bf_emma'] });
  });

  it('maps an outage to sanitized 503s and ready:false', async () => {
    const dead = createServer(); await new Promise<void>(r => dead.listen(0, '127.0.0.1', r));
    process.env.KOKORO_URL = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`; await new Promise<void>(r => dead.close(() => r()));
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Speech service unavailable' });
    expect(await (await get(status)).json()).toEqual({ ready: false });
    expect((await get(voices)).status).toBe(503);
  });

  it('refuses non-loopback or credentialed service addresses (no cloud fallback)', async () => {
    for (const bad of ['https://api.example.com', 'http://user:pw@127.0.0.1:8880', 'file:///etc/passwd']) {
      process.env.KOKORO_URL = bad;
      const res = await post(valid);
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toMatch(/example|user|passwd/);
    }
  });

  it('sanitizes upstream errors and rejects oversized or non-WAV responses', async () => {
    const cases = [['error500', 503], ['reject400', 502], ['notwav', 502], ['huge', 502]] as const;
    for (const [m, code] of cases) {
      mode = m;
      const res = await post(valid);
      expect(res.status, m).toBe(code);
      expect(JSON.stringify(await res.json())).not.toMatch(/secret|detail|voice not found/);
    }
  });

  it('times out a stalled service with 504', async () => {
    mode = 'hang'; process.env.KOKORO_TIMEOUT_MS = '300';
    const t = Date.now();
    const res = await post(valid);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: 'Speech service timed out' });
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('limits concurrent synthesis to 2 per server process', async () => {
    mode = 'slow';
    const codes = (await Promise.all([post(valid), post(valid), post(valid)])).map(r => r.status).sort();
    expect(codes).toEqual([200, 200, 429]);
    expect(hits).toBe(2);
  });

  it('propagates client cancellation to the upstream request', async () => {
    mode = 'hang';
    const client = new AbortController();
    const pending = post(valid, { signal: client.signal });
    await new Promise(r => setTimeout(r, 150));
    client.abort();
    const res = await pending;
    expect(res.status).toBe(503);
    await new Promise(r => setTimeout(r, 100));
    expect(closedEarly).toBe(1);
  });
});
