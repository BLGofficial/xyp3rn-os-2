import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertArtifact, insertRun, insertTake } from '../helpers/records-fixture.ts';
import { insertEvidence, insertResearchRun } from '../helpers/tech-fixture.ts';
import { ANALYSIS } from '../helpers/trace-fixture.ts';

// Phase 14 proof (part 1): trace_analyses and rd_backlog on a throwaway migrated database. Fixture
// rows are inserted directly under the role that owns each write; no agent or model runs here.

let db: TestDb;
let researchRunId: string;
beforeAll(async () => {
  db = await createTestDb('phase14_tech_db', { migrated: true });
  researchRunId = await insertResearchRun(db.sql);
});
afterAll(async () => {
  await db?.drop();
});

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => asCommitted(db.sql, role, fn);
const code = (c: string) => ({ code: c });
const json = (v: unknown) => v as postgres.JSONValue;

const analysis = async (body: unknown = ANALYSIS, over: { schemaId?: string; takeId?: string | null } = {}): Promise<string> => {
  const runId = await insertRun(db.sql, 'tech-audio-tools', 'Execution');
  return as('xyp_trace_intake', async (tx) => (await tx<{ id: string }[]>`
    insert into trace_analyses (schema_id, body, take_id, agent_run_id)
    values (${over.schemaId ?? 'trace.analysis/v1'}, ${tx.json(json(body))}, ${over.takeId ?? null}, ${runId}) returning id`)[0]!.id);
};
const link = (analysisId: string, artifactId: string | null, role = 'xyp_trace_intake') =>
  as(role, (tx) => tx`update trace_analyses set mix_report_artifact_id = ${artifactId} where id = ${analysisId}`);
const mixReport = (analysisBody: unknown = ANALYSIS) =>
  insertArtifact(db.sql, 'x3lius.mix-report/v1', { stage: 'mix', analysis: analysisBody, checks: [], unset: [] });

describe('trace_analyses: the measurement as received, linked once to the report that checked it', () => {
  it('stores an analysis, optionally with its take; schema_id must be the body\'s own schema (23514)', async () => {
    const { takeId } = await insertTake(db.sql);
    const id = await analysis(ANALYSIS, { takeId });
    expect(await db.sql`select take_id from trace_analyses where id = ${id}`).toEqual([{ take_id: takeId }]);
    await expect(analysis(ANALYSIS, { schemaId: 'trace.analysis/v2' })).rejects.toMatchObject(code('23514'));
    await expect(analysis([ANALYSIS])).rejects.toMatchObject(code('23514'));
  });

  it('links its mix report once; the report must be a mix report of this very analysis (23514); relinking is 55000', async () => {
    const id = await analysis();
    const lyrics = await insertArtifact(db.sql, 'x3lius.lyrics/v2', { fixture: true });
    await expect(link(id, lyrics)).rejects.toMatchObject(code('23514'));
    const other = await mixReport({ ...ANALYSIS, subject: { stage: 'mix', label: '[FIXTURE] another render' } });
    await expect(link(id, other)).rejects.toMatchObject(code('23514'));
    const report = await mixReport();
    await link(id, report);
    expect(await db.sql`select mix_report_artifact_id from trace_analyses where id = ${id}`).toEqual([{ mix_report_artifact_id: report }]);
    await expect(link(id, await mixReport())).rejects.toMatchObject(code('55000'));
    await expect(link(id, null)).rejects.toMatchObject(code('55000'));
  });

  it('is append-only apart from that link, for every role, the owner included (55000)', async () => {
    const id = await analysis();
    await expect(db.sql`update trace_analyses set body = '{}' where id = ${id}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from trace_analyses where id = ${id}`).rejects.toMatchObject(code('55000'));
  });

  it('grants: xyp_trace_intake writes; xyp_runtime and service_role read; nobody else (42501)', async () => {
    const id = await analysis();
    for (const role of ['xyp_runtime', 'service_role']) {
      await expect(as(role, (tx) => tx`select 1 from trace_analyses where id = ${id}`)).resolves.toHaveLength(1);
    }
    const runId = await insertRun(db.sql, 'tech-audio-tools', 'Execution');
    for (const role of ['xyp_runtime', 'service_role', 'xyp_catalog', 'xyp_planner', 'anon', 'authenticated']) {
      await expect(as(role, (tx) => tx`insert into trace_analyses (schema_id, body, agent_run_id) values ('trace.analysis/v1', ${tx.json(json(ANALYSIS))}, ${runId})`))
        .rejects.toMatchObject(code('42501'));
    }
    await expect(as('xyp_trace_intake', (tx) => tx`update trace_analyses set take_id = null where id = ${id}`)).rejects.toMatchObject(code('42501'));
    await expect(as('anon', (tx) => tx`select 1 from trace_analyses`)).rejects.toMatchObject(code('42501'));
  });
});

