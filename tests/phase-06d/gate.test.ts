import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quoteIdent } from '../../core/db/client.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { decideApproval, runGate } from '../../knowledge/promotion-gate/gate.ts';
import { GATE_STEPS } from '../../knowledge/promotion-gate/decide.ts';
import { resolveContradiction } from '../../research-intelligence/contradictions/engine.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { designExperiment, recordTrial } from '../../research-intelligence/experiments/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import { createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 6D proof: the full state machine on real data. Nothing auto-approves before Phase 12
// (stub-scored experiments), so the end-to-end promotion goes through the human approval queue.

let db: TestDb;
let researchRunId: string;

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

/** Studio-observation evidence → finding → candidate, the path a researcher uses by hand. */
const candidateFor = async (slug: string, topic: string, value: unknown, modelTag: string, note: string) => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: `studio:x3lius/${slug}`, title: note,
    contentSha256: createHash('sha256').update(`${slug}\n${note}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'human:studio' }, {
    research_source_id: src.id, claim: note, model_tag: modelTag, confidence: 0.7, confidence_inputs: { basis: 'studio listening, 10 takes' },
    claim_topic: topic, claim_value: value,
  });
  const f = await recordFinding(db.sql, { researchRunId, claim: note, claim_topic: topic, claim_value: value, model_tag: modelTag, evidenceIds: [ev] });
  return proposeCandidate(db.sql, { findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: slug, title: note, body: note, domain: 'RECORDS' });
};

beforeAll(async () => {
  db = await createTestDb('phase06d_gate', { migrated: true });
  await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  researchRunId = await as('xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('suno-vocal-control', 'Suno vocal control') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, 'How should the Suno v4.5 style prompt order vocal descriptors?') returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
});
afterAll(async () => {
  await db?.drop();
});

describe('candidate → human approval → canonical (end to end)', () => {
  let candidate: string;
  let approvalId: string;

  it('routes a stub-tested candidate to the human queue, recording every step and why', async () => {
    candidate = await candidateFor('suno-v45-vocal-descriptor-first', 'suno.vocal-descriptor-position', 'first', 'suno-v4.5', 'Lead the Suno v4.5 style prompt with the vocal descriptor.');
    const exp = await designExperiment(db.sql, {
      candidateId: candidate, hypothesis: 'Descriptor-first improves timbre adherence on Suno v4.5.',
      variantA: { style: 'dark melodic trap, dark baritone vocal' }, variantB: { style: 'dark baritone vocal, dark melodic trap' }, nPerVariant: 1,
    });
    await recordTrial(db.sql, { experimentId: exp, variant: 'a', trial: 1, output: { take: 'a1' } });
    await recordTrial(db.sql, { experimentId: exp, variant: 'b', trial: 1, output: { take: 'b1' } });

    const r = await runGate(db.sql, candidate);
    expect(r.outcome).toBe('pending_approval');
    expect(r.steps.map((s) => s.step)).toEqual(GATE_STEPS.slice(0, 7));
    expect(r.steps.find((s) => s.step === 'controlled-test')).toMatchObject({ passed: false });
    expect(r.steps.find((s) => s.step === 'validated-rule')!.reason).toMatch(/experiment not validated/);
    approvalId = r.approvalId!;
    const [q] = await db.sql<{ status: string; item_type: string }[]>`select status::text, item_type::text from approval_queue where id = ${approvalId}`;
    expect(q).toEqual({ status: 'pending', item_type: 'knowledge_candidate' });
    expect(await db.sql`select 1 from canonical_prompts where slug = 'suno-v45-vocal-descriptor-first'`).toHaveLength(0);
  });

  it('re-running while pending changes nothing (one queue entry per candidate)', async () => {
    const r = await runGate(db.sql, candidate);
    expect(r).toMatchObject({ outcome: 'pending_approval', approvalId });
    expect(await db.sql`select 1 from approval_queue where item_id = ${candidate}`).toHaveLength(1);
  });

  it('agent roles cannot decide approvals (42501) — only the operator path', async () => {
    for (const role of ['xyp_research', 'xyp_promotion', 'xyp_verifier', 'xyp_runtime']) {
      await expectPgError(() => as(role, (tx) => tx`select xyp_decide_approval(${approvalId}, 'approve', 'agent', 'self-approval')`), '42501');
    }
  });

  it('after operator approval the gate writes canonical + knowledge_versions and propagates', async () => {
    await decideApproval(db.sql, approvalId, { decision: 'approve', approver: 'operator:phase-06d-test', reason: 'Matches studio results; accept pending Phase 12 scoring.' });
    const r = await runGate(db.sql, candidate);
    expect(r.outcome).toBe('promoted');
    expect(r.steps.map((s) => s.step)).toEqual([...GATE_STEPS]);

    const [cp] = await db.sql<{ id: string; version: number; promoted_via: string; model_tag: string; structured: { claims: unknown[]; candidate_id: string } }[]>`
      select id, version, promoted_via::text, model_tag, structured from canonical_prompts where slug = 'suno-v45-vocal-descriptor-first'`;
    expect(cp).toMatchObject({ version: 1, promoted_via: 'gate', model_tag: 'suno-v4.5' });
    expect(cp!.structured.claims).toEqual([{ topic: 'suno.vocal-descriptor-position', value: 'first', model_scope: 'suno-v4.5' }]);
    expect(cp!.structured.candidate_id).toBe(candidate);

    const [kv] = await db.sql<{ candidate_id: string; approval: Record<string, unknown> }[]>`
      select candidate_id, approval from knowledge_versions where canonical_id = ${cp!.id}`;
    expect(kv).toMatchObject({ candidate_id: candidate, approval: { mode: 'human', approver: 'operator:phase-06d-test', approval_id: approvalId } });

    const [c] = await db.sql<{ status: string }[]>`select status::text from knowledge_candidates where id = ${candidate}`;
    expect(c!.status).toBe('promoted');
    const queued = await db.sql<{ kind: string }[]>`select kind::text from regression_queue where promotion_run_id = ${r.promotionRunId} order by 1`;
    expect(queued.map((q) => q.kind)).toEqual(['contradiction-guard', 'retrieval']);
  });

  it('a promoted candidate is terminal: the gate refuses it, and the state machine rejects moving it (23514)', async () => {
    await expect(runGate(db.sql, candidate)).rejects.toThrow(/already promoted/);
    await expectPgError(() => as('xyp_promotion', (tx) => tx`update knowledge_candidates set status = 'proposed' where id = ${candidate}`), '23514');
  });

  it('a decided approval is sealed: the operator cannot re-decide it', async () => {
    await expect(decideApproval(db.sql, approvalId, { decision: 'reject', approver: 'operator:phase-06d-test', reason: 'second thoughts' }))
      .rejects.toThrow(/is not pending/);
  });

  it('the promoted rule now guards canonical state: a same-version conflicting finding is caught', async () => {
    const c2 = await candidateFor('suno-v45-vocal-descriptor-last', 'suno.vocal-descriptor-position', 'last', 'suno-v4.5', 'On Suno v4.5 put the vocal descriptor last.');
    const r = await runGate(db.sql, c2);
    expect(r.outcome).toBe('blocked');
    const [ct] = await db.sql<{ target_type: string; slug: string }[]>`
      select c.target_type::text, cp.slug from contradictions c join canonical_prompts cp on cp.id = c.target_id
      join knowledge_candidates kc on kc.finding_id = c.finding_id where kc.id = ${c2}`;
    expect(ct).toEqual({ target_type: 'canonical_prompt', slug: 'suno-v45-vocal-descriptor-first' });
    expect(await db.sql`select 1 from canonical_prompts where slug = 'suno-v45-vocal-descriptor-last'`).toHaveLength(0);
  });
});

describe('other outcomes', () => {
  it('blocks a candidate that contradicts live canonical knowledge — no queue entry, no write', async () => {
    const c = await candidateFor('x3lius-voice-soft-pop', 'x3lius.voice-reference', ['soft pop ballad', 'gentle', 'English only'], 'model-agnostic', 'X3LIUS as a soft pop ballad voice.');
    const r = await runGate(db.sql, c);
    expect(r).toMatchObject({ outcome: 'blocked', approvalId: undefined });
    expect(await db.sql`select 1 from approval_queue where item_id = ${c}`).toHaveLength(0);
    const [run] = await db.sql<{ outcome: string }[]>`select outcome::text from promotion_runs where id = ${r.promotionRunId}`;
    expect(run!.outcome).toBe('blocked');
  });

  it('an operator rejection rejects the candidate; nothing is written', async () => {
    const c = await candidateFor('suno-v5-negative-prompt-no-reverb', 'suno.negative-prompt.reverb', 'exclude', 'suno-v5', 'On Suno v5 exclude reverb in the negative prompt.');
    const pending = await runGate(db.sql, c);
    await decideApproval(db.sql, pending.approvalId!, { decision: 'reject', approver: 'operator:phase-06d-test', reason: 'Single observation; needs more takes.' });
    const r = await runGate(db.sql, c);
    expect(r.outcome).toBe('rejected');
    const [row] = await db.sql<{ status: string }[]>`select status::text from knowledge_candidates where id = ${c}`;
    expect(row!.status).toBe('rejected');
    expect(await db.sql`select 1 from canonical_prompts where slug = 'suno-v5-negative-prompt-no-reverb'`).toHaveLength(0);
  });

  it('never overwrites: a second promotion of the same slug is version 2, version 1 untouched', async () => {
    const [before] = await db.sql<{ id: string; body: string }[]>`select id, body from canonical_prompts where slug = 'suno-v45-vocal-descriptor-first' and version = 1`;
    const c = await candidateFor('suno-v45-vocal-descriptor-first', 'suno.vocal-descriptor-position', 'first', 'suno-v4.5', 'Corroborated: descriptor-first on Suno v4.5, second session.');
    // The still-proposed 'descriptor-last' candidate conflicts with this one, so it starts blocked;
    // the verifier resolves that (6C) before the gate will look at it.
    expect((await runGate(db.sql, c)).outcome).toBe('blocked');
    const open = await db.sql<{ id: string }[]>`
      select ct.id from contradictions ct join knowledge_candidates kc on kc.finding_id = ct.finding_id
      where kc.id = ${c} and ct.status = 'open'`;
    expect(open).toHaveLength(1);
    await resolveContradiction(db.sql, open[0]!.id, { method: 'manual', reason: 'The descriptor-last candidate is itself blocked by canonical v1; this one agrees with it.' });
    const pending = await runGate(db.sql, c);
    expect(pending.outcome).toBe('pending_approval');
    await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-06d-test', reason: 'Second session corroborates.' });
    const r = await runGate(db.sql, c);
    expect(r.outcome).toBe('promoted');
    const rows = await db.sql<{ id: string; version: number; body: string }[]>`
      select id, version, body from canonical_prompts where slug = 'suno-v45-vocal-descriptor-first' order by version`;
    expect(rows.map((x) => x.version)).toEqual([1, 2]);
    expect(rows[0]).toEqual({ id: before!.id, version: 1, body: before!.body });
  });
});
