import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease, SHA } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 1): the Records tables, their links to Phase 8-11 rows, and audit_log.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;

beforeAll(async () => {
  db = await createTestDb('phase13_records', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

const track = (releaseId: string, cols: Record<string, unknown>) =>
  db.sql`insert into tracks ${db.sql({ release_id: releaseId, position: 1, title: 't', ...cols })} returning id`;

describe('tracks: one audio source, real links', () => {
  it('accepts a Suno take or a studio master, never both or neither', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await track(releaseId, { suno_take_id: fx.takeId, artifact_ids: [fx.lyricsId, fx.promptId] });
    await track(releaseId, { position: 2, master_uri: 'file:///m.wav', master_sha256: SHA, mix_report_id: fx.mixReportId });
    await expectPgError(() => track(releaseId, { position: 3 }), '23514');
    await expectPgError(() => track(releaseId, { position: 3, suno_take_id: fx.takeId, master_uri: 'file:///m.wav', master_sha256: SHA }), '23514');
    await expectPgError(() => track(releaseId, { position: 3, master_uri: 'file:///m.wav' }), '23514');
  });

  it('refuses an unknown artifact id and a mix report that is not one', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await expectPgError(() => track(releaseId, { suno_take_id: fx.takeId, artifact_ids: [crypto.randomUUID()] }), '23503');
    const e = await expectPgError(() => track(releaseId, { suno_take_id: fx.takeId, mix_report_id: fx.lyricsId }), '23514');
    expect(e.message).toMatch(/not x3lius\.mix-report\/v1/);
  });

  it('checks ISRC and UPC formats, unique when set, null until assigned', async () => {
    const { releaseId, trackIds } = await seedRelease(db.sql);
    await db.sql`update tracks set isrc = 'USRC17607839' where id = ${trackIds[0]!}`;
    await expectPgError(() => db.sql`update tracks set isrc = 'US-RC1-76-07839' where id = ${trackIds[0]!}`, '23514');
    await expectPgError(() => db.sql`update releases set upc = '12345' where id = ${releaseId}`, '23514');
    const other = await seedRelease(db.sql);
    await expectPgError(() => db.sql`update tracks set isrc = 'USRC17607839' where id = ${other.trackIds[0]!}`, '23505');
  });
});

describe('audit_log', () => {
  it('records every insert, update and delete on the Records tables, with the acting role', async () => {
    const { releaseId } = await seedRelease(db.sql);
    await db.sql`update releases set title = 'renamed' where id = ${releaseId}`;
    const rows = await db.sql<{ table_name: string; op: string; actor: string }[]>`
      select table_name, op, actor from audit_log where row_id = ${releaseId}
      and (old is null or new is null or (old - array['integrity_version','updated_at']) is distinct from (new - array['integrity_version','updated_at'])) order by id`;
    expect(rows.map((r) => [r.table_name, r.op])).toEqual([['releases', 'insert'], ['releases', 'update']]);
    expect(rows[0]!.actor).toBe('postgres');
  });

  it('is append-only for every role, owner included', async () => {
    const [a] = await db.sql<{ id: string }[]>`select id from audit_log limit 1`;
    await expectPgError(() => db.sql`update audit_log set op = 'x' where id = ${a!.id}`, '55000');
    await expectPgError(() => db.sql`delete from audit_log where id = ${a!.id}`, '55000');
    await expectPgError(() => asRole(db.sql, 'service_role', (tx) => tx`delete from audit_log`), '42501');
  });
});

const splits = (trackId: string, rows: [string, string, number][]) =>
  db.sql.begin(async (tx) => {
    for (const [payee, role, pct] of rows) {
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${trackId}, ${payee}, ${role}::split_role, ${pct})`;
    }
  });

describe('rights_splits: every track totals exactly 100 at commit (a direct INSERT cannot bypass it)', () => {
  it('refuses 99.99, 100.01, and 60 committed alone', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql);
    for (const rows of [[['A', 'writer', 50], ['B', 'producer', 49.99]], [['A', 'writer', 50], ['B', 'producer', 50.01]], [['A', 'writer', 60]]] as [string, string, number][][]) {
      const e = await expectPgError(() => splits(t!, rows), '23514');
      expect(e.message).toMatch(/^rights_splits_sum_not_100: track .* totals/);
    }
    expect(await db.sql`select 1 from rights_splits where track_id = ${t!}`).toHaveLength(0);
  });

  it('accepts exactly 100, thirds that add up, and an explicit UNASSIGNED share', async () => {
    const { trackIds: [a, b, c] } = await seedRelease(db.sql, { tracks: 3 });
    await splits(a!, [['A', 'writer', 50], ['B', 'producer', 50]]);
    await splits(b!, [['A', 'writer', 33.33], ['B', 'writer', 33.33], ['C', 'writer', 33.34]]);
    await splits(c!, [['A', 'writer', 75], ['UNASSIGNED', 'publisher', 25]]);
    const { trackIds: [d] } = await seedRelease(db.sql);
    await expectPgError(() => splits(d!, [['A', 'writer', 33.33], ['B', 'writer', 33.33], ['C', 'writer', 33.33]]), '23514');
  });

  it('replaces a split set in one transaction (delete + insert), and refuses leaving a partial set', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    await db.sql.begin(async (tx) => {
      await tx`delete from rights_splits where track_id = ${t!}`;
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${t!}, 'A', 'writer', 40), (${t!}, 'B', 'producer', 60)`;
    });
    await expectPgError(() => db.sql`delete from rights_splits where track_id = ${t!} and payee = 'B'`, '23514');
  });
});

