import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertArtifact, insertRun, insertTake } from '../helpers/records-fixture.ts';

// AOS-02 proof (part 1): people and credits, tasks, platform links, artwork, delivery status, tracks
// whose recording is a Vault audio file, and the computed catalog checks, on a throwaway migrated
// database. Fixture rows are inserted directly under the role that owns each write; no agent runs
// here. Every refusal asserts its exact SQLSTATE.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos02_command_db', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => asCommitted(db.sql, role, fn);
const code = (c: string) => ({ code: c });
const catalogRun = () => insertRun(db.sql, 'records-catalog', 'Execution');

let seq = 0;
const uniq = (prefix: string) => `${prefix} ${process.pid}-${++seq}`;

/** A person, as xyp_catalog. */
const person = async (name: string): Promise<string> => {
  const runId = await catalogRun();
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`insert into people (name, agent_run_id) values (${name}, ${runId}) returning id`)[0]!.id);
};
const alias = async (personId: string, a: string) => {
  const runId = await catalogRun();
  return as('xyp_catalog', (tx) => tx`insert into person_aliases (person_id, alias, agent_run_id) values (${personId}, ${a}, ${runId})`);
};

/** A song with its first revision, as xyp_vault. */
const song = async (status = 'idea'): Promise<string> => {
  const runId = await insertRun(db.sql, 'records-songs', 'Execution');
  return as('xyp_vault', async (tx) => {
    const [s] = await tx<{ id: string }[]>`insert into songs (agent_run_id) values (${runId}) returning id`;
    await tx`insert into song_revisions (song_id, title, artist, status, agent_run_id) values (${s!.id}, '[FIXTURE] Night City', 'X3LIUS', ${status}::song_status, ${runId})`;
    return s!.id;
  });
};
const revise = async (songId: string, status: string) => {
  const runId = await insertRun(db.sql, 'records-songs', 'Execution');
  await as('xyp_vault', (tx) => tx`
    insert into song_revisions (song_id, title, artist, status, agent_run_id) values (${songId}, '[FIXTURE] Night City', 'X3LIUS', ${status}::song_status, ${runId})`);
};
const songLink = async (songId: string, target: { track_id?: string; artifact_lineage_id?: string }) => {
  const runId = await insertRun(db.sql, 'records-songs', 'Execution');
  await as('xyp_vault', (tx) => tx`
    insert into song_links (song_id, track_id, artifact_lineage_id, agent_run_id) values (${songId}, ${target.track_id ?? null}, ${target.artifact_lineage_id ?? null}, ${runId})`);
};

