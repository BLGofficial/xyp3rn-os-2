import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../core/agent-registry/parse-agent-file.ts';
import { validateJson, type JsonSchema } from '../../core/llm/json-schema.ts';
import { createLlmClient, parseModelRef, PROVIDERS } from '../../core/llm/providers.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import type { AgentContext } from '../../core/orchestrator/dispatch.ts';

// Phase 8: the provider-agnostic LLM runner (user decision: native Anthropic + OpenAI-compatible
// Groq/OpenRouter). No key exists in this container, so every transport here runs against a FAKE
// fetch that records the request and returns a canned provider response. What this proves: the
// request each provider receives and how its reply is parsed. What it cannot prove: that a live
// provider accepts it — that is the keyed-session proof (docs/handoffs/PHASE-08.md).

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    line: { type: 'string' },
    bars: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    mood: { type: 'string', enum: ['dark', 'light'] },
  },
  required: ['line', 'bars', 'tags', 'mood'],
  additionalProperties: false,
};
const GOOD = { line: 'x', bars: 4, tags: ['a'], mood: 'dark' };

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** FAKE fetch: records every request, answers with the next canned response. */
const fakeFetch = (responses: readonly { status?: number; body: unknown }[]) => {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
    calls.push({ url, headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};

const anthropicReply = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
  usage: { input_tokens: 120, output_tokens: 30 }, ...extra,
});
const chatReply = (content: string, finish = 'stop') => ({
  id: 'chatcmpl-fake', object: 'chat.completion', model: 'served-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 },
});

const REQ = { system: 'SYSTEM', user: 'USER', schema: { name: 'test_schema', schema: SCHEMA } };
const ENV = { ANTHROPIC_API_KEY: 'test-anthropic', GROQ_API_KEY: 'test-groq', OPENROUTER_API_KEY: 'test-openrouter' };

