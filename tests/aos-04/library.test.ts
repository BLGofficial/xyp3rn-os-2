import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGate } from '../../knowledge/promotion-gate/gate.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { decideFinding, decidePromotion, promoteFinding } from '../../research-intelligence/library.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { synthesizeRun } from '../../research-intelligence/synthesis/synthesize.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §7 (R3): accept/reject into the Findings Library (never canonical), promotion only from an
// accepted finding, the gate's pending approval decided by the owner.

let db: TestDb;
let runId: string;
let findingId: string;
const canonicalCount = async () => Number((await db.sql<{ n: string }[]>`select count(*) as n from canonical_prompts`)[0]!.n);

/** One quoted piece of evidence on a fetched page, synthesized into its own finding. */
const finding = async (topic: string): Promise<string> => {
  const text = `[FIXTURE] Put the vocal descriptor first. ${randomUUID()}`;
  const src = await registerResearchSource(db.sql, { researchRunId: runId, kind: 'web', uri: `https://example.org/${randomUUID()}`, title: '[FIXTURE] a', contentSha256: createHash('sha256').update(text).digest('hex'), text });
  await writeEvidence(db.sql, { researchRunId: runId, agentRunId: null, specialist: 'suno-researcher' }, {
    research_source_id: src.id, claim: '[FIXTURE] descriptor first', model_tag: 'suno-v5', confidence: 0.7, confidence_inputs: { basis: 'fixture' },
    claim_topic: topic, claim_value: 'first', quote: 'Put the vocal descriptor first.',
  });
  return (await synthesizeRun(db.sql, runId)).findings[0]!.findingId;
};

beforeAll(async () => {
  db = await createTestDb('aos04_library', { migrated: true });
  runId = await insertResearchRun(db.sql);
  findingId = await finding('suno.vocal-descriptor-position');
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const candidate = (id = findingId) => ({ findingId: id, proposed_kind: 'canonical_prompt' as const, target_slug: 'suno-vocal-descriptor-first', title: '[FIXTURE] Lead with the vocal descriptor', body: '[FIXTURE] Put the vocal descriptor first in a Suno style prompt.', domain: 'RECORDS' as const });

describe('the Findings Library (R3)', () => {
  it('refuses promotion of a finding the owner has not accepted', async () => {
    await expect(promoteFinding(db.sql, candidate())).rejects.toThrow(/only an accepted finding can be promoted; finding .* is undecided/);
  });

  it('refuses promotion of a rejected finding', async () => {
    const rejected = await finding('suno.meta-tag-position');
    await decideFinding(db.sql, rejected, { decision: 'reject', approver: 'owner', reason: '[FIXTURE] one page is not enough' });
    await expect(promoteFinding(db.sql, candidate(rejected))).rejects.toThrow(/is reject/);
    expect(await db.sql`select 1 from knowledge_candidates where finding_id = ${rejected}`).toHaveLength(0);
  });

  it('accepts once, touching no canonical table; a second decision is refused in the owner\'s terms', async () => {
    const before = await canonicalCount();
    const d = await decideFinding(db.sql, findingId, { decision: 'accept', approver: 'owner', reason: '[FIXTURE] reusable' });
    expect(d.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(decideFinding(db.sql, findingId, { decision: 'reject', approver: 'owner', reason: '[FIXTURE] no' })).rejects.toThrow(/already decided/);
    expect(await canonicalCount()).toBe(before);
    const [lib] = await db.sql<{ canonical_status: string }[]>`select canonical_status from findings_library where finding_id = ${findingId}`;
    expect(lib!.canonical_status).toBe('none');
  });

  it('promotes an accepted finding to a pending approval, still touching no canonical table, then the owner approves', async () => {
    const before = await canonicalCount();
    const p = await promoteFinding(db.sql, candidate());
    expect(p.gate.outcome).toBe('pending_approval');
    expect(await canonicalCount()).toBe(before);
    const [pending] = await db.sql<{ canonical_status: string }[]>`select canonical_status from findings_library where finding_id = ${findingId}`;
    expect(pending!.canonical_status).toBe('candidate');
    const d = await decidePromotion(db.sql, p.gate.approvalId!, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] make it canonical' }, (id) => runGate(db.sql, id));
    expect(d.approval).toBe('approved');
    expect(await canonicalCount()).toBe(before + 1);
    const [lib] = await db.sql<{ canonical_status: string }[]>`select canonical_status from findings_library where finding_id = ${findingId}`;
    expect(lib!.canonical_status).toBe('promoted');
  });
});
