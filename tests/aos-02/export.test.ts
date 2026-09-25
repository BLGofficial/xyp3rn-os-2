import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { addToVault } from '../../knowledge/ingestion/vault.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { exportVault } from '../../knowledge/vault-io/export.ts';
import { importVault } from '../../knowledge/vault-io/import.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { inDays } from '../helpers/records-fixture.ts';

// AOS-02 proof (part 3): the Command Center's records travel with the Vault export (design §7). A
// song's credits and people, its draft release's Vault-audio track, links, artwork, deliveries and
// tasks: exported from A, imported into a fresh B, re-exported byte-identical.

let a: TestDb;
let b: TestDb;
let storeA: VaultStore;
let storeB: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos02-export-'));
const dir = (n: string) => join(tmp, n);
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
let deps: DispatchDeps;
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const wav = (): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return Buffer.concat([h, Buffer.alloc(1600, 7)]);
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let songId: string;
let releaseId: string;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb('aos02_export_a', { migrated: true }), createTestDb('aos02_export_b', { migrated: true })]);
  mkdirSync(dir('files'));
  storeA = createLocalVaultStore(dir('store-a'));
  storeB = createLocalVaultStore(dir('store-b'));
  deps = { sql: a.sql, registry, tools: createRuntimeTools({ sql: a.sql, vault: storeA }), handlers: HANDLERS };

  songId = (await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } })).songId;
  writeFileSync(join(dir('files'), 'night-city-master.wav'), wav());
  writeFileSync(join(dir('files'), 'cover.png'), PNG);
  const bounce = (await addToVault(deps, { path: join(dir('files'), 'night-city-master.wav'), songId })).sourceId;
  const cover = (await addToVault(deps, { path: join(dir('files'), 'cover.png') })).sourceId;
  const reg = await runWorkflow(deps, loadWorkflow(join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml'), registry), {
    takeId: null, sourceId: bounce, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1, title: null, mixReportArtifactId: null,
  });
  expect(reg.status).toBe('success');
  ({ releaseId } = reg.output as { releaseId: string });
  const trackId = (reg.output as { trackId: string }).trackId;
  await ok('records-songs', { link: { songId, trackId, role: 'release' } });
  const x = await ok('records-catalog', { person: { name: 'X3LIUS' } });
  await ok('records-catalog', { alias: { personId: x.personId, alias: 'Xelius' } });
  await ok('records-catalog', { person: { name: 'Nova (featured)' } });
  const first = await ok('records-catalog', { credit: { personId: x.personId, role: 'writer', songId } });
  await ok('records-catalog', { uncredit: { creditId: first.creditId, reason: '[FIXTURE] re-credit with a note' } });
  await ok('records-catalog', { credit: { personId: x.personId, role: 'writer', songId, note: 'words and music' } });
  await ok('records-catalog', { credit: { person: 'Nova (featured)', role: 'featured_artist', trackId } });
  await ok('records-catalog', { link: { trackId, platform: 'soundcloud', url: 'https://soundcloud.com/x3lius/night-city-preview' } });
  await ok('records-catalog', { artwork: { releaseId, sourceId: cover } });
  await ok('records-catalog', { delivery: { releaseId, distributor: 'DistroKid', status: 'submitted' } });
  const t = await ok('records-tasks', { create: { title: 'Book the mastering session', releaseId, dueDate: inDays(7) } });
  await ok('records-tasks', { move: { taskId: t.taskId, status: 'done' } });
  await ok('records-tasks', { create: { title: 'Renew the distributor plan' } });
}, 120_000);
afterAll(async () => {
  await Promise.all([a?.drop(), b?.drop()]);
  rmSync(tmp, { recursive: true, force: true });
});

describe('the Command Center records travel with xyp-vault-export/v1', () => {
  it('exports people, credits, links, artwork, deliveries, tasks and the Vault-audio track; imports into B; re-exports byte-identical', async () => {
    await exportVault(a.sql, storeA, dir('export-a'));
    const manifest = JSON.parse(readFileSync(join(dir('export-a'), 'manifest.json'), 'utf8'));
    expect(manifest.counts).toMatchObject({
      people: 2, person_aliases: 1, credits: 3, credit_retractions: 1, platform_links: 1, release_artwork: 1, release_deliveries: 1,
      tasks: 2, task_events: 1, tracks: 1, releases: 1,
    });
    expect(manifest.blobs).toHaveLength(2);
    const r = await importVault(b.sql, storeB, dir('export-a'));
    expect(r).toMatchObject({ inserted: r.records, skipped: 0 });
    expect(await b.sql`select role, person_name, note from current_credits order by role`).toEqual([
      { role: 'featured_artist', person_name: 'Nova (featured)', note: null }, { role: 'writer', person_name: 'X3LIUS', note: 'words and music' },
    ]);
    expect(await b.sql`select title, status from current_tasks order by title`).toEqual([
      { title: 'Book the mastering session', status: 'done' }, { title: 'Renew the distributor plan', status: 'open' },
    ]);
    expect((await b.sql`select take_id, source_id is not null as vault from tracks`)[0]).toEqual({ take_id: null, vault: true });
    await exportVault(b.sql, storeB, dir('export-b'));
    expect(readFileSync(join(dir('export-b'), 'records.ndjson'), 'utf8')).toBe(readFileSync(join(dir('export-a'), 'records.ndjson'), 'utf8'));
    expect(await importVault(b.sql, storeB, dir('export-a'))).toMatchObject({ inserted: 0 });
  });
});