describe('model references: frontmatter `model` picks the provider', () => {
  it.each([
    ['claude-sonnet-5', { provider: 'anthropic', model: 'claude-sonnet-5' }],
    ['anthropic:claude-opus-5', { provider: 'anthropic', model: 'claude-opus-5' }],
    ['groq:llama-3.3-70b-versatile', { provider: 'groq', model: 'llama-3.3-70b-versatile' }],
    ['openrouter:anthropic/claude-opus-5', { provider: 'openrouter', model: 'anthropic/claude-opus-5' }],
    // OpenRouter variant suffixes keep their colon: only the first one separates the provider.
    ['openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }],
  ])('%s', (ref, expected) => {
    expect(parseModelRef(ref)).toEqual(expected);
  });

  it.each([['none'], ['gpt-5'], ['mistral:large'], ['groq:'], ['']])('refuses %j (unknown provider or no model)', (ref) => {
    expect(() => parseModelRef(ref)).toThrow(/model/);
  });

  it('each provider reads its own key variable', () => {
    expect(Object.fromEntries(Object.entries(PROVIDERS).map(([p, d]) => [p, d.keyEnv]))).toEqual({
      anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY',
    });
  });
});

describe('missing key: fails at the call, naming the variable — never a silent fallback provider', () => {
  it.each([
    ['openrouter:anthropic/claude-opus-5', 'OPENROUTER_API_KEY'],
    ['groq:llama-3.3-70b-versatile', 'GROQ_API_KEY'],
    ['claude-sonnet-5', 'ANTHROPIC_API_KEY'],
  ])('%s → %s', async (model, keyEnv) => {
    const f = fakeFetch([{ body: {} }]);
    const client = createLlmClient({ model, agentName: 'x3lius-lyrics', env: {}, fetch: f.fn });
    await expect(client.complete(REQ)).rejects.toThrow(
      `LLM runner unavailable: ${keyEnv} is not set (agent x3lius-lyrics uses model ${model})`,
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe('Anthropic transport (official SDK, FAKE fetch)', () => {
  it('sends system + user + json_schema output_config to api.anthropic.com, parses text blocks and usage', async () => {
    const f = fakeFetch([{ body: anthropicReply(JSON.stringify(GOOD)) }]);
    // The container sets ANTHROPIC_BASE_URL for its own use; the transport must not follow it.
    const client = createLlmClient({ model: 'claude-sonnet-5', agentName: 'a', env: { ...ENV, ANTHROPIC_BASE_URL: 'http://wrong.invalid' }, fetch: f.fn });
    const r = await client.complete(REQ);
    expect(r).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', json: GOOD, usage: { inputTokens: 120, outputTokens: 30 }, stopReason: 'end_turn' });
    const [c] = f.calls;
    expect(c!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c!.headers['x-api-key']).toBe('test-anthropic');
    expect(c!.body).toMatchObject({
      model: 'claude-sonnet-5', system: 'SYSTEM', messages: [{ role: 'user', content: 'USER' }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    expect(c!.body.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  it('a refusal is an error carrying the category, never parsed as output', async () => {
    const f = fakeFetch([{ body: anthropicReply('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' } }) }]);
    const client = createLlmClient({ model: 'claude-sonnet-5', agentName: 'a', env: ENV, fetch: f.fn });
    await expect(client.complete(REQ)).rejects.toThrow(/anthropic refused \(category cyber\)/);
  });

  it('an API error surfaces its status', async () => {
    const f = fakeFetch([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } } }]);
    const client = createLlmClient({ model: 'claude-sonnet-5', agentName: 'a', env: ENV, fetch: f.fn });
    await expect(client.complete(REQ)).rejects.toThrow(/anthropic API error 400/);
  });
});

describe('OpenAI-compatible transport (Groq, OpenRouter; FAKE fetch)', () => {
  it.each([
    ['groq:llama-3.3-70b-versatile', 'https://api.groq.com/openai/v1/chat/completions', 'test-groq', 'llama-3.3-70b-versatile'],
    ['openrouter:anthropic/claude-opus-5', 'https://openrouter.ai/api/v1/chat/completions', 'test-openrouter', 'anthropic/claude-opus-5'],
  ])('%s → %s with a bearer key and a strict json_schema response_format', async (model, url, key, wireModel) => {
    const f = fakeFetch([{ body: chatReply(JSON.stringify(GOOD)) }]);
    const r = await createLlmClient({ model, agentName: 'a', env: ENV, fetch: f.fn }).complete(REQ);
    expect(r).toMatchObject({ json: GOOD, model: 'served-model', usage: { inputTokens: 90, outputTokens: 12 }, stopReason: 'stop' });
    const [c] = f.calls;
    expect(c!.url).toBe(url);
    expect(c!.headers.authorization).toBe(`Bearer ${key}`);
    expect(c!.body).toMatchObject({
      model: wireModel,
      messages: [{ role: 'system' }, { role: 'user', content: 'USER' }],
      response_format: { type: 'json_schema', json_schema: { name: 'test_schema', strict: true, schema: SCHEMA } },
    });
  });

  it('also states the schema in the system message: some routes (e.g. OpenRouter :free) silently drop response_format', async () => {
    const f = fakeFetch([{ body: chatReply(JSON.stringify(GOOD)) }]);
    await createLlmClient({ model: 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', agentName: 'a', env: ENV, fetch: f.fn }).complete(REQ);
    const system = (f.calls[0]!.body.messages as { content: string }[])[0]!.content;
    expect(system.startsWith('SYSTEM\n\n')).toBe(true);
    expect(system).toContain(JSON.stringify(SCHEMA));
    expect(system).toMatch(/single JSON object/);
  });

  it('a reply cut off by the token limit is an error, not partial JSON, and is not retried', async () => {
    const f = fakeFetch([{ body: chatReply('{"line":', 'length') }]);
    await expect(createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0] }).complete(REQ)).rejects.toThrow(/groq reply incomplete \(length\)/);
    expect(f.calls).toHaveLength(1);
  });

  it('a non-2xx reply surfaces status and provider message', async () => {
    const f = fakeFetch([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    await expect(createLlmClient({ model: 'openrouter:x/y', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [] }).complete(REQ)).rejects.toThrow('openrouter API error 429: rate limited');
  });
});

describe('transient provider errors: bounded retries (a model call changes no external state)', () => {
  const overloaded = { status: 503, body: { error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 503 } } };

  it('retries 503 / 429 / 502, including an error reported inside a 200, then succeeds', async () => {
    const f = fakeFetch([overloaded, { status: 200, body: { error: { message: 'overloaded', code: 502 } } }, { status: 429, body: { error: { message: 'rate limited' } } }, { body: chatReply(JSON.stringify(GOOD)) }]);
    const r = await createLlmClient({ model: 'openrouter:x/y', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0, 0] }).complete(REQ);
    expect(r.json).toEqual(GOOD);
    expect(f.calls).toHaveLength(4);
  });

  it('retries a reply the upstream provider abandoned mid-generation (finish_reason "error" inside a 200)', async () => {
    // Seen live (Nemotron via OpenRouter, 2026-09-24): a whole-song lyrics call ended after 137s with
    // finish_reason "error"; the same request then completed.
    const f = fakeFetch([{ body: chatReply('{"line":"half', 'error') }, { body: chatReply(JSON.stringify(GOOD)) }]);
    const r = await createLlmClient({ model: 'openrouter:x/y', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0] }).complete(REQ);
    expect(r.json).toEqual(GOOD);
    expect(f.calls).toHaveLength(2);
    const always = fakeFetch([{ body: chatReply('', 'error') }]);
    await expect(createLlmClient({ model: 'openrouter:x/y', agentName: 'a', env: ENV, fetch: always.fn, retryDelaysMs: [0] }).complete(REQ))
      .rejects.toThrow('openrouter reply incomplete (error) (after 2 attempts)');
  });

  it('gives up after the last delay, surfacing the final error', async () => {
    const f = fakeFetch([overloaded]);
    await expect(createLlmClient({ model: 'openrouter:x/y', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0] }).complete(REQ))
      .rejects.toThrow('openrouter API error 503: Upstream error from Nvidia: Service temporarily overloaded (after 3 attempts)');
    expect(f.calls).toHaveLength(3);
  });

  it('never retries a request the provider rejected as invalid (400/401/402)', async () => {
    for (const status of [400, 401, 402]) {
      const f = fakeFetch([{ status, body: { error: { message: 'no' } } }]);
      await expect(createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0] }).complete(REQ)).rejects.toThrow(`groq API error ${status}`);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('never retries a schema-invalid reply (that is the model, not the transport)', async () => {
    const f = fakeFetch([{ body: chatReply('{"nope":1}') }]);
    await expect(createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn, retryDelaysMs: [0, 0] }).complete(REQ)).rejects.toThrow(/violates schema/);
    expect(f.calls).toHaveLength(1);
  });
});

describe('reply validation: JSON, then the schema — whatever the provider promised', () => {
  it('accepts JSON wrapped in one fenced block', async () => {
    const f = fakeFetch([{ body: chatReply('```json\n' + JSON.stringify(GOOD) + '\n```') }]);
    expect((await createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn }).complete(REQ)).json).toEqual(GOOD);
  });

  it('rejects prose', async () => {
    const f = fakeFetch([{ body: chatReply('Here is a verse about the city.') }]);
    await expect(createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn }).complete(REQ)).rejects.toThrow(/groq reply is not JSON/);
  });

  it('rejects JSON that violates the schema, listing every violation', async () => {
    const f = fakeFetch([{ body: chatReply(JSON.stringify({ line: 1, tags: 'a', mood: 'grey', extra: true })) }]);
    await expect(createLlmClient({ model: 'groq:m', agentName: 'a', env: ENV, fetch: f.fn }).complete(REQ)).rejects.toThrow(
      /violates schema test_schema: .*\$\.line must be string.*\$\.bars is required.*\$\.tags must be array.*\$\.mood must be one of dark, light.*\$\.extra is not allowed/,
    );
  });
});