/** A Vault file of the given media class, as xyp_vault. */
const vaultFile = async (mediaClass: string): Promise<string> => {
  const runId = await insertRun(db.sql, 'vault-curator', 'Execution');
  const sha = createHash('sha256').update(randomUUID()).digest('hex');
  return as('xyp_vault', async (tx) => (await tx<{ id: string }[]>`
    insert into sources (kind, uri, title, checksum_sha256, storage, media_class, agent_run_id)
    values ('file', ${`vault://${sha}`}, ${`[FIXTURE] ${mediaClass}`}, ${sha}, 'local-vault', ${mediaClass}, ${runId}) returning id`)[0]!.id);
};
const knowledgeSource = async (): Promise<string> =>
  (await db.sql<{ id: string }[]>`
    insert into sources (kind, uri, title, checksum_sha256) values ('file', '/docs/k.md', '[FIXTURE] knowledge', ${createHash('sha256').update(randomUUID()).digest('hex')}) returning id`)[0]!.id;

const release = async (): Promise<string> => {
  const runId = await catalogRun();
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into releases (title, artist, kind, agent_run_id) values ('[FIXTURE] New Era', 'X3LIUS', 'single', ${runId}) returning id`)[0]!.id);
};
type Recording = { take_id?: string; source_id?: string };
const track = async (releaseId: string, position: number, rec: Recording, isrc: string | null = null): Promise<string> => {
  const runId = await catalogRun();
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into tracks (release_id, position, title, isrc, take_id, source_id, agent_run_id)
    values (${releaseId}, ${position}, '[FIXTURE] Night City', ${isrc}, ${rec.take_id ?? null}, ${rec.source_id ?? null}, ${runId}) returning id`)[0]!.id);
};
const splits = async (trackId: string, rows: ReadonlyArray<readonly [string | null, number]>) => {
  const runId = await catalogRun();
  await as('xyp_catalog', async (tx) => {
    const [v] = await tx<{ next: number }[]>`select coalesce(max(version), 0) + 1 as next from rights_splits where track_id = ${trackId}`;
    for (const [payee, pct] of rows) await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${trackId}, ${v!.next}, ${payee}, ${pct}, ${runId})`;
  });
};
const credit = async (personId: string, role: string, target: { song_id?: string; track_id?: string }): Promise<string> => {
  const runId = await catalogRun();
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into credits (person_id, role, song_id, track_id, agent_run_id) values (${personId}, ${role}, ${target.song_id ?? null}, ${target.track_id ?? null}, ${runId})
    returning id`)[0]!.id);
};
const link = async (platform: string, url: string, target: { release_id?: string; track_id?: string }): Promise<string> => {
  const runId = await catalogRun();
  return as('xyp_catalog', async (tx) => (await tx<{ id: string }[]>`
    insert into platform_links (platform, url, release_id, track_id, agent_run_id) values (${platform}, ${url}, ${target.release_id ?? null}, ${target.track_id ?? null}, ${runId})
    returning id`)[0]!.id);
};
const retractLink = async (linkId: string) => {
  const runId = await catalogRun();
  await as('xyp_catalog', (tx) => tx`insert into platform_link_retractions (platform_link_id, reason, agent_run_id) values (${linkId}, '[FIXTURE] wrong link', ${runId})`);
};
const artwork = async (releaseId: string, sourceId: string) => {
  const runId = await catalogRun();
  await as('xyp_catalog', (tx) => tx`insert into release_artwork (release_id, source_id, agent_run_id) values (${releaseId}, ${sourceId}, ${runId})`);
};
const delivery = async (releaseId: string, distributor: string, status: string) => {
  const runId = await catalogRun();
  await as('xyp_catalog', (tx) => tx`insert into release_deliveries (release_id, distributor, status, agent_run_id) values (${releaseId}, ${distributor}, ${status}, ${runId})`);
};
const checks = (subjectId: string) =>
  db.sql<{ severity: string; code: string }[]>`select severity, code from catalog_checks where subject_id = ${subjectId} order by severity, code`;
const codes = async (subjectId: string) => (await checks(subjectId)).map((c) => c.code);

describe('people: one namespace of names and aliases', () => {
  it('a name or alias belongs to one person, case- and space-insensitively (23505)', async () => {
    const name = uniq('X3LIUS');
    const x = await person(name);
    await expect(person(name.toLowerCase())).rejects.toMatchObject(code('23505'));
    await expect(person(`  ${name}  `)).rejects.toMatchObject(code('23505'));
    await alias(x, `${name} (alias)`);
    await expect(person(`${name} (ALIAS)`)).rejects.toMatchObject(code('23505'));
    const other = await person(uniq('Nova'));
    await expect(alias(other, name.toUpperCase())).rejects.toMatchObject(code('23505'));
    await expect(alias(other, `${name} (alias)`)).rejects.toMatchObject(code('23505'));
  });

  it('refuses a blank name; people and aliases never change (55000)', async () => {
    await expect(person('  ')).rejects.toMatchObject(code('23514'));
    const p = await person(uniq('Blank-check'));
    await expect(db.sql`update people set name = 'x' where id = ${p}`).rejects.toMatchObject(code('55000'));
    await alias(p, uniq('alias'));
    await expect(db.sql`delete from person_aliases where person_id = ${p}`).rejects.toMatchObject(code('55000'));
  });
});

describe('credits: a person, a role, exactly one song or track', () => {
  it('credits a song and a track; one live credit per target, person and role; a retraction frees it', async () => {
    const p = await person(uniq('Writer'));
    const s = await song();
    const r = await release();
    const t = await track(r, 1, { take_id: (await insertTake(db.sql)).takeId });
    const c = await credit(p, 'writer', { song_id: s });
    await credit(p, 'producer', { song_id: s });
    await credit(p, 'vocalist', { track_id: t });
    await expect(credit(p, 'writer', { song_id: s })).rejects.toMatchObject(code('23505'));
    const runId = await catalogRun();
    await as('xyp_catalog', (tx) => tx`insert into credit_retractions (credit_id, reason, agent_run_id) values (${c}, '[FIXTURE] wrong role', ${runId})`);
    await credit(p, 'writer', { song_id: s });
    expect((await db.sql`select role from current_credits where song_id = ${s} order by role`).map((x) => x.role)).toEqual(['producer', 'writer']);
    expect(await db.sql`select count(*)::int as n from credits where song_id = ${s}`).toEqual([{ n: 3 }]);
  });

  it('refuses no target, two targets, an unknown role (23514); credits never change (55000)', async () => {
    const p = await person(uniq('Refused'));
    const s = await song();
    const r = await release();
    const t = await track(r, 1, { take_id: (await insertTake(db.sql)).takeId });
    await expect(credit(p, 'writer', {})).rejects.toMatchObject(code('23514'));
    await expect(credit(p, 'writer', { song_id: s, track_id: t })).rejects.toMatchObject(code('23514'));
    await expect(credit(p, 'dj', { song_id: s })).rejects.toMatchObject(code('23514'));
    const c = await credit(p, 'mixing_engineer', { track_id: t });
    await expect(db.sql`update credits set role = 'writer' where id = ${c}`).rejects.toMatchObject(code('55000'));
  });
});

