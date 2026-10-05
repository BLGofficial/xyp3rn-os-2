import { describe, expect, it, vi } from 'vitest';
import { clampLevel, createLevelMeter, createVoiceReporter, postVoiceStatus, rmsLevel } from './viewer/voice-report.js';

type Ev = { status: string; level: number };

/** A post() whose completion the test controls, to prove ordering. */
function gatedPost() {
  const sent: Array<{ status: string; level: number }> = [];
  const gates: Array<{ ok: () => void; fail: () => void }> = [];
  const post = (ev: { status: string; level: number }) => {
    sent.push(ev);
    return new Promise<void>((ok, fail) => gates.push({ ok, fail: () => fail(new Error('down')) }));
  };
  return { post, sent, gates };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('clampLevel', () => {
  it('keeps 0..1 and zeroes anything that is not a finite number', () => {
    expect([clampLevel(-1), clampLevel(0.4), clampLevel(7)]).toEqual([0, 0.4, 1]);
    expect([clampLevel(NaN), clampLevel(Infinity), clampLevel(undefined as never), clampLevel('0.5' as never)]).toEqual([0, 0, 0, 0]);
  });
});

describe('createVoiceReporter', () => {
  it('posts a status change at once, with level 0 by default', async () => {
    const post = vi.fn(async (_ev: Ev) => {});
    createVoiceReporter({ post }).report('listening');
    expect(post).toHaveBeenCalledWith({ status: 'listening', level: 0 });
  });

  it('does not repost an identical status and level', async () => {
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post });
    r.report('idle'); await flush(); r.report('idle'); r.report('idle', 0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown status instead of throwing', () => {
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post });
    expect(() => r.report('dancing' as never)).not.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it('clamps level before it leaves the page', () => {
    const post = vi.fn(async (_ev: Ev) => {});
    createVoiceReporter({ post }).report('speaking', 9);
    expect(post).toHaveBeenCalledWith({ status: 'speaking', level: 1 });
  });

  it('rate-limits level changes inside one status, and ignores tiny ones', async () => {
    let t = 0;
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post, now: () => t, levelGapMs: 100 });
    r.report('speaking', 0.2); await flush();          // first post
    t = 50;  r.report('speaking', 0.6); await flush(); // inside the gap: held back
    t = 150; r.report('speaking', 0.22); await flush();// past the gap but under the step: ignored
    t = 150; r.report('speaking', 0.6); await flush(); // past the gap, real change: posted
    expect(post.mock.calls.map(c => c[0].level)).toEqual([0.2, 0.6]);
  });

  it('lets a status change through the level gap', async () => {
    let t = 0;
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post, now: () => t, levelGapMs: 100 });
    r.report('speaking', 0.5); await flush();
    t = 10; r.report('idle'); await flush();
    expect(post.mock.calls.map(c => c[0].status)).toEqual(['speaking', 'idle']);
  });

  it('reports nothing when disabled (a ?mute=1 test tab)', () => {
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post, enabled: false });
    r.report('speaking', 0.5); r.report('listening');
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps order: one post in flight, and only the latest of the rest follows', async () => {
    const { post, sent, gates } = gatedPost();
    const r = createVoiceReporter({ post });
    r.report('listening');
    r.report('thinking');   // held while listening is in flight
    r.report('speaking');   // replaces thinking: a stale middle state is never sent
    expect(sent.map(e => e.status)).toEqual(['listening']);
    gates[0]!.ok(); await flush();
    expect(sent.map(e => e.status)).toEqual(['listening', 'speaking']);
    gates[1]!.ok(); await flush();
    expect(sent).toHaveLength(2);
  });

  it('survives a failed post and retries the same status next time', async () => {
    const { post, sent, gates } = gatedPost();
    const r = createVoiceReporter({ post });
    r.report('listening');
    gates[0]!.fail(); await flush();
    r.report('listening');   // the server never heard it, so it must go again
    expect(sent.map(e => e.status)).toEqual(['listening', 'listening']);
  });

  it('survives a post that throws synchronously', async () => {
    const post = vi.fn((_ev: Ev) => { throw new Error('boom'); });
    const r = createVoiceReporter({ post });
    expect(() => r.report('listening')).not.toThrow();
    await flush();
    r.report('idle');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('re-sends a status the server has since replaced (listening, thinking, listening)', async () => {
    // The server alone publishes idle after a brain turn, so the reporter must see thinking to know listening is news again.
    const post = vi.fn(async (_ev: Ev) => {});
    const r = createVoiceReporter({ post });
    r.report('listening'); await flush();
    r.report('thinking'); await flush();
    r.report('listening'); await flush();
    expect(post.mock.calls.map(c => c[0].status)).toEqual(['listening', 'thinking', 'listening']);
  });
});

