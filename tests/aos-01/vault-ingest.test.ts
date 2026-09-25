import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { CLASS_CAPABILITIES } from '../../core/tool-registry/capabilities.ts';
import { decideArtifact } from '../../governance/approvals.ts';
import { addToVault, mediaClassOf } from '../../knowledge/ingestion/vault.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { addAndImport, importLyricSheet } from '../../records/vault/import.ts';
import { renderLyrics } from '../../records/x3lius/suno/formula.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertArtifact, insertRun } from '../helpers/records-fixture.ts';

// AOS-01 proof (part 2): files into the Creative Vault, songs and their links, lyric sheets into
// x3lius.lyrics/v2 lineages, owner edits and approvals, end to end on a throwaway migrated
// database and a temporary byte store. No model: the three agents are deterministic. What is real:
// the dispatch point (authorization, agent_runs), every tool's DB role, the byte store, text
// extraction (the build guide PDF), the lyric parser and the DB guards.

let db: TestDb;
let deps: DispatchDeps;
let store: VaultStore;
const files = mkdtempSync(join(tmpdir(), 'aos01-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos01-vault-'));
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const BUILD_GUIDE = join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf');
const SCREENSHOT = join(REPO_ROOT, 'interface.png');

beforeAll(async () => {
  db = await createTestDb('aos01_vault_ingest', { migrated: true });
  store = createLocalVaultStore(vaultDir);
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, vault: store }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(files, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const file = (name: string, content: string | Uint8Array): string => {
  const p = join(files, name);
  writeFileSync(p, content);
  return p;
};
/** 0.1 s of 16-bit mono silence at 8 kHz: a complete, playable WAV. */
const wav = (): Buffer => {
  const samples = 800;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([h, Buffer.alloc(samples * 2)]);
};
const run = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, unknown>;
};
const songs = (input: unknown) => run('records-songs', input);
/** A second version of an artifact, as xyp_creative: linking it must link its lineage root. */
const childOf = async (parentId: string): Promise<string> => {
  const runId = await insertRun(db.sql, 'x3lius-lyric-editor', 'Creative');
  return asCommitted(db.sql, 'xyp_creative', async (tx) => (await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model)
    select schema_id, 'x3lius-lyric-editor', ${runId}, id, brief, body, '[]', '{}', 'none' from creative_artifacts where id = ${parentId}
    returning id`)[0]!.id);
};
const newSong = async (title = '[FIXTURE] Night City') => (await songs({ create: { title, artist: 'X3LIUS', language: 'en' } })).songId as string;

const NIGHT_CITY = [
  '[Intro]', '', '[Verse 1]', 'Night city lights', 'Neon on the glass', '',
  '[Chorus]', '[Guitar solo]', 'We run tonight', 'Till the morning comes', '', '[Verse 2]', 'Second verse, same street', '[Outro]', '',
].join('\n');

describe('three deterministic agents; vault.write is Execution, vault.read Knowledge + Creative + Execution', () => {
  it('validateAll() is clean and each agent has its class, domain and narrowed tools', () => {
    expect(registry.validateAll()).toEqual([]);
    const shape = (name: string) => {
      const a = registry.get(name)!;
      return { class: a.class, domain: a.domain, model: a.model, tools: [...a.tools].sort() };
    };
    expect(shape('vault-curator')).toEqual({ class: 'Execution', domain: 'KNOWLEDGE', model: 'none', tools: ['log_message', 'register_vault_file'] });
    expect(shape('records-songs')).toEqual({ class: 'Execution', domain: 'RECORDS', model: 'none', tools: ['link_song', 'log_message', 'unlink_song', 'write_song'] });
    expect(shape('x3lius-lyric-editor')).toEqual({
      class: 'Creative', domain: 'RECORDS', model: 'none', tools: ['log_message', 'read_artifact', 'read_vault_file', 'write_artifact'],
    });
  });

  it('each tool declares its capability; nothing else can call it', () => {
    expect(CLASS_CAPABILITIES['vault.write']).toEqual(['Execution']);
    expect(CLASS_CAPABILITIES['vault.read']).toEqual(['Knowledge', 'Creative', 'Execution']);
    for (const t of ['register_vault_file', 'write_song', 'link_song', 'unlink_song']) {
      expect(deps.tools.get(t)?.capability).toBe('vault.write');
      for (const cls of ['Research', 'Knowledge', 'Planning', 'Creative', 'Critic', 'Revision', 'Governance'] as const) {
        expect(deps.tools.authorize(cls, t).allow).toBe(false);
      }
    }
    expect(deps.tools.get('read_vault_file')?.capability).toBe('vault.read');
    expect(deps.tools.authorize('Research', 'read_vault_file').allow).toBe(false);
  });
});

describe('addToVault: bytes in the store, a sources row, the text, tags; one run per step', () => {
  it('media class: --as wins, else the extension; a lyric sheet is always named explicitly', () => {
    expect(['a.mp3', 'b.WAV', 'c.flac', 'd.m4a', 'e.aiff', 'f.ogg'].map((p) => mediaClassOf(p))).toEqual(Array(6).fill('audio'));
    expect(['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif'].map((p) => mediaClassOf(p))).toEqual(Array(5).fill('image'));
    expect(['a.txt', 'b.md', 'c.pdf'].map((p) => mediaClassOf(p))).toEqual(Array(3).fill('document'));
    expect(mediaClassOf('stems.zip')).toBe('other');
    expect(mediaClassOf('night-city.txt', 'lyric_sheet')).toBe('lyric_sheet');
    expect(() => mediaClassOf('a.txt', 'video')).toThrow(/--as must be one of/);
  });

  it('a text file, a Markdown file and the build guide PDF: stored, registered, their text extracted', async () => {
    const txt = file('session-notes.txt', 'Session 2026-09-24: vocal chain Neve 1073 into LA-2A, 3 dB gain reduction on the verses.\n');
    const md = file('release-plan.md', '# New Era: release plan\n\n- Single 1: Night City\n- Visualiser before the drop\n');
    const added = [await addToVault(deps, { path: txt }), await addToVault(deps, { path: md, title: 'Release plan' }), await addToVault(deps, { path: BUILD_GUIDE })];
    expect(added.map((a) => [a.status, a.mediaClass])).toEqual([['added', 'document'], ['added', 'document'], ['added', 'document']]);
    const rows = await db.sql<{ id: string; kind: string; uri: string; title: string; checksum_sha256: string; mime_type: string; storage: string; media_class: string; text: string; extractor: string }[]>`
      select s.id, s.kind::text, s.uri, s.title, s.checksum_sha256, s.mime_type, s.storage, s.media_class, t.text, t.extractor
      from sources s join source_texts t on t.source_id = s.id where s.id = any(${added.map((a) => a.sourceId)}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const [t, m, p] = added.map((a) => byId.get(a.sourceId)!);
    expect(t).toMatchObject({ kind: 'file', title: 'session-notes.txt', mime_type: 'text/plain', storage: 'local-vault', extractor: 'utf8', uri: `vault://${sha(readFileSync(txt))}` });
    expect(t!.text).toContain('Neve 1073 into LA-2A');
    expect(m).toMatchObject({ title: 'Release plan', mime_type: 'text/markdown', extractor: 'utf8' });
    expect(p).toMatchObject({ title: 'XYP3RN_Agentic_OS_Build_Sequence.pdf', mime_type: 'application/pdf', extractor: 'unpdf' });
    expect(p!.text).toContain('PHASE 13 — XYP3RN Records');
    expect(added[2]!.textChars).toBe(p!.text.length);
    for (const a of added) expect(await store.has(a.sha256)).toBe(true);
    const runs = await db.sql`select agent_name, class::text, status::text from agent_runs where id = any(${added.flatMap((a) => a.runIds)}::uuid[])`;
    expect(runs).toEqual(Array(3).fill({ agent_name: 'vault-curator', class: 'Execution', status: 'success' }));
  });

  it('audio and an image are stored as they are, with no text', async () => {
    const audio = await addToVault(deps, { path: file('night-city-demo.wav', wav()) });
    const image = await addToVault(deps, { path: SCREENSHOT, language: null });
    expect([audio.mediaClass, image.mediaClass, audio.textChars, image.textChars]).toEqual(['audio', 'image', null, null]);
    expect(await db.sql`select mime_type, media_class from sources where id in (${audio.sourceId}, ${image.sourceId}) order by media_class`).toEqual([
      { mime_type: 'audio/wav', media_class: 'audio' }, { mime_type: 'image/png', media_class: 'image' },
    ]);
    expect(await db.sql`select 1 from source_texts where source_id in (${audio.sourceId}, ${image.sourceId})`).toEqual([]);
    expect(Buffer.from(await store.get(image.sha256)).equals(readFileSync(SCREENSHOT))).toBe(true);
  });

  it('the same bytes again return the existing file: no second row, no second text', async () => {
    const p = file('mix-notes.txt', 'Mix v3: kick 2 dB down, vocal rides in the second chorus.\n');
    const first = await addToVault(deps, { path: p });
    const again = await addToVault(deps, { path: file('copy-of-mix-notes.txt', readFileSync(p)), title: 'another title' });
    expect(again).toMatchObject({ status: 'existing', sourceId: first.sourceId });
    expect(await db.sql`select title from sources where checksum_sha256 = ${first.sha256}`).toEqual([{ title: 'mix-notes.txt' }]);
    expect((await db.sql`select count(*)::int as n from source_texts where source_id = ${first.sourceId}`)[0]).toEqual({ n: 1 });
  });

  it('bytes `pnpm ingest` already registered: the knowledge source becomes a Vault file (once), keeping its title', async () => {
    const p = file('vocal-dna-notes.md', '# Vocal DNA notes\n\nChest voice through the verses, head voice only on the last chorus.\n');
    const [k] = await db.sql<{ id: string }[]>`
      insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, metadata)
      values ('file', 'docs/vocal-dna-notes.md', 'Vocal DNA notes', ${sha(readFileSync(p))}, 'text/markdown', ${readFileSync(p).length}, '{"origin":"first_party"}')
      returning id`;
    const promoted = await addToVault(deps, { path: p, title: 'ignored: the knowledge title stays' });
    expect(promoted).toMatchObject({ status: 'promoted', sourceId: k!.id, mediaClass: 'document' });
    expect((await db.sql`select title, uri, storage from sources where id = ${k!.id}`)[0]).toEqual({ title: 'Vocal DNA notes', uri: 'docs/vocal-dna-notes.md', storage: 'local-vault' });
    expect(await addToVault(deps, { path: p })).toMatchObject({ status: 'existing', sourceId: k!.id });
  });

  it('tags attach once and are shared across files; a label with no Latin letters still gets a valid slug', async () => {
    const a = await addToVault(deps, { path: file('moodboard-1.txt', 'Chrome, rain, sodium lamps.\n'), tags: ['New Era', 'moodboard'] });
    const b = await addToVault(deps, { path: file('moodboard-2.txt', 'Night bus, empty platform.\n'), tags: ['moodboard', 'Нова ера'] });
    const tagsOf = (id: string) => db.sql<{ slug: string; label: string }[]>`
      select t.slug, t.label from source_tags st join tags t on t.id = st.tag_id where st.source_id = ${id} order by t.slug`;
    expect(await tagsOf(a.sourceId)).toEqual([{ slug: 'moodboard', label: 'moodboard' }, { slug: 'new-era', label: 'New Era' }]);
    const bt = await tagsOf(b.sourceId);
    expect(bt.map((t) => t.label)).toEqual(['moodboard', 'Нова ера']);
    expect(bt[1]!.slug).toMatch(/^t-[0-9a-f]{12}$/);
  });

  it('refuses a missing file, and a file whose bytes no longer match the hash it was registered with', async () => {
    await expect(addToVault(deps, { path: join(files, 'missing.txt') })).rejects.toThrow(/no such file/i);
    const p = file('changing.txt', 'first bytes');
    const r = await dispatch(deps, 'vault-curator', { add: { path: p, sha256: sha('other bytes'), mediaClass: 'document', title: 'changing.txt' } });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/does not match/);
    expect(await db.sql`select 1 from sources where title = 'changing.txt'`).toEqual([]);
  });
});

