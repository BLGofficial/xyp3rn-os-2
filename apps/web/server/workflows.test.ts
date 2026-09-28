import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRoots } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, type TestDb } from '../../../tests/helpers/db.ts';
import { workflowsOverview } from './workflows-loaders.ts';

// Jarvis Prompt 01 Task 5 (J1): the Workflow Builder, read-only. The workflows that exist, read from their files
// (the index) and their recorded runs, by revision; runs of a workflow with no definition file listed apart.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let db: TestDb;
const root = mkdtempSync(join(tmpdir(), 'jarvis01-workflows-root-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'jarvis01-workflows-vault-'));
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const RUN = 'name: fixture-run\ndescription: x\nsteps:\n  - id: fetch\n    agent: fixture-agent\n  - id: sum\n    agent: fixture-agent\n    dependsOn: [fetch]\n';
const IDLE = 'name: fixture-idle\ndescription: x\nsteps:\n  - id: only\n    agent: fixture-agent\n';
const run = (name: string, spec: string, status: 'success' | 'error', at: string) =>
  db.sql`insert into workflow_runs (workflow_name, spec_sha256, spec, input, status, created_at, completed_at, failed_step, error_detail)
         values (${name}, ${spec}, '{}', '{}', ${status}, ${at}, ${at}, ${status === 'error' ? 'fetch' : null}, ${status === 'error' ? '[FIXTURE] failed' : null})`;

beforeAll(async () => {
  db = await createTestDb('jarvis01_workflows', { migrated: true });
  put('agents/fixture-agent.agent.md', '---\nname: fixture-agent\nclass: Execution\ndomain: CORE\ntools: []\nmodel: none\n---\n\n## Role\n\n[FIXTURE]\n\n## Contract\n\nx\n\n## Refuses\n\nx\n');
  put('core/workflows/fixture-run.workflow.yaml', RUN);
  put('records/workflows/fixture-idle.workflow.yaml', IDLE);
  expect((await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir) })).status).toBe('success');
  await run('fixture-run', sha(RUN), 'success', '2026-09-27T10:00:00Z');
  await run('fixture-run', sha('[FIXTURE] an earlier revision'), 'error', '2026-09-26T10:00:00Z');
  // A plan generated at run time (as research runs record theirs): no definition file.
  await run('research-specialists', sha('[FIXTURE] generated'), 'success', '2026-09-25T10:00:00Z');
}, 180_000);
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('workflowsOverview', () => {
  it('lists each workflow file with its owner, revision, steps and runs by revision', async () => {
    const o = await workflowsOverview(db.sql);
    const wf = o.workflows.find((w) => w.name === 'fixture-run')!;
    expect(wf).toMatchObject({ id: 'workflow:fixture-run', ownerDomain: 'CORE', path: 'core/workflows/fixture-run.workflow.yaml', revision: sha(RUN) });
    expect(wf.steps).toEqual([
      { id: 'workflow_step:fixture-run#fetch', step: 'fetch', agent: 'fixture-agent', dependsOn: [] },
      { id: 'workflow_step:fixture-run#sum', step: 'sum', agent: 'fixture-agent', dependsOn: ['fetch'] },
    ]);
    expect(wf.runs).toMatchObject({ total: 2, current: 1, earlier: 1, last: { status: 'success', at: '2026-09-27T10:00:00.000Z' } });
    expect(o.workflows.find((w) => w.name === 'fixture-idle')).toMatchObject({ ownerDomain: 'RECORDS', runs: { total: 0, current: 0, earlier: 0, last: null } });
  });

  it('lists runs of a workflow with no definition file apart, and nothing that has neither a file nor a run', async () => {
    const o = await workflowsOverview(db.sql);
    expect(o.undefinedRuns).toEqual([{ name: 'research-specialists', total: 1, last: { status: 'success', at: '2026-09-25T10:00:00.000Z' } }]);
    expect(o.workflows.map((w) => w.name).sort()).toEqual(['fixture-idle', 'fixture-run']);
  });
});