describe('postVoiceStatus', () => {
  it('POSTs JSON to /voice/status and rejects on a refusal', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: object) => ({ ok: true }));
    await postVoiceStatus(fetchImpl as never)({ status: 'speaking', level: 0.5 });
    expect(fetchImpl).toHaveBeenCalledWith('/voice/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'speaking', level: 0.5 }), keepalive: true,
    });
    const refused = vi.fn(async (_url: string, _init: object) => ({ ok: false, status: 403 }));
    await expect(postVoiceStatus(refused as never)({ status: 'idle', level: 0 })).rejects.toThrow('403');
  });
});

describe('rmsLevel', () => {
  it('is 0 for silence and for no data', () => {
    expect(rmsLevel(new Uint8Array(256).fill(128))).toBe(0);
    expect(rmsLevel(new Uint8Array(0))).toBe(0);
  });
  it('is the gained RMS of the centred waveform, clamped to 1', () => {
    const half = new Uint8Array(256).fill(192);             // +0.5 of full scale
    expect(rmsLevel(half, 1)).toBeCloseTo(0.5, 5);
    expect(rmsLevel(half, 3)).toBe(1);                      // 1.5 clamps
    const alternating = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 160 : 96)); // ±0.25
    expect(rmsLevel(alternating, 1)).toBeCloseTo(0.25, 5);
  });
});

describe('createLevelMeter', () => {
  function fakeContext(state: 'running' | 'suspended', after: 'running' | 'suspended' = state) {
    const calls: string[] = [];
    const analyser = {
      fftSize: 0, connect: () => calls.push('analyser.connect'),
      getByteTimeDomainData: (a: Uint8Array) => a.fill(192),
    };
    const ctx = {
      state, calls,
      createMediaElementSource: () => { calls.push('source'); return { connect: () => calls.push('source.connect') }; },
      createAnalyser: () => analyser,
      destination: {},
      resume: async () => { ctx.state = after; },
      close: async () => { calls.push('close'); },
    };
    return ctx;
  }

  it('samples the element at the interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const ctx = fakeContext('running');
    const levels: number[] = [];
    const meter = await createLevelMeter({ audio: {} as never, AudioContextCtor: function () { return ctx; } as never, onLevel: l => levels.push(l), intervalMs: 100, gain: 1 });
    vi.advanceTimersByTime(350);
    expect(levels).toEqual([0.5, 0.5, 0.5]);
    meter.stop();
    vi.advanceTimersByTime(500);
    expect(levels).toHaveLength(3);
    expect(ctx.calls).toContain('close');
    vi.useRealTimers();
  });

  it('never touches the audio element when the context cannot run (it would mute the voice)', async () => {
    const ctx = fakeContext('suspended', 'suspended');
    const meter = await createLevelMeter({ audio: {} as never, AudioContextCtor: function () { return ctx; } as never, onLevel: () => {} });
    expect(ctx.calls).not.toContain('source');
    expect(() => meter.stop()).not.toThrow();
  });

  it('resumes a suspended context before deciding', async () => {
    const ctx = fakeContext('suspended', 'running');
    await createLevelMeter({ audio: {} as never, AudioContextCtor: function () { return ctx; } as never, onLevel: () => {} });
    expect(ctx.calls).toContain('source');
  });

  it('returns a no-op meter when Web Audio is missing or throws', async () => {
    const none = await createLevelMeter({ audio: {} as never, AudioContextCtor: undefined, onLevel: () => {} });
    expect(() => none.stop()).not.toThrow();
    const bad = await createLevelMeter({ audio: {} as never, AudioContextCtor: function () { throw new Error('nope'); } as never, onLevel: () => {} });
    expect(() => bad.stop()).not.toThrow();
  });
});
