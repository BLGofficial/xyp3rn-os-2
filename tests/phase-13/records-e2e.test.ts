import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decideQueueItem } from '../../knowledge/promotion-gate/gate.ts';
import { replaceSplits } from '../../records/ops/splits.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedCreative, SHA } from '../helpers/records-fixture.ts';

// Phase 13 proof (end to end): catalog → splits with an UNASSIGNED share → Rights flags → Calendar
// refuses → fix splits → Calendar queues → operator approves → scheduled.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const deps = (): DispatchDeps => ({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS });
const run = (agent: string, input: unknown) => dispatch(deps(), agent, input, { timeoutMs: 60_000 });
const noRerun = async () => { throw new Error('no gate re-run for a release'); };

beforeAll(async () => {
  db = await createTestDb('phase13_e2e', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

describe('PROOF: a two-track EP from registration to scheduled', () => {
  it('runs the whole path, and every write is audited', async () => {
    const first = await run('records-catalog', { release: { title: 'Night Drive', kind: 'ep' }, track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId }, artifactIds: [fx.lyricsId, fx.promptId] } });
    const releaseId = (first.output as { release: { id: string } }).release.id;
    const t1 = (first.output as { track: { id: string } }).track.id;
    const second = await run('records-catalog', { releaseId, track: { title: 'Wet Asphalt', position: 2, source: { masterUri: 'file:///masters/wet-asphalt.wav', masterSha256: SHA }, mixReportId: fx.mixReportId } });
    const t2 = (second.output as { track: { id: string } }).track.id;

    await replaceSplits(db.sql, t1, [{ payee: 'X3LIUS', role: 'writer', percentage: 50 }, { payee: 'Producer A', role: 'producer', percentage: 50 }]);
    await replaceSplits(db.sql, t2, [{ payee: 'X3LIUS', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }]);

    const flagged = await run('records-rights-splits', { releaseId });
    expect(flagged.output).toMatchObject({ schedulable: false, flagId: expect.any(String) });
    const refused = await run('records-release-calendar', { releaseId, releaseDate: '2026-12-04' });
    expect(refused.status).toBe('error');
    expect(refused.error).toMatch(/track 2: UNASSIGNED share of 25%/);

    await replaceSplits(db.sql, t2, [{ payee: 'X3LIUS', role: 'writer', percentage: 75 }, { payee: 'Publisher B', role: 'publisher', percentage: 25 }]);
    expect((await run('records-rights-splits', { releaseId })).output).toMatchObject({ schedulable: true });
    const queued = await run('records-release-calendar', { releaseId, releaseDate: '2026-12-04' });
    const approvalId = (queued.output as { approvalId: string }).approvalId;

    const decided = await decideQueueItem(db.sql, approvalId, { decision: 'approve', approver: 'operator:phase-13-proof', reason: 'splits complete, date confirmed' }, noRerun);
    expect(decided.release).toEqual({ id: releaseId, status: 'scheduled' });

    const audit = await db.sql<{ table_name: string; actor: string; n: number }[]>`
      select table_name, actor, count(*)::int as n from audit_log
      where table_name in ('releases','rights_splits','tracks') group by 1, 2 order by 1, 2`;
    expect(audit.map((a) => [a.table_name, a.actor])).toEqual([
      ['releases', 'service_role'], ['releases', 'xyp_calendar'], ['releases', 'xyp_catalog'],
      ['rights_splits', 'service_role'], ['tracks', 'xyp_catalog'],
    ]);
  });
});
