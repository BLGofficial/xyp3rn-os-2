import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.ts';

// Phase 13 proof (part 1): releases, tracks and rights_splits on a throwaway migrated database.
// The guide's constraint test: split-set integrity is a DB rule no role can bypass by a direct insert,
// the owner included. Fixture rows are inserted directly under the role that owns each write; no
// agent runs here. Every refusal asserts its exact SQLSTATE.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase13_records', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

/** Runs fn as role in a transaction that COMMITS — deferred constraint triggers fire at commit. */
const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;

const code = (c: string) => ({ code: c });
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let upcSeq = 0;
/** A fresh, valid UPC-A: an 11-digit base plus its GS1 check digit (weights 3,1 from the right). */
const upc = (): string => {
  const base = `0${String(70_000_000 + ++upcSeq).padStart(10, '0')}`;
  const sum = [...base].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
};

const runRow = async (agent: string, cls: string): Promise<string> =>
  (await db.sql<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values (${agent}, ${cls}, 'RECORDS', '{}') returning id`)[0]!.id;

/** A finished Rights run, as dispatch would leave it (sealed, output stored). */
const rightsRun = async (
  releaseId: string,
  over: { verdict?: string; agent?: string; status?: 'success' | 'error'; forRelease?: string } = {},
): Promise<string> => {
  const status = over.status ?? 'success';
  // dispatch's shape: { result: <handler output>, logs }.
  const output = { result: { releaseId: over.forRelease ?? releaseId, verdict: over.verdict ?? 'pass', rules: [], flags: [] }, logs: [] };
  return (await db.sql<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input, output, status, error_detail, completed_at)
    values (${over.agent ?? 'records-rights-splits'}, 'Governance', 'RECORDS', ${db.sql.json({ releaseId })}, ${db.sql.json(output)},
            ${status}, ${status === 'error' ? '[FIXTURE] failed' : null}, now())
    returning id`)[0]!.id;
};

const artifact = async (schemaId: string, body: Record<string, unknown>): Promise<string> => {
  const runId = await runRow('x3lius-suno', 'Creative');
  return as('xyp_creative', async (tx) => (await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'x3lius-suno', ${runId}, '[FIXTURE] brief', ${tx.json(body as postgres.JSONValue)}, '[]', '{}', 'fixture')
    returning id`)[0]!.id);
};

let takeSeq = 0;
/** A Phase 9 manual take: formula artifact → submission → take. */
const take = async (): Promise<string> => {
  const formula = await artifact('x3lius.suno-prompt/v1', { title: '[FIXTURE] Night City', style: 'x', excludeStyles: [], lyrics: 'x', sunoModel: 'v5' });
  const runId = await runRow('suno-submitter', 'Execution');
  return as('xyp_execution', async (tx) => {
    const [sub] = await tx<{ id: string }[]>`
      insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
      values (${formula}, ${runId}, 'manual', 'v5', ${tx.json({ title: '[FIXTURE] Night City', style: 'x', excludeStyles: [], lyrics: 'x' })})
      returning id`;
    const [t] = await tx<{ id: string }[]>`
      insert into suno_takes (submission_id, agent_run_id, audio_url, title, duration_seconds)
      values (${sub!.id}, ${runId}, ${`https://cdn.example.org/fixture-${++takeSeq}.mp3`}, '[FIXTURE] take', 180)
      returning id`;
    return t!.id;
  });
};

const release = async (kind = 'single'): Promise<string> => {
  const runId = await runRow('records-catalog', 'Execution');
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into releases (title, artist, kind, agent_run_id) values ('[FIXTURE] Release', 'X3LIUS', ${kind}, ${runId}) returning id`)[0]!.id);
};

