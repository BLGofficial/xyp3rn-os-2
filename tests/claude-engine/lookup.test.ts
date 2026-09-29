import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerLookup } from '../../core/orchestrator/lookup.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('claude_engine_lookup', { migrated: true }); });
afterAll(async () => { await db?.drop(); });

describe('answerLookup: read-only answers from stored data', () => {
  it('says nothing is stored, for every topic, on an empty DB', async () => {
    for (const q of [
      'how many approvals are pending',
      'what releases are scheduled',
      'status of the last workflow run',
      'status of the last research run',
      'what did the latest research find',
    ]) {
      expect(await answerLookup(db.sql, q), q).toEqual({ reply: expect.stringMatching(/^Nothing stored yet/), source: 'none' });
    }
  });

  it('answers every branch from stored data, honestly, without a model', async () => {
    await db.sql`insert into approval_queue (item_type, item_id, request) values ('knowledge_candidate', ${randomUUID()}, '{}'::jsonb)`;

    // Schema note: public.releases guards status via trg_releases_guard (migration
    // 20260925115000) — a fresh row must be inserted as 'draft' (only xyp_apply_release_decision,
    // via a full tracks/splits/approval workflow, can move it to 'scheduled'). That workflow is out
    // of scope for this read-only lookup test, so the fixture and expected reply use 'draft' in
    // place of the brief's literal 'scheduled', while still exercising the same template path.
    const [release] = await db.sql<{ id: string }[]>`insert into releases (title, kind, status, release_date) values ('Night Drive', 'single', 'draft', '2026-11-01') returning id`;
    await db.sql`insert into release_schedule_requests (release_id, release_date) values (${release!.id}, '2026-11-01')`;

    await db.sql`
      insert into workflow_runs (workflow_name, spec_sha256, spec, input, status, failed_step, error_detail, completed_at)
      values ('publish-release', repeat('a', 64), '{}'::jsonb, '{}'::jsonb, 'error', 'notify', 'boom', now())`;
    await db.sql`
      insert into agent_runs (agent_name, input, status, error_detail, completed_at)
      values ('mercury', '{}'::jsonb, 'error', 'boom', now())`;

    const [project] = await db.sql<{ id: string }[]>`insert into research_projects (slug, title) values ('vocals-mix', 'Vocals mix') returning id`;
    const [question] = await db.sql<{ id: string }[]>`insert into research_questions (project_id, question) values (${project!.id}, 'what compression works for vocals?') returning id`;
    // Two separate inserts (not one multi-row statement) so created_at orders them deterministically.
    const [runA] = await db.sql<{ id: string }[]>`
      insert into research_runs (question_id, status, selected_specialists, completed_at)
      values (${question!.id}, 'success', ARRAY['a', 'b', 'c', 'd'], now()) returning id`;
    await db.sql`
      insert into research_runs (question_id, status, selected_specialists, error_detail, completed_at)
      values (${question!.id}, 'error', ARRAY['e', 'f'], 'timeout', now())`;

    await db.sql`
      insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
      values (${runA!.id}, 'Upcoming releases have pending mastering tasks flagged by engineers', 'haiku', 0.800, '{}'::jsonb, 'mixing.vocal-mastering', '{}'::jsonb)`;

    let called = false;
    const spy = async () => { called = true; return 'x'; };

    expect(await answerLookup(db.sql, 'how many approvals are pending', spy))
      .toEqual({ reply: '1 approval is pending: knowledge_candidate.', source: 'template' });

    expect(await answerLookup(db.sql, 'what releases are pending', spy))
      .toEqual({ reply: 'Latest releases: Night Drive (single, draft, 2026-11-01). 1 schedule request(s) pending.', source: 'template' });

    expect(await answerLookup(db.sql, 'status of the last workflow run', spy))
      .toEqual({ reply: 'Recent runs: publish-release error at notify. 1 agent run(s) failed in the last 24 hours.', source: 'template' });

    expect(await answerLookup(db.sql, 'status of the last research run', spy))
      .toEqual({ reply: 'Latest research runs: error (2 specialists); success (4 specialists).', source: 'template' });

    // "find" routes to research findings even though the question also names releases/pending —
    // it must not be answered as an approvals or releases lookup.
    expect(await answerLookup(db.sql, 'what did the research find about pending releases'))
      .toEqual({ reply: 'Latest findings: Upcoming releases have pending mastering tasks flagged by engineers', source: 'template' });

    // Keywords given, nothing stored matches them: say so honestly, never substitute an unrelated row.
    expect(await answerLookup(db.sql, 'what did the research find about tempo drift issues'))
      .toEqual({ reply: 'No stored findings match that yet. Send it as a normal request to start a research run.', source: 'none' });

    expect(called).toBe(false);
  });

  it('writes nothing, across every table it reads and every branch', async () => {
    const tableCounts = () => db.sql`select
      (select count(*) from research_findings)::int research_findings,
      (select count(*) from approval_queue)::int approval_queue,
      (select count(*) from releases)::int releases,
      (select count(*) from release_schedule_requests)::int release_schedule_requests,
      (select count(*) from research_runs)::int research_runs,
      (select count(*) from workflow_runs)::int workflow_runs,
      (select count(*) from agent_runs)::int agent_runs`;

    const before = await tableCounts();
    await answerLookup(db.sql, 'what did the latest research find about vocals');
    await answerLookup(db.sql, 'how many approvals are pending');
    await answerLookup(db.sql, 'what releases are pending');
    await answerLookup(db.sql, 'status of the last workflow run');
    await answerLookup(db.sql, 'status of the last research run');
    await answerLookup(db.sql, 'what did the research find about tempo drift issues');
    expect(await tableCounts()).toEqual(before);
  });
});
