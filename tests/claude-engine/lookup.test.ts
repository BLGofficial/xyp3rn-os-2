import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerLookup } from '../../core/orchestrator/lookup.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('claude_engine_lookup', { migrated: true }); });
afterAll(async () => { await db?.drop(); });

describe('answerLookup: read-only answers from stored data', () => {
  it('says nothing is stored, for every topic, on an empty DB', async () => {
    for (const q of ['how many approvals are pending', 'what releases are scheduled', 'status of the last workflow run', 'what did the latest research find']) {
      expect(await answerLookup(db.sql, q), q).toEqual({ reply: expect.stringMatching(/^Nothing stored yet/), source: 'none' });
    }
  });

  it('answers pending approvals and releases from templates, without a model', async () => {
    await db.sql`insert into approval_queue (item_type, item_id, request) values ('knowledge_candidate', ${randomUUID()}, '{}'::jsonb)`;
    // Schema note: public.releases now guards status via trg_releases_guard (migration
    // 20260925115000) — a fresh row must be inserted as 'draft' (only xyp_apply_release_decision,
    // via a full tracks/splits/approval workflow, can move it to 'scheduled'). That workflow is
    // out of scope for this read-only lookup test, so the fixture and expected reply use 'draft'
    // in place of the brief's literal 'scheduled', while still exercising the same template path.
    await db.sql`insert into releases (title, kind, status, release_date) values ('Night Drive', 'single', 'draft', '2026-11-01')`;
    let called = false;
    const spy = async () => { called = true; return 'x'; };
    expect(await answerLookup(db.sql, 'how many approvals are pending', spy)).toEqual({ reply: '1 approval is pending: knowledge_candidate.', source: 'template' });
    expect(await answerLookup(db.sql, 'what releases are coming', spy)).toEqual({ reply: 'Latest releases: Night Drive (single, draft, 2026-11-01).', source: 'template' });
    expect(called).toBe(false);
  });

  it('writes nothing', async () => {
    const before = await db.sql`select (select count(*) from workflow_runs)::int w, (select count(*) from agent_runs)::int a, (select count(*) from research_runs)::int r`;
    await answerLookup(db.sql, 'what did the latest research find about vocals');
    expect(await db.sql`select (select count(*) from workflow_runs)::int w, (select count(*) from agent_runs)::int a, (select count(*) from research_runs)::int r`).toEqual(before);
  });
});
