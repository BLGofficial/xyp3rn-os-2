import { createHash } from 'node:crypto';
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
import { decide, songCreate, uploadFiles } from './ops.ts';
import { songDetail } from './loaders.ts';
import { packageDetail, songStudio, studioIndex, studioLineage } from './studio-loaders.ts';
import { buildPackage, defaultTagSet, handOff, importTake, list, rateTake, tagSections, writeRecipe, writeTagSet } from './studio-ops.ts';

// AOS-03 §6: what the Studio screens read (as xyp_web, read only) and write (dispatch and
// build-suno-package), against a throwaway migrated database. The pages only render these.

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'aos03-web-vault-'));
const WAV = (() => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(1600, 9)]));
})();
const approve = (id: string) => decide(db.sql, id, 'approve', '[FIXTURE] ready', 'owner');

let songId: string;
let lyricsId: string;
let recipe: { artifactId: string; lineageId: string };
let tags: { artifactId: string; lineageId: string };
let packageId: string;

beforeAll(async () => {
  db = await createTestDb('aos03_web', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, env: {}, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
  songId = (await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })).songId;
  const [sheet] = await uploadFiles(deps, [{ name: 'night-city.txt', bytes: new TextEncoder().encode('[Verse 1]\n[FIXTURE] neon on the wet street\n[Chorus]\n[FIXTURE] we run tonight\n') }], { as: 'lyric_sheet', language: 'en', songId });
  lyricsId = (sheet!.lyrics as { artifactId: string }).artifactId;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('form parsing', () => {
  it('list: one entry per line or comma, trimmed, blanks dropped', () => {
    expect(list(' country, acoustic\n\nsynthwave ,')).toEqual(['country', 'acoustic', 'synthwave']);
    expect(list('one per line\nsecond, still', 'lines')).toEqual(['one per line', 'second, still']);
  });

  it('tagSections: the kinds ticked, with their label, numbering and cues', () => {
    const form: Record<string, string> = { 'include:verse': 'on', 'label:verse': 'Verse', 'numbered:verse': 'on', 'cues:verse': 'Whispered, Sparse drums', 'include:chorus': 'on', 'label:chorus': 'Chorus', 'cues:chorus': '', 'label:bridge': 'Bridge' };
    expect(tagSections((k) => form[k] ?? null)).toEqual([
      { kind: 'verse', label: 'Verse', numbered: true, cues: ['Whispered', 'Sparse drums'] },
      { kind: 'chorus', label: 'Chorus', numbered: false, cues: [] },
    ]);
  });
});

describe('/studio: recipes, tag sets, attempts', () => {
  it('lists each recipe and tag set lineage with its name, latest and approved version', async () => {
    recipe = await writeRecipe(deps, { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 140 bpm', excludeStyles: ['[FIXTURE] country'] });
    tags = await defaultTagSet(deps);
    const s = await studioIndex(db.sql);
    expect(s.recipes).toEqual([expect.objectContaining({ lineageId: recipe.lineageId, name: '[FIXTURE] Night drive', latestVersion: 1, approvedVersion: null })]);
    expect(s.tagSets).toEqual([expect.objectContaining({ lineageId: tags.lineageId, name: 'Default (code labels)', latestVersion: 1, approvedVersion: null })]);
    expect(Date.parse(s.asOf)).not.toBeNaN();
  });
});

describe('/studio/recipes/[id] and /studio/tags/[id]', () => {
  it('a lineage shows every version with its status; an edit is the next version; approval moves the pointer', async () => {
    recipe = await writeRecipe(deps, { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 138 bpm', excludeStyles: [], notes: ['[FIXTURE] 140 rushed'], parentId: recipe.artifactId });
    await approve(recipe.artifactId);
    const r = await studioLineage(db.sql, recipe.lineageId);
    expect(r).toMatchObject({ kind: 'recipe', lineageId: recipe.lineageId, approvedVersion: 2 });
    expect(r!.versions.map((v) => [v.version, v.status])).toEqual([[1, 'draft'], [2, 'approved']]);
    expect(r!.versions[1]!.body).toMatchObject({ style: '[FIXTURE] dark melodic trap, 138 bpm', notes: ['[FIXTURE] 140 rushed'] });
    tags = await writeTagSet(deps, { name: '[FIXTURE] live', sections: [{ kind: 'verse', label: 'Verse', numbered: true, cues: ['Whispered'] }, { kind: 'chorus', label: 'Chorus', numbered: false, cues: ['Anthemic'] }], parentId: tags.artifactId });
    expect(await studioLineage(db.sql, tags.lineageId)).toMatchObject({ kind: 'tags', versions: [{ version: 1 }, { version: 2, status: 'draft' }] });
    // A lyrics lineage is not a Studio lineage; a malformed id is nothing.
    expect(await studioLineage(db.sql, lyricsId)).toBeNull();
    expect(await studioLineage(db.sql, 'not-a-uuid')).toBeNull();
  });
});

describe('the song’s Studio section and the package', () => {
  it('offers the song’s lyric versions and every recipe and tag set version, each with its status; builds a package linked to the song', async () => {
    const s = await songStudio(db.sql, songId);
    expect(s.lyrics).toEqual([expect.objectContaining({ id: lyricsId, version: 1, status: 'draft' })]);
    expect(s.recipes.map((r) => [r.version, r.status])).toEqual([[2, 'approved'], [1, 'draft']]);
    expect(s.tagSets.map((t) => t.version)).toEqual([2, 1]);
    packageId = (await buildPackage(deps, { songId, lyricsArtifactId: lyricsId, styleRecipeArtifactId: recipe.artifactId, tagSetArtifactId: tags.artifactId, title: '[FIXTURE] Night City', sunoModel: 'v5' })).packageId;
    const after = await songStudio(db.sql, songId);
    expect(after.packages).toEqual([expect.objectContaining({ packageId, title: '[FIXTURE] Night City', ready: false, blockers: 2, attempts: 0 })]);
    // The package is the Studio's, not a lyric: the song's lyrics list stays lyrics.
    expect((await songDetail(db.sql, songId))!.lyrics.map((l) => l.lineageId)).toEqual([lyricsId]);
  });

  it('a package page: the export, what blocks the handoff, its attempts; hand off, import the take, rate it', async () => {
    let p = await packageDetail(db.sql, packageId);
    expect(p).toMatchObject({ song: { id: songId, title: '[FIXTURE] Night City' }, attempts: [] });
    expect(p!.export.ready).toBe(false);
    expect(p!.export.sources.map((x) => [x.role, x.status, x.lineageId !== undefined])).toEqual([['lyrics', 'draft', true], ['style-recipe', 'approved', true], ['meta-tag-set', 'draft', true]]);
    await expect(handOff(deps, packageId)).rejects.toThrow(/not ready to hand off/);
    await approve(lyricsId);
    await approve(tags.artifactId);
    const { submissionId } = await handOff(deps, packageId);
    const { takeId } = await importTake(deps, { submissionId, songId, upload: { name: 'night-city-take-1.wav', bytes: WAV }, title: '[FIXTURE] take 1' });
    await rateTake(deps, { takeId, rating: 5, keep: '[FIXTURE] the whispered verse' });
    p = await packageDetail(db.sql, packageId);
    expect(p!.export.ready).toBe(true);
    expect(p!.attempts).toEqual([expect.objectContaining({
      submissionId, adapter: 'manual',
      takes: [expect.objectContaining({ takeId, title: '[FIXTURE] take 1', audioSha256: createHash('sha256').update(WAV).digest('hex'), rating: 5, keep: '[FIXTURE] the whispered verse' })],
    })]);
    expect((await studioIndex(db.sql)).attempts).toEqual([expect.objectContaining({ submissionId, songTitle: '[FIXTURE] Night City', title: '[FIXTURE] Night City', takeCount: 1, isTraced: true })]);
    expect(await packageDetail(db.sql, lyricsId)).toBeNull();
  });
});