type Item = { title: string; component?: string; proposal?: string; rationale?: string; evidence?: readonly string[] };
let seq = 0;
/** Writes one backlog item and its evidence links in ONE transaction, as role. */
const item = async (it: Item, role = 'xyp_planner'): Promise<string> => {
  const runId = await insertRun(db.sql, 'tech-r-and-d', 'Planning');
  return as(role, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into rd_backlog (title, component, proposal, rationale, model, agent_run_id)
      values (${it.title}, ${it.component ?? 'audio-tools'}, ${it.proposal ?? '[FIXTURE] build it'}, ${it.rationale ?? '[FIXTURE] because'}, 'fake:model', ${runId})
      returning id`;
    for (const e of it.evidence ?? []) await tx`insert into rd_backlog_evidence (rd_backlog_id, research_evidence_id) values (${row!.id}, ${e})`;
    return row!.id;
  });
};
const frontier = () => insertEvidence(db.sql, researchRunId, `new stem-separation plugin ${++seq}`);

describe('rd_backlog: proposals only, each citing the Frontier Scanner, each queued for a human', () => {
  it('an item citing frontier evidence commits and queues exactly one pending rd_backlog_item approval', async () => {
    const e = await frontier();
    const id = await item({ title: '[FIXTURE] Stem-aware TRACE meter', evidence: [e] });
    expect(await db.sql`select item_type::text, status::text from approval_queue where item_id = ${id}`).toEqual([{ item_type: 'rd_backlog_item', status: 'pending' }]);
    const [v] = await as('service_role', (tx) => tx<{ status: string; evidence_ids: string[] }[]>`select status, evidence_ids from rd_backlog_items where id = ${id}`);
    expect(v).toEqual({ status: 'pending', evidence_ids: [e] });
  });

  it('an item citing no evidence is refused at commit (23514), and nothing is queued', async () => {
    await expect(item({ title: '[FIXTURE] Uncited idea' })).rejects.toMatchObject(code('23514'));
    expect(await db.sql`select 1 from rd_backlog where title = '[FIXTURE] Uncited idea'`).toHaveLength(0);
    expect(await db.sql`select 1 from approval_queue a join rd_backlog r on r.id = a.item_id where r.title = '[FIXTURE] Uncited idea'`).toHaveLength(0);
  });

  it('cites only the Frontier Scanner\'s evidence (23514)', async () => {
    const other = await insertEvidence(db.sql, researchRunId, 'a Suno changelog line', 'suno-researcher');
    await expect(item({ title: '[FIXTURE] Off-scope idea', evidence: [other] })).rejects.toMatchObject(code('23514'));
  });

  it('refuses a repeated title (case-insensitive, 23505), a blank or over-long title, an unknown component (23514)', async () => {
    const e = await frontier();
    await item({ title: '[FIXTURE] Loudness history view', evidence: [e] });
    await expect(item({ title: '  [fixture] LOUDNESS history view ', evidence: [e] })).rejects.toMatchObject(code('23505'));
    await expect(item({ title: '   ', evidence: [e] })).rejects.toMatchObject(code('23514'));
    await expect(item({ title: 'x'.repeat(121), evidence: [e] })).rejects.toMatchObject(code('23514'));
    await expect(item({ title: '[FIXTURE] Wrong component', component: 'marketing', evidence: [e] })).rejects.toMatchObject(code('23514'));
    await expect(item({ title: '[FIXTURE] Blank proposal', proposal: ' ', evidence: [e] })).rejects.toMatchObject(code('23514'));
  });

  it('is immutable for every role, the owner included (55000)', async () => {
    const id = await item({ title: '[FIXTURE] Immutable idea', evidence: [await frontier()] });
    await expect(db.sql`update rd_backlog set title = 'x' where id = ${id}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from rd_backlog where id = ${id}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from rd_backlog_evidence where rd_backlog_id = ${id}`).rejects.toMatchObject(code('55000'));
  });

  it('a human decides: service_role through xyp_decide_approval; the view follows; the planner cannot decide (42501)', async () => {
    const id = await item({ title: '[FIXTURE] Decided idea', evidence: [await frontier()] });
    const [q] = await db.sql<{ id: string }[]>`select id from approval_queue where item_id = ${id}`;
    await expect(as('xyp_planner', (tx) => tx`select xyp_decide_approval(${q!.id}, 'approve', 'planner', 'self-approval')`)).rejects.toMatchObject(code('42501'));
    await as('service_role', (tx) => tx`select xyp_decide_approval(${q!.id}, 'approve', 'operator', '[FIXTURE] ship it')`);
    const [v] = await as('service_role', (tx) => tx<{ status: string; decided_by: string; decision_reason: string }[]>`
      select status, decided_by, decision_reason from rd_backlog_items where id = ${id}`);
    expect(v).toEqual({ status: 'approved', decided_by: 'operator', decision_reason: '[FIXTURE] ship it' });
  });

  it('grants: xyp_planner proposes and reads research; it cannot touch the queue, canonical or research writes (42501)', async () => {
    await expect(as('xyp_planner', (tx) => tx`select 1 from research_evidence e join research_sources s on s.id = e.research_source_id limit 1`)).resolves.toBeDefined();
    await expect(as('xyp_planner', (tx) => tx`select 1 from approval_queue`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_planner', (tx) => tx`insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs) select research_run_id, research_source_id, 'x', 'x', 'x', 0.1, '{}' from research_evidence limit 1`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_planner', (tx) => tx`select 1 from canonical_prompts limit 1`)).rejects.toMatchObject(code('42501'));
    for (const role of ['xyp_runtime', 'service_role', 'anon', 'authenticated']) {
      await expect(item({ title: `[FIXTURE] ${role} idea`, evidence: [await frontier()] }, role)).rejects.toMatchObject(code('42501'));
    }
  });
});
