import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { synthesizeRun } from '../../research-intelligence/synthesis/synthesize.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §6: synthesis groups a run's evidence by (topic, value, model tag) into findings through the
// existing recordFinding; two values for one topic are two findings; evidence without a topic is listed.

let db: TestDb;
let runId: string;
beforeAll(async () => {
  db = await createTestDb('aos04_synth', { migrated: true });
  runId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const ev = async (specialist: string, topic: string | undefined, value: unknown, confidence: number, claim: string, tag = 'suno-v5') => {
  const text = `[FIXTURE] ${claim} ${randomUUID()}`;
  const src = await registerResearchSource(db.sql, { researchRunId: runId, kind: 'web', uri: `https://example.org/${randomUUID()}`, title: '[FIXTURE] page', contentSha256: createHash('sha256').update(text).digest('hex'), text });
  return writeEvidence(db.sql, { researchRunId: runId, agentRunId: null, specialist }, {
    research_source_id: src.id, claim: `[FIXTURE] ${claim}`, model_tag: tag, confidence, confidence_inputs: { basis: 'fixture' }, quote: text.slice(0, 20),
    ...(topic ? { claim_topic: topic, claim_value: value } : {}),
  });
};

describe('synthesizeRun', () => {
  it('writes one finding per (topic, value, tag), claim text from the most confident evidence; lists untopical evidence', async () => {
    const a = await ev('suno-researcher', 'suno.vocal-descriptor-position', 'first', 0.5, 'first, weakly');
    const b = await ev('prompt-engineering-researcher', 'suno.vocal-descriptor-position', 'first', 0.8, 'first, strongly');
    const c = await ev('genre-style-researcher', 'suno.vocal-descriptor-position', 'last', 0.4, 'last');
    const d = await ev('suno-researcher', undefined, undefined, 0.3, 'no topic');
    const r = await synthesizeRun(db.sql, runId);
    expect(r.unsynthesized).toEqual([d]);
    expect(r.findings.map((f) => [...f.evidenceIds].sort())).toEqual(expect.arrayContaining([[a, b].sort(), [c]]));
    const rows = await db.sql<{ claim: string; claim_value: unknown }[]>`select claim, claim_value from research_findings where research_run_id = ${runId} order by claim`;
    expect(rows.map((x) => x.claim_value).sort()).toEqual(['first', 'last']);
    expect(rows.find((x) => x.claim_value === 'first')!.claim).toMatch(/^\[FIXTURE\] first, strongly/);
  });

  it('keeps different model tags apart (recordFinding refuses a mixed-tag finding)', async () => {
    const v4 = await ev('suno-researcher', 'suno.meta-tag-brackets', 'square', 0.5, 'square on v4.5', 'suno-v4.5');
    const v5 = await ev('suno-researcher', 'suno.meta-tag-brackets', 'square', 0.5, 'square on v5', 'suno-v5');
    const r = await synthesizeRun(db.sql, runId);
    expect(r.findings.map((f) => f.evidenceIds)).toEqual(expect.arrayContaining([[v4], [v5]]));
  });

  it('is idempotent: a second call writes nothing new', async () => {
    const before = await db.sql`select id from research_findings where research_run_id = ${runId}`;
    const r = await synthesizeRun(db.sql, runId);
    expect(r.findings).toEqual([]);
    expect(await db.sql`select id from research_findings where research_run_id = ${runId}`).toHaveLength(before.length);
  });
});