const track = async (
  releaseId: string,
  position: number,
  over: { takeId?: string; isrc?: string | null; mixReportArtifactId?: string | null } = {},
): Promise<string> => {
  const takeId = over.takeId ?? (await take());
  const runId = await runRow('records-catalog', 'Execution');
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into tracks (release_id, position, title, isrc, take_id, mix_report_artifact_id, agent_run_id)
    values (${releaseId}, ${position}, '[FIXTURE] Track', ${over.isrc ?? null}, ${takeId}, ${over.mixReportArtifactId ?? null}, ${runId})
    returning id`)[0]!.id);
};

type Split = readonly [payee: string | null, percentage: number];
/** Writes one split set in ONE transaction, as role. */
const splits = async (trackId: string, version: number, rows: readonly Split[], role = 'xyp_catalog'): Promise<void> => {
  const runId = await runRow('records-catalog', 'Execution');
  await as(role, async (tx) => {
    for (const [payee, pct] of rows) {
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${trackId}, ${version}, ${payee}, ${pct}, ${runId})`;
    }
  });
};

const setStatus = (releaseId: string, status: string, date: string | null, runId: string | null, role = 'xyp_release_calendar') =>
  as(role, (tx) => tx`update releases set status = ${status}::release_status, release_date = ${date}::date, rights_check_run_id = ${runId} where id = ${releaseId}`);

const schedule = async (releaseId: string, date = inDays(30)) => setStatus(releaseId, 'scheduled', date, await rightsRun(releaseId));

/** A release with one track whose split set is complete: ready to schedule. */
const readyRelease = async (): Promise<{ releaseId: string; trackId: string }> => {
  const releaseId = await release();
  const trackId = await track(releaseId, 1);
  await splits(trackId, 1, [['X3LIUS', 60], ['[FIXTURE] Producer', 40]]);
  return { releaseId, trackId };
};

const statusOf = async (releaseId: string) =>
  (await db.sql<{ status: string }[]>`select status::text from releases where id = ${releaseId}`)[0]!.status;

describe('rights_splits: every committed split set sums to exactly 100 (deferred, every role)', () => {
  it('a set summing to 100 commits and is the track\'s current set', async () => {
    const t = await track(await release(), 1);
    await splits(t, 1, [['X3LIUS', 60], ['[FIXTURE] Producer', 40]]);
    const rows = await db.sql<{ payee: string; percentage: string; version: number }[]>`
      select payee, percentage::text, version from current_rights_splits where track_id = ${t} order by percentage desc`;
    expect(rows).toEqual([
      { payee: 'X3LIUS', percentage: '60.000', version: 1 },
      { payee: '[FIXTURE] Producer', percentage: '40.000', version: 1 },
    ]);
  });

  it('a set summing to 90 or 110 is refused at commit (23514) for xyp_catalog and for the owner', async () => {
    const t = await track(await release(), 1);
    await expect(splits(t, 1, [['X3LIUS', 60], ['[FIXTURE] Producer', 30]])).rejects.toMatchObject(code('23514'));
    await expect(splits(t, 1, [['X3LIUS', 60], ['[FIXTURE] Producer', 50]])).rejects.toMatchObject(code('23514'));
    // The owner (the migration role, superuser here) is bound by the trigger too.
    const runId = await runRow('records-catalog', 'Execution');
    await expect(db.sql.begin(async (tx) => {
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t}, 1, 'X3LIUS', 90, ${runId})`;
    })).rejects.toMatchObject(code('23514'));
    expect(await db.sql`select 1 from rights_splits where track_id = ${t}`).toHaveLength(0);
  });

  it('service_role and the read roles cannot insert at all (42501)', async () => {
    const t = await track(await release(), 1);
    for (const role of ['service_role', 'xyp_runtime', 'xyp_release_calendar', 'xyp_execution', 'anon', 'authenticated']) {
      await expect(splits(t, 1, [['X3LIUS', 100]], role)).rejects.toMatchObject(code('42501'));
    }
  });

  it('set constraints all immediate fires the sum check inside the transaction', async () => {
    const t = await track(await release(), 1);
    const runId = await runRow('records-catalog', 'Execution');
    await expect(as('xyp_catalog', async (tx) => {
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t}, 1, 'X3LIUS', 50, ${runId})`;
      await tx`set constraints all immediate`;
    })).rejects.toMatchObject(code('23514'));
  });

  it('a row added to a committed set pushes it past 100 and is refused (23514)', async () => {
    const t = await track(await release(), 1);
    await splits(t, 1, [['X3LIUS', 100]]);
    await expect(splits(t, 1, [['[FIXTURE] Late', 10]])).rejects.toMatchObject(code('23514'));
  });

  it('versions start at 1 and never skip (23514); a new version becomes the current set, history kept', async () => {
    const t = await track(await release(), 1);
    await expect(splits(t, 2, [['X3LIUS', 100]])).rejects.toMatchObject(code('23514'));
    await splits(t, 1, [['X3LIUS', 100]]);
    await expect(splits(t, 3, [['X3LIUS', 100]])).rejects.toMatchObject(code('23514'));
    await splits(t, 2, [['X3LIUS', 50], ['[FIXTURE] Producer', 50]]);
    expect(await db.sql`select 1 from current_rights_splits where track_id = ${t}`).toHaveLength(2);
    expect(await db.sql`select 1 from rights_splits where track_id = ${t}`).toHaveLength(3);
  });

  it('refuses a zero, negative or over-100 share, a blank payee, a repeated payee, two unassigned rows', async () => {
    const t = await track(await release(), 1);
    await expect(splits(t, 1, [['X3LIUS', 0], ['[FIXTURE] B', 100]])).rejects.toMatchObject(code('23514'));
    await expect(splits(t, 1, [['X3LIUS', -10], ['[FIXTURE] B', 110]])).rejects.toMatchObject(code('23514'));
    await expect(splits(t, 1, [['X3LIUS', 100.5]])).rejects.toMatchObject(code('23514'));
    await expect(splits(t, 1, [['  ', 100]])).rejects.toMatchObject(code('23514'));
    await expect(splits(t, 1, [['X3LIUS', 50], ['X3LIUS', 50]])).rejects.toMatchObject(code('23505'));
    await expect(splits(t, 1, [[null, 50], [null, 50]])).rejects.toMatchObject(code('23505'));
  });

  it('is append-only for every role, the owner included (55000)', async () => {
    const t = await track(await release(), 1);
    await splits(t, 1, [['X3LIUS', 100]]);
    await expect(db.sql`update rights_splits set percentage = 99 where track_id = ${t}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from rights_splits where track_id = ${t}`).rejects.toMatchObject(code('55000'));
  });
});

