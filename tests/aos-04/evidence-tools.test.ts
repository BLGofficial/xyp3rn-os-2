import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertCanonical } from '../helpers/research-fixture.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §5 step 4: fetch_source keeps the page's text; write_evidence requires a quote from an agent and
// cites either a fetched page or an ingested source through a canonical row; the DB verifies the quote.

let db: TestDb;
let researchRunId: string;
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const fetchStub: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('missing')) return new Response('nope', { status: 404 });
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
};
const ctx = (agentName = 'suno-researcher') => ({ runId: randomUUID(), agentName, researchRunId, log: () => {} });

beforeAll(async () => {
  db = await createTestDb('aos04_evidence', { migrated: true });
  researchRunId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const tools = () => createRuntimeTools({ sql: db.sql, env: {}, fetch: fetchStub });
const call = (name: string, args: unknown, c = ctx()) => tools().get(name)!.handler(c as never, args);

describe('fetch_source', () => {
  it('stores the text it read, so a quote can be re-verified later', async () => {
    const r = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string; text: string };
    expect(r.text).toContain('Put the vocal descriptor first.');
    const [s] = await db.sql<{ text: string }[]>`select text from research_sources where id = ${r.research_source_id}`;
    expect(s!.text).toContain('Put the vocal descriptor first.');
  });

  it('fails loudly on a non-2xx page', async () => {
    await expect(call('fetch_source', { url: 'https://example.org/missing' })).rejects.toThrow(/HTTP 404/);
  });
});

describe('write_evidence', () => {
  const base = { claim: '[FIXTURE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: 'first', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: 'fixture', directness: 'direct' } };

  it('writes a quoted claim against a fetched page', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    const r = (await call('write_evidence', { ...base, research_source_id: page.research_source_id, quote: 'Put the vocal descriptor first.' })) as { evidence_id: string };
    const [e] = await db.sql<{ quote: string; specialist: string }[]>`select quote, specialist from research_evidence where id = ${r.evidence_id}`;
    expect(e).toEqual({ quote: 'Put the vocal descriptor first.', specialist: 'suno-researcher' });
  });

  it('refuses an agent write without a quote, and one with both or neither source', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    await expect(call('write_evidence', { ...base, research_source_id: page.research_source_id })).rejects.toThrow(/quote is required/);
    await expect(call('write_evidence', { ...base, quote: 'x' })).rejects.toThrow(/exactly one of research_source_id or canonical_prompt_id/);
    await expect(call('write_evidence', { ...base, quote: 'x', research_source_id: page.research_source_id, canonical_prompt_id: randomUUID() }))
      .rejects.toThrow(/exactly one of research_source_id or canonical_prompt_id/);
  });

  it('refuses a quote the page does not contain (the DB check)', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    await expect(call('write_evidence', { ...base, research_source_id: page.research_source_id, quote: 'Put the vocal descriptor last.' }))
      .rejects.toThrow(/quote not found verbatim/);
  });

  it('cites an ingested source through a canonical row and verifies the quote in its body', async () => {
    const c = await insertCanonical(db.sql, { slug: 'fixture-rules', body: '[FIXTURE] Lead with the vocal descriptor.' });
    const r = (await call('write_evidence', { ...base, canonical_prompt_id: c.canonicalPromptId, quote: 'Lead with the vocal descriptor.' })) as { evidence_id: string; research_source_id: string };
    const [s] = await db.sql<{ kind: string; source_id: string }[]>`select kind::text, source_id from research_sources where id = ${r.research_source_id}`;
    expect(s).toEqual({ kind: 'ingested', source_id: c.sourceId });
  });

  it('refuses a canonical row with no source (not citable)', async () => {
    const c = await insertCanonical(db.sql, { slug: 'fixture-nosource', body: '[FIXTURE] body', withSource: false });
    await expect(call('write_evidence', { ...base, canonical_prompt_id: c.canonicalPromptId, quote: 'body' })).rejects.toThrow(/has no source; not citable/);
  });
});
