import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { BUILT_SUBDOMAINS, HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { selectNormalizer } from '../../knowledge/ingestion/normalizers/index.ts';
import { detectVocalDna, normalizeVocalDna, VOCAL_DNA_NORMALIZER_ID } from '../../knowledge/ingestion/normalizers/vocal-dna.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { FIRST_PARTY_ADMISSION_ERROR } from '../../knowledge/promotion-gate/gate.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { subdomainStub } from '../../records/x3lius/subdomain-stub.ts';
import { readVocalDna } from '../../records/x3lius/vocal-dna/read.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// Phase 10: X3LIUS Vocal DNA as ONE structured canonical row (tone, register, delivery, ad-libs,
// RVC/Applio model), admitted through the gate's first-party path and versioned like any canonical
// write, read identically by the Suno formula (Phase 9) and the RVC post-processing step.
//
// FIXTURE: the Vocal DNA file below is synthetic, "[FIXTURE]" in every value, and is admitted only
// into this throwaway database. The real file is operator-authored (records/x3lius/vocal-dna.yaml).
// FAKE MODEL for the formula call (tests/helpers/fake-llm.ts).

const REQUEST = 'An X3LIUS track about the city at night';
const fixture = (tone = '[FIXTURE] tone one') => `# [FIXTURE] synthetic Vocal DNA for the Phase 10 tests
vocal_dna: xyp-vocal-dna/v1
artist: X3LIUS
date: 2026-09-24
module: x3lius-vocal-dna
tone:
  - '${tone}'
  - '[FIXTURE] tone two'
register:
  - '[FIXTURE] register'
delivery:
  - '[FIXTURE] delivery one'
  - '[FIXTURE] delivery two'
adlibs:
  - '[FIXTURE] ad-lib style'
rvc:
  engine: applio
  model: '[FIXTURE]-voice.pth'
  pitch: -2
  index_rate: 0.75
`;
const VOCAL_TOPICS = ['x3lius.vocal.adlibs', 'x3lius.vocal.delivery', 'x3lius.vocal.register', 'x3lius.vocal.rvc', 'x3lius.vocal.tone'];

let db: TestDb;
let dir: string;
let embedder: Embedder;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const depsWith = (model = fakeModel()): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (deps: DispatchDeps, agent: string, input: unknown) => dispatch(deps, agent, input, { timeoutMs: 60_000 });
const admit = async (text: string, name = 'vocal-dna.yaml', origin: 'first_party' | 'third_party' = 'first_party') => {
  const path = join(dir, name);
  writeFileSync(path, text);
  const r = await ingestSource(db.sql, { kind: 'file', path, origin } as Parameters<typeof ingestSource>[1]);
  await embedPending(db.sql, embedder); // scoped retrieval is vector search: a row is findable once embedded
  return r;
};
const vocalRows = () => db.sql<{ id: string; version: number; module: string }[]>`
  select cp.id, cp.version, m.slug as module from canonical_prompts cp join modules m on m.id = cp.module_id
  where cp.slug = 'x3lius-vocal-dna' order by cp.version`;
const vocalClaims = () => db.sql<{ canonical_prompt_id: string; version: number; topic: string; value: unknown; model_scope: string }[]>`
  select canonical_prompt_id, version, topic, value, model_scope from canonical_claims where topic like 'x3lius.vocal.%' order by topic`;

type RvcOut = { status: string; source: { canonicalPromptId: string; slug: string; version: number; ref: string }; rvc: Record<string, unknown>; unset: string[]; vocal: { tone: string[]; register: string[]; delivery: string[]; adlibs: string[] } };

beforeAll(async () => {
  db = await createTestDb('phase10_vocal_dna', { migrated: true });
  dir = mkdtempSync(join(tmpdir(), 'phase10-'));
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
});
afterAll(async () => {
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('Vocal DNA normalizer (xyp-vocal-dna/v1): structured, strict, one row', () => {
  it('is selected for a Vocal DNA file and only for one', () => {
    expect(VOCAL_DNA_NORMALIZER_ID).toBe('xyp-vocal-dna-v1');
    expect(selectNormalizer([fixture()])?.id).toBe(VOCAL_DNA_NORMALIZER_ID);
    expect(detectVocalDna(['vocal_dna: something-else/v1'])).toBe(false);
    expect(detectVocalDna([fixture(), 'a second page'])).toBe(false);
  });

  it('yields one prompt in the Vocal DNA module, claims per attribute, RVC settings scoped to rvc', () => {
    const doc = normalizeVocalDna([fixture()]);
    // The module is the manifest's; this document references it, never redeclares it.
    expect(doc.modules).toEqual([]);
    expect(doc.prompts).toHaveLength(1);
    const p = doc.prompts[0]!;
    expect(p).toMatchObject({ moduleSlug: 'x3lius-vocal-dna', slug: 'x3lius-vocal-dna', title: 'X3LIUS Vocal DNA', modelTag: 'model-agnostic' });
    expect(p.structured).toEqual({
      schema: 'xyp-vocal-dna/v1',
      claims: [
        { topic: 'x3lius.vocal.tone', value: ['[FIXTURE] tone one', '[FIXTURE] tone two'], model_scope: 'model-agnostic' },
        { topic: 'x3lius.vocal.register', value: ['[FIXTURE] register'], model_scope: 'model-agnostic' },
        { topic: 'x3lius.vocal.delivery', value: ['[FIXTURE] delivery one', '[FIXTURE] delivery two'], model_scope: 'model-agnostic' },
        { topic: 'x3lius.vocal.adlibs', value: ['[FIXTURE] ad-lib style'], model_scope: 'model-agnostic' },
        { topic: 'x3lius.vocal.rvc', value: { engine: 'applio', model: '[FIXTURE]-voice.pth', pitch: -2, index_rate: 0.75 }, model_scope: 'rvc' },
      ],
    });
    // The rule text every creative agent retrieves carries the vocal signature, not the RVC settings.
    expect(p.body).toContain('[FIXTURE] tone one');
    expect(p.body).toContain('[FIXTURE] ad-lib style');
    expect(p.body).not.toContain('voice.pth');
    expect(p.completeness.present).toEqual(p.completeness.expected);
    expect(doc).toMatchObject({ normalizer: 'xyp-vocal-dna-v1', documentDate: '2026-09-24' });
  });

  it.each([
    ['a missing attribute', (t: string) => t.replace(/register:\n {2}- '\[FIXTURE\] register'\n/, ''), /register must be a non-empty list/],
    ['an empty list', (t: string) => t.replace(/adlibs:\n {2}- '\[FIXTURE\] ad-lib style'\n/, 'adlibs: []\n'), /adlibs must be a non-empty list/],
    ['a non-string descriptor', (t: string) => t.replace("  - '[FIXTURE] tone two'", '  - 7'), /tone\[1\] must be a non-empty string/],
    ['an unknown field', (t: string) => `${t}vibe: loud\n`, /unknown field: vibe/],
    ['an unknown RVC setting', (t: string) => t.replace('  index_rate: 0.75', '  index_rate: 0.75\n  turbo: true'), /rvc: unknown field: turbo/],
    ['an unknown RVC engine', (t: string) => t.replace('engine: applio', 'engine: magic'), /rvc\.engine must be one of applio, rvc/],
    ['no RVC model', (t: string) => t.replace("  model: '[FIXTURE]-voice.pth'\n", ''), /rvc\.model must be a non-empty string/],
    ['an index rate above 1', (t: string) => t.replace('index_rate: 0.75', 'index_rate: 1.5'), /rvc\.index_rate must be a number from 0 to 1/],
    ['a fractional pitch', (t: string) => t.replace('pitch: -2', 'pitch: 2.5'), /rvc\.pitch must be a whole number of semitones from -24 to 24/],
    ['a protect value above 0.5', (t: string) => t.replace('index_rate: 0.75', 'index_rate: 0.75\n  protect: 0.6'), /rvc\.protect must be a number from 0 to 0\.5/],
    ['a bad date', (t: string) => t.replace('date: 2026-09-24', 'date: soon'), /date must be YYYY-MM-DD/],
    ['a module that is not a slug', (t: string) => t.replace('module: x3lius-vocal-dna', 'module: Vocal DNA'), /module "Vocal DNA" is not a kebab-case slug/],
  ])('refuses %s, loudly (never half-normalized)', (_, edit, error) => {
    expect(() => normalizeVocalDna([edit(fixture())])).toThrow(error);
  });
});

describe('the Suno formula and the RVC step read the same canonical row', () => {
  it('before any Vocal DNA is admitted, the RVC step refuses and says how to admit it', async () => {
    const r = await run(depsWith(), 'x3lius-rvc-post', {});
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no canonical Vocal DNA: admit records\/x3lius\/vocal-dna\.yaml/);
  });

  it('only first-party origin is admitted; third-party material goes through Research Intelligence', async () => {
    const r = await admit(fixture(), 'third.yaml', 'third_party');
    expect(r.status).toBe('error');
    expect(r.error).toContain(FIRST_PARTY_ADMISSION_ERROR);
  });

  it('admission writes one versioned row in the manifest’s Vocal DNA module, with its knowledge_versions entry', async () => {
    const modulesBefore = await db.sql<{ n: number }[]>`select count(*)::int as n from modules where slug = 'x3lius-vocal-dna'`;
    const r = await admit(fixture());
    expect(r.status, r.error).toBe('success');
    const rows = await vocalRows();
    expect(rows).toEqual([expect.objectContaining({ version: 1, module: 'x3lius-vocal-dna' })]);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from modules where slug = 'x3lius-vocal-dna'`)[0]!.n).toBe(modulesBefore[0]!.n);
    const [kv] = await db.sql<{ version: number; promoted_via: string }[]>`
      select version, promoted_via from knowledge_versions where canonical_table = 'canonical_prompts' and canonical_id = ${rows[0]!.id}`;
    expect(kv).toEqual({ version: 1, promoted_via: 'gate' });
    const claims = await vocalClaims();
    expect(claims.map((c) => c.topic)).toEqual(VOCAL_TOPICS);
    expect(new Set(claims.map((c) => c.canonical_prompt_id))).toEqual(new Set([rows[0]!.id]));
  });

  it('x3lius-rvc-post (no LLM) outputs the Applio job spec from that row, naming its id and version', async () => {
    const [row] = await vocalRows();
    const r = await run(depsWith(), 'x3lius-rvc-post', {});
    expect(r.status, r.error).toBe('success');
    const o = r.output as RvcOut;
    expect(o).toMatchObject({ status: 'job-spec', source: { canonicalPromptId: row!.id, slug: 'x3lius-vocal-dna', version: 1, ref: `canonical_prompts:${row!.id}` } });
    expect(o.rvc).toEqual({ engine: 'applio', model: '[FIXTURE]-voice.pth', pitch: -2, index_rate: 0.75 });
    // Settings the DNA doesn't state are listed, never filled with a default of ours.
    expect(o.unset).toEqual(['index', 'protect', 'f0_method', 'rms_mix_rate']);
    expect(o.vocal).toEqual({ tone: ['[FIXTURE] tone one', '[FIXTURE] tone two'], register: ['[FIXTURE] register'], delivery: ['[FIXTURE] delivery one', '[FIXTURE] delivery two'], adlibs: ['[FIXTURE] ad-lib style'] });
    const [log] = await db.sql<{ output: { logs: { message: string }[] }; tokens_used: number }[]>`select output, tokens_used from agent_runs where id = ${r.runId}`;
    expect(log!.output.logs.map((l) => l.message)).toContainEqual(`x3lius-rvc-post: Vocal DNA canonical_prompts:${row!.id} v1 → applio model [FIXTURE]-voice.pth`);
    expect(log!.tokens_used).toBe(0);
  });

  it('the Suno formula gets the vocal signature from the same row, and not the RVC settings', async () => {
    const [row] = await vocalRows();
    const lyrics = await run(depsWith(), 'x3lius-lyrics', { request: REQUEST });
    expect(lyrics.status, lyrics.error).toBe('success');
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [(lyrics.output as { artifact: { id: string } }).artifact.id] });
    expect(r.status, r.error).toBe('success');
    const prompt = model.calls[0]!.system;
    for (const t of ['tone', 'register', 'delivery', 'adlibs']) expect(prompt).toContain(`[canonical_prompts:${row!.id}#x3lius.vocal.${t}]`);
    expect(prompt).toContain('[FIXTURE] delivery two');
    expect(prompt).not.toContain('x3lius.vocal.rvc');
    expect(prompt).not.toContain('voice.pth');
    const o = r.output as { context: { ref: string }[]; knowledge: { reasons: string[]; perModule: Record<string, number> } };
    // The Vocal DNA row reaches the formula both as a scoped rule (its module) and as claims.
    expect(o.knowledge.perModule['x3lius-vocal-dna']).toBe(1);
    expect(o.context.map((c) => c.ref)).toEqual(expect.arrayContaining([`canonical_prompts:${row!.id}`, `canonical_prompts:${row!.id}#x3lius.vocal.tone`]));
    expect(o.knowledge.reasons.join('\n')).toMatch(/excluded 1 canonical entry scoped to another model or tool/);
  });

  it('other creative agents get the vocal signature too, and never the RVC settings', async () => {
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics', { request: REQUEST });
    expect(r.status, r.error).toBe('success');
    expect(model.calls[0]!.system).toContain('x3lius.vocal.tone');
    expect(model.calls[0]!.system).not.toContain('x3lius.vocal.rvc');
    expect((r.output as { knowledge: { reasons: string[] } }).knowledge.reasons.join('\n')).toMatch(/excluded 1 canonical entry scoped to a specific model or tool/);
  });

  it('x3lius-vocal-dna is no longer a stub: it answers with the same row', async () => {
    const [row] = await vocalRows();
    const r = await run(depsWith(), 'x3lius-vocal-dna', { request: 'What is the X3LIUS vocal signature?' });
    expect(r.status, r.error).toBe('success');
    expect(r.output).toMatchObject({ subdomain: 'x3lius-vocal-dna', status: 'known', vocalDna: { source: { canonicalPromptId: row!.id, version: 1 }, rvc: { model: '[FIXTURE]-voice.pth' } } });
  });

  it('a vocal-direction change is a new version, and both readers move to it together (no copy to drift)', async () => {
    const unchanged = await admit(fixture(), 'vocal-dna-same.yaml');
    expect(unchanged.status, unchanged.error).not.toBe('error');
    expect(await vocalRows()).toHaveLength(1);

    const changed = await admit(fixture('[FIXTURE] tone one, revised'), 'vocal-dna-v2.yaml');
    expect(changed.status, changed.error).toBe('success');
    const rows = await vocalRows();
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    const v2 = rows[1]!;
    const kv = await db.sql<{ canonical_id: string; version: number }[]>`
      select canonical_id, version from knowledge_versions where canonical_table = 'canonical_prompts' and canonical_id = any(${rows.map((r) => r.id)}::uuid[]) order by version`;
    expect(kv.map((k) => k.version)).toEqual([1, 2]);

    const rvc = (await run(depsWith(), 'x3lius-rvc-post', {})).output as RvcOut;
    expect(rvc.source).toMatchObject({ canonicalPromptId: v2.id, version: 2 });
    expect(rvc.vocal.tone[0]).toBe('[FIXTURE] tone one, revised');
    const model = fakeModel();
    const lyrics = await run(depsWith(), 'x3lius-lyrics', { request: REQUEST });
    await run(depsWith(model), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [(lyrics.output as { artifact: { id: string } }).artifact.id] });
    expect(model.calls[0]!.system).toContain(`[canonical_prompts:${v2.id}#x3lius.vocal.tone] x3lius.vocal.tone = [FIXTURE] tone one, revised`);
    expect(model.calls[0]!.system).not.toContain(`canonical_prompts:${rows[0]!.id}`);
  });

  it('a document may only reference a module that already exists', async () => {
    const r = await admit(fixture().replace('module: x3lius-vocal-dna', 'module: x3lius-no-such-module'), 'orphan.yaml');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/prompt x3lius-vocal-dna references unknown module x3lius-no-such-module/);
  });
});

describe('readVocalDna: one source of truth or nothing', () => {
  const claim = (id: string, topic: string, value: unknown) => ({ ref: { table: 'canonical_prompts', id }, slug: 'x3lius-vocal-dna', version: 1, title: 't', module: 'x3lius-vocal-dna', topic: `x3lius.vocal.${topic}`, value, modelScope: 'model-agnostic', source: null });
  const ctxWith = (items: unknown[]) => ({ useTool: async () => ({ topicPrefix: 'x3lius.vocal.', items }) }) as unknown as Parameters<typeof readVocalDna>[0];
  const full = (id: string) => ['tone', 'register', 'delivery', 'adlibs'].map((t) => claim(id, t, ['x'])).concat([claim(id, 'rvc', { engine: 'applio', model: 'm' })]);

  it('refuses Vocal DNA claims that come from two canonical rows', async () => {
    await expect(readVocalDna(ctxWith([...full('00000000-0000-0000-0000-00000000000a'), claim('00000000-0000-0000-0000-00000000000b', 'tone', ['y'])])))
      .rejects.toThrow(/Vocal DNA claims come from 2 canonical rows .*expected exactly one/);
  });

  it('refuses a row missing an attribute', async () => {
    await expect(readVocalDna(ctxWith(full('00000000-0000-0000-0000-00000000000a').filter((c) => c.topic !== 'x3lius.vocal.adlibs'))))
      .rejects.toThrow(/has no x3lius\.vocal\.adlibs claim/);
  });
});

describe('registry: Phase 10 agents', () => {
  it('x3lius-rvc-post is a deterministic Execution agent under RECORDS that only reads claims', () => {
    expect(registry.get('x3lius-rvc-post')).toMatchObject({ class: 'Execution', domain: 'RECORDS', model: 'none', tools: ['retrieve_claims', 'log_message'] });
    expect(HANDLERS['x3lius-rvc-post']).toBeTypeOf('function');
  });

  it('x3lius-vocal-dna is a built Knowledge agent (Phase 10), no longer the Phase 7 stub', () => {
    expect(loadMusicSystem().subdomains.find((s) => s.slug === 'x3lius-vocal-dna')).toMatchObject({ builtIn: '10' });
    expect(registry.get('x3lius-vocal-dna')).toMatchObject({ class: 'Knowledge', model: 'none', tools: ['retrieve_claims', 'log_message'] });
    expect(HANDLERS['x3lius-vocal-dna']).not.toBe(subdomainStub);
    expect(BUILT_SUBDOMAINS).toContain('x3lius-vocal-dna');
    expect(registry.validateAll()).toEqual([]);
  });
});
