import type postgres from 'postgres';
import type { Sql } from '../../../core/db/client.ts';
import { asWeb, type SongRef } from './loaders.ts';

/**
 * What the Command Center screens read (AOS-02 §6), as xyp_web in read-only transactions. Every list
 * carries its times; the dashboard carries the moment it was read (asOf).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SONG_STATUSES = ['idea', 'writing', 'producing', 'releasing', 'released', 'archived'] as const;
const STAGE_ORDER = ['draft', 'scheduled', 'released'] as const;

export type Check = {
  readonly severity: 'blocker' | 'warning';
  readonly subjectKind: 'song' | 'release' | 'track';
  readonly subjectId: string;
  readonly subjectTitle: string;
  readonly releaseId: string | null;
  readonly code: string;
  readonly message: string;
};

type CheckRow = { severity: Check['severity']; subject_kind: Check['subjectKind']; subject_id: string; subject_title: string; release_id: string | null; code: string; message: string };
const toCheck = (c: CheckRow): Check => ({
  severity: c.severity, subjectKind: c.subject_kind, subjectId: c.subject_id, subjectTitle: c.subject_title, releaseId: c.release_id, code: c.code, message: c.message,
});

// Checks with the title of what they are about; blockers first.
const checksWhere = (tx: postgres.TransactionSql, where: postgres.PendingQuery<postgres.Row[]>) => tx<CheckRow[]>`
  select c.severity, c.subject_kind, c.subject_id, c.release_id, c.code, c.message,
         coalesce(s.title, r.title, t.title, '?') as subject_title
  from catalog_checks c
  left join current_songs s on c.subject_kind = 'song' and s.id = c.subject_id
  left join releases r on c.subject_kind = 'release' and r.id = c.subject_id
  left join tracks t on c.subject_kind = 'track' and t.id = c.subject_id
  where ${where}
  order by c.severity, c.subject_kind, subject_title, c.code`;

export type TaskRow = {
  readonly id: string; readonly title: string; readonly status: string; readonly statusNote: string | null; readonly statusAt: string;
  readonly dueDate: string | null; readonly songId: string | null; readonly songTitle: string | null; readonly releaseId: string | null;
  readonly releaseTitle: string | null; readonly createdAt: string;
};
type TaskDb = {
  id: string; title: string; status: string; status_note: string | null; status_at: Date; due_date: string | null; song_id: string | null;
  song_title: string | null; release_id: string | null; release_title: string | null; created_at: Date;
};
const toTask = (t: TaskDb): TaskRow => ({
  id: t.id, title: t.title, status: t.status, statusNote: t.status_note, statusAt: t.status_at.toISOString(), dueDate: t.due_date,
  songId: t.song_id, songTitle: t.song_title, releaseId: t.release_id, releaseTitle: t.release_title, createdAt: t.created_at.toISOString(),
});
const tasksWhere = (tx: postgres.TransactionSql, where: postgres.PendingQuery<postgres.Row[]>) => tx<TaskDb[]>`
  select t.id, t.title, t.status, t.status_note, t.status_at, t.due_date::text, t.song_id, s.title as song_title, t.release_id, r.title as release_title, t.created_at
  from current_tasks t left join current_songs s on s.id = t.song_id left join releases r on r.id = t.release_id
  where ${where}
  order by t.due_date nulls last, t.title, t.id`;

/**
 * `/`: the Command Center. Songs by status, releases with their blocker and warning counts, open
 * tasks, alerts (every check, blockers first), recent research, and connector health (none yet).
 * @param sql - the app's pool
 * @returns the dashboard, with the moment it was read
 */
export const dashboard = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const songs = await tx<{ id: string; title: string; status: string; revision: number; created_at: Date }[]>`
      select id, title, status::text, revision, created_at from current_songs order by title, id`;
    const releases = await tx<{ id: string; title: string; artist: string; kind: string; status: string; release_date: string | null; blockers: number; warnings: number; created_at: Date }[]>`
      select r.id, r.title, r.artist, r.kind, r.status::text, r.release_date::text,
             (select count(*)::int from catalog_checks c where c.release_id = r.id and c.severity = 'blocker') as blockers,
             (select count(*)::int from catalog_checks c where c.release_id = r.id and c.severity = 'warning') as warnings,
             r.created_at
      from releases r order by r.release_date nulls last, r.created_at desc, r.id`;
    const openTasks = await tasksWhere(tx, tx`t.status = 'open'`);
    const alerts = await checksWhere(tx, tx`true`);
    const questions = await tx<{ id: string; question: string; created_at: Date }[]>`
      select id, question, created_at from research_questions order by created_at desc, id limit 5`;
    const findings = await tx<{ id: string; claim: string; confidence: string; created_at: Date }[]>`
      select id, claim, confidence::text, created_at from research_findings order by created_at desc, id limit 5`;
    const [{ now }] = (await tx<{ now: Date }[]>`select now()`) as [{ now: Date }];
    return {
      asOf: now.toISOString(),
      songsByStatus: SONG_STATUSES.map((status) => ({
        status, songs: songs.filter((s) => s.status === status).map((s) => ({ id: s.id, title: s.title, revision: s.revision, createdAt: s.created_at.toISOString() })),
      })),
      releases: releases.map((r) => ({
        id: r.id, title: r.title, artist: r.artist, kind: r.kind, status: r.status, releaseDate: r.release_date, blockers: r.blockers, warnings: r.warnings,
        createdAt: r.created_at.toISOString(),
      })),
      openTasks: openTasks.map(toTask),
      alerts: alerts.map(toCheck),
      research: {
        questions: questions.map((q) => ({ id: q.id, question: q.question, createdAt: q.created_at.toISOString() })),
        findings: findings.map((f) => ({ id: f.id, claim: f.claim, confidence: Number(f.confidence), createdAt: f.created_at.toISOString() })),
      },
      // No platform or distributor is connected before AOS-06; the dashboard says so rather than guess.
      connectors: [] as { name: string; status: string }[],
    };
  });

