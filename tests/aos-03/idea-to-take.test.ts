import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { importVault } from '../../knowledge/vault-io/import.ts';
import { addAndImport } from '../../records/vault/import.ts';
import { defaultTagSet } from '../../records/x3lius/studio/tags.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// AOS-03 gate (PLAN.md §5 Phase 3): "every generation attempt can be traced to the exact lyric, style,
// tags, workflow version, and resulting audio". One song, from idea to a rated take on a draft
// release, through the real agents and workflows only: no fixture row is inserted directly. The
// handoff is refused while any version it names is a draft (S4). At the end the attempt names each
// exact version, the workflow's spec sha256 and the audio's sha256, and all of it survives an export
// into a fresh database.

let a: TestDb;
let b: TestDb;
let deps: DispatchDeps;
let storeA: VaultStore;
let storeB: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos03-gate-'));
const dir = (n: string) => join(tmp, n);
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const BUILD = join(REPO_ROOT, 'records', 'workflows', 'build-suno-package.workflow.yaml');
const REGISTER = join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml');
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const file = (name: string, content: Buffer | string) => {
  const p = join(dir('files'), name);
  writeFileSync(p, content);
  return p;
};
const approve = (artifactId: string) => decideArtifact(a.sql, artifactId, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] ready for Suno' });
/** 0.1 s of 16-bit mono silence at 8 kHz: a complete, playable WAV, standing in for Suno's download. */
const WAV = (() => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return Buffer.concat([h, Buffer.alloc(1600, 3)]);
})();

type Journey = {
  songId: string; lyricsV2: string; recipeV2: string; tagsV2: string; packageId: string; workflowRunId: string;
  submissionId: string; audioId: string; takeId: string; trackId: string;
};
const j = {} as Journey;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb('aos03_gate_a', { migrated: true }), createTestDb('aos03_gate_b', { migrated: true })]);
  mkdirSync(dir('files'));
  storeA = createLocalVaultStore(dir('store-a'));
  storeB = createLocalVaultStore(dir('store-b'));
  deps = { sql: a.sql, registry, tools: createRuntimeTools({ sql: a.sql, env: {}, vault: storeA }), handlers: HANDLERS };
});
afterAll(async () => {
  await Promise.all([a?.drop(), b?.drop()]);
  rmSync(tmp, { recursive: true, force: true });
});