describe('the unassigned share and the scheduling guard', () => {
  it('an unassigned share is a null-payee row the sum counts: 70 + unassigned 30 commits', async () => {
    const t = await track(await release(), 1);
    await splits(t, 1, [['X3LIUS', 70], [null, 30]]);
    expect(await db.sql`select 1 from current_rights_splits where track_id = ${t} and payee is null`).toHaveLength(1);
  });

  it('a release with an unassigned share cannot be scheduled (55000)', async () => {
    const r = await release();
    const t = await track(r, 1);
    await splits(t, 1, [['X3LIUS', 70], [null, 30]]);
    await expect(schedule(r)).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/unassigned/) });
    expect(await statusOf(r)).toBe('draft');
  });

  it('a release with no tracks, or a track with no split set, cannot be scheduled (55000)', async () => {
    await expect(schedule(await release())).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/no tracks/) });
    const r = await release();
    await track(r, 1);
    await expect(schedule(r)).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/no split set/) });
  });

  it('needs a passing records-rights-splits run for this release (55000 otherwise)', async () => {
    const { releaseId: r } = await readyRelease();
    const date = inDays(30);
    await expect(setStatus(r, 'scheduled', date, null)).rejects.toMatchObject(code('55000'));
    await expect(setStatus(r, 'scheduled', date, await rightsRun(r, { verdict: 'flag' }))).rejects.toMatchObject(code('55000'));
    await expect(setStatus(r, 'scheduled', date, await rightsRun(r, { status: 'error' }))).rejects.toMatchObject(code('55000'));
    await expect(setStatus(r, 'scheduled', date, await rightsRun(r, { agent: 'records-catalog' }))).rejects.toMatchObject(code('55000'));
    await expect(setStatus(r, 'scheduled', date, await rightsRun(r, { forRelease: (await readyRelease()).releaseId }))).rejects.toMatchObject(code('55000'));
    await setStatus(r, 'scheduled', date, await rightsRun(r));
    expect(await statusOf(r)).toBe('scheduled');
  });

  it('refuses a scheduled date in the past (55000); a reschedule is checked again', async () => {
    const { releaseId: r } = await readyRelease();
    await expect(schedule(r, inDays(-1))).rejects.toMatchObject(code('55000'));
    await schedule(r, inDays(30));
    await setStatus(r, 'scheduled', inDays(45), await rightsRun(r));
    await expect(setStatus(r, 'scheduled', inDays(-2), await rightsRun(r))).rejects.toMatchObject(code('55000'));
  });

  it('once scheduled: no unassigned share (55000), no new track (55000); a complete correction commits', async () => {
    const { releaseId: r, trackId: t } = await readyRelease();
    await schedule(r);
    await expect(splits(t, 2, [['X3LIUS', 80], [null, 20]])).rejects.toMatchObject(code('55000'));
    await expect(track(r, 2)).rejects.toMatchObject(code('55000'));
    await splits(t, 2, [['X3LIUS', 55], ['[FIXTURE] Producer', 45]]);
    expect(await db.sql`select 1 from current_rights_splits where track_id = ${t} and version = 2`).toHaveLength(2);
  });

  it('transitions: draft → scheduled → draft; scheduled → released on or after its date; nothing else (55000)', async () => {
    const { releaseId: r } = await readyRelease();
    await expect(setStatus(r, 'released', inDays(0), await rightsRun(r))).rejects.toMatchObject(code('55000'));
    await schedule(r);
    await setStatus(r, 'draft', null, null);
    expect(await statusOf(r)).toBe('draft');
    await schedule(r, inDays(30));
    // released before its date
    await expect(as('xyp_release_calendar', (tx) => tx`update releases set status = 'released' where id = ${r}`)).rejects.toMatchObject(code('55000'));

    const { releaseId: today } = await readyRelease();
    const run = await rightsRun(today);
    await as('xyp_release_calendar', (tx) => tx`update releases set status = 'scheduled', release_date = current_date, rights_check_run_id = ${run} where id = ${today}`);
    await as('xyp_release_calendar', (tx) => tx`update releases set status = 'released' where id = ${today}`);
    expect(await statusOf(today)).toBe('released');
    for (const s of ['draft', 'scheduled']) {
      await expect(as('xyp_release_calendar', (tx) => tx`update releases set status = ${s}::release_status where id = ${today}`)).rejects.toMatchObject(code('55000'));
    }
  });
});

