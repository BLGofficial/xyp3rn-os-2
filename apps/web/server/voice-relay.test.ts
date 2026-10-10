import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { relayVoice } from './voice-relay.ts';

// The relay between the browser and Jarvis (galaxy/server.py GET /voice/stream). A fake Jarvis stands in for it.

let jarvis: Server | undefined;
afterEach(() => new Promise<void>((done) => { if (!jarvis) return done(); jarvis.closeAllConnections(); jarvis.close(() => done()); jarvis = undefined; }));

const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<string>((resolve) => {
  jarvis = createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(jarvis!.address() as AddressInfo).port}`));
});

describe('relayVoice', () => {
  it('passes Jarvis\'s events through unchanged, as an event stream', async () => {
    const frame = 'id: 7\nevent: voice\ndata: {"status":"speaking","level":0.5,"seq":7}\n\n';
    const seen: { origin?: string; fetchSite?: string; path?: string } = {};
    const origin = await listen((req, res) => {
      Object.assign(seen, { origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'], path: req.url });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame);
    });
    const r = await relayVoice(new AbortController().signal, origin);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(await r.text()).toBe(frame);
    expect(seen).toEqual({ origin: undefined, fetchSite: undefined, path: '/voice/stream' }); // nothing Jarvis's guard would refuse
  });

  it('answers 200 with a stream that asks to be retried when Jarvis is not running', async () => {
    const origin = await listen((_req, res) => res.end());
    jarvis!.closeAllConnections(); await new Promise((r) => jarvis!.close(r)); jarvis = undefined; // the port is now closed
    const r = await relayVoice(new AbortController().signal, origin);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('retry: 5000');
  });

  it('answers 200 with the same retry stream when Jarvis refuses (403)', async () => {
    const origin = await listen((_req, res) => { res.writeHead(403); res.end('Unknown host.'); });
    const r = await relayVoice(new AbortController().signal, origin);
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain('Unknown host');
  });
});