describe('AOS-03 gate: one song from idea to a rated take, every attempt traced', () => {
  it('1. a song at idea, with the owner’s lyric sheet, edited to a second version', async () => {
    j.songId = (await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } })).songId;
    const sheet = await addAndImport(deps, {
      path: file('night-city.txt', '[Verse 1]\n[FIXTURE] neon on the wet street\n[Chorus]\n[FIXTURE] we run tonight\n'),
      as: 'lyric_sheet', language: 'en', songId: j.songId,
    });
    const v1 = (sheet.lyrics as { artifactId: string }).artifactId;
    const v2 = await ok('x3lius-lyric-editor', { edit: { parentId: v1, text: '[Verse 1]\n[FIXTURE] neon on the wet street\n[FIXTURE] nobody sleeps here\n[Chorus]\n[FIXTURE] we run tonight\n' } });
    expect(v2.version).toBe(2);
    j.lyricsV2 = v2.artifactId;
  });

  it('2. a style recipe, then its next version with the owner’s tested notes', async () => {
    const r1 = await ok('x3lius-studio-editor', { recipe: { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 140 bpm, male baritone', excludeStyles: ['[FIXTURE] country'] } });
    const r2 = await ok('x3lius-studio-editor', { recipe: {
      name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 138 bpm, male baritone', excludeStyles: ['[FIXTURE] country'],
      mood: ['[FIXTURE] cold'], notes: ['[FIXTURE] 140 bpm rushed the hook'], parentId: r1.artifactId,
    } });
    expect(r2).toMatchObject({ lineageId: r1.lineageId, version: 2 });
    j.recipeV2 = r2.artifactId;
  });

  it('3. the default tag set (the code labels), then a version with the owner’s cues', async () => {
    const d = await ok('x3lius-studio-editor', { defaultTagSet: {} });
    const sections = defaultTagSet().sections.map((s) => (s.kind === 'chorus' ? { ...s, cues: ['Anthemic'] } : s.kind === 'verse' ? { ...s, cues: ['Whispered'] } : s));
    const t2 = await ok('x3lius-studio-editor', { tagSet: { name: '[FIXTURE] X3LIUS live', sections, parentId: d.artifactId } });
    expect(t2.version).toBe(2);
    j.tagsV2 = t2.artifactId;
  });

  it('4. the package, built in build-suno-package and linked to the song', async () => {
    const r = await runWorkflow(deps, loadWorkflow(BUILD, registry), {
      songId: j.songId, lyricsArtifactId: j.lyricsV2, styleRecipeArtifactId: j.recipeV2, tagSetArtifactId: j.tagsV2, title: '[FIXTURE] Night City', sunoModel: 'v5',
    });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
    j.packageId = (r.output as { packageId: string }).packageId;
    j.workflowRunId = r.workflowRunId;
    const [p] = await a.sql<{ body: { lyrics: string; style: string } }[]>`select body from creative_artifacts where id = ${j.packageId}`;
    expect(p!.body.lyrics).toBe('[Verse 1]\n[Whispered]\n[FIXTURE] neon on the wet street\n[FIXTURE] nobody sleeps here\n\n[Chorus]\n[Anthemic]\n[FIXTURE] we run tonight');
    expect(p!.body.style).toBe('[FIXTURE] dark melodic trap, 138 bpm, male baritone');
  });

  it('5. the handoff is refused while any version is a draft; each approval clears its reason; then it is recorded', async () => {
    const submit = () => dispatch(deps, 'suno-submitter', { submit: { packageId: j.packageId, adapter: 'manual' } });
    let r = await submit();
    expect(r.error).toMatch(/not ready to hand off: lyrics .* v2 is draft: .*; style-recipe .* v2 is draft: .*; meta-tag-set .* v2 is draft/);
    await approve(j.lyricsV2);
    await approve(j.recipeV2);
    r = await submit();
    expect(r.error).toMatch(/not ready to hand off: meta-tag-set .* v2 is draft/);
    expect(r.error).not.toMatch(/lyrics|style-recipe/);
    await approve(j.tagsV2);
    j.submissionId = (await ok('suno-submitter', { submit: { packageId: j.packageId, adapter: 'manual' } })).submissionId;
  });

  it('6. the result is uploaded into the Vault and recorded as the attempt’s take; 7. the owner rates it', async () => {
    j.audioId = (await addToVault(deps, { path: file('night-city-take-1.wav', WAV), songId: j.songId, linkRole: 'suno-take' })).sourceId;
    const c = await ok('suno-submitter', { capture: { submissionId: j.submissionId, takes: [{ sourceId: j.audioId, title: '[FIXTURE] Night City (take 1)' }] } });
    j.takeId = c.takes[0].id;
    await ok('suno-submitter', { rate: { takeId: j.takeId, rating: 4, keep: '[FIXTURE] the whispered verse', change: '[FIXTURE] a shorter intro' } });
  });

  it('8. the take is registered on a draft release, titled from the package, and the track linked to the song', async () => {
    const r = await runWorkflow(deps, loadWorkflow(REGISTER, registry), { takeId: j.takeId, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1 });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
    j.trackId = (r.output as { trackId: string }).trackId;
    await ok('records-songs', { link: { songId: j.songId, trackId: j.trackId, role: 'release' } });
    expect((await a.sql`select title, take_id from tracks where id = ${j.trackId}`)[0]).toEqual({ title: '[FIXTURE] Night City', take_id: j.takeId });
  });

  it('the gate: the attempt names the exact lyric, style and tag versions, the workflow version, and the audio', async () => {
    const wf = loadWorkflow(BUILD, registry);
    const [attempt] = await a.sql`select * from generation_attempts where submission_id = ${j.submissionId}`;
    expect(attempt).toMatchObject({
      package_id: j.packageId, song_id: j.songId, title: '[FIXTURE] Night City', suno_model: 'v5', adapter: 'manual',
      lyrics_id: j.lyricsV2, lyrics_version: 2, style_recipe_id: j.recipeV2, style_recipe_version: 2, meta_tag_set_id: j.tagsV2, meta_tag_set_version: 2,
      workflow_run_id: j.workflowRunId, workflow_name: 'build-suno-package', workflow_sha256: wf.sha256, take_count: 1, is_traced: true,
    });
    const [take] = await a.sql`select * from generation_takes where take_id = ${j.takeId}`;
    expect(take).toMatchObject({ submission_id: j.submissionId, source_id: j.audioId, audio_sha256: createHash('sha256').update(WAV).digest('hex'), audio_url: null, rating: 4 });
    // Every attempt in this database is traced: there is no other path to a submission.
    expect(await a.sql`select submission_id from generation_attempts where not is_traced`).toEqual([]);
    // The versions it names are exactly the approved ones, and the audio's bytes are the Vault's.
    const statuses = await a.sql<{ status: string }[]>`select status from artifact_approvals where id in (${j.lyricsV2}, ${j.recipeV2}, ${j.tagsV2})`;
    expect(statuses.map((s) => s.status)).toEqual(['approved', 'approved', 'approved']);
    expect(Buffer.compare(await storeA.get(take!.audio_sha256 as string), WAV)).toBe(0);
  });

  it('the trace survives xyp-vault-export/v1: B names the same versions, workflow and audio; B re-exports byte-identical', async () => {
    await exportVault(a.sql, storeA, dir('export-a'));
    const manifest = JSON.parse(readFileSync(join(dir('export-a'), 'manifest.json'), 'utf8'));
    expect(manifest.counts).toMatchObject({ suno_submissions: 1, suno_takes: 1, take_ratings: 1, tracks: 1 });
    const r = await importVault(b.sql, storeB, dir('export-a'));
    expect(r).toMatchObject({ inserted: r.records, skipped: 0 });
    const trace = (sql: TestDb['sql']) => sql`
      select g.*, t.audio_sha256, t.rating from generation_attempts g join generation_takes t on t.submission_id = g.submission_id
      where g.submission_id = ${j.submissionId}`;
    expect(await trace(b.sql)).toEqual(await trace(a.sql));
    await exportVault(b.sql, storeB, dir('export-b'));
    expect(readFileSync(join(dir('export-b'), 'records.ndjson'), 'utf8')).toBe(readFileSync(join(dir('export-a'), 'records.ndjson'), 'utf8'));
  });
});
