import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { runMusicSystem } from '../../records/x3lius/entrypoint.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FIXTURE_FORMULA_TITLE, inDays, insertArtifact, insertTake } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 2): the four Records ops agents and both workflows, end to end on a throwaway
// migrated database. No model: all four agents are deterministic. What is real: the dispatch point
// (authorization, agent_runs), every tool's DB role, the workflow chaining, and the DB guard.

let db: TestDb;
let deps: DispatchDeps;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const REGISTER_TRACK = join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml');
const SCHEDULE_RELEASE = join(REPO_ROOT, 'records', 'workflows', 'schedule-release.workflow.yaml');

beforeAll(async () => {
  db = await createTestDb('phase13_agents', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
});

const run = (agent: string, input: unknown) => dispatch(deps, agent, input);
const workflow = (path: string, input: Record<string, unknown>) => runWorkflow(deps, loadWorkflow(path, registry), input);
/** register-track's input: title and mixReportArtifactId are required keys, null = not given. */
const registration = (input: Record<string, unknown>) => ({ title: null, mixReportArtifactId: null, ...input });
const RELEASE = { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' } as const;

type Registered = { releaseId: string; trackId: string; createdRelease: boolean };
/** register-track end to end; returns the Execution step's output. */
const register = async (input: Record<string, unknown>): Promise<Registered> => {
  const r = await workflow(REGISTER_TRACK, registration(input));
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Registered;
};
const splits = (trackId: string, rows: ReadonlyArray<{ payee: string | null; percentage: number }>) =>
  run('records-catalog', { splits: { trackId, splits: rows } });

describe('the four agents are registered, single-class, deterministic (F10 resolved: split + workflow)', () => {
  it('validateAll() is clean and each agent has its class, domain and narrowed tools', () => {
    expect(registry.validateAll()).toEqual([]);
    const shape = (name: string) => {
      const a = registry.get(name)!;
      return { class: a.class, domain: a.domain, model: a.model, tools: [...a.tools].sort() };
    };
    expect(shape('records-catalog-lookup')).toEqual({ class: 'Knowledge', domain: 'RECORDS', model: 'none', tools: ['log_message', 'read_catalog', 'resolve_take'] });
    expect(shape('records-catalog')).toEqual({ class: 'Execution', domain: 'RECORDS', model: 'none', tools: ['assign_codes', 'log_message', 'register_track', 'write_splits'] });
    expect(shape('records-rights-splits')).toEqual({ class: 'Governance', domain: 'RECORDS', model: 'none', tools: ['log_message', 'read_catalog'] });
    expect(shape('records-release-calendar')).toEqual({ class: 'Execution', domain: 'RECORDS', model: 'none', tools: ['log_message', 'schedule_release'] });
  });

  it('capabilities: catalog.read is Knowledge + Governance, catalog.write is Execution only', () => {
    const tools = createRuntimeTools({ sql: db.sql });
    for (const t of ['resolve_take', 'read_catalog']) {
      expect(tools.get(t)?.capability).toBe('catalog.read');
      expect(tools.authorize('Knowledge', t).allow).toBe(true);
      expect(tools.authorize('Governance', t).allow).toBe(true);
      expect(tools.authorize('Execution', t).allow).toBe(false);
    }
    for (const t of ['register_track', 'write_splits', 'assign_codes', 'schedule_release']) {
      expect(tools.get(t)?.capability).toBe('catalog.write');
      expect(tools.authorize('Execution', t).allow).toBe(true);
      for (const cls of ['Knowledge', 'Governance', 'Planning', 'Creative'] as const) expect(tools.authorize(cls, t).allow).toBe(false);
    }
  });
});

describe('register-track: Knowledge lookup → Execution write', () => {
  it('registers a Phase 9 take on a new draft release; the title comes from the formula artifact', async () => {
    const { takeId, submissionId, formulaArtifactId } = await insertTake(db.sql);
    const report = await insertArtifact(db.sql, 'x3lius.mix-report/v1', { fixture: true });
    const r = await workflow(REGISTER_TRACK, registration({ takeId, release: RELEASE, position: 1, mixReportArtifactId: report }));
    expect(r.status).toBe('success');
    const out = r.output as Registered;
    expect(out.createdRelease).toBe(true);
    const [row] = await db.sql<{ title: string; take_id: string; mix_report_artifact_id: string; isrc: string | null; status: string }[]>`
      select t.title, t.take_id, t.mix_report_artifact_id, t.isrc, r.status::text from tracks t join releases r on r.id = t.release_id where t.id = ${out.trackId}`;
    expect(row).toEqual({ title: FIXTURE_FORMULA_TITLE, take_id: takeId, mix_report_artifact_id: report, isrc: null, status: 'draft' });
    const steps = await db.sql<{ agent_name: string; class: string; output: { result: { provenance?: { submission: { id: string }; formula: { artifactId: string } } } } }[]>`
      select agent_name, class::text, output from agent_runs where workflow_run_id = ${r.workflowRunId} order by created_at`;
    expect(steps.map((s) => [s.agent_name, s.class])).toEqual([['records-catalog-lookup', 'Knowledge'], ['records-catalog', 'Execution']]);
    expect(steps[0]!.output.result.provenance).toMatchObject({ submission: { id: submissionId }, formula: { artifactId: formulaArtifactId } });
  });

  it('adds a second take to the same draft by id, with an explicit title', async () => {
    const first = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    const second = await register({ takeId: (await insertTake(db.sql)).takeId, release: { id: first.releaseId }, position: 2, title: '[FIXTURE] Outro' });
    expect(second).toMatchObject({ releaseId: first.releaseId, createdRelease: false });
    expect(await db.sql`select title from tracks where release_id = ${first.releaseId} order by position`).toEqual([
      { title: FIXTURE_FORMULA_TITLE }, { title: '[FIXTURE] Outro' },
    ]);
  });

  it('the lookup refuses: an unknown take, a non-mix-report link, a taken position, a take already on the release', async () => {
    const { takeId } = await insertTake(db.sql);
    const reg = await register({ takeId, release: RELEASE, position: 1 });
    const lyrics = await insertArtifact(db.sql, 'x3lius.lyrics/v2', { fixture: true });
    const cases: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
      [{ takeId: '00000000-0000-4000-8000-000000000000', release: RELEASE, position: 1 }, /no take/],
      [{ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1, mixReportArtifactId: lyrics }, /not a x3lius\.mix-report\/v1/],
      [{ takeId: (await insertTake(db.sql)).takeId, release: { id: reg.releaseId }, position: 1 }, /position 1 is taken/],
      [{ takeId, release: { id: reg.releaseId }, position: 2 }, /already on release/],
    ];
    for (const [input, reason] of cases) {
      const r = await workflow(REGISTER_TRACK, registration(input));
      expect(r).toMatchObject({ status: 'error', failedStep: 'lookup' });
      expect(r.error).toMatch(reason);
    }
  });
});

describe('records-catalog: splits and codes, exactly the operation given', () => {
  it('writes a split set as the next version and reports the unassigned share', async () => {
    const { trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    const v1 = await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }]);
    expect(v1).toMatchObject({ status: 'success', output: { trackId, version: 1, unassigned: 30 } });
    const v2 = await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: '[FIXTURE] Producer', percentage: 30 }]);
    expect(v2).toMatchObject({ status: 'success', output: { trackId, version: 2, unassigned: 0 } });
  });

  it('the DB decides the sum: a set of 90 fails the run with the DB reason, and nothing is written', async () => {
    const { trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    const r = await splits(trackId, [{ payee: 'X3LIUS', percentage: 60 }, { payee: '[FIXTURE] Producer', percentage: 30 }]);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/sums to 90\.000, not 100/);
    expect(await db.sql`select 1 from rights_splits where track_id = ${trackId}`).toHaveLength(0);
  });

  it('assigns an ISRC and a UPC once; refuses an input naming more than one operation', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await expect(run('records-catalog', { assign: { trackId, isrc: 'QZAB12600001' } })).resolves.toMatchObject({ status: 'success', output: { trackId, isrc: 'QZAB12600001' } });
    await expect(run('records-catalog', { assign: { releaseId, upc: '036000291452' } })).resolves.toMatchObject({ status: 'success', output: { releaseId, upc: '036000291452' } });
    const again = await run('records-catalog', { assign: { trackId, isrc: 'QZAB12600002' } });
    expect(again.error).toMatch(/assigned code never changes/);
    const both = await run('records-catalog', { splits: { trackId, splits: [] }, assign: { trackId, isrc: 'QZAB12600003' } });
    expect(both.error).toMatch(/exactly one of register, splits, assign/);
  });
});