describe('ISRC / UPC: nullable until assigned, format-checked, assigned once', () => {
  it('checks the ISRC format (ISO 3901, no hyphens) and the UPC/EAN check digit (23514)', async () => {
    const r = await release();
    await expect(track(r, 1, { isrc: 'US-AB1-26-00001' })).rejects.toMatchObject(code('23514'));
    await expect(track(r, 1, { isrc: 'usab12600001' })).rejects.toMatchObject(code('23514'));
    await expect(track(r, 1, { isrc: 'USAB1260001' })).rejects.toMatchObject(code('23514'));
    await track(r, 1, { isrc: 'USAB12600001' });
    const setUpc = (upc: string) => as('xyp_catalog', (tx) => tx`update releases set upc = ${upc} where id = ${r}`);
    await expect(setUpc('036000291453')).rejects.toMatchObject(code('23514'));
    await expect(setUpc('03600029145')).rejects.toMatchObject(code('23514'));
    await setUpc('036000291452');
    const ean = await release();
    await as('xyp_catalog', (tx) => tx`update releases set upc = '4006381333931' where id = ${ean}`);
  });

  it('an assigned code never changes or clears (55000)', async () => {
    const r = await release();
    const t = await track(r, 1);
    await as('xyp_catalog', (tx) => tx`update tracks set isrc = 'USAB12600002' where id = ${t}`);
    await expect(as('xyp_catalog', (tx) => tx`update tracks set isrc = 'USAB12600003' where id = ${t}`)).rejects.toMatchObject(code('55000'));
    await expect(as('xyp_catalog', (tx) => tx`update tracks set isrc = null where id = ${t}`)).rejects.toMatchObject(code('55000'));
    await as('xyp_catalog', (tx) => tx`update releases set upc = ${upc()} where id = ${r}`);
    await expect(as('xyp_catalog', (tx) => tx`update releases set upc = ${upc()} where id = ${r}`)).rejects.toMatchObject(code('55000'));
    await expect(as('xyp_catalog', (tx) => tx`update releases set upc = null where id = ${r}`)).rejects.toMatchObject(code('55000'));
  });

  it('an ISRC names one recording: two takes under one ISRC are refused (23514); one take on a single and an album is fine', async () => {
    const takeId = await take();
    await track(await release('single'), 1, { takeId, isrc: 'USAB12600010' });
    await track(await release('album'), 3, { takeId, isrc: 'USAB12600010' });
    await expect(track(await release(), 1, { isrc: 'USAB12600010' })).rejects.toMatchObject(code('23514'));
  });

  it('unique per release: a UPC across releases, a position, a take (23505)', async () => {
    const r = await release();
    const takeId = await take();
    await track(r, 1, { takeId });
    await expect(track(r, 1)).rejects.toMatchObject(code('23505'));
    await expect(track(r, 2, { takeId })).rejects.toMatchObject(code('23505'));
    const a = await release();
    const b = await release();
    const shared = upc();
    await as('xyp_catalog', (tx) => tx`update releases set upc = ${shared} where id = ${a}`);
    await expect(as('xyp_catalog', (tx) => tx`update releases set upc = ${shared} where id = ${b}`)).rejects.toMatchObject(code('23505'));
  });
});

