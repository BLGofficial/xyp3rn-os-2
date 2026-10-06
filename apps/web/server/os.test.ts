import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { registerTrack } from './catalog-ops.ts';
import { songCreate, uploadFiles } from './ops.ts';
import { audioLibrary, knowledgeSummary, obsidianPanel, researchSummary } from './os-loaders.ts';
import { syncObsidian } from './os-ops.ts';

// /os (F54): the dashboard's reads. Every figure comes from a row or a file read now; nothing is estimated.

let db: TestDb;
let deps: DispatchDeps;
let songId: string;
let audioId: string;
const vaultDir = mkdtempSync(join(tmpdir(), 'os-dash-store-'));
const notes = mkdtempSync(join(tmpdir(), 'os-dash-obsidian-'));
const wav = (): Uint8Array => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(1600, 7)]));
};

beforeAll(async () => {
  db = await createTestDb('os_dashboard', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
  ({ songId } = await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' }));
  const [bounce] = await uploadFiles(deps, [{ name: 'night-city-master.wav', bytes: wav() }], { songId });
  audioId = bounce!.file.sourceId;
  await registerTrack(deps, { sourceId: audioId, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1, songId });
  mkdirSync(join(notes, 'Songs'));
  writeFileSync(join(notes, 'Home.md'), '[[Hook]] [[Nowhere]]');
  writeFileSync(join(notes, 'Songs', 'Hook.md'), '[[Home]] #hook');
}, 120_000);
afterAll(async () => {
  await db?.drop();
  for (const d of [vaultDir, notes]) rmSync(d, { recursive: true, force: true });
});

describe('/os loaders', () => {
  it('lists Vault audio with its song and the track that records it', async () => {
    const lib = await audioLibrary(db.sql);
    expect(lib.total).toBe(1);
    expect(lib.items[0]).toMatchObject({
      id: audioId, title: 'night-city-master.wav', mimeType: 'audio/wav', byteSize: 1644,
      songs: [{ id: songId, title: '[FIXTURE] Night City' }],
      tracks: [{ title: '[FIXTURE] Night City', releaseTitle: '[FIXTURE] New Era' }],
      takes: [],
    });
  });

  it('counts research from the tables, zero only when the table is empty', async () => {
    expect(await researchSummary(db.sql)).toEqual({ openBriefs: 0, acceptedFindings: 0, undecidedFindings: 0, runs: [] });
  });

  it('counts the knowledge layer by kind', async () => {
    const k = await knowledgeSummary(db.sql);
    expect(k.vaultFiles).toEqual([{ mediaClass: 'audio', count: 1 }]);
    expect(k.obsidianImports).toBe(0);
    expect(typeof k.canonicalPrompts).toBe('number');
  });

  it('says plainly when no Obsidian vault is configured', async () => {
    expect(await obsidianPanel(db.sql, {})).toEqual({ state: 'not-configured', envVar: 'XYP_OBSIDIAN_VAULT' });
  });

  it('reports an unreadable vault as an error, not as an empty one', async () => {
    const p = await obsidianPanel(db.sql, { XYP_OBSIDIAN_VAULT: join(notes, 'gone') });
    expect(p.state).toBe('error');
  });

  it('previews a configured vault with its link graph, then the sync applies by that hash', async () => {
    const p = await obsidianPanel(db.sql, { XYP_OBSIDIAN_VAULT: notes });
    if (p.state !== 'ready') throw new Error(JSON.stringify(p));
    expect(p.graph).toMatchObject({ notes: 2, links: 2, unresolved: [{ from: 'Home.md', target: 'Nowhere' }] });
    expect(p.counts).toEqual({ import: 2, export: 1, conflicts: 0, unchanged: 0, gone: 0, skipped: 0 });
    const r = await syncObsidian(deps, { XYP_OBSIDIAN_VAULT: notes }, p.planHash);
    expect(r.failed).toEqual([]);
    const after = await obsidianPanel(db.sql, { XYP_OBSIDIAN_VAULT: notes });
    if (after.state !== 'ready') throw new Error(JSON.stringify(after));
    expect(after.counts).toMatchObject({ import: 0, export: 0, unchanged: 3 });
    expect(after.lastSync).not.toBeNull();
    expect((await knowledgeSummary(db.sql)).obsidianImports).toBe(2);
  });

  it('refuses to sync without a configured vault', async () => {
    await expect(syncObsidian(deps, {}, 'a'.repeat(64))).rejects.toThrow(/XYP_OBSIDIAN_VAULT/);
  });
});