describe('rights_splits: locked once a release leaves draft', () => {
  it('refuses insert, update and delete while the release is pending_schedule, scheduled or released', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    await db.sql`update releases set status = 'pending_schedule' where id = ${releaseId}`;
    const e = await expectPgError(() => db.sql`update rights_splits set payee = 'Z' where track_id = ${t!}`, '55000');
    expect(e.message).toMatch(/^splits_locked_after_schedule/);
    await expectPgError(() => db.sql`delete from rights_splits where track_id = ${t!}`, '55000');
    await expectPgError(() => splits(t!, [['B', 'writer', 1]]), '55000');
  });
});

const ok100 = [{ payee: 'A', role: 'writer', percentage: 100 }];
const setStatus = (id: string, s: string) => db.sql`update releases set status = ${s}::release_status where id = ${id}`;
// Commits (asRole rolls back): the queue row must survive for the apply step.
const asCalendar = <T>(fn: (tx: import('postgres').TransactionSql) => Promise<T>) =>
  db.sql.begin(async (tx) => { await tx.unsafe('set local role xyp_calendar'); return fn(tx); }) as Promise<T>;
const request = (id: string) => asCalendar((tx) => tx<{ id: string }[]>`select public.xyp_request_release_schedule(${id}) as id`);
const decide = (approvalId: string, d: 'approve' | 'reject') =>
  db.sql`select public.xyp_decide_approval(${approvalId}, ${d}, 'operator:test', 'test')`;
const apply = (approvalId: string) => db.sql<{ s: string }[]>`select public.xyp_apply_release_decision(${approvalId})::text as s`;

describe('releases: status path', () => {
  it('refuses illegal moves and keeps terminal states terminal', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const e = await expectPgError(() => setStatus(releaseId, 'released'), '23514');
    expect(e.message).toMatch(/^release_status_transition: draft -> released/);
    await setStatus(releaseId, 'cancelled');
    await expectPgError(() => setStatus(releaseId, 'draft'), '23514');
  });
});

describe('scheduling gate', () => {
  it.each([
    ['no date', { splits: ok100 }, /no release_date/],
    ['no tracks', { tracks: 0, releaseDate: '2026-12-01' }, /no tracks/],
    ['a track with no splits', { releaseDate: '2026-12-01' }, /has no splits/],
    ['an UNASSIGNED share', { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }], releaseDate: '2026-12-01' }, /UNASSIGNED 25\.00/],
  ])('refuses pending_schedule with %s', async (_, opts, why) => {
    const { releaseId } = await seedRelease(db.sql, opts);
    const e = await expectPgError(() => setStatus(releaseId, 'pending_schedule'), '23514');
    expect(e.message).toMatch(/^release_not_schedulable: /);
    expect(e.message).toMatch(why);
  });
});

describe('locks outside draft (spec amendment 2)', () => {
  it('allows only status and UPC on the release, only ISRC on its tracks, and no added or removed track', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await setStatus(releaseId, 'pending_schedule');
    await db.sql`update releases set upc = '123456789012' where id = ${releaseId}`;
    await db.sql`update tracks set isrc = 'GBXYZ2600001' where id = ${t!}`;
    expect((await expectPgError(() => db.sql`update releases set release_date = '2027-01-01' where id = ${releaseId}`, '55000')).message).toMatch(/^release_locked/);
    expect((await expectPgError(() => db.sql`update tracks set master_uri = 'file:///other.wav' where id = ${t!}`, '55000')).message).toMatch(/^track_locked/);
    await expectPgError(() => db.sql`insert into tracks (release_id, position, title, master_uri, master_sha256) values (${releaseId}, 2, 'late', 'file:///x.wav', ${SHA})`, '55000');
  });
});

