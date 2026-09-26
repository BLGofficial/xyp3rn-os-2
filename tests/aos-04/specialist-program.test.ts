import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createToolRegistry, type Tool } from '../../core/tool-registry/registry.ts';
import { SPECIALISTS } from '../../research-intelligence/specialists/program.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §5 (R4): the one program the 20 specialists share. FAKE MODEL: replies are scripted from the
// passages the real prompt listed. Real: passage gathering, the prompt, the checks, the writes and the DB's
// verbatim quote check. retrieve_context is replaced by a stub returning no canonical rows, so the test
// needs no embedder; the gate test (Task 8) runs the real one.

let db: TestDb;
let researchRunId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first. Suno weighs early words more.</p></body></html>';
const pageFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('broken')) return new Response('gone', { status: 404 });
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
};

beforeAll(async () => {
  db = await createTestDb('aos04_program', { migrated: true });
  researchRunId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

type Claim = { passage: number; quote: string; claim: string; claim_topic: string; claim_value: string; model_tag: string; confidence: number; confidence_inputs: { basis: string; directness: string } };
const claim = (over: Partial<Claim> = {}): Claim => ({
  passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] the vocal descriptor goes first', claim_topic: 'suno.vocal-descriptor-position',
  claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] one vendor-adjacent page', directness: 'direct' }, ...over,
});
const scripted = (claims: Claim[]) => fakeModel({ override: (schema) => ('claims' in ((schema.properties ?? {}) as object) ? { claims, declined: [] } : undefined) });

/** The live tools with retrieve_context stubbed to "no canonical row" (no embedder in this test). */
const toolsWith = (fetchFn: typeof fetch) => {
  const real = createRuntimeTools({ sql: db.sql, env: {}, fetch: fetchFn });
  const noCanonical: Tool = {
    ...real.get('retrieve_context')!,
    handler: async () => ({ query: '', scope: null, model: 'stub', generation: 'stub', cache: 'miss', items: [], diagnostics: { vectorHits: 0, edgesConsidered: 0, skippedPredicates: [], skippedEntityTypes: [] } }),
  };
  return createToolRegistry([...real.list().filter((t) => t.name !== 'retrieve_context'), noCanonical]);
};
const run = async (model: ReturnType<typeof fakeModel>, input: unknown, fetchFn: typeof fetch = pageFetch) => {
  const deps: DispatchDeps = { sql: db.sql, registry, tools: toolsWith(fetchFn), handlers: HANDLERS, llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }) };
  return dispatch(deps, 'suno-researcher', input, { researchRunId, timeoutMs: 60_000 });
};
type Out = { status: string; evidenceIds: string[]; declined: { claim?: string; reason: string }[]; failedUrls: { url: string; reason: string }[]; passages: number };

describe('registration (R1)', () => {
  it('registers the program for exactly the Research agents with a Scope, all on the OpenRouter free route', () => {
    const roster = registry.list().filter((a) => a.class === 'Research' && a.sections.Scope).map((a) => a.name).sort();
    expect([...SPECIALISTS].sort()).toEqual(roster);
    for (const name of SPECIALISTS) {
      expect(LLM_PROGRAMS[name]).toBeTypeOf('function');
      expect(registry.get(name)!.model).toBe('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free');
    }
  });
});