describe('records-rights-splits: rule-based verdicts, flags as data', () => {
  it('flags an unassigned share with its percentage; the run itself succeeds', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }]);
    const r = await run('records-rights-splits', { releaseId });
    expect(r.status).toBe('success');
    expect(r.output).toMatchObject({
      runId: r.runId, releaseId, verdict: 'flag',
      rules: [
        { id: 'rights.release-has-tracks', status: 'pass' },
        { id: 'rights.split-set-present', status: 'pass' },
        { id: 'rights.no-unassigned-share', status: 'flag' },
        { id: 'rights.sum-100', status: 'pass' },
      ],
      flags: [{ rule: 'rights.no-unassigned-share', trackId, unassignedPercentage: 30 }],
    });
  });

  it('flags a track with no split set; refuses an unknown release', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    const r = await run('records-rights-splits', { releaseId });
    expect(r.output).toMatchObject({ verdict: 'flag', flags: [{ rule: 'rights.split-set-present', trackId }] });
    expect(await run('records-rights-splits', { releaseId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ status: 'error', error: expect.stringMatching(/no release/) });
  });

  it('passes a release whose every track has a complete set', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 100 }]);
    expect((await run('records-rights-splits', { releaseId })).output).toMatchObject({ verdict: 'pass', flags: [] });
  });
});