describe('scheduling approval: request, decide, apply', () => {
  it('queues a request as xyp_calendar; approve schedules, re-checked by the gate', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const id = (await request(releaseId))[0]!.id;
    expect((await db.sql`select status::text from releases where id = ${releaseId}`)[0]!.status).toBe('pending_schedule');
    const [q] = await db.sql`select item_type::text, status::text from approval_queue where id = ${id}`;
    expect(q).toEqual({ item_type: 'release_schedule', status: 'pending' });
    await expectPgError(() => apply(id), '55000'); // still pending
    await decide(id, 'approve');
    expect((await apply(id))[0]!.s).toBe('scheduled');
    await expectPgError(() => apply(id), '55000'); // applied once only
  });

  it('reject returns the release to draft, and it can be requested again (spec amendment 1)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const id = (await request(releaseId))[0]!.id;
    await decide(id, 'reject');
    expect((await apply(id))[0]!.s).toBe('draft');
    const again = (await request(releaseId))[0]!.id;
    expect(again).not.toBe(id);
  });

  it('replaying an old, already-applied rejection cannot undo a newer request', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const old = (await request(releaseId))[0]!.id;
    await decide(old, 'reject');
    await apply(old);
    await request(releaseId);
    await expectPgError(() => apply(old), '55000');
    expect((await db.sql`select status::text from releases where id = ${releaseId}`)[0]!.status).toBe('pending_schedule');
  });

  it('refuses a request for a release that is not a draft', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await request(releaseId);
    await expectPgError(() => request(releaseId), '55000');
  });
});

describe('roles: each agent role only does its job', () => {
  it('xyp_catalog cannot write splits or status; xyp_rights cannot change a release; xyp_calendar cannot schedule directly', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await expectPgError(() => asRole(db.sql, 'xyp_catalog', (tx) => tx`insert into rights_splits (track_id, payee, role, percentage) values (${t!}, 'X', 'writer', 1)`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_catalog', (tx) => tx`update releases set status = 'cancelled' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_rights', (tx) => tx`update releases set title = 'x' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_calendar', (tx) => tx`update releases set status = 'scheduled' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_calendar', (tx) => tx`select public.xyp_apply_release_decision(${crypto.randomUUID()})`), '42501');
  });
});

describe('final review fixes', () => {
  it('service_role cannot TRUNCATE the Records tables, reopen an applied decision or delete a flag (I1)', async () => {
    for (const t of ['releases', 'tracks', 'rights_splits', 'records_flags', 'release_schedule_requests']) {
      const [r] = await db.sql<{ ok: boolean }[]>`select has_table_privilege('service_role', ${`public.${t}`}, 'TRUNCATE') as ok`;
      expect(r!.ok, t).toBe(false);
    }
    await expectPgError(() => asRole(db.sql, 'service_role', (tx) => tx`update release_schedule_requests set applied_at = null`), '42501');
    await expectPgError(() => asRole(db.sql, 'service_role', (tx) => tx`delete from records_flags`), '42501');
  });

  it('leaves pending_schedule for scheduled or draft only through the operator decision (I3)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await request(releaseId);
    for (const s of ['scheduled', 'draft']) {
      expect((await expectPgError(() => setStatus(releaseId, s), '23514')).message).toMatch(/only through xyp_apply_release_decision/);
    }
    await setStatus(releaseId, 'cancelled');
  });

  it('refuses an approval whose request no longer matches the release (I3)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const id = (await request(releaseId))[0]!.id;
    await decide(id, 'approve');
    await db.sql`update release_schedule_requests set release_date = '2027-01-01' where release_id = ${releaseId}`;
    expect((await expectPgError(() => apply(id), '55000')).message).toMatch(/stale/);
  });

  it('refuses moving a split or a track out of a locked parent, and deleting a locked track (I4)', async () => {
    const locked = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const draft = await seedRelease(db.sql, { splits: ok100 });
    await setStatus(locked.releaseId, 'pending_schedule');
    await expectPgError(() => db.sql`update rights_splits set track_id = ${draft.trackIds[0]!} where track_id = ${locked.trackIds[0]!}`, '55000');
    await expectPgError(() => db.sql`update tracks set release_id = ${draft.releaseId}, position = 9 where id = ${locked.trackIds[0]!}`, '55000');
    await expectPgError(() => db.sql`delete from tracks where id = ${locked.trackIds[0]!}`, '55000');
  });

  it('assigns an ISRC or UPC once outside draft; never changes or clears it', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await setStatus(releaseId, 'pending_schedule');
    await db.sql`update releases set upc = '123456789013' where id = ${releaseId}`;
    await db.sql`update tracks set isrc = 'GBXYZ2600002' where id = ${t!}`;
    await expectPgError(() => db.sql`update releases set upc = '123456789014' where id = ${releaseId}`, '55000');
    await expectPgError(() => db.sql`update releases set upc = null where id = ${releaseId}`, '55000');
    await expectPgError(() => db.sql`update tracks set isrc = 'GBXYZ2600003' where id = ${t!}`, '55000');
    await expectPgError(() => db.sql`update tracks set isrc = null where id = ${t!}`, '55000');
  });

  it('reserves one spelling of UNASSIGNED', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql);
    await expectPgError(() => splits(t!, [['A', 'writer', 75], [' unassigned', 'publisher', 25]]), '23514');
  });
});