describe('the specialist program (R4)', () => {
  it('writes a claim whose quote the page contains, with the quote kept', async () => {
    const model = scripted([claim()]);
    const r = await run(model, { question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order', urls: ['https://example.org/suno'] });
    expect(r.status).toBe('success');
    const out = r.output as Out;
    expect(out).toMatchObject({ status: 'done', passages: 1, declined: [], failedUrls: [] });
    const [e] = await db.sql<{ quote: string; claim_topic: string; claim_value: unknown }[]>`
      select quote, claim_topic, claim_value from research_evidence where id = ${out.evidenceIds[0]!}`;
    expect(e).toEqual({ quote: 'Put the vocal descriptor first.', claim_topic: 'suno.vocal-descriptor-position', claim_value: 'first' });
    expect(model.calls[0]!.user).toContain('[1]');
    expect(model.calls[0]!.user).toContain('[FIXTURE] recipe order');
    expect(model.calls[0]!.system).toContain('Suno Researcher');
    expect(model.calls[0]!.url).toContain('openrouter.ai');
  });

  it('declines a fabricated quote, a typographic variant, an unknown passage, a bad topic and a non-JSON value, writing none of them', async () => {
    const model = scripted([
      claim({ quote: 'Put the vocal descriptor last.' }),
      claim({ quote: 'Suno weighs early words more…' }),
      claim({ passage: 7 }),
      claim({ claim_topic: 'Vocal Position' }),
      claim({ claim_value: 'first, obviously' }),
    ]);
    const before = await db.sql`select id from research_evidence`;
    const out = (await run(model, { question: '[FIXTURE] q', urls: ['https://example.org/suno'] })).output as Out;
    expect(out.evidenceIds).toEqual([]);
    expect(out.declined.map((d) => d.reason)).toEqual([
      expect.stringMatching(/quote not found verbatim/),
      expect.stringMatching(/quote not found verbatim/),
      expect.stringMatching(/passage 7 is not one of the 1 given/),
      expect.stringMatching(/claim_topic .* is not dotted kebab/),
      expect.stringMatching(/claim_value is not JSON/),
    ]);
    expect(await db.sql`select id from research_evidence`).toHaveLength(before.length);
  });

  it('skips a failing URL and reports it', async () => {
    const out = (await run(scripted([claim()]), { question: '[FIXTURE] q', urls: ['https://example.org/broken', 'https://example.org/suno'] })).output as Out;
    expect(out.failedUrls).toEqual([{ url: 'https://example.org/broken', reason: expect.stringMatching(/HTTP 404/) }]);
    expect(out.evidenceIds).toHaveLength(1);
  });

  it('with no sources, makes no model call and declines', async () => {
    const model = scripted([claim()]);
    const out = (await run(model, { question: '[FIXTURE] q', urls: ['https://example.org/broken'] })).output as Out;
    expect(out).toMatchObject({ status: 'no-sources', evidenceIds: [], declined: [{ reason: expect.stringMatching(/^no sources/) }] });
    expect(model.calls).toHaveLength(0);
  });

  it('accepts a null intended use and null urls (optional workflow inputs bind as null)', async () => {
    const out = (await run(scripted([]), { question: '[FIXTURE] q', intendedUse: null, urls: null })).output as Out;
    expect(out.status).toBe('no-sources');
  });

  it('caps passages at the budget', async () => {
    // Two ~20 000-char pages exceed the 24 000 budget: the second is dropped.
    const bigFetch: typeof fetch = async () =>
      new Response(`<html><body><p>${`[FIXTURE] word ${randomUUID()} `.repeat(400)}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    const out = (await run(scripted([]), { question: '[FIXTURE] q', urls: [`https://example.org/a-${randomUUID()}`, `https://example.org/b-${randomUUID()}`] }, bigFetch)).output as Out;
    expect(out.passages).toBe(1);
  });
});

describe('passage order', () => {
  it('lists the brief\'s pages before canonical rows, so the owner\'s sources are never crowded out', async () => {
    const real = createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch });
    const canonical: Tool = {
      ...real.get('retrieve_context')!,
      handler: async () => ({ items: [{ ref: { table: 'canonical_prompts', id: randomUUID() }, title: '[FIXTURE] big canonical row', text: 'x'.repeat(23_990), snippet: 'x', source: { id: randomUUID(), uri: 'file:///fixture' } }] }),
    };
    const model = scripted([]);
    const deps: DispatchDeps = {
      sql: db.sql, registry, handlers: HANDLERS, tools: createToolRegistry([...real.list().filter((t) => t.name !== 'retrieve_context'), canonical]),
      llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
    };
    const out = (await dispatch(deps, 'suno-researcher', { question: '[FIXTURE] q', urls: ['https://example.org/suno'] }, { researchRunId, timeoutMs: 60_000 })).output as Out;
    expect(out.passages).toBe(1);
    expect(model.calls[0]!.user).toMatch(/\[1\] \[FIXTURE\] Suno tips <https:\/\/example\.org\/suno>/);
  });
});
