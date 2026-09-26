import { describe, expect, it } from 'vitest';
import { createSunoAdapter, SUNO_ADAPTERS, toSunoApiModel } from '../../records/x3lius/suno/adapters.ts';

// Phase 9: how the Execution agent reaches Suno (user decision: pluggable, two adapters).
// - manual: the prompt is recorded as a submission packet; the operator generates in the Suno
//   UI and registers the takes. Works today, no key, no ToS exposure.
// - sunoapi: the sunoapi.org reseller API (Suno has no official public API as of 2026-09).
//   UNVERIFIED against the live service: no SUNO_API_KEY exists. Shapes follow the vendor docs
//   (docs.sunoapi.org: POST /api/v1/generate, GET /api/v1/generate/record-info); every call
//   here goes to a FAKE fetch.

const PROMPT = { title: 'Night Shift', style: 'style words', excludeStyles: ['a', 'b'], lyrics: '[Verse 1]\nline one\nline two' };
const ENV = { SUNO_API_KEY: 'test-suno', SUNO_CALLBACK_URL: 'https://hooks.example.org/suno' };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const fakeFetch = (responses: readonly unknown[]) => {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};

describe('adapter registry', () => {
  it('offers exactly manual and sunoapi; anything else is refused', () => {
    expect([...SUNO_ADAPTERS]).toEqual(['manual', 'sunoapi']);
    expect(() => createSunoAdapter('browser', { env: {} })).toThrow(/adapter must be one of manual, sunoapi/);
  });

  it.each([['v5', 'V5'], ['v4.5', 'V4_5'], ['v4.5plus', 'V4_5PLUS'], ['v5.5', 'V5_5'], ['V6', 'V6']])('suno model %s → sunoapi %s', (v, api) => {
    expect(toSunoApiModel(v)).toBe(api);
  });

  it('refuses a model it cannot map', () => {
    expect(() => toSunoApiModel('chirp-v3')).toThrow(/suno model/);
  });
});

describe('manual adapter', () => {
  const manual = createSunoAdapter('manual', { env: {} });

  it('submit records nothing externally and returns no provider task', async () => {
    expect(await manual.submit({ prompt: PROMPT, sunoModel: 'v5' })).toEqual({ providerTaskId: null, providerResponse: null });
  });

  it('capture takes the operator’s takes, each an https audio URL', async () => {
    const r = await manual.capture({ providerTaskId: null, takes: [{ audioUrl: 'https://cdn1.suno.ai/abc.mp3', title: 'Night Shift', durationSeconds: 171.2 }] });
    expect(r).toMatchObject({ status: 'complete', takes: [{ audioUrl: 'https://cdn1.suno.ai/abc.mp3', title: 'Night Shift', durationSeconds: 171.2 }] });
  });

  it.each([
    [undefined, /manual capture needs takes/],
    [[], /manual capture needs takes/],
    [[{ audioUrl: 'http://cdn1.suno.ai/abc.mp3' }], /takes\[0\]\.audioUrl must be an https URL/],
    // AOS-03: a take is an https URL or a Vault audio file (sourceId), exactly one.
    [[{ url: 'https://x' }], /takes\[0\] needs exactly one of audioUrl, sourceId/],
    [[{ audioUrl: 'https://x.org/a.mp3', sourceId: '00000000-0000-4000-8000-000000000000' }], /takes\[0\] needs exactly one of audioUrl, sourceId/],
    [[{ audioUrl: 'https://x.org/a.mp3', durationSeconds: -3 }], /takes\[0\]\.durationSeconds must be a positive number/],
  ])('refuses %j', async (takes, error) => {
    await expect(manual.capture({ providerTaskId: null, ...(takes ? { takes } : {}) })).rejects.toThrow(error);
  });
});

