import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { asCommitted, insertTake } from '../../../tests/helpers/records-fixture.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { fileDetail, ingestStatus, lineageDetail, listVault, songDetail, songList } from './loaders.ts';
import { decide, editLyrics, songCreate, songLink, songRevise, songUnlink, uploadFiles } from './ops.ts';

// AOS-01 §9: what the UI reads (as xyp_web, read only) and writes (through dispatch and
// xyp_decide_artifact), against a throwaway migrated database. The pages only render these.

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'aos01-web-vault-'));
const enc = (s: string) => new TextEncoder().encode(s);
/** 0.1 s of 16-bit mono silence at 8 kHz: a complete, playable WAV. */
const wav = (): Uint8Array => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(1600)]));
};

beforeAll(async () => {
  db = await createTestDb('aos01_web', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('ops: the UI\'s writes, each an agent run or the owner\'s decision', () => {
  it('uploads: bytes go to a server-side temp file (never a browser path), removed after; a lyric sheet becomes a lineage', async () => {
    const tmpBefore = readdirSync(tmpdir()).filter((f) => f.startsWith('xyp-upload-')).length;
    const songId = (await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })).songId;
    const [sheet, notes] = await uploadFiles(deps, [
      { name: '../../etc/night-city.txt', bytes: enc('[Verse 1]\nNight city lights\n[Chorus]\nWe run tonight\n') },
      { name: 'notes.md', bytes: enc('# Notes\n\nLA-2A on the verses.\n') },
    ], { as: 'lyric_sheet', language: 'en', tags: ['New Era'], songId });
    expect(sheet).toMatchObject({ file: { status: 'added', mediaClass: 'lyric_sheet' }, lyrics: { version: 1 } });
    expect(notes!.file.mediaClass).toBe('lyric_sheet');
    expect((await db.sql`select title from sources where id = ${sheet!.file.sourceId}`)[0]).toEqual({ title: 'night-city.txt' });
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith('xyp-upload-')).length).toBe(tmpBefore);
    await expect(uploadFiles(deps, [{ name: '', bytes: enc('x') }], {})).rejects.toThrow(/file name/);
  });
});

