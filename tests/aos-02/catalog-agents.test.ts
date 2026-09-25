import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { CLASS_CAPABILITIES } from '../../core/tool-registry/capabilities.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { addToVault } from '../../knowledge/ingestion/vault.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { inDays, insertTake } from '../helpers/records-fixture.ts';

// AOS-02 proof (part 2): the catalog's new operations through the real agents. records-catalog
// (Execution) gains people, aliases, credits, platform links, artwork and delivery status;
// records-tasks (Execution, new) writes tasks; register-track accepts a Vault audio file as the
// recording (B4). No model: all deterministic. What is real: dispatch, every tool's DB role, the
// workflows, and the DB guards.

let db: TestDb;
let deps: DispatchDeps;
const files = mkdtempSync(join(tmpdir(), 'aos02-agents-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos02-agents-vault-'));
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const REGISTER_TRACK = join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml');
const SCHEDULE_RELEASE = join(REPO_ROOT, 'records', 'workflows', 'schedule-release.workflow.yaml');
const RELEASE = { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' } as const;

beforeAll(async () => {
  db = await createTestDb('aos02_catalog_agents', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(files, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

let seq = 0;
/** 0.1 s of 16-bit mono silence at 8 kHz, made unique per call: a complete, playable WAV. */
const wav = (): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  const body = Buffer.alloc(1600);
  body.writeUInt16LE(++seq, 0);
  return Buffer.concat([h, body]);
};
const png1x1 = (): Buffer => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`, 'base64');
const file = (name: string, content: Buffer | string): string => {
  const p = join(files, `${++seq}-${name}`);
  writeFileSync(p, content);
  return p;
};
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const refused = async (agent: string, input: unknown, reason: RegExp) => {
  const r = await dispatch(deps, agent, input);
  expect(r.status, JSON.stringify(input)).toBe('error');
  expect(r.error).toMatch(reason);
};
const register = (input: Record<string, unknown>) =>
  runWorkflow(deps, loadWorkflow(REGISTER_TRACK, registry), { takeId: null, sourceId: null, title: null, mixReportArtifactId: null, ...input });
const bounce = async (songId?: string) => (await addToVault(deps, { path: file('bounce.wav', wav()), ...(songId ? { songId } : {}) })).sourceId;

describe('agents and capabilities', () => {
  it('records-catalog gains the metadata tools; records-tasks is new; the lookup reads Vault files', () => {
    expect(registry.validateAll()).toEqual([]);
    const tools = (name: string) => [...registry.get(name)!.tools].sort();
    expect(tools('records-catalog')).toEqual([
      'add_alias', 'add_person', 'assign_codes', 'log_message', 'record_delivery', 'register_track', 'retract_credit',
      'retract_platform_link', 'set_artwork', 'write_credit', 'write_platform_link', 'write_splits',
    ]);
    expect(registry.get('records-tasks')).toMatchObject({ class: 'Execution', domain: 'RECORDS', model: 'none' });
    expect(tools('records-tasks')).toEqual(['log_message', 'move_task', 'write_task']);
    expect(tools('records-catalog-lookup')).toEqual(['log_message', 'read_catalog', 'read_vault_file', 'resolve_take']);
    expect(CLASS_CAPABILITIES['task.write']).toEqual(['Execution']);
    for (const t of ['add_person', 'add_alias', 'write_credit', 'retract_credit', 'write_platform_link', 'retract_platform_link', 'set_artwork', 'record_delivery']) {
      expect(deps.tools.get(t)?.capability).toBe('catalog.write');
    }
    for (const t of ['write_task', 'move_task']) {
      expect(deps.tools.get(t)?.capability).toBe('task.write');
      expect(deps.tools.authorize('Creative', t).allow).toBe(false);
    }
  });
});

describe('register-track: a Vault audio file is a recording (B4)', () => {
  it('registers a bounce on a new draft release; the title comes from the one song the file is linked to', async () => {
    const song = await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } });
    const sourceId = await bounce(song.songId);
    const r = await register({ sourceId, release: RELEASE, position: 1 });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
    const out = r.output as { releaseId: string; trackId: string };
    expect((await db.sql`select title, take_id, source_id from tracks where id = ${out.trackId}`)[0]).toEqual({ title: '[FIXTURE] Night City', take_id: null, source_id: sourceId });
    const catalog = await ok('records-catalog-lookup', { takeId: null, sourceId: await bounce(), release: { id: out.releaseId }, position: 2, title: 'Night City (Instrumental)', mixReportArtifactId: null });
    expect(catalog.registration.track).toMatchObject({ sourceId: expect.any(String), takeId: null, title: 'Night City (Instrumental)' });
  });

  it('the lookup refuses: both or neither recording, a file that is not audio, no title to derive, a file already on the release', async () => {
    const { takeId } = await insertTake(db.sql);
    const image = (await addToVault(deps, { path: file('cover.png', png1x1()) })).sourceId;
    const unlinked = await bounce();
    const base = { release: RELEASE, position: 1, title: null, mixReportArtifactId: null };
    await refused('records-catalog-lookup', { ...base, takeId, sourceId: unlinked }, /exactly one of takeId, sourceId/);
    await refused('records-catalog-lookup', { ...base, takeId: null, sourceId: null }, /exactly one of takeId, sourceId/);
    await refused('records-catalog-lookup', { ...base, takeId: null, sourceId: image }, /not an audio file/);
    await refused('records-catalog-lookup', { ...base, takeId: null, sourceId: unlinked }, /give a title/);
    const first = await register({ sourceId: unlinked, release: RELEASE, position: 1, title: 'Bounce' });
    const releaseId = (first.output as { releaseId: string }).releaseId;
    await refused('records-catalog-lookup', { ...base, release: { id: releaseId }, position: 2, takeId: null, sourceId: unlinked, title: 'Again' }, /already on release/);
  });

  it('a Suno take still registers as before (Phase 13), and read_catalog names each track\'s recording', async () => {
    const { takeId } = await insertTake(db.sql);
    const r = await register({ takeId, release: RELEASE, position: 1 });
    expect(r.status).toBe('success');
    const releaseId = (r.output as { releaseId: string }).releaseId;
    await register({ sourceId: await bounce(), release: { id: releaseId }, position: 2, title: 'B-side' });
    const lookup = await ok('records-catalog-lookup', { takeId: null, sourceId: await bounce(), release: { id: releaseId }, position: 3, title: 'C', mixReportArtifactId: null });
    expect(lookup.registration.release).toEqual({ id: releaseId });
  });
});

describe('records-catalog: people, credits, links, artwork, delivery', () => {
  it('people and aliases; a credit names a person by id or by any of their names; uncredit keeps history', async () => {
    const x = await ok('records-catalog', { person: { name: 'X3LIUS (catalog test)' } });
    await ok('records-catalog', { alias: { personId: x.personId, alias: 'x3lius-ct' } });
    await refused('records-catalog', { person: { name: 'x3lius (CATALOG TEST)' } }, /already names a person/);
    const song = await ok('records-songs', { create: { title: '[FIXTURE] Credits', artist: 'X3LIUS' } });
    const c1 = await ok('records-catalog', { credit: { personId: x.personId, role: 'writer', songId: song.songId } });
    const c2 = await ok('records-catalog', { credit: { person: 'X3LIUS-CT', role: 'producer', songId: song.songId, note: 'co-produced' } });
    expect(c2).toMatchObject({ personId: x.personId, role: 'producer' });
    await refused('records-catalog', { credit: { person: 'Nobody Known', role: 'writer', songId: song.songId } }, /no person named "Nobody Known"/);
    await refused('records-catalog', { credit: { personId: x.personId, role: 'writer', songId: song.songId } }, /already has a live writer credit/);
    await ok('records-catalog', { uncredit: { creditId: c1.creditId, reason: '[FIXTURE] was a co-write' } });
    expect((await db.sql`select role from current_credits where song_id = ${song.songId} order by role`).map((r) => r.role)).toEqual(['producer']);
  });

  it('platform links on a release and a track, host-checked; unlink; artwork from the Vault; delivery events', async () => {
    const r = await register({ sourceId: await bounce(), release: RELEASE, position: 1, title: 'Linked' });
    const { releaseId, trackId } = r.output as { releaseId: string; trackId: string };
    const l = await ok('records-catalog', { link: { releaseId, platform: 'spotify', url: 'https://open.spotify.com/album/0sNOF9WDwhWunNAHPD3Baj' } });
    await ok('records-catalog', { link: { trackId, platform: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' } });
    await refused('records-catalog', { link: { releaseId, platform: 'spotify', url: 'https://www.youtube.com/watch?v=x' } }, /platform_links_url_check|host/);
    await ok('records-catalog', { unlink: { linkId: l.linkId, reason: '[FIXTURE] wrong album' } });
    await ok('records-catalog', { link: { releaseId, platform: 'spotify', url: 'https://open.spotify.com/album/1' } });
    const cover = (await addToVault(deps, { path: file('cover.png', png1x1()) })).sourceId;
    await ok('records-catalog', { artwork: { releaseId, sourceId: cover } });
    await refused('records-catalog', { artwork: { releaseId, sourceId: await bounce() } }, /not a Vault image/);
    await ok('records-catalog', { delivery: { releaseId, distributor: 'DistroKid', status: 'submitted' } });
    await ok('records-catalog', { delivery: { releaseId, distributor: 'distrokid', status: 'live', note: 'went live early' } });
    expect(await db.sql`select status, note from current_deliveries where release_id = ${releaseId}`).toEqual([{ status: 'live', note: 'went live early' }]);
    expect(await db.sql`select source_id from current_release_artwork where release_id = ${releaseId}`).toEqual([{ source_id: cover }]);
    expect(await db.sql`select platform, url from current_platform_links where release_id = ${releaseId}`).toEqual([{ platform: 'spotify', url: 'https://open.spotify.com/album/1' }]);
  });

  it('exactly one operation per call', async () => {
    await refused('records-catalog', { person: { name: 'A' }, alias: { personId: 'x', alias: 'y' } }, /exactly one of/);
    await refused('records-catalog', {}, /exactly one of/);
  });
});

describe('records-tasks', () => {
  it('creates a task for a song, a release, or nothing; moves it; history kept', async () => {
    const song = await ok('records-songs', { create: { title: '[FIXTURE] Tasks', artist: 'X3LIUS' } });
    const t = await ok('records-tasks', { create: { title: 'Book the mastering session', songId: song.songId, dueDate: inDays(7) } });
    await ok('records-tasks', { create: { title: 'Renew the distributor plan' } });
    await ok('records-tasks', { move: { taskId: t.taskId, status: 'done', note: 'booked for Friday' } });
    expect(await db.sql`select status, status_note from current_tasks where id = ${t.taskId}`).toEqual([{ status: 'done', status_note: 'booked for Friday' }]);
    await refused('records-tasks', { create: { title: 'x', songId: song.songId, releaseId: song.songId } }, /at most one of songId, releaseId/);
    await refused('records-tasks', { create: { title: 'x', dueDate: '25/09/2026' } }, /YYYY-MM-DD/);
    await refused('records-tasks', { move: { taskId: t.taskId, status: 'blocked' } }, /open, done or cancelled/);
    await refused('records-tasks', { create: { title: 'x' }, move: { taskId: t.taskId, status: 'done' } }, /exactly one of create, move/);
  });
});

describe('a Vault track through the calendar', () => {
  it('splits, a passing Rights check, scheduled: a bounce can reach a release', async () => {
    const r = await register({ sourceId: await bounce(), release: RELEASE, position: 1, title: 'Scheduled bounce' });
    const { releaseId, trackId } = r.output as { releaseId: string; trackId: string };
    await ok('records-catalog', { splits: { trackId, splits: [{ payee: 'X3LIUS', percentage: 100 }] } });
    const s = await runWorkflow(deps, loadWorkflow(SCHEDULE_RELEASE, registry), { releaseId, releaseDate: inDays(30) });
    expect(s, JSON.stringify(s)).toMatchObject({ status: 'success' });
    expect((await db.sql`select status::text from releases where id = ${releaseId}`)[0]).toEqual({ status: 'scheduled' });
  });
});
