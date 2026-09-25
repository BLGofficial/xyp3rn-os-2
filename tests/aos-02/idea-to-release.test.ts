import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { decideArtifact } from '../../governance/approvals.ts';
import { addToVault } from '../../knowledge/ingestion/vault.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { exportVault } from '../../knowledge/vault-io/export.ts';
import { addAndImport } from '../../records/vault/import.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// AOS-02 gate (PLAN.md §5 Phase 2): "a song can move from idea to release with its creative history
// and metadata intact". One song, end to end, through the real agents and workflows only: no fixture
// row is inserted directly. The computed checks are read at each stage; at the end none is left,
// and the whole history is still there.

let db: TestDb;
let deps: DispatchDeps;
let store: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos02-gate-'));
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const workflow = (name: string, input: Record<string, unknown>) => runWorkflow(deps, loadWorkflow(join(REPO_ROOT, 'records', 'workflows', name), registry), input);
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const file = (name: string, content: Buffer | string) => {
  const p = join(tmp, 'files', name);
  writeFileSync(p, content);
  return p;
};
const today = () => new Date().toISOString().slice(0, 10);
/** A fixture UPC-A: an 11-digit base in an unused range plus its GS1 check digit (weights 3,1 from the right). */
const fixtureUpc = (base = '07000026001'): string => {
  const sum = [...base].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
};
const UPC = fixtureUpc();
/** Every check on the song, the release and its tracks, as `subject:code`. */
const openChecks = async (songId: string, releaseId: string | null = null) =>
  (await db.sql<{ subject_kind: string; code: string }[]>`
    select subject_kind, code from catalog_checks where subject_id = ${songId} or release_id = ${releaseId} order by subject_kind, code`)
    .map((c) => `${c.subject_kind}:${c.code}`);

