import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { JarvisCore } from '../../../core/src/jarvis/JarvisOrchestrator.ts';
import { loadWorkflow, runWorkflow } from '../../../core/workflow-engine/engine.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { insertTake } from '../../../tests/helpers/records-fixture.ts';
import { applySplitOp, decideSplitOp, splitProposals } from './approvals-ops.ts';

// The /approvals page's server side, on a throwaway database with every migration: list, decide, apply.

let db: TestDb;
let deps: DispatchDeps;
let core: JarvisCore;
let trackId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const propose = async (splits: { payee: string | null; percentage: number }[]) =>
  (await core.interceptAndExecute('cli', { type: 'propose-split', trackId, reason: 'assign the rest', splits })).approvalIds![0]!;

beforeAll(async () => {
  db = await createTestDb('web_approvals_ops', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
  core = new JarvisCore({ ...deps, engine: { retrieve: async () => { throw new Error('not used'); } } as never });
  const { takeId } = await insertTake(db.sql);
  const reg = await runWorkflow(deps, loadWorkflow(join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml'), registry), {
    takeId, sourceId: null, release: { title: '[FIXTURE] Approvals Page', artist: 'X3LIUS', kind: 'single' }, position: 1, title: null, mixReportArtifactId: null,
  });
  trackId = (reg.output as { trackId: string }).trackId;
  await dispatch(deps, 'records-catalog', { splits: { trackId, splits: [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }] } });
});
afterAll(async () => { await db?.drop(); });

describe('approvals page operations', () => {
  it('lists a queued proposal as pending with the version it was made against', async () => {
    await propose([{ payee: 'X3LIUS', percentage: 70 }, { payee: 'House', percentage: 30 }]);
    const [p] = await splitProposals(db.sql);
    expect(p).toMatchObject({ status: 'pending', trackId, trackTitle: expect.stringContaining('[FIXTURE]'), proposedAgainst: 1, currentVersion: 1, proposedBy: 'jarvis' });
    expect(p!.splits).toEqual([{ payee: 'X3LIUS', percentage: 70 }, { payee: 'House', percentage: 30 }]);
  });

  it('needs a reason, decides once, and refuses anything that is not a split proposal', async () => {
    const [p] = await splitProposals(db.sql);
    await expect(decideSplitOp(db.sql, p!.approvalId, 'approve', '  ', 'owner')).rejects.toThrow(/needs a reason/);
    await expect(decideSplitOp(db.sql, '00000000-0000-4000-8000-000000000000', 'approve', 'ok', 'owner')).rejects.toThrow(/not a split proposal/);
    expect(await decideSplitOp(db.sql, p!.approvalId, 'approve', 'numbers check out', 'owner')).toBe('approved');
    await expect(decideSplitOp(db.sql, p!.approvalId, 'reject', 'changed my mind', 'owner')).rejects.toThrow(/already approved/);
    expect((await splitProposals(db.sql))[0]).toMatchObject({ status: 'approved', decidedBy: 'owner', decisionReason: 'numbers check out' });
  });

  it('applies the approved proposal once, then reports the splits as moved', async () => {
    const [p] = await splitProposals(db.sql);
    expect(await applySplitOp(deps, p!.approvalId)).toMatch(/version 2/);
    expect((await splitProposals(db.sql))[0]).toMatchObject({ proposedAgainst: 1, currentVersion: 2 });
    await expect(applySplitOp(deps, p!.approvalId)).rejects.toThrow(/moved from version 1 to 2/);
  });

  it('lists a pending proposal ahead of decided ones', async () => {
    const id = await propose([{ payee: 'X3LIUS', percentage: 100 }]);
    const list = await splitProposals(db.sql);
    expect(list[0]).toMatchObject({ approvalId: id, status: 'pending' });
    expect(list).toHaveLength(2);
  });
});