describe('platform links: the host must match the platform', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', true],
    ['spotify', 'http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', false],
    ['spotify', 'https://www.youtube.com/watch?v=abc', false],
    ['spotify', 'https://open.spotify.com.evil.io/track/x', false],
    ['apple_music', 'https://music.apple.com/us/album/new-era/123', true],
    ['youtube', 'https://youtu.be/dQw4w9WgXcQ', true],
    ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['youtube_music', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', true],
    ['youtube_music', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', false],
    ['soundcloud', 'https://soundcloud.com/x3lius/night-city', true],
    ['bandcamp', 'https://x3lius.bandcamp.com/track/night-city', true],
    ['bandcamp', 'https://bandcamp.com.evil.io/track/night-city', false],
    ['tidal', 'https://tidal.com/browse/track/123', true],
    ['deezer', 'https://www.deezer.com/track/123', true],
    ['amazon_music', 'https://music.amazon.de/albums/B0XYZ', true],
    ['amazon_music', 'https://music.amazon.co.uk/albums/B0XYZ', true],
    ['amazon_music', 'https://www.amazon.com/music', false],
    ['tiktok', 'https://www.tiktok.com/music/night-city-123', true],
    ['instagram', 'https://www.instagram.com/x3lius/', true],
    ['other', 'https://x3lius.example.org/night-city', true],
    ['other', 'ftp://x3lius.example.org/night-city', false],
    ['myspace', 'https://myspace.com/x3lius', false],
    ['spotify', 'https://', false],
  ];

  it.each(cases)('%s %s → %s', async (platform, url, ok) => {
    const r = await release();
    if (ok) await expect(link(platform, url, { release_id: r })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    else await expect(link(platform, url, { release_id: r })).rejects.toMatchObject(code('23514'));
  });

  it('exactly one of release or track; one live link per target and platform (23505); a retraction frees it; history kept', async () => {
    const r = await release();
    const t = await track(r, 1, { take_id: (await insertTake(db.sql)).takeId });
    await expect(link('spotify', 'https://open.spotify.com/album/1', {})).rejects.toMatchObject(code('23514'));
    await expect(link('spotify', 'https://open.spotify.com/album/1', { release_id: r, track_id: t })).rejects.toMatchObject(code('23514'));
    const l = await link('spotify', 'https://open.spotify.com/album/1', { release_id: r });
    await link('spotify', 'https://open.spotify.com/track/2', { track_id: t });
    await expect(link('spotify', 'https://open.spotify.com/album/3', { release_id: r })).rejects.toMatchObject(code('23505'));
    await retractLink(l);
    await link('spotify', 'https://open.spotify.com/album/3', { release_id: r });
    expect(await db.sql`select url from current_platform_links where release_id = ${r}`).toEqual([{ url: 'https://open.spotify.com/album/3' }]);
    expect(await db.sql`select count(*)::int as n from platform_links where release_id = ${r}`).toEqual([{ n: 2 }]);
    await expect(db.sql`delete from platform_links where id = ${l}`).rejects.toMatchObject(code('55000'));
  });
});

describe('artwork and delivery status', () => {
  it('artwork is a Vault image; the newest one is current; history kept', async () => {
    const r = await release();
    await expect(artwork(r, await vaultFile('audio'))).rejects.toMatchObject(code('23514'));
    await expect(artwork(r, await knowledgeSource())).rejects.toMatchObject(code('23514'));
    const first = await vaultFile('image');
    const second = await vaultFile('image');
    await artwork(r, first);
    await artwork(r, second);
    expect(await db.sql`select source_id from current_release_artwork where release_id = ${r}`).toEqual([{ source_id: second }]);
  });

  it('delivery events per distributor (case-insensitive); only the listed statuses (23514)', async () => {
    const r = await release();
    await delivery(r, 'DistroKid', 'submitted');
    await delivery(r, 'distrokid', 'live');
    await delivery(r, 'TuneCore', 'in_review');
    await expect(delivery(r, 'DistroKid', 'shipped')).rejects.toMatchObject(code('23514'));
    await expect(delivery(r, '  ', 'live')).rejects.toMatchObject(code('23514'));
    expect(await db.sql`select lower(distributor) as d, status from current_deliveries where release_id = ${r} order by 1`).toEqual([
      { d: 'distrokid', status: 'live' }, { d: 'tunecore', status: 'in_review' },
    ]);
  });
});

describe('tracks: the recording is a Suno take or a Vault audio file (B4)', () => {
  it('registers a Vault audio file; refuses none, both, or a file that is not audio (23514); one per release (23505)', async () => {
    const r = await release();
    const bounce = await vaultFile('audio');
    await track(r, 1, { source_id: bounce });
    await expect(track(r, 2, {})).rejects.toMatchObject(code('23514'));
    await expect(track(r, 3, { take_id: (await insertTake(db.sql)).takeId, source_id: await vaultFile('audio') })).rejects.toMatchObject(code('23514'));
    await expect(track(r, 4, { source_id: await vaultFile('image') })).rejects.toMatchObject(code('23514'));
    await expect(track(r, 5, { source_id: bounce })).rejects.toMatchObject(code('23505'));
  });

  it('one ISRC names one recording, a take or a Vault file (23514 for a different recording)', async () => {
    const bounce = await vaultFile('audio');
    const isrc = `XZA2${String(26_000_000 + (++seq % 1_000_000)).padStart(8, '0')}`.slice(0, 12);
    await track(await release(), 1, { source_id: bounce }, isrc);
    await track(await release(), 1, { source_id: bounce }, isrc);
    await expect(track(await release(), 1, { source_id: await vaultFile('audio') }, isrc)).rejects.toMatchObject(code('23514'));
    await expect(track(await release(), 1, { take_id: (await insertTake(db.sql)).takeId }, isrc)).rejects.toMatchObject(code('23514'));
  });
});

describe('tasks: immutable, with a status history', () => {
  const task = async (over: { song_id?: string; release_id?: string; title?: string } = {}): Promise<string> => {
    const runId = await insertRun(db.sql, 'records-tasks', 'Execution');
    return as('xyp_tasks', async (tx) => (await tx<{ id: string }[]>`
      insert into tasks (title, song_id, release_id, due_date, agent_run_id)
      values (${over.title ?? '[FIXTURE] Book the mastering session'}, ${over.song_id ?? null}, ${over.release_id ?? null}, current_date + 7, ${runId})
      returning id`)[0]!.id);
  };
  const move = async (taskId: string, status: string) => {
    const runId = await insertRun(db.sql, 'records-tasks', 'Execution');
    await as('xyp_tasks', (tx) => tx`insert into task_events (task_id, status, agent_run_id) values (${taskId}, ${status}, ${runId})`);
  };

  it('open until an event says otherwise; done, reopened, cancelled; the latest event is the status', async () => {
    const t = await task({ song_id: await song() });
    const status = async () => (await db.sql<{ status: string }[]>`select status from current_tasks where id = ${t}`)[0]!.status;
    expect(await status()).toBe('open');
    await move(t, 'done');
    expect(await status()).toBe('done');
    await move(t, 'open');
    await move(t, 'cancelled');
    expect(await status()).toBe('cancelled');
    expect(await db.sql`select count(*)::int as n from task_events where task_id = ${t}`).toEqual([{ n: 3 }]);
  });

  it('refuses both a song and a release, a blank title, an unknown status (23514); tasks never change (55000)', async () => {
    await expect(task({ song_id: await song(), release_id: await release() })).rejects.toMatchObject(code('23514'));
    await expect(task({ title: ' ' })).rejects.toMatchObject(code('23514'));
    const t = await task();
    await expect(move(t, 'blocked')).rejects.toMatchObject(code('23514'));
    await expect(db.sql`update tasks set title = 'x' where id = ${t}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from task_events where task_id = ${t}`).rejects.toMatchObject(code('55000'));
  });
});

describe('catalog_checks: computed from the data, cleared by fixing it', () => {
  it('a release: blockers and warnings appear, and each clears when the data is there', async () => {
    const r = await release();
    expect(await checks(r)).toEqual([{ severity: 'blocker', code: 'no_artwork' }, { severity: 'blocker', code: 'no_tracks' }, { severity: 'warning', code: 'no_upc' }]);
    const t = await track(r, 1, { source_id: await vaultFile('audio') });
    expect(await codes(t)).toEqual(['track_no_splits', 'track_no_credits', 'track_no_isrc']);
    await splits(t, [['X3LIUS', 60], [null, 40]]);
    expect(await codes(t)).toEqual(['track_unassigned_share', 'track_no_credits', 'track_no_isrc']);
    await splits(t, [['X3LIUS', 100]]);
    await credit(await person(uniq('Producer')), 'producer', { track_id: t });
    await as('xyp_catalog', (tx) => tx`update tracks set isrc = ${`XZB2${String(27_000_000 + (++seq % 1_000_000)).padStart(8, '0')}`.slice(0, 12)} where id = ${t}`);
    expect(await codes(t)).toEqual([]);
    await artwork(r, await vaultFile('image'));
    expect(await codes(r)).toEqual(['no_upc']);
  });

  it('scheduled without a delivery, released without a platform link', async () => {
    const r = await release();
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update releases set status = 'scheduled', release_date = current_date + 30, rights_check_run_id = agent_run_id where id = ${r}`;
    });
    expect(await codes(r)).toContain('scheduled_no_delivery');
    await delivery(r, 'DistroKid', 'submitted');
    expect(await codes(r)).not.toContain('scheduled_no_delivery');
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update releases set status = 'released' where id = ${r}`;
    });
    expect(await codes(r)).toContain('released_no_platform_link');
    await link('spotify', 'https://open.spotify.com/album/9', { release_id: r });
    expect(await codes(r)).not.toContain('released_no_platform_link');
  });

  it('a song: unapproved lyrics, no credits, status behind or ahead of its release', async () => {
    const s = await song('writing');
    const lyrics = await insertArtifact(db.sql, 'x3lius.lyrics/v2', { fixture: true });
    await songLink(s, { artifact_lineage_id: lyrics });
    expect(await codes(s)).toEqual(['lyrics_not_approved', 'no_credits']);
    await as('service_role', (tx) => tx`select xyp_decide_artifact(${lyrics}, 'approve', 'owner', '[FIXTURE] yes')`);
    await credit(await person(uniq('Songwriter')), 'writer', { song_id: s });
    expect(await codes(s)).toEqual([]);
    await revise(s, 'released');
    expect(await codes(s)).toEqual(['status_ahead']);
    const r = await release();
    const t = await track(r, 1, { source_id: await vaultFile('audio') });
    await songLink(s, { track_id: t });
    await db.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update releases set status = 'released', release_date = current_date, rights_check_run_id = agent_run_id where id = ${r}`;
    });
    expect(await codes(s)).toEqual([]);
    await revise(s, 'producing');
    expect(await codes(s)).toEqual(['status_behind']);
  });
});

describe('grants: least privilege', () => {
  it('xyp_web reads everything new and writes nothing (42501)', async () => {
    for (const rel of ['people', 'person_aliases', 'credits', 'credit_retractions', 'current_credits', 'platform_links', 'platform_link_retractions',
      'current_platform_links', 'release_artwork', 'current_release_artwork', 'release_deliveries', 'current_deliveries', 'tasks', 'task_events',
      'current_tasks', 'catalog_checks']) {
      await expect(as('xyp_web', (tx) => tx.unsafe(`select * from public.${rel} limit 1`))).resolves.toBeDefined();
    }
    await expect(as('xyp_web', (tx) => tx`insert into people (name, agent_run_id) values ('x', gen_random_uuid())`)).rejects.toMatchObject(code('42501'));
  });

  it('xyp_catalog writes catalog metadata, not tasks; xyp_tasks writes tasks, not credits (42501)', async () => {
    const runId = await catalogRun();
    await expect(as('xyp_catalog', (tx) => tx`insert into tasks (title, agent_run_id) values ('x', ${runId})`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_tasks', (tx) => tx`insert into people (name, agent_run_id) values (${uniq('p')}, ${runId})`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_vault', (tx) => tx`insert into people (name, agent_run_id) values (${uniq('p')}, ${runId})`)).rejects.toMatchObject(code('42501'));
  });

  it('service_role reads only; anon and authenticated get nothing', async () => {
    await expect(as('service_role', (tx) => tx`select count(*) from people`)).resolves.toBeDefined();
    await expect(as('service_role', (tx) => tx`insert into people (name, agent_run_id) values ('x', gen_random_uuid())`)).rejects.toMatchObject(code('42501'));
    for (const role of ['anon', 'authenticated']) {
      await expect(as(role, (tx) => tx`select count(*) from credits`)).rejects.toMatchObject(code('42501'));
    }
  });
});