beforeAll(async () => {
  db = await createTestDb('aos02_idea_to_release', { migrated: true });
  mkdirSync(join(tmp, 'files'));
  store = createLocalVaultStore(join(tmp, 'vault'));
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, vault: store }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the gate: one song from idea to release, its history and metadata intact', () => {
  it('idea → writing → producing → releasing → released, every step an agent run, no check left at the end', async () => {
    // 1. An idea. Ideas carry no checks.
    const { songId } = await ok('records-songs', { create: { title: 'Night City', artist: 'X3LIUS', language: 'en', genre: 'darkwave' } });
    expect(await openChecks(songId)).toEqual([]);

    // 2. Writing: the lyric sheet becomes a lyrics lineage, a draft until approved.
    await ok('records-songs', { revise: { songId, status: 'writing' } });
    const sheet = await addAndImport(deps, {
      path: file('night-city.txt', '[Verse 1]\nNeon bleeding on the glass\nSodium lamps and a midnight train\n\n[Chorus]\nWe run the city till the morning breaks\n'),
      as: 'lyric_sheet', language: 'en', songId,
    });
    const lyrics = sheet.lyrics as { artifactId: string; lineageId: string };
    expect(await openChecks(songId)).toEqual(['song:lyrics_not_approved', 'song:no_credits']);
    await decideArtifact(db.sql, lyrics.artifactId, { decision: 'approve', approver: 'owner', reason: 'the words are final' });
    const x3lius = await ok('records-catalog', { person: { name: 'X3LIUS' } });
    await ok('records-catalog', { credit: { personId: x3lius.personId, role: 'writer', songId } });
    expect(await openChecks(songId)).toEqual([]);

    // 3. Producing: the FL Studio bounce goes into the Vault, linked to the song.
    await ok('records-songs', { revise: { songId, status: 'producing' } });
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + 16000, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(16000, 40);
    const bounce = await addToVault(deps, { path: file('night-city-master-v3.wav', Buffer.concat([h, Buffer.alloc(16000)])), songId, linkRole: 'master' });

    // 4. Releasing: the bounce becomes a track on a new draft single, titled from its song.
    await ok('records-songs', { revise: { songId, status: 'releasing' } });
    const reg = await workflow('register-track.workflow.yaml', {
      takeId: null, sourceId: bounce.sourceId, release: { title: 'Night City', artist: 'X3LIUS', kind: 'single' }, position: 1, title: null, mixReportArtifactId: null,
    });
    expect(reg, JSON.stringify(reg)).toMatchObject({ status: 'success' });
    const { releaseId, trackId } = reg.output as { releaseId: string; trackId: string };
    await ok('records-songs', { link: { songId, trackId, role: 'release' } });
    const task = await ok('records-tasks', { create: { title: 'Get the cover finished', releaseId, dueDate: today() } });
    expect(await openChecks(songId, releaseId)).toEqual([
      'release:no_artwork', 'release:no_upc', 'track:track_no_credits', 'track:track_no_isrc', 'track:track_no_splits',
    ]);

    // Metadata: splits, credits, codes, artwork. The blockers clear as the data arrives.
    await ok('records-catalog', { splits: { trackId, splits: [{ payee: 'X3LIUS', percentage: 100 }] } });
    await ok('records-catalog', { credit: { person: 'x3lius', role: 'producer', trackId } });
    await ok('records-catalog', { assign: { trackId, isrc: 'XZA262600001' } });
    await ok('records-catalog', { assign: { releaseId, upc: UPC } });
    const cover = await addToVault(deps, { path: file('night-city-cover.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')) });
    await ok('records-catalog', { artwork: { releaseId, sourceId: cover.sourceId } });
    await ok('records-tasks', { move: { taskId: task.taskId, status: 'done', note: 'cover approved' } });
    expect(await openChecks(songId, releaseId)).toEqual([]);

    // 5. The calendar: the Rights check clears it, it is scheduled, delivered, and released.
    const scheduled = await workflow('schedule-release.workflow.yaml', { releaseId, releaseDate: today() });
    expect(scheduled, JSON.stringify(scheduled)).toMatchObject({ status: 'success' });
    expect(await openChecks(songId, releaseId)).toEqual(['release:scheduled_no_delivery']);
    await ok('records-catalog', { delivery: { releaseId, distributor: 'DistroKid', status: 'submitted' } });
    expect(await openChecks(songId, releaseId)).toEqual([]);
    await ok('records-release-calendar', { release: { releaseId } });
    await ok('records-catalog', { delivery: { releaseId, distributor: 'DistroKid', status: 'live' } });
    expect(await openChecks(songId, releaseId)).toEqual(['release:released_no_platform_link', 'song:status_behind']);
    await ok('records-catalog', { link: { releaseId, platform: 'spotify', url: 'https://open.spotify.com/album/5ht7ItJgpBH7W6vJ5BqpPr' } });
    await ok('records-songs', { revise: { songId, status: 'released' } });
    expect(await openChecks(songId, releaseId)).toEqual([]);

    // The history is intact: every revision, link, lyric version and decision, the recording's origin.
    expect((await db.sql`select status::text from song_revisions where song_id = ${songId} order by revision`).map((r) => r.status))
      .toEqual(['idea', 'writing', 'producing', 'releasing', 'released']);
    expect(await db.sql`select kind, role from current_song_links where song_id = ${songId} order by created_at`).toEqual([
      { kind: 'source', role: 'lyric-sheet' }, { kind: 'artifact_lineage', role: 'lyrics' }, { kind: 'source', role: 'master' }, { kind: 'track', role: 'release' },
    ]);
    expect((await db.sql`select version, status, approved_version from artifact_approvals where lineage_id = ${lyrics.lineageId}`)[0])
      .toEqual({ version: 1, status: 'approved', approved_version: 1 });
    expect((await db.sql`
      select t.title, t.isrc, s.checksum_sha256, r.agent_name as added_by
      from tracks t join sources s on s.id = t.source_id join agent_runs r on r.id = s.agent_run_id where t.id = ${trackId}`)[0])
      .toEqual({ title: 'Night City', isrc: 'XZA262600001', checksum_sha256: bounce.sha256, added_by: 'vault-curator' });
    expect(await db.sql`select person_name, role, coalesce(song_id, track_id) = ${songId} as on_song from current_credits order by role`).toEqual([
      { person_name: 'X3LIUS', role: 'producer', on_song: false }, { person_name: 'X3LIUS', role: 'writer', on_song: true },
    ]);
    expect((await db.sql`select status::text, upc, release_date::text from releases where id = ${releaseId}`)[0]).toEqual({ status: 'released', upc: UPC, release_date: today() });
    expect(await db.sql`select status from current_deliveries where release_id = ${releaseId}`).toEqual([{ status: 'live' }]);
    expect(await db.sql`select status::text, count(*)::int as n from agent_runs group by status`).toEqual([{ status: 'success', n: expect.any(Number) }]);
    // Known limit (F37): a released release can't be exported for a restore yet (AOS-08).
    await expect(exportVault(db.sql, store, join(tmp, 'export'))).rejects.toThrow(/release .* is released/);
  });
});