/**
 * `/releases`: every release with its status, date, track count and check counts.
 * @param sql - the app's pool
 * @returns releases, scheduled and released first by date
 */
export const releaseList = (sql: Sql) =>
  asWeb(sql, async (tx) => (await tx<{ id: string; title: string; artist: string; kind: string; status: string; release_date: string | null; upc: string | null; tracks: number; blockers: number; warnings: number; created_at: Date }[]>`
    select r.id, r.title, r.artist, r.kind, r.status::text, r.release_date::text, r.upc,
           (select count(*)::int from tracks t where t.release_id = r.id) as tracks,
           (select count(*)::int from catalog_checks c where c.release_id = r.id and c.severity = 'blocker') as blockers,
           (select count(*)::int from catalog_checks c where c.release_id = r.id and c.severity = 'warning') as warnings,
           r.created_at
    from releases r order by r.release_date nulls last, r.created_at desc, r.id`).map((r) => ({
    id: r.id, title: r.title, artist: r.artist, kind: r.kind, status: r.status, releaseDate: r.release_date, upc: r.upc, tracks: r.tracks,
    blockers: r.blockers, warnings: r.warnings, createdAt: r.created_at.toISOString(),
  })));

type CreditRow = { id: string; person_id: string; person_name: string; role: string; note: string | null; song_id: string | null; track_id: string | null; created_at: Date };
const toCredit = (c: CreditRow) => ({ id: c.id, personId: c.person_id, personName: c.person_name, role: c.role, note: c.note, createdAt: c.created_at.toISOString() });
type LinkRow = { id: string; platform: string; url: string; release_id: string | null; track_id: string | null; created_at: Date };
const toLink = (l: LinkRow) => ({ id: l.id, platform: l.platform, url: l.url, createdAt: l.created_at.toISOString() });

/**
 * `/releases/[id]`: a release with its tracks (recording, ISRC, current splits, credits, links),
 * artwork (current and earlier), platform links, deliveries, checks and tasks.
 * @param sql - the app's pool
 * @param id - releases.id
 * @returns the release, or null
 */