describe('tracks', () => {
  it('a mix report link must be a x3lius.mix-report/v1 artifact (23514)', async () => {
    const r = await release();
    const lyrics = await artifact('x3lius.lyrics/v2', { fixture: true });
    await expect(track(r, 1, { mixReportArtifactId: lyrics })).rejects.toMatchObject(code('23514'));
    const report = await artifact('x3lius.mix-report/v1', { fixture: true });
    await track(r, 1, { mixReportArtifactId: report });
  });

  it('refuses a blank title or artist, an unknown kind, a position below 1 (23514)', async () => {
    const runId = await runRow('records-catalog', 'Execution');
    const ins = (title: string, artist: string, kind: string) =>
      as('xyp_catalog', (tx) => tx`insert into releases (title, artist, kind, agent_run_id) values (${title}, ${artist}, ${kind}, ${runId})`);
    await expect(ins(' ', 'X3LIUS', 'single')).rejects.toMatchObject(code('23514'));
    await expect(ins('[FIXTURE] R', '', 'single')).rejects.toMatchObject(code('23514'));
    await expect(ins('[FIXTURE] R', 'X3LIUS', 'mixtape')).rejects.toMatchObject(code('23514'));
    await expect(track(await release(), 0)).rejects.toMatchObject(code('23514'));
  });
});

