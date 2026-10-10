import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../../../knowledge/promotion-gate/gate.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { insertTake } from '../../../tests/helpers/records-fixture.ts';
import { createAgentRegistry } from '../../agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../orchestrator/dispatch.ts';
import { HANDLERS } from '../../runtime/handlers.ts';
import { createRuntimeTools } from '../../runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../../workflow-engine/engine.ts';
import { JarvisCore } from './JarvisOrchestrator.ts';

// Roadmap item 3, on a throwaway database with every migration: Jarvis can only QUEUE a new split set. The write
// happens after the owner approves, once, and only while the set it was proposed against is still current.

let db: TestDb;
let deps: DispatchDeps;
let core: JarvisCore;
let trackId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const OWNER = { approver: 'owner', reason: 'checked the numbers' };
const versions = async () => (await db.sql<{ v: number; n: number }[]>`select version v, count(*)::int n from rights_splits where track_id = ${trackId} group by 1 order by 1`);

beforeAll(async () => {
  db = await createTestDb('jarvis_split_proposals', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
  core = new JarvisCore({ ...deps, engine: { retrieve: async () => { throw new Error('not used'); } } as never });
  const { takeId } = await insertTake(db.sql);
  const reg = await runWorkflow(deps, loadWorkflow(join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml'), registry), {
    takeId, sourceId: null, release: { title: '[FIXTURE] Split Fix', artist: 'X3LIUS', kind: 'single' }, position: 1, title: null, mixReportArtifactId: null,
  });
  expect(reg, JSON.stringify(reg)).toMatchObject({ status: 'success' });
  trackId = (reg.output as { trackId: string }).trackId;
  const first = await dispatch(deps, 'records-catalog', { splits: { trackId, splits: [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }] } });
  expect(first, JSON.stringify(first)).toMatchObject({ status: 'success' });
});
afterAll(async () => { await db?.drop(); });

describe('rights-split proposals', () => {
  it('queues a valid set without writing anything', async () => {
    const r = await core.interceptAndExecute('cli', { type: 'propose-split', trackId, reason: 'assign the unassigned 30', splits: [{ payee: 'X3LIUS', percentage: 70 }, { payee: 'House', percentage: 30 }] });
    expect(r.status).toBe('PENDING_HUMAN_APPROVAL');
    expect(r.approvalIds).toHaveLength(1);
    expect(await versions()).toEqual([{ v: 1, n: 2 }]);
  });

  it('refuses a set that does not sum to 100, before it is queued', async () => {
    const r = await core.interceptAndExecute('cli', { type: 'propose-split', trackId, reason: 'bad sum', splits: [{ payee: 'X3LIUS', percentage: 70 }, { payee: 'House', percentage: 22 }] });
    expect(r.status).toBe('ERROR');
    expect(r.summary).toMatch(/sums to 92, not 100/);
    const [q] = await db.sql<{ n: number }[]>`select count(*)::int n from approval_queue where item_type::text = 'split_proposal'`;
    expect(q!.n).toBe(1);
  });

  it('does not apply while pending, nor after a rejection', async () => {
    const id = (await db.sql<{ id: string }[]>`select id from approval_queue where item_type::text = 'split_proposal' and status = 'pending'`)[0]!.id;
    expect((await core.interceptAndExecute('cli', { type: 'apply-split', approvalId: id })).status).toBe('PENDING_HUMAN_APPROVAL');
    const rej = await core.interceptAndExecute('cli', { type: 'propose-split', trackId, reason: 'to be rejected', splits: [{ payee: 'X3LIUS', percentage: 100 }] });
    await decideApproval(db.sql, rej.approvalIds![0]!, { decision: 'reject', ...OWNER });
    expect((await core.interceptAndExecute('cli', { type: 'apply-split', approvalId: rej.approvalIds![0]! })).status).toBe('BLOCKED');
    expect(await versions()).toEqual([{ v: 1, n: 2 }]);
  });

  it('writes the next version once the owner approves, and only once', async () => {
    const id = (await db.sql<{ id: string }[]>`select id from approval_queue where item_type::text = 'split_proposal' and status = 'pending'`)[0]!.id;
    await decideApproval(db.sql, id, { decision: 'approve', ...OWNER });
    const r = await core.interceptAndExecute('cli', { type: 'apply-split', approvalId: id });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'OK' });
    expect(await versions()).toEqual([{ v: 1, n: 2 }, { v: 2, n: 2 }]);
    const again = await core.interceptAndExecute('cli', { type: 'apply-split', approvalId: id });
    expect(again.status).toBe('BLOCKED');
    expect(await versions()).toEqual([{ v: 1, n: 2 }, { v: 2, n: 2 }]);
  });

  it('refuses a proposal made against a version that has since moved', async () => {
    const stale = await core.interceptAndExecute('cli', { type: 'propose-split', trackId, reason: 'against v2', splits: [{ payee: 'X3LIUS', percentage: 100 }] });
    await dispatch(deps, 'records-catalog', { splits: { trackId, splits: [{ payee: 'X3LIUS', percentage: 60 }, { payee: 'House', percentage: 40 }] } });
    await decideApproval(db.sql, stale.approvalIds![0]!, { decision: 'approve', ...OWNER });
    const r = await core.interceptAndExecute('cli', { type: 'apply-split', approvalId: stale.approvalIds![0]! });
    expect(r.status).toBe('BLOCKED');
    expect(r.summary).toMatch(/moved from version 2 to 3/);
  });
});