describe('schedule-release: Rights first, then the calendar; the DB is the hard stop', () => {
  it('a flagged release stops at the calendar step with every flag named, and stays a draft', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }]);
    const r = await workflow(SCHEDULE_RELEASE, { releaseId, releaseDate: inDays(30) });
    expect(r).toMatchObject({ status: 'error', failedStep: 'calendar' });
    expect(r.error).toMatch(/rights\.no-unassigned-share/);
    expect(r.error).toMatch(/30/);
    expect(await db.sql`select status::text from releases where id = ${releaseId}`).toEqual([{ status: 'draft' }]);
  });

  it('once the share is assigned it schedules, and the release points at the Rights run that cleared it', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }]);
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: '[FIXTURE] Producer', percentage: 30 }]);
    const date = inDays(30);
    const r = await workflow(SCHEDULE_RELEASE, { releaseId, releaseDate: date });
    expect(r.status, r.error).toBe('success');
    const rightsRunId = r.steps.find((s) => s.stepId === 'rights')!.agentRunId;
    const [row] = await db.sql<{ status: string; release_date: string; rights_check_run_id: string }[]>`
      select status::text, release_date::text, rights_check_run_id from releases where id = ${releaseId}`;
    expect(row).toEqual({ status: 'scheduled', release_date: date, rights_check_run_id: rightsRunId });
    expect(r.output).toMatchObject({ releaseId, status: 'scheduled', releaseDate: date });
  });

  it('the calendar unschedules; a forged pass (a flagged run\'s id) is refused by the DB', async () => {
    const { releaseId, trackId } = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(trackId, [{ payee: 'X3LIUS', percentage: 70 }, { payee: null, percentage: 30 }]);
    const flagged = await run('records-rights-splits', { releaseId });
    const forged = { ...(flagged.output as Record<string, unknown>), verdict: 'pass', flags: [] };
    const r = await run('records-release-calendar', { schedule: { releaseId, releaseDate: inDays(30), rightsCheck: forged } });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/unassigned share|not a passing records-rights-splits check/);

    await splits(trackId, [{ payee: 'X3LIUS', percentage: 100 }]);
    const ok = await workflow(SCHEDULE_RELEASE, { releaseId, releaseDate: inDays(30) });
    expect(ok.status, ok.error).toBe('success');
    expect(await run('records-release-calendar', { unschedule: { releaseId } })).toMatchObject({ status: 'success', output: { releaseId, status: 'draft' } });
  });

  it('refuses a rights check for another release before any DB call', async () => {
    const a = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    const b = await register({ takeId: (await insertTake(db.sql)).takeId, release: RELEASE, position: 1 });
    await splits(b.trackId, [{ payee: 'X3LIUS', percentage: 100 }]);
    const check = (await run('records-rights-splits', { releaseId: b.releaseId })).output;
    const r = await run('records-release-calendar', { schedule: { releaseId: a.releaseId, releaseDate: inDays(30), rightsCheck: check } });
    expect(r.error).toMatch(/rights check is for release .*, not/);
  });
});

describe('pnpm ask: Records ops requests are named, never guessed (F5)', () => {
  it('a catalog / rights / calendar request that matches no X3LIUS sub-domain gets the ops commands', async () => {
    const r = await runMusicSystem(deps, { request: 'assign the ISRC and schedule the release date for the catalog' });
    expect(r.status).toBe('clarify');
    expect(r.reason).toMatch(/Records ops/);
    expect(r.reason).toMatch(/register-track\.workflow\.yaml/);
    expect(r.reason).toMatch(/schedule-release\.workflow\.yaml/);
    expect(r.reason).toMatch(/records-catalog/);
  });
});
