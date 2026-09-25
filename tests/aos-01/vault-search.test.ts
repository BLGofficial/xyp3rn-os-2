import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createContextEngine, type ContextBundle, type VaultBundle } from '../../core/context-engine/context-engine.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending, embedVault } from '../../knowledge/vector-retrieval/pipeline.ts';
import { addAndImport } from '../../records/vault/import.ts';
import { asCommitted } from '../helpers/records-fixture.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-01 proof (part 3): one Context Engine, two corpora (A3). The knowledge corpus (every agent's
// grounding) is unchanged by Vault rows, item for item; the vault corpus finds the owner's lyrics,
// files and research findings next to canonical knowledge. Real data and the real model: the
// ingested build guide, gte-small, the lyric sheet through the real agents.

let db: TestDb;
let deps: DispatchDeps;
let embedder: Embedder;
const files = mkdtempSync(join(tmpdir(), 'aos01-search-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos01-search-vault-'));
const QUERIES = ['Tool Registry authorization, deny-by-default for unregistered tools', 'assemble a Suno-ready prompt from songwriting and lyrics output'];
let before: ContextBundle[];
let lyrics: { lineageId: string; artifactId: string };
let songId: string;
let notesId: string;
let findingId: string;

const file = (name: string, content: string | Buffer): string => {
  const p = join(files, name);
  writeFileSync(p, content);
  return p;
};
/** 0.1 s of 16-bit mono silence at 8 kHz: a complete, playable WAV. */
const wav = (): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return Buffer.concat([h, Buffer.alloc(1600)]);
};

