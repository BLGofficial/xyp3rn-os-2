import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../../core/db/client.ts';

// F9: the lookup summarizer had no timeout. These are DB-free (a fake `sql` answers the one query
// findingsAnswer issues) and provider-free (createLlmClient is mocked), unlike
// tests/claude-engine/lookup.test.ts which needs a real Postgres (out per the fix brief).

const providers = vi.hoisted(() => ({ lastReq: null as null | { signal?: AbortSignal } }));
vi.mock('../../core/llm/providers.ts', () => ({
  createLlmClient: () => ({
    modelRef: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    complete: async (req: { signal?: AbortSignal }) => {
      providers.lastReq = req;
      return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', text: '{"answer":"ok"}', json: { answer: 'ok' }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
    },
  }),
}));

const { answerLookup, summarizerFromEnv } = await import('../../core/orchestrator/lookup.ts');
type Summarize = import('../../core/orchestrator/lookup.ts').Summarize;

const fakeSql = (rows: readonly unknown[]): Queryable => (async () => rows) as unknown as Queryable;

describe('F9: findingsAnswer passes a signal to the summarizer', () => {
  it('the signal is a live AbortSignal (not yet aborted)', async () => {
    const rows = [{ claim: 'Dark vocals need heavy compression', confidence: '0.9' }];
    let seenSignal: AbortSignal | undefined;
    const summarize: Summarize = async (_q, _facts, signal) => { seenSignal = signal; return 'the answer'; };
    const result = await answerLookup(fakeSql(rows), 'what did the research find about vocals', summarize);
    expect(result).toEqual({ reply: 'the answer', source: 'model' });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
  });

  it('a summarizer that rejects when its signal aborts makes answerLookup reject too (the caller\'s lookup-error catch handles it)', async () => {
    const rows = [{ claim: 'Dark vocals need heavy compression', confidence: '0.9' }];
    const summarize: Summarize = (_q, _facts, signal) => new Promise((_resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    // Abort the *caller's own* controller to simulate the production timeout firing, without
    // waiting out the real 60s that findingsAnswer itself uses.
    const external = new AbortController();
    const p = answerLookup(fakeSql(rows), 'what did the research find about vocals', (q, f) => summarize(q, f, external.signal));
    external.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('F9: summarizerFromEnv forwards its signal into llm.complete', () => {
  it('passes the exact AbortSignal through to the request', async () => {
    const summarize = summarizerFromEnv({ LLM_ENGINE: 'claude-code' })!;
    const controller = new AbortController();
    const answer = await summarize('what did the research find', '- a fact (confidence 0.9)', controller.signal);
    expect(answer).toBe('ok');
    expect(providers.lastReq?.signal).toBe(controller.signal);
  });

  it('omits signal from the request when none is given', async () => {
    const summarize = summarizerFromEnv({ LLM_ENGINE: 'claude-code' })!;
    providers.lastReq = null;
    await summarize('q', 'facts');
    expect(providers.lastReq).not.toBeNull();
    expect(providers.lastReq).not.toHaveProperty('signal');
  });
});
