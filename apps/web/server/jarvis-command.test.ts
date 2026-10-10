import { describe, expect, it } from 'vitest';
import { relayCommand, routeCommand } from './jarvis-command.ts';

const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('jarvis command relay', () => {
  it('sends "remember ..." to /remember and everything else to /chat', () => {
    expect(routeCommand('Remember that the hook is 8 bars')).toEqual({ path: '/remember', body: { text: 'Remember that the hook is 8 bars' } });
    expect(routeCommand('what did I write about drill?')).toEqual({ path: '/chat', body: { question: 'what did I write about drill?' } });
  });

  it('posts with Jarvis\'s own Origin and returns its answer', async () => {
    let seen: { url: string; origin: string | null } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, origin: new Headers(init.headers).get('origin') }; return new Response('{"answer":"ok","route":"chat"}'); }) as unknown as typeof fetch;
    expect(await relayCommand('hi', 'http://127.0.0.1:4700', f)).toEqual({ kind: 'answer', answer: 'ok', route: 'chat' });
    expect(seen).toEqual({ url: 'http://127.0.0.1:4700/chat', origin: 'http://127.0.0.1:4700' });
  });

  it('reports offline when nothing answers and refused when Jarvis says no', async () => {
    expect(await relayCommand('hi', 'http://x', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch)).toEqual({ kind: 'offline' });
    expect(await relayCommand('hi', 'http://x', reply(400, { error: 'Say something first.' }))).toEqual({ kind: 'refused', status: 400, message: 'Say something first.' });
  });
});