beforeAll(async () => {
  db = await createTestDb('aos01_vault_search', { migrated: true });
  await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  const knowledgeOnly = createContextEngine(db.sql, embedder);
  before = await Promise.all(QUERIES.map((q) => knowledgeOnly.retrieve(q)));

  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
  const song = await dispatch(deps, 'records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' } });
  songId = (song.output as { songId: string }).songId;
  const sheet = await addAndImport(deps, {
    path: file('night-city.txt', '[Verse 1]\nNeon bleeding on the glass\nSodium lamps and a midnight train\n\n[Chorus]\nWe run the city till the morning breaks\n'),
    as: 'lyric_sheet', language: 'en', songId,
  });
  lyrics = sheet.lyrics as { lineageId: string; artifactId: string };
  notesId = (await addAndImport(deps, {
    path: file('session-notes.txt', 'Vocal chain for the verses: Neve 1073 preamp into an LA-2A compressor, about 3 dB of gain reduction, then a Pultec EQ.\n'),
  })).file.sourceId;
  await addAndImport(deps, { path: file('night-city-demo.wav', wav()), tags: ['demo'] });
  const researchRun = await insertResearchRun(db.sql);
  const [finding] = await asCommitted(db.sql, 'xyp_research', (tx) => tx<{ id: string }[]>`
    insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
    values (${researchRun}, '[FIXTURE] Spotify normalizes playback loudness to about -14 LUFS integrated', 'model-agnostic', 0.5,
            '{"basis":"fixture"}', 'release.loudness-target', '"-14 LUFS"') returning id`);
  findingId = finding!.id;
}, 180_000);
afterAll(async () => {
  await db?.drop();
  rmSync(files, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('the knowledge corpus is unchanged by the Vault', () => {
  it('pnpm embed leaves Vault-only files out of the knowledge index; every agent-facing bundle is identical, generation included', async () => {
    const stats = await embedPending(db.sql, embedder);
    expect(stats.sources).toMatchObject({ embedded: 0 });
    expect(await db.sql`select title from sources where embedding is not null and storage is not null`).toEqual([]);
    const fresh = createContextEngine(db.sql, embedder);
    for (const [i, q] of QUERIES.entries()) {
      const after = await fresh.retrieve(q, { corpus: 'knowledge' });
      expect({ ...after, cache: before[i]!.cache }).toEqual(before[i]);
      expect(await fresh.retrieve(q)).toMatchObject({ items: before[i]!.items, generation: before[i]!.generation });
    }
  });
});

describe('embedVault: artifacts, Vault files and research findings, one row per entity and model', () => {
  it('embeds each once; an unchanged input is skipped; the knowledge index is untouched', async () => {
    const first = await embedVault(db.sql, embedder);
    expect(first).toMatchObject({ model: 'Supabase/gte-small', artifact: { embedded: 1 }, source: { embedded: 3 }, research_finding: { embedded: 1 } });
    const again = await embedVault(db.sql, embedder);
    expect(again).toMatchObject({ artifact: { embedded: 0, skipped: 1 }, source: { embedded: 0, skipped: 3 }, research_finding: { embedded: 0, skipped: 1 } });
    expect((await db.sql`select count(*)::int as n from vault_embeddings`)[0]).toEqual({ n: 5 });
    expect(await db.sql`select title from sources where embedding is not null and storage is not null`).toEqual([]);
  });
});

describe('the vault corpus: the owner\'s material next to canonical knowledge', () => {
  const search = async (q: string): Promise<VaultBundle> => {
    const b = await createContextEngine(db.sql, embedder).retrieve(q, { corpus: 'vault', limit: 5 });
    expect(b).toMatchObject({ corpus: 'vault', model: 'Supabase/gte-small' });
    return b;
  };

  it('finds a lyric line twice over: the lyrics lineage (its version, its song) and the sheet it came from', async () => {
    const b = await search('neon on the glass, sodium lamps, a midnight train');
    const top2 = b.items.slice(0, 2);
    const art = top2.find((i) => i.kind === 'artifact');
    expect(art).toMatchObject({
      id: lyrics.artifactId, lineage: { id: lyrics.lineageId, version: 1, schemaId: 'x3lius.lyrics/v2' },
      songs: [{ id: songId, title: '[FIXTURE] Night City' }],
    });
    expect(art!.snippet).toContain('Neon bleeding on the glass');
    expect(top2.find((i) => i.kind === 'file')).toMatchObject({ title: 'night-city.txt', mediaClass: 'lyric_sheet', songs: [{ id: songId }] });
  });

  it('finds a file by its text, and a file with no text by its name and tags', async () => {
    expect((await search('which compressor and preamp are on the vocal chain')).items[0]).toMatchObject({ kind: 'file', id: notesId, title: 'session-notes.txt', mediaClass: 'document' });
    const demo = (await search('night city demo recording')).items.find((i) => i.kind === 'file' && i.mediaClass === 'audio');
    expect(demo).toMatchObject({ title: 'night-city-demo.wav' });
  });

  it('finds a research finding, and canonical knowledge in the same search', async () => {
    expect((await search('streaming loudness normalization target in LUFS')).items.map((i) => [i.kind, i.id])).toContainEqual(['research_finding', findingId]);
    const k = await search('Tool Registry authorization, deny-by-default for unregistered tools');
    expect(k.items[0]!.kind).toBe('canonical');
    expect(k.items[0]!.title.length).toBeGreaterThan(0);
  });

  it('one item per lineage (its best version), ordered by similarity', async () => {
    const edit = await dispatch(deps, 'x3lius-lyric-editor', { edit: { parentId: lyrics.artifactId, text: '[Verse 1]\nNeon bleeding on the glass\nSodium lamps and the last train home\n' } });
    expect(edit.status).toBe('success');
    await embedVault(db.sql, embedder);
    const b = await search('neon bleeding on the glass, sodium lamps');
    const lineages = b.items.filter((i) => i.kind === 'artifact').map((i) => i.lineage!.id);
    expect(lineages).toEqual([...new Set(lineages)]);
    // Whichever version matches best, the item is named by the lineage (its first version's brief).
    expect(b.items.find((i) => i.lineage?.id === lyrics.lineageId)!.title).toBe('Lyric sheet "night-city.txt" (Vault file ' + b.items.find((i) => i.kind === 'file' && i.title === 'night-city.txt')!.id + ')');
    const sims = b.items.map((i) => i.similarity);
    expect(sims).toEqual([...sims].sort((x, y) => y - x));
  });
});