export const releaseDetail = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(id)) return null;
    const [r] = await tx<{ id: string; title: string; artist: string; kind: string; status: string; release_date: string | null; upc: string | null; rights_check_run_id: string | null; created_at: Date }[]>`
      select id, title, artist, kind, status::text, release_date::text, upc, rights_check_run_id, created_at from releases where id = ${id}`;
    if (!r) return null;
    const tracks = await tx<{ id: string; position: number; title: string; isrc: string | null; take_id: string | null; source_id: string | null; take_title: string | null; audio_url: string | null; file_title: string | null }[]>`
      select t.id, t.position, t.title, t.isrc, t.take_id, t.source_id, k.title as take_title, k.audio_url, s.title as file_title
      from tracks t left join suno_takes k on k.id = t.take_id left join sources s on s.id = t.source_id
      where t.release_id = ${id} order by t.position`;
    const trackIds = tracks.map((t) => t.id);
    const splits = await tx<{ track_id: string; version: number; payee: string | null; percentage: string }[]>`
      select track_id, version, payee, percentage::text from current_rights_splits where track_id = any(${trackIds}::uuid[]) order by percentage desc, payee nulls last`;
    const credits = await tx<CreditRow[]>`
      select id, person_id, person_name, role, note, song_id, track_id, created_at from current_credits where track_id = any(${trackIds}::uuid[]) order by role, person_name`;
    const links = await tx<LinkRow[]>`
      select id, platform, url, release_id, track_id, created_at from current_platform_links
      where release_id = ${id} or track_id = any(${trackIds}::uuid[]) order by platform`;
    const artwork = await tx<{ id: string; source_id: string; title: string; created_at: Date }[]>`
      select a.id, a.source_id, s.title, a.created_at from release_artwork a join sources s on s.id = a.source_id
      where a.release_id = ${id} order by a.created_at desc, a.id desc`;
    const deliveries = await tx<{ distributor: string; status: string; note: string | null; created_at: Date }[]>`
      select distributor, status, note, created_at from current_deliveries where release_id = ${id} order by lower(distributor)`;
    const checks = await checksWhere(tx, tx`c.release_id = ${id}`);
    const tasks = await tasksWhere(tx, tx`t.release_id = ${id}`);
    const songs = await tx<{ track_id: string; id: string; title: string }[]>`
      select l.track_id, s.id, s.title from current_song_links l join current_songs s on s.id = l.song_id where l.track_id = any(${trackIds}::uuid[]) order by s.title`;
    return {
      release: { id: r.id, title: r.title, artist: r.artist, kind: r.kind, status: r.status, releaseDate: r.release_date, upc: r.upc, rightsCheckRunId: r.rights_check_run_id, createdAt: r.created_at.toISOString() },
      tracks: tracks.map((t) => {
        const own = splits.filter((s) => s.track_id === t.id);
        return {
          id: t.id, position: t.position, title: t.title, isrc: t.isrc,
          recording: t.take_id
            ? { kind: 'take' as const, id: t.take_id, title: t.take_title ?? t.take_id, url: t.audio_url }
            : { kind: 'vault' as const, id: t.source_id!, title: t.file_title ?? t.source_id!, url: `/vault/files/${t.source_id}/raw` },
          splits: own.length === 0 ? null : { version: own[0]!.version, rows: own.map((s) => ({ payee: s.payee, percentage: Number(s.percentage) })) },
          credits: credits.filter((c) => c.track_id === t.id).map(toCredit),
          links: links.filter((l) => l.track_id === t.id).map(toLink),
          songs: songs.filter((s) => s.track_id === t.id).map((s) => ({ id: s.id, title: s.title })),
        };
      }),
      artwork: artwork[0] ? { sourceId: artwork[0].source_id, title: artwork[0].title, setAt: artwork[0].created_at.toISOString() } : null,
      artworkHistory: artwork.slice(1).map((a) => ({ sourceId: a.source_id, title: a.title, setAt: a.created_at.toISOString() })),
      links: links.filter((l) => l.release_id === id).map(toLink),
      deliveries: deliveries.map((d) => ({ distributor: d.distributor, status: d.status, note: d.note, at: d.created_at.toISOString() })),
      checks: checks.map(toCheck),
      tasks: tasks.map(toTask),
    };
  });

/**
 * `/people`: every person, their aliases and their count of live credits.
 * @param sql - the app's pool
 * @returns people by name
 */
export const peopleList = (sql: Sql) =>
  asWeb(sql, async (tx) => (await tx<{ id: string; name: string; aliases: string[]; credits: number; created_at: Date }[]>`
    select p.id, p.name, array(select a.alias from person_aliases a where a.person_id = p.id order by a.alias) as aliases,
           (select count(*)::int from current_credits c where c.person_id = p.id) as credits, p.created_at
    from people p order by lower(p.name), p.id`).map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, credits: p.credits, createdAt: p.created_at.toISOString() })));

/**
 * `/tasks`: tasks with one status (open, done or cancelled), soonest due first.
 * @param sql - the app's pool
 * @param status - which tasks
 * @returns tasks with their song or release title
 */
export const taskList = (sql: Sql, status: string) =>
  asWeb(sql, async (tx) => (await tasksWhere(tx, tx`t.status = ${status}`)).map(toTask));

/**
 * The song workspace's AOS-02 part (`/songs/[id]`): credits, tasks, the releases of its linked
 * tracks and the derived release stage (the furthest of them), and the song's own checks.
 * @param sql - the app's pool
 * @param id - songs.id
 * @returns the workspace, or null
 */
export const songWorkspace = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(id)) return null;
    const [s] = await tx<{ id: string }[]>`select id from current_songs where id = ${id}`;
    if (!s) return null;
    const credits = await tx<CreditRow[]>`
      select id, person_id, person_name, role, note, song_id, track_id, created_at from current_credits where song_id = ${id} order by role, person_name`;
    const tasks = await tasksWhere(tx, tx`t.song_id = ${id}`);
    const releases = await tx<{ id: string; title: string; status: string; release_date: string | null }[]>`
      select distinct r.id, r.title, r.status::text, r.release_date::text
      from current_song_links l join tracks t on t.id = l.track_id join releases r on r.id = t.release_id
      where l.song_id = ${id} order by r.title`;
    const checks = await checksWhere(tx, tx`c.subject_kind = 'song' and c.subject_id = ${id}`);
    const stage = releases.reduce<string | null>((best, r) => (best === null || STAGE_ORDER.indexOf(r.status as never) > STAGE_ORDER.indexOf(best as never) ? r.status : best), null);
    return {
      credits: credits.map(toCredit),
      tasks: tasks.map(toTask),
      releases: releases.map((r) => ({ id: r.id, title: r.title, status: r.status, releaseDate: r.release_date })),
      releaseStage: stage ?? 'none',
      checks: checks.map(toCheck),
    };
  });

export type { SongRef };