describe('validateJson (the subset the creative schemas use)', () => {
  it('passes a valid value and reports nested paths', () => {
    expect(validateJson(SCHEMA, GOOD)).toEqual([]);
    expect(validateJson(SCHEMA, { ...GOOD, bars: 1.5, tags: ['a', 2] })).toEqual(['$.bars must be integer', '$.tags[1] must be string']);
  });
});

describe('createLlmRunner: the shared LlmRunner the dispatcher calls for every non-`none` model', () => {
  const agent = (name: string, model: string) => ({ name, model, class: 'Creative', domain: 'RECORDS', tools: [], path: `${name}.agent.md`, sections: {} }) as unknown as AgentDefinition;
  const ctx = (a: AgentDefinition) => ({ runId: 'r', agent: a, signal: new AbortController().signal, useTool: async () => null, log: () => {} }) as AgentContext;

  it('runs the program registered for the agent, handing it a client bound to the agent’s model', async () => {
    const f = fakeFetch([{ body: chatReply(JSON.stringify(GOOD)) }]);
    const runner = createLlmRunner({
      programs: { poet: async (_c, input, llm) => ({ output: { input, model: llm.modelRef, reply: (await llm.complete(REQ)).json }, tokensUsed: 1 }) },
      env: ENV, fetch: f.fn,
    });
    const r = await runner(ctx(agent('poet', 'groq:m')), { q: 1 });
    expect(r).toEqual({ output: { input: { q: 1 }, model: { provider: 'groq', model: 'm' }, reply: GOOD }, tokensUsed: 1 });
  });

  it('an LLM agent with no registered program fails loudly (the generic tool-loop runner is not built)', async () => {
    const runner = createLlmRunner({ programs: {}, env: ENV });
    await expect(runner(ctx(agent('suno-researcher', 'claude-sonnet-5')), {})).rejects.toThrow(
      'no LLM program registered for agent suno-researcher (model claude-sonnet-5)',
    );
  });
});
