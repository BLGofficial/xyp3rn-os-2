import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { insertResearchRun } from '../../../tests/helpers/tech-fixture.ts';
import { dashboard, peopleList, releaseDetail, releaseList, songWorkspace, taskList } from './catalog-loaders.ts';
import {
  addAlias, addPerson, assignCode, credit, createTask, link, markReleased, moveTask, recordDelivery, registerTrack, scheduleRelease, setArtwork,
  uncredit, unlink, writeSplits,
} from './catalog-ops.ts';
import { songCreate, songRevise, uploadFiles } from './ops.ts';

// AOS-02 §6: what the Command Center screens read (as xyp_web, read only) and write (dispatch and the
// Records workflows), against a throwaway migrated database. The pages only render these.

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'aos02-web-vault-'));
const today = () => new Date().toISOString().slice(0, 10);
const wav = (n: number): Uint8Array => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(1600, n)]));
};
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

let songId: string;
let releaseId: string;
let trackId: string;
let personId: string;
let taskId: string;
let questionId: string;

beforeAll(async () => {
  db = await createTestDb('aos02_web', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
  songId = (await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })).songId;
  await songRevise(deps, { songId, status: 'releasing' });
  const [bounce] = await uploadFiles(deps, [{ name: 'night-city-master.wav', bytes: wav(1) }], { songId });
  ({ releaseId, trackId } = await registerTrack(deps, { sourceId: bounce!.file.sourceId, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1, songId }));
  personId = (await addPerson(deps, 'X3LIUS')).personId;
  await addAlias(deps, personId, 'Xelius');
  await credit(deps, { person: 'xelius', role: 'writer', songId });
  taskId = (await createTask(deps, { title: 'Get the cover finished', releaseId, dueDate: today() })).taskId;
  await createTask(deps, { title: 'Renew the distributor plan' });
  const researchRun = await insertResearchRun(db.sql);
  questionId = (await db.sql<{ question_id: string }[]>`select question_id from research_runs where id = ${researchRun}`)[0]!.question_id;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('the dashboard (/)', () => {
  it('songs by status, releases with their blockers, open tasks, alerts, recent research, connectors', async () => {
    const d = await dashboard(db.sql);
    expect(d.songsByStatus.find((g) => g.status === 'releasing')!.songs).toEqual([expect.objectContaining({ id: songId, title: '[FIXTURE] Night City' })]);
    expect(d.releases).toEqual([expect.objectContaining({ id: releaseId, status: 'draft', blockers: 2, title: '[FIXTURE] New Era' })]);
    expect(d.openTasks.map((t) => t.title)).toEqual(['Get the cover finished', 'Renew the distributor plan']);
    expect(d.alerts[0]).toMatchObject({ severity: 'blocker', subjectKind: 'release', subjectTitle: '[FIXTURE] New Era' });
    expect(d.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(['no_artwork', 'track_no_splits', 'no_upc', 'track_no_isrc', 'track_no_credits']));
    expect(d.alerts.find((a) => a.code === 'track_no_splits')).toMatchObject({ subjectKind: 'track', releaseId, subjectTitle: '[FIXTURE] Night City' });
    expect(d.research.questions.map((q) => q.id)).toContain(questionId);
    expect(d.connectors).toEqual([]);
    expect(Date.parse(d.asOf)).not.toBeNaN();
  });
});

describe('releases', () => {
  it('lists releases; a release shows its tracks (recording, splits, credits, links), artwork, deliveries, checks and tasks', async () => {
    expect((await releaseList(db.sql)).map((r) => r.id)).toContain(releaseId);
    await writeSplits(deps, trackId, [{ payee: 'X3LIUS', percentage: 100 }]);
    await credit(deps, { personId, role: 'producer', trackId });
    await assignCode(deps, { trackId, isrc: 'XZA262600002' });
    await link(deps, { trackId, platform: 'soundcloud', url: 'https://soundcloud.com/x3lius/night-city' });
    await setArtwork(deps, releaseId, { name: 'cover.png', bytes: PNG });
    await recordDelivery(deps, { releaseId, distributor: 'DistroKid', status: 'submitted' });
    const r = await releaseDetail(db.sql, releaseId);
    expect(r!.release).toMatchObject({ id: releaseId, status: 'draft', upc: null });
    expect(r!.tracks[0]).toMatchObject({
      id: trackId, position: 1, isrc: 'XZA262600002', recording: { kind: 'vault', title: 'night-city-master.wav' },
      splits: { version: 1, rows: [{ payee: 'X3LIUS', percentage: 100 }] },
      credits: [expect.objectContaining({ personName: 'X3LIUS', role: 'producer' })],
      links: [expect.objectContaining({ platform: 'soundcloud' })],
    });
    expect(r!.artwork).toMatchObject({ title: 'cover.png' });
    expect(r!.deliveries).toEqual([expect.objectContaining({ distributor: 'DistroKid', status: 'submitted' })]);
    expect(r!.checks.map((c) => c.code)).toEqual(['no_upc']);
    expect(r!.tasks.map((t) => [t.title, t.status])).toEqual([['Get the cover finished', 'open']]);
    expect(await releaseDetail(db.sql, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('unlink and uncredit keep history; schedule runs the Rights check and the calendar; mark released', async () => {
    const l = await link(deps, { releaseId, platform: 'spotify', url: 'https://open.spotify.com/album/1' });
    await unlink(deps, l.linkId, 'wrong album');
    const c = await credit(deps, { personId, role: 'mastering_engineer', trackId });
    await uncredit(deps, c.creditId, 'mastered elsewhere');
    await assignCode(deps, { releaseId, upc: '070000260025' });
    await expect(scheduleRelease(deps, { releaseId: '00000000-0000-4000-8000-000000000000', releaseDate: today() })).rejects.toThrow(/no release/);
    expect(await scheduleRelease(deps, { releaseId, releaseDate: today() })).toMatchObject({ status: 'scheduled' });
    expect(await markReleased(deps, releaseId)).toMatchObject({ status: 'released' });
    const r = await releaseDetail(db.sql, releaseId);
    expect(r!.release.status).toBe('released');
    expect(r!.links).toEqual([]);
    expect(r!.tracks[0]!.credits.map((x) => x.role)).toEqual(['producer']);
  });
});

describe('people, tasks and the song workspace', () => {
  it('people with their aliases and credits', async () => {
    const people = await peopleList(db.sql);
    expect(people.find((p) => p.id === personId)).toMatchObject({ name: 'X3LIUS', aliases: ['Xelius'], credits: 2 });
  });

  it('tasks by status; moving one changes it and keeps its history', async () => {
    await moveTask(deps, taskId, 'done', 'cover approved');
    expect((await taskList(db.sql, 'open')).map((t) => t.title)).toEqual(['Renew the distributor plan']);
    expect((await taskList(db.sql, 'done'))[0]).toMatchObject({ id: taskId, title: 'Get the cover finished', releaseTitle: '[FIXTURE] New Era', statusNote: 'cover approved' });
  });

  it('the song workspace: credits, tasks, the derived release stage, the song\'s checks', async () => {
    const w = await songWorkspace(db.sql, songId);
    expect(w!.credits).toEqual([expect.objectContaining({ personName: 'X3LIUS', role: 'writer' })]);
    expect(w!.releaseStage).toBe('released');
    expect(w!.releases).toEqual([expect.objectContaining({ id: releaseId, status: 'released' })]);
    expect(w!.checks.map((c) => c.code)).toEqual(['status_behind']);
    await songRevise(deps, { songId, status: 'released' });
    expect((await songWorkspace(db.sql, songId))!.checks).toEqual([]);
    expect(await songWorkspace(db.sql, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