describe('loaders: read as xyp_web, read only', () => {
  let songId: string;
  let lineageId: string;
  let v1: string;
  let fileId: string;
  beforeAll(async () => {
    songId = (await songCreate(deps, { title: '[FIXTURE] Outro', artist: 'X3LIUS', language: 'bg', genre: 'darkwave' })).songId;
    await songRevise(deps, { songId, status: 'writing' });
    const [sheet, demo] = [
      ...(await uploadFiles(deps, [{ name: 'outro.txt', bytes: enc('[Verse 1]\nПоследен влак\n') }], { as: 'lyric_sheet', language: 'bg', songId, tags: ['outro'] })),
      ...(await uploadFiles(deps, [{ name: 'outro-demo.wav', bytes: wav() }], { songId })),
    ];
    fileId = sheet!.file.sourceId;
    lineageId = (sheet!.lyrics as { lineageId: string }).lineageId;
    v1 = (sheet!.lyrics as { artifactId: string }).artifactId;
    expect(demo!.file.mediaClass).toBe('audio');
    await editLyrics(deps, { parentId: v1, text: '[Verse 1]\nПоследен влак, последна гара\n' });
    await decide(db.sql, v1, 'approve', '[FIXTURE] v1 stays', 'owner');
  });

  it('listVault: files and lyric lineages, filtered by kind, song, tag and language', async () => {
    const all = await listVault(db.sql, {});
    expect(all.files.length).toBeGreaterThanOrEqual(4);
    expect(all.lineages.find((l) => l.lineageId === lineageId)).toMatchObject({ latestVersion: 2, approvedVersion: 1, language: 'bg', songs: [{ id: songId, title: '[FIXTURE] Outro' }] });
    const audio = await listVault(db.sql, { kind: 'audio' });
    expect(audio.lineages).toEqual([]);
    expect(audio.files.map((f) => f.title)).toEqual(['outro-demo.wav']);
    expect((await listVault(db.sql, { kind: 'lyrics' })).files).toEqual([]);
    expect((await listVault(db.sql, { tag: 'outro' })).files.map((f) => f.id)).toEqual([fileId]);
    const bySong = await listVault(db.sql, { songId });
    expect([bySong.files.length, bySong.lineages.length]).toEqual([2, 1]);
    expect((await listVault(db.sql, { language: 'bg' })).lineages.map((l) => l.lineageId)).toEqual([lineageId]);
  });

  it('fileDetail: metadata, provenance (the run that added it), text, tags, songs', async () => {
    const f = await fileDetail(db.sql, fileId);
    expect(f).toMatchObject({
      title: 'outro.txt', mediaClass: 'lyric_sheet', language: 'bg', filename: 'outro.txt', tags: ['outro'],
      run: { agentName: 'vault-curator', status: 'success' }, songs: [{ id: songId, title: '[FIXTURE] Outro' }],
    });
    expect(f!.text).toContain('Последен влак');
    expect(await fileDetail(db.sql, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('lineageDetail: versions with their approval state and sheet text; the approved version marked', async () => {
    const l = await lineageDetail(db.sql, lineageId);
    expect(l).toMatchObject({ lineageId, schemaId: 'x3lius.lyrics/v2', approvedVersion: 1, songs: [{ id: songId }] });
    expect(l!.versions.map((v) => [v.version, v.status, v.agentName])).toEqual([[1, 'approved', 'x3lius-lyric-editor'], [2, 'draft', 'x3lius-lyric-editor']]);
    expect(l!.versions[1]!.sheet).toBe('[Verse 1]\nПоследен влак, последна гара');
    expect(await lineageDetail(db.sql, v1.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBeNull();
  });

  it('songList and songDetail: revisions and every link, grouped by kind, with the approved lyrics marked', async () => {
    expect((await songList(db.sql)).find((s) => s.id === songId)).toMatchObject({ title: '[FIXTURE] Outro', status: 'writing', revision: 2, links: 3 });
    const { takeId } = await insertTake(db.sql);
    const take = await songLink(deps, { songId, takeId, role: 'take' });
    const d = await songDetail(db.sql, songId);
    expect(d!.revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(d!.lyrics).toEqual([expect.objectContaining({ lineageId, approvedVersion: 1, latestVersion: 2, role: 'lyrics' })]);
    expect(d!.files.map((f) => [f.title, f.role])).toEqual([['outro.txt', 'lyric-sheet'], ['outro-demo.wav', 'audio']]);
    expect(d!.takes).toEqual([expect.objectContaining({ linkId: take.linkId, id: takeId })]);
    await songUnlink(deps, { linkId: take.linkId, reason: '[FIXTURE] wrong take' });
    expect((await songDetail(db.sql, songId))!.takes).toEqual([]);
    expect(await songDetail(db.sql, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('ingestStatus: recent Vault runs, knowledge ingestion runs, and the unembedded Vault backlog', async () => {
    const s = await ingestStatus(db.sql);
    expect(s.runs.length).toBeGreaterThan(0);
    expect(new Set(s.runs.map((r) => r.agentName))).toEqual(new Set(['vault-curator', 'records-songs', 'x3lius-lyric-editor']));
    expect(s.backlog).toMatchObject({ artifact: expect.any(Number), source: expect.any(Number), research_finding: 0 });
    expect(s.backlog.source).toBeGreaterThanOrEqual(4);
  });

  it('the loaders cannot write: they run as xyp_web in a read-only transaction', async () => {
    const { asWeb } = await import('./loaders.ts');
    await expect(asWeb(db.sql, (tx) => tx`insert into tags (slug, label) values ('x', 'x')`)).rejects.toMatchObject({ code: '25006' });
    await expect(asCommitted(db.sql, 'xyp_web', (tx) => tx`insert into tags (slug, label) values ('x', 'x')`)).rejects.toMatchObject({ code: '42501' });
  });
});
