import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 3): the three Records agents through the Orchestrator.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const deps = (): DispatchDeps => ({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS });
const run = (agent: string, input: unknown) => dispatch(deps(), agent, input, { timeoutMs: 60_000 });

beforeAll(async () => {
  db = await createTestDb('phase13_agents', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

describe('records agents through the Orchestrator', () => {
  it('records-catalog registers a track and tells the operator to enter splits', async () => {
    const r = await run('records-catalog', { release: { title: 'Night Drive', kind: 'single' }, track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId } } });
    expect(r.status).toBe('success');
    expect(r.output).toMatchObject({ release: { status: 'draft' }, next: expect.stringMatching(/pnpm records splits/) });
  });

  it('records-rights-splits flags an UNASSIGNED share and reports it', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }], releaseDate: '2026-12-01' });
    const r = await run('records-rights-splits', { releaseId });
    expect(r.output).toMatchObject({ schedulable: false, tracks: [{ problems: ['UNASSIGNED share of 25%'] }], flagId: expect.any(String) });
  });

  it('records-rights-splits writes no flag for complete splits, even before the Calendar sets a date', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    const r = await run('records-rights-splits', { releaseId });
    expect(r.output).toMatchObject({ schedulable: true });
    expect((r.output as { flagId?: string }).flagId).toBeUndefined();
  });

  it('records-release-calendar refuses a blocked release and queues a clean one', async () => {
    const blocked = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }] });
    const refused = await run('records-release-calendar', { releaseId: blocked.releaseId, releaseDate: '2026-12-01' });
    expect(refused.status).toBe('error');
    expect(refused.error).toMatch(/not schedulable: .*UNASSIGNED share of 25%.*records-rights-splits/);
    const clean = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    const ok = await run('records-release-calendar', { releaseId: clean.releaseId, releaseDate: '2026-12-01' });
    expect(ok.output).toMatchObject({ release: { status: 'pending_schedule', releaseDate: '2026-12-01' }, approvalId: expect.any(String) });
  });
});