describe('records-songs: a song identity, revisions, typed links', () => {
  it('creates a song, revises only what is given, links a file and a lineage, unlinks with a reason', async () => {
    const created = await songs({ create: { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en', genre: 'darkwave' } });
    expect(created).toMatchObject({ revision: 1 });
    const songId = created.songId as string;
    expect(await songs({ revise: { songId, status: 'writing' } })).toEqual({ songId, revision: 2 });
    expect((await db.sql`select title, artist, language, genre, status::text from current_songs where id = ${songId}`)[0]).toEqual({
      title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en', genre: 'darkwave', status: 'writing',
    });
    const f = await addToVault(deps, { path: file('night-city-refs.txt', 'Reference: late-80s synth bass, gated snare.\n') });
    const fileLink = await songs({ link: { songId, sourceId: f.sourceId, role: 'reference' } });
    expect(fileLink).toMatchObject({ kind: 'source', targetId: f.sourceId });
    const root = await insertArtifact(db.sql, 'x3lius.song-structure/v1', { fixture: true });
    const child = await childOf(root);
    const lineageLink = await songs({ link: { songId, artifactId: child, role: 'structure' } });
    expect(lineageLink).toMatchObject({ kind: 'artifact_lineage', targetId: root });
    expect(await songs({ unlink: { linkId: fileLink.linkId, reason: '[FIXTURE] wrong reference' } })).toEqual({ linkId: fileLink.linkId, retracted: true });
    expect(await db.sql`select kind, role from current_song_links where song_id = ${songId}`).toEqual([{ kind: 'artifact_lineage', role: 'structure' }]);
  });

  it('refuses: zero or two operations, two link targets, an unknown song, an unlink without a reason', async () => {
    const songId = await newSong();
    const f = await addToVault(deps, { path: file('two-targets.txt', 'x\n') });
    const art = await insertArtifact(db.sql, 'x3lius.song-structure/v1', { fixture: true });
    const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
      [{}, /exactly one of create, revise, link, unlink/],
      [{ create: { title: 'a', artist: 'b' }, revise: { songId } }, /exactly one of/],
      [{ link: { songId, sourceId: f.sourceId, artifactId: art } }, /exactly one target/],
      [{ revise: { songId: '00000000-0000-4000-8000-000000000000', status: 'writing' } }, /no song/],
      [{ unlink: { linkId: '00000000-0000-4000-8000-000000000000' } }, /reason/],
    ];
    for (const [input, reason] of cases) {
      const r = await dispatch(deps, 'records-songs', input);
      expect(r.status, JSON.stringify(input)).toBe('error');
      expect(r.error).toMatch(reason);
    }
  });
});

describe('lyric sheets → x3lius.lyrics/v2 lineages (owner-authored, draft until approved)', () => {
  it('a tagged sheet: the file is linked as the lyric sheet, the new lineage as the lyrics; the artifact cites its file', async () => {
    const songId = await newSong();
    const f = await addToVault(deps, { path: file('night-city-lyrics.txt', NIGHT_CITY), as: 'lyric_sheet', language: 'en', songId });
    expect(f).toMatchObject({ mediaClass: 'lyric_sheet', status: 'added' });
    const imported = await importLyricSheet(deps, { sourceId: f.sourceId, songId });
    expect(imported).toMatchObject({ version: 1, instrumental: ['s1', 's5'], warnings: [] });
    const [a] = await db.sql<{ schema_id: string; agent_name: string; body: Record<string, unknown>; context_refs: unknown; knowledge: unknown; model: string; lineage_id: string }[]>`
      select schema_id, agent_name, body, context_refs, knowledge, model, lineage_id from creative_artifacts where id = ${imported.artifactId}`;
    expect(a).toMatchObject({ schema_id: 'x3lius.lyrics/v2', agent_name: 'x3lius-lyric-editor', model: 'none', knowledge: { authored: 'owner' } });
    expect(a!.context_refs).toEqual([{ kind: 'vault-file', sourceId: f.sourceId, sha256: f.sha256, title: 'night-city-lyrics.txt' }]);
    expect(a!.body).toMatchObject({ sources: [], rulesApplied: [], ungroundedChoices: ['owner-authored'], instrumental: ['s1', 's5'] });
    expect(renderLyrics([{ schemaId: a!.schema_id, body: a!.body }])).toBe(
      '[Verse 1]\nNight city lights\nNeon on the glass\n\n[Chorus]\nWe run tonight\nTill the morning comes\n\n[Verse 2]\nSecond verse, same street',
    );
    expect((await db.sql`select status from artifact_approvals where id = ${imported.artifactId}`)[0]).toEqual({ status: 'draft' });
    expect(await db.sql`select kind, role, target_id from current_song_links where song_id = ${songId} order by created_at`).toEqual([
      { kind: 'source', role: 'lyric-sheet', target_id: f.sourceId },
      { kind: 'artifact_lineage', role: 'lyrics', target_id: a!.lineage_id },
    ]);
    const runs = await db.sql`select agent_name, status::text from agent_runs where id = any(${[...f.runIds, ...imported.runIds]}::uuid[]) order by created_at`;
    expect(runs).toEqual([
      { agent_name: 'vault-curator', status: 'success' }, { agent_name: 'records-songs', status: 'success' },
      { agent_name: 'x3lius-lyric-editor', status: 'success' }, { agent_name: 'records-songs', status: 'success' },
    ]);
  });

  it('an untagged Bulgarian sheet: stanzas become verses in the file\'s language; instrumental directions are reported', async () => {
    const f = await addToVault(deps, { path: file('noshten-grad.txt', 'Нощен град, светлини\nнеон по стъклото\n\nвтори куплет, същата улица\n'), as: 'lyric_sheet', language: 'bg' });
    const imported = await importLyricSheet(deps, { sourceId: f.sourceId });
    const [a] = await db.sql<{ body: { sections: { kind: string; label: string; bars: { language: string }[] }[] } }[]>`select body from creative_artifacts where id = ${imported.artifactId}`;
    expect(a!.body.sections.map((s) => [s.kind, s.label, s.bars[0]!.language])).toEqual([['verse', 'Verse 1', 'bg'], ['verse', 'Verse 2', 'bg']]);
    const g = await addToVault(deps, { path: file('intro-direction.txt', '[Intro]\n[Guitar solo]\n[Verse]\nhello\n'), as: 'lyric_sheet' });
    const w = await importLyricSheet(deps, { sourceId: g.sourceId });
    expect(w.warnings).toEqual(['s1 (Intro) has no sung lines, so it is instrumental; its directions "Guitar solo" stay only in the sheet']);
    expect((await db.sql`select body->'sections'->0->'bars'->0->>'language' as l from creative_artifacts where id = ${w.artifactId}`)[0]).toEqual({ l: 'und' });
  });

  it('addAndImport: a lyric sheet is imported once; adding the same sheet again finds the lineage instead of writing a second one', async () => {
    const p = file('once.txt', '[Verse]\nonly once\n');
    const first = await addAndImport(deps, { path: p, as: 'lyric_sheet', language: 'en' });
    expect(first.lyrics).toMatchObject({ version: 1, alreadyImported: false });
    const again = await addAndImport(deps, { path: p, as: 'lyric_sheet', language: 'en' });
    expect(again.file.status).toBe('existing');
    expect(again.lyrics).toEqual({ artifactId: first.lyrics!.artifactId, lineageId: first.lyrics!.lineageId, version: 1, alreadyImported: true });
    expect(await addAndImport(deps, { path: file('plain-note.txt', 'not lyrics\n') })).toMatchObject({ lyrics: null });
  });

  it('the owner edits a version: a child version, still a draft; the approved pointer moves only on approval', async () => {
    const f = await addToVault(deps, { path: file('edit-me.txt', '[Verse]\nfirst draft line\n'), as: 'lyric_sheet', language: 'en' });
    const v1 = await importLyricSheet(deps, { sourceId: f.sourceId });
    const v2 = await run('x3lius-lyric-editor', { edit: { parentId: v1.artifactId, text: '[Verse]\nsecond draft line\n[Chorus]\nhook line', language: 'en' } });
    expect(v2).toMatchObject({ lineageId: v1.lineageId, version: 2 });
    expect(await decideArtifact(db.sql, v1.artifactId, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] first take is the one' }))
      .toMatchObject({ status: 'approved', approvedVersion: 1 });
    const statuses = () => db.sql`select version, status, approved_version from artifact_approvals where lineage_id = ${v1.lineageId} order by version`;
    expect(await statuses()).toEqual([{ version: 1, status: 'approved', approved_version: 1 }, { version: 2, status: 'draft', approved_version: 1 }]);
    expect(await decideArtifact(db.sql, v2.artifactId as string, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] the edit is better' }))
      .toMatchObject({ status: 'approved', approvedVersion: 2 });
    await expect(decideArtifact(db.sql, v2.artifactId as string, { decision: 'reject', approver: 'owner', reason: '[FIXTURE] changed my mind' }))
      .rejects.toMatchObject({ code: '23505', message: expect.stringMatching(/already has a decision/) });
    const [edited] = await db.sql<{ body: { sections: { label: string }[] }; context_refs: unknown; parent_id: string }[]>`
      select body, context_refs, parent_id from creative_artifacts where id = ${v2.artifactId as string}`;
    expect(edited).toMatchObject({ parent_id: v1.artifactId, context_refs: [{ kind: 'owner-edit' }] });
    expect(edited!.body.sections.map((s) => s.label)).toEqual(['Verse 1', 'Chorus']);
  });

  it('refuses: a mixed-script word in a sung line (F22), a file that is not a lyric sheet, an edit of a non-lyrics artifact', async () => {
    const mixed = await addToVault(deps, { path: file('mixed.txt', '[Verse]\nNightгород tonight\n'), as: 'lyric_sheet', language: 'mixed' });
    await expect(importLyricSheet(deps, { sourceId: mixed.sourceId })).rejects.toThrow(/mixes Latin and Cyrillic.*Nightгород/);
    const doc = await addToVault(deps, { path: file('not-lyrics.txt', 'a plain note\n') });
    await expect(importLyricSheet(deps, { sourceId: doc.sourceId })).rejects.toThrow(/not a lyric sheet/);
    const structure = await insertArtifact(db.sql, 'x3lius.song-structure/v1', { fixture: true });
    const r = await dispatch(deps, 'x3lius-lyric-editor', { edit: { parentId: structure, text: '[Verse]\nx' } });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/x3lius\.lyrics\/v2/);
    expect(await db.sql`select 1 from creative_artifacts where context_refs @> ${db.sql.json([{ sourceId: mixed.sourceId }])}`).toEqual([]);
  });
});