describe('grants: least privilege per role', () => {
  it('xyp_catalog registers and assigns codes, nothing else (42501)', async () => {
    const r = await release();
    await expect(as('xyp_catalog', (tx) => tx`update releases set title = 'x' where id = ${r}`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_catalog', (tx) => tx`update releases set status = 'scheduled' where id = ${r}`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_catalog', (tx) => tx`delete from releases where id = ${r}`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_catalog', (tx) => tx`select 1 from canonical_prompts`)).rejects.toMatchObject(code('42501'));
  });

  it('xyp_release_calendar moves the calendar, nothing else (42501)', async () => {
    const r = await release();
    const runId = await runRow('records-release-calendar', 'Execution');
    await expect(as('xyp_release_calendar', (tx) => tx`insert into releases (title, artist, kind, agent_run_id) values ('x', 'y', 'single', ${runId})`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_release_calendar', (tx) => tx`update releases set upc = ${upc()} where id = ${r}`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_release_calendar', (tx) => tx`update tracks set isrc = 'USAB12600099'`)).rejects.toMatchObject(code('42501'));
  });

  it('xyp_runtime and service_role read; anon and authenticated get nothing', async () => {
    await readyRelease();
    for (const role of ['xyp_runtime', 'service_role']) {
      for (const rel of ['releases', 'tracks', 'rights_splits', 'current_rights_splits']) {
        await expect(as(role, (tx) => tx.unsafe(`select 1 from ${rel} limit 1`))).resolves.toBeDefined();
      }
      await expect(as(role, (tx) => tx`update releases set title = 'x'`)).rejects.toMatchObject(code('42501'));
    }
    // resolve_take (catalog.read) runs as xyp_runtime, which still can't read the Suno trail (Phase 9):
    // it calls xyp_resolve_take, which returns one take's chain and nothing else.
    const takeId = await take();
    await expect(as('xyp_runtime', (tx) => tx`select 1 from suno_takes`)).rejects.toMatchObject(code('42501'));
    const [chain] = await as('xyp_runtime', (tx) => tx<{ take_id: string; formula_title: string }[]>`select take_id, formula_title from xyp_resolve_take(${takeId})`);
    expect(chain).toEqual({ take_id: takeId, formula_title: '[FIXTURE] Night City' });
    for (const role of ['service_role', 'xyp_catalog', 'anon', 'authenticated']) {
      await expect(as(role, (tx) => tx`select * from xyp_resolve_take(${takeId})`)).rejects.toMatchObject(code('42501'));
    }
    for (const role of ['anon', 'authenticated']) {
      for (const rel of ['releases', 'tracks', 'rights_splits', 'current_rights_splits']) {
        await expect(as(role, (tx) => tx.unsafe(`select 1 from ${rel}`))).rejects.toMatchObject(code('42501'));
      }
    }
  });
});

describe('concurrency: a split write and a schedule never both commit past each other\'s check', { timeout: 15_000 }, () => {
  /** Resolves once some backend in this database waits on a lock (deterministic, no sleep). */
  const someoneWaits = async (): Promise<void> => {
    for (let i = 0; i < 80; i++) {
      const [row] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
      if (row!.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no backend ever waited on a lock');
  };

  it('schedule first: the concurrent unassigned-share write waits, then is refused (55000)', async () => {
    const { releaseId: r, trackId: t } = await readyRelease();
    const run = await rightsRun(r);
    let commit!: () => void;
    const held = new Promise<void>((res) => (commit = res));
    const scheduling = as('xyp_release_calendar', async (tx) => {
      await tx`update releases set status = 'scheduled', release_date = ${inDays(30)}::date, rights_check_run_id = ${run} where id = ${r}`;
      await held;
    });
    const writing = splits(t, 2, [['X3LIUS', 80], [null, 20]]);
    try {
      await someoneWaits();
    } finally {
      commit();
    }
    await scheduling;
    await expect(writing).rejects.toMatchObject(code('55000'));
    expect(await db.sql`select 1 from rights_splits where track_id = ${t} and version = 2`).toHaveLength(0);
  });

  it('split first: the concurrent schedule waits, then sees the unassigned share and is refused (55000)', async () => {
    const { releaseId: r, trackId: t } = await readyRelease();
    const run = await rightsRun(r);
    const runId = await runRow('records-catalog', 'Execution');
    let commit!: () => void;
    const held = new Promise<void>((res) => (commit = res));
    let locked!: () => void;
    const hasLocks = new Promise<void>((res) => (locked = res));
    const writing = as('xyp_catalog', async (tx) => {
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t}, 2, 'X3LIUS', 80, ${runId})`;
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t}, 2, null, 20, ${runId})`;
      locked();
      await held;
    });
    await hasLocks;
    const scheduling = setStatus(r, 'scheduled', inDays(30), run);
    try {
      await someoneWaits();
    } finally {
      commit();
    }
    await writing;
    await expect(scheduling).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/unassigned/) });
    expect(await statusOf(r)).toBe('draft');
  });

  it('two writers of the same new version: the second waits, then its set sums past 100 (23514)', async () => {
    const t = await track(await release(), 1);
    const runId = await runRow('records-catalog', 'Execution');
    let commit!: () => void;
    const held = new Promise<void>((res) => (commit = res));
    let locked!: () => void;
    const hasLocks = new Promise<void>((res) => (locked = res));
    const first = as('xyp_catalog', async (tx) => {
      await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t}, 1, 'X3LIUS', 100, ${runId})`;
      locked();
      await held;
    });
    await hasLocks;
    const second = splits(t, 1, [['[FIXTURE] Other', 100]]);
    try {
      await someoneWaits();
    } finally {
      commit();
    }
    await first;
    await expect(second).rejects.toMatchObject(code('23514'));
    expect(await db.sql`select payee from current_rights_splits where track_id = ${t}`).toEqual([{ payee: 'X3LIUS' }]);
  });
});
