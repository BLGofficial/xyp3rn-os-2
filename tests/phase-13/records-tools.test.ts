import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import type { ToolContext } from '../../core/tool-registry/registry.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease, SHA } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 2): the Records tools, each under its own DB role.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
beforeAll(async () => {
  db = await createTestDb('phase13_tools', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

const ctx = (): ToolContext => ({ runId: fx.runId, agentName: 'records-test', log: () => {} });
const call = (name: string, args: unknown) => {
  const tool = createRuntimeTools({ sql: db.sql }).get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool.handler(ctx(), args);
};

describe('register_track', () => {
  it('creates a release and a track from a Suno take, ISRC/UPC null', async () => {
    const out = (await call('register_track', {
      release: { title: 'Night Drive', kind: 'single' },
      track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId }, artifactIds: [fx.lyricsId] },
    })) as { release: { id: string; status: string }; track: { id: string } };
    expect(out.release.status).toBe('draft');
    const [t] = await db.sql`select isrc, suno_take_id from tracks where id = ${out.track.id}`;
    expect(t).toEqual({ isrc: null, suno_take_id: fx.takeId });
    const [a] = await db.sql`select actor from audit_log where row_id = ${out.track.id}`;
    expect(a!.actor).toBe('xyp_catalog');
  });

  it('adds a studio-master track to an existing release, and refuses both or neither id', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await call('register_track', { releaseId, track: { title: 'M', position: 1, source: { masterUri: 'file:///m.wav', masterSha256: SHA }, mixReportId: fx.mixReportId } });
    await expect(call('register_track', { track: { title: 'x', position: 1, source: { sunoTakeId: fx.takeId } } })).rejects.toThrow(/exactly one of releaseId or release/);
  });
});

describe('read_release, flag_release, propose_schedule', () => {
  it('reads a release as a ReleaseView with numeric percentages', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const v = await call('read_release', { releaseId });
    expect(v).toMatchObject({ id: releaseId, status: 'draft', releaseDate: '2026-12-01', tracks: [{ position: 1, splits: [{ payee: 'A', role: 'writer', percentage: 100 }] }] });
  });

  it('flags as xyp_rights, and proposes as xyp_calendar (date set, request queued)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    const { flag_id } = (await call('flag_release', { releaseId, report: { schedulable: false, problems: ['x'], tracks: [] } })) as { flag_id: string };
    expect((await db.sql`select release_id from records_flags where id = ${flag_id}`)[0]!.release_id).toBe(releaseId);
    const { approvalId } = (await call('propose_schedule', { releaseId, releaseDate: '2026-12-01' })) as { approvalId: string };
    expect((await db.sql`select item_type::text from approval_queue where id = ${approvalId}`)[0]!.item_type).toBe('release_schedule');
    expect((await db.sql`select status::text, release_date::text from releases where id = ${releaseId}`)[0]).toEqual({ status: 'pending_schedule', release_date: '2026-12-01' });
  });

  it('refuses a malformed date before touching the DB', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    await expect(call('propose_schedule', { releaseId, releaseDate: '12/01/2026' })).rejects.toThrow(/releaseDate must be YYYY-MM-DD/);
  });
});
