import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideQueueItem, pendingApprovals } from '../../knowledge/promotion-gate/gate.ts';
import { replaceSplits } from '../../records/ops/splits.ts';
import { createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { seedRelease } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 4): the operator path — splits, the approval queue, scheduling decisions.
let db: TestDb;
beforeAll(async () => { db = await createTestDb('phase13_operator', { migrated: true }); });
afterAll(async () => db?.drop());

const propose = async (releaseId: string) => (await db.sql.begin(async (tx) => {
  await tx.unsafe('set local role xyp_calendar');
  return tx<{ id: string }[]>`select public.xyp_request_release_schedule(${releaseId}) as id`;
}))[0]!.id;
const noRerun = async () => { throw new Error('the gate must not re-run for a release_schedule'); };

describe('operator: splits and scheduling decisions', () => {
  it('replaces splits as service_role; a set that is not 100 is refused whole', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    expect(await replaceSplits(db.sql, t!, [{ payee: 'A', role: 'writer', percentage: 50 }, { payee: 'B', role: 'producer', percentage: 50 }])).toBe(2);
    await expectPgError(() => replaceSplits(db.sql, t!, [{ payee: 'A', role: 'writer', percentage: 90 }]), '23514');
    expect(await db.sql`select payee from rights_splits where track_id = ${t!} order by payee`).toEqual([{ payee: 'A' }, { payee: 'B' }]);
  });

  it('the queue shows a release_schedule request; approve schedules it without re-running the gate', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const id = await propose(releaseId);
    expect((await pendingApprovals(db.sql)).find((p) => p.approval_id === id)).toMatchObject({ item_type: 'release_schedule', schedule: { release_id: releaseId, release_date: '2026-12-01' } });
    const out = await decideQueueItem(db.sql, id, { decision: 'approve', approver: 'operator:test', reason: 'date confirmed' }, noRerun);
    expect(out).toEqual({ approval: 'approved', itemType: 'release_schedule', release: { id: releaseId, status: 'scheduled' } });
  });

  it('reject sends the release back to draft', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const id = await propose(releaseId);
    const out = await decideQueueItem(db.sql, id, { decision: 'reject', approver: 'operator:test', reason: 'move the date' }, noRerun);
    expect(out).toMatchObject({ release: { id: releaseId, status: 'draft' } });
  });
});

describe('final review fixes: decide and apply are one transaction (I2)', () => {
  it('an approval that cannot be applied is not recorded; a rejection of a cancelled release is', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const id = await propose(releaseId);
    await db.sql`update releases set status = 'cancelled' where id = ${releaseId}`;
    await expect(decideQueueItem(db.sql, id, { decision: 'approve', approver: 'operator:test', reason: 'go' }, noRerun)).rejects.toThrow(/no longer pending_schedule/);
    expect((await db.sql`select status::text from approval_queue where id = ${id}`)[0]!.status).toBe('pending');
    const out = await decideQueueItem(db.sql, id, { decision: 'reject', approver: 'operator:test', reason: 'release cancelled' }, noRerun);
    expect(out).toMatchObject({ approval: 'rejected', release: { id: releaseId, status: 'cancelled' } });
  });
});