describe('sunoapi adapter (FAKE fetch; unverified against the live service)', () => {
  it('submit: custom-mode generate with the prompt fields, bearer key, mapped model and the configured callback', async () => {
    const f = fakeFetch([{ code: 200, msg: 'success', data: { taskId: 'task-123' } }]);
    const r = await createSunoAdapter('sunoapi', { env: ENV, fetch: f.fn }).submit({ prompt: PROMPT, sunoModel: 'v4.5' });
    expect(r).toEqual({ providerTaskId: 'task-123', providerResponse: { code: 200, msg: 'success', data: { taskId: 'task-123' } } });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.sunoapi.org/api/v1/generate', method: 'POST', headers: { authorization: 'Bearer test-suno' },
      body: {
        customMode: true, instrumental: false, model: 'V4_5', callBackUrl: 'https://hooks.example.org/suno',
        title: 'Night Shift', style: 'style words', negativeTags: 'a, b', lyrics: PROMPT.lyrics,
      },
    });
  });

  it.each([
    [{ SUNO_CALLBACK_URL: 'https://h' }, /SUNO_API_KEY is not set/],
    [{ SUNO_API_KEY: 'k' }, /SUNO_CALLBACK_URL is not set/],
  ])('fails before any call when configuration is missing', async (env, error) => {
    const f = fakeFetch([{}]);
    await expect(createSunoAdapter('sunoapi', { env, fetch: f.fn }).submit({ prompt: PROMPT, sunoModel: 'v5' })).rejects.toThrow(error);
    expect(f.calls).toHaveLength(0);
  });

  it('a non-200 code is an error carrying the vendor message', async () => {
    const f = fakeFetch([{ code: 429, msg: 'insufficient credits', data: null }]);
    await expect(createSunoAdapter('sunoapi', { env: ENV, fetch: f.fn }).submit({ prompt: PROMPT, sunoModel: 'v5' })).rejects.toThrow('sunoapi error 429: insufficient credits');
  });

  it('capture: SUCCESS yields the takes (either field casing); PENDING yields none, not an error', async () => {
    const f = fakeFetch([
      { code: 200, msg: 'success', data: { taskId: 'task-123', status: 'PENDING', response: null } },
      { code: 200, msg: 'success', data: { taskId: 'task-123', status: 'SUCCESS', response: { sunoData: [
        { id: 'clip-a', audio_url: 'https://cdn.example.org/a.mp3', title: 'Night Shift', duration: 198.44, tags: 't', model_name: 'chirp-v4-5' },
        { id: 'clip-b', audioUrl: 'https://cdn.example.org/b.mp3', title: 'Night Shift', duration: 201.1 },
      ] } } },
    ]);
    const a = createSunoAdapter('sunoapi', { env: ENV, fetch: f.fn });
    expect(await a.capture({ providerTaskId: 'task-123' })).toMatchObject({ status: 'pending', takes: [] });
    const done = await a.capture({ providerTaskId: 'task-123' });
    expect(done).toMatchObject({ status: 'complete', takes: [
      { providerTakeId: 'clip-a', audioUrl: 'https://cdn.example.org/a.mp3', title: 'Night Shift', durationSeconds: 198.44 },
      { providerTakeId: 'clip-b', audioUrl: 'https://cdn.example.org/b.mp3', durationSeconds: 201.1 },
    ] });
    expect(f.calls[1]).toMatchObject({ url: 'https://api.sunoapi.org/api/v1/generate/record-info?taskId=task-123', method: 'GET', headers: { authorization: 'Bearer test-suno' } });
  });

  it('capture: a failed task is an error naming the status', async () => {
    const f = fakeFetch([{ code: 200, msg: 'success', data: { taskId: 't', status: 'SENSITIVE_WORD_ERROR', errorMessage: 'blocked word' } }]);
    await expect(createSunoAdapter('sunoapi', { env: ENV, fetch: f.fn }).capture({ providerTaskId: 't' })).rejects.toThrow(/sunoapi task t failed: SENSITIVE_WORD_ERROR/);
  });

  it('capture refuses operator-supplied takes: sunoapi takes come from the provider', async () => {
    await expect(createSunoAdapter('sunoapi', { env: ENV, fetch: fakeFetch([{}]).fn }).capture({ providerTaskId: 't', takes: [{ audioUrl: 'https://x.org/a.mp3' }] }))
      .rejects.toThrow(/sunoapi takes come from the provider/);
  });
});
