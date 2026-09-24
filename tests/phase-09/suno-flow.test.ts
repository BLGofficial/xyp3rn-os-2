import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { decideApproval, runGate } from '../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { asRole } from '../../research-intelligence/db.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import { CREATIVE_SUBDOMAINS } from '../../records/x3lius/creative/program.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { renderLyrics, SONG_TO_SUNO_WORKFLOW } from '../../records/x3lius/suno/formula.ts';
import { STUB_SCORER } from '../../records/x3lius/suno/score-hook.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeBody, fakeModel } from '../helpers/fake-llm.ts';

// Phase 9 proof: song → Suno prompt → submission → takes → scoring hook, against a throwaway DB
// holding the real ingested guide + X3LIUS manifest.
//
// FAKE MODEL (tests/helpers/fake-llm.ts): no provider key exists in this container; every LLM call
// goes through the real runner into a fake fetch replying "[FAKE] …". FAKE SUNO: the sunoapi
// adapter talks to a fake fetch too. FIXTURE rules: synthetic, "[FIXTURE]" in every field,
// promoted through the real gate into x3lius-suno, only in this throwaway database.
// What is real: context pulls, prompt assembly, the lyrics rendering, validation, every table
// write, grants, the agent_runs audit trail, and the workflow chaining the agents.

const REQUEST = 'An X3LIUS track about the city at night';
const SUNO_RULE = 'Lead the Suno style prompt with the vocal descriptor, then the genre.';
const SUNO_ENV = { SUNO_API_KEY: 'test-suno', SUNO_CALLBACK_URL: 'https://hooks.example.org/suno' };

let db: TestDb;
let embedder: Embedder;
let researchRunId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

const depsWith = (model: ReturnType<typeof fakeModel>, tools: { env?: Record<string, string>; fetch?: typeof fetch } = {}): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, ...tools }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (deps: DispatchDeps, agent: string, input: unknown) => dispatch(deps, agent, input, { timeoutMs: 60_000 });

type Out = { artifact: { id: string; schemaId: string }; body: Record<string, unknown>; knowledge: { perModule: Record<string, number>; sparse: boolean }; context: { kind: string; slug: string | null }[] };
const out = (r: { output?: unknown }) => r.output as Out;
type LyricsV2 = { sections: { sectionId: string; kind: string; label: string; bars: { text: string }[] }[]; instrumental: string[]; sources: unknown[] };
const artifactsOf = (runId: string) => db.sql<{ id: string }[]>`select id from creative_artifacts where agent_run_id = ${runId}`;

/** Writes a pre-v2 lyrics artifact (x3lius.lyrics/v1, one section) the way Phase 8 did, so the formula's legacy path is tested. */
const insertLegacyLyrics = async (bars: readonly string[]) => {
  const [src] = await db.sql<{ agent_run_id: string }[]>`select agent_run_id from creative_artifacts where id = ${ids.structure}`;
  const body = { section: { kind: 'verse', label: 'Verse 1' }, bars: bars.map((text, i) => ({ n: i + 1, text, language: 'en', rhymeTag: 'A' })), rhymeScheme: 'AA', devices: [], rulesApplied: [], ungroundedChoices: [] };
  return asRole(db.sql, 'xyp_creative', async (tx) => {
    const [a] = await tx<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.lyrics/v1', 'x3lius-lyrics', ${src!.agent_run_id}, '[FIXTURE] legacy v1 lyrics', ${tx.json(body)}, '[]', '{}', 'fixture')
      returning id`;
    return a!.id;
  });
};

/** Promotes one [FIXTURE] rule into x3lius-suno through the real gate, then embeds it. */
const promoteSunoFixture = async (slug: string, note: string, claim: { topic: string; value: unknown; modelTag: string }) => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: `fixture:phase-09/${slug}`, title: `[FIXTURE] ${note}`,
    contentSha256: createHash('sha256').update(`fixture\n${note}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-09-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${note}`, model_tag: claim.modelTag, confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 9 wiring proof — not a real observation' },
    claim_topic: claim.topic, claim_value: claim.value,
  });
  const f = await recordFinding(db.sql, { researchRunId, claim: `[FIXTURE] ${note}`, claim_topic: claim.topic, claim_value: claim.value, model_tag: claim.modelTag, evidenceIds: [ev] });
  const c = await proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: slug, title: `[FIXTURE] ${note}`,
    body: `[FIXTURE — synthetic, Phase 9 wiring proof] ${note}`, domain: 'RECORDS', tags: ['x3lius-suno'],
  });
  const pending = await runGate(db.sql, c);
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-09-test', reason: 'Fixture for the wiring proof.' });
  const r = await runGate(db.sql, c);
  expect(r.outcome).toBe('promoted');
  await embedPending(db.sql, embedder);
  return r.canonicalPromptId!;
};

/** Fake Suno reseller: records calls, answers generate then record-info in order. */
const fakeSuno = (responses: readonly unknown[]) => {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};

const ids = { structure: '', lyrics: '', genre: '', formula: '', fixture: '' };

beforeAll(async () => {
  db = await createTestDb('phase09_flow', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-09-fixture', '[FIXTURE] Phase 9 wiring proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${REQUEST}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
});
afterAll(async () => {
  await db?.drop();
});

describe('registry: Phase 9 agents', () => {
  it('Genre/Style (F15) and Suno are Creative now; the manifest’s Phase 9 sub-domains are exactly those', () => {
    const p9 = loadMusicSystem().subdomains.filter((s) => s.builtIn === '9').map((s) => s.slug).sort();
    expect(p9).toEqual(['x3lius-genre-style', 'x3lius-suno']);
    for (const s of p9) expect(CREATIVE_SUBDOMAINS).toContain(s);
    expect(registry.get('x3lius-genre-style')).toMatchObject({ class: 'Creative', domain: 'RECORDS', tools: ['retrieve_context', 'retrieve_claims', 'write_artifact', 'log_message'] });
    expect(registry.get('x3lius-suno')).toMatchObject({ class: 'Creative', domain: 'RECORDS', tools: ['retrieve_context', 'retrieve_claims', 'read_artifact', 'write_artifact', 'log_message'] });
  });

  it('suno-submitter is a deterministic Execution agent under RECORDS', () => {
    expect(registry.get('suno-submitter')).toMatchObject({ class: 'Execution', domain: 'RECORDS', model: 'none', tools: ['submit_suno', 'capture_suno_takes', 'log_message'] });
    expect(HANDLERS['suno-submitter']).toBeTypeOf('function');
  });

  it('authorization follows the class matrix', () => {
    const tools = createRuntimeTools({ sql: db.sql });
    expect(tools.authorize('Execution', 'submit_suno')).toEqual({ allow: true, capability: 'external.execute' });
    expect(tools.authorize('Execution', 'capture_suno_takes')).toEqual({ allow: true, capability: 'external.execute' });
    expect(tools.authorize('Creative', 'submit_suno')).toMatchObject({ allow: false });
    expect(tools.authorize('Execution', 'write_artifact')).toMatchObject({ allow: false });
    expect(tools.authorize('Creative', 'read_artifact')).toEqual({ allow: true, capability: 'artifact.read' });
    expect(tools.authorize('Knowledge', 'read_artifact')).toMatchObject({ allow: false });
  });

  it('every sub-domain not built yet is still a read-only stub; the registry validates', () => {
    const stubs = loadMusicSystem().subdomains.map((s) => s.slug).filter((s) => !CREATIVE_SUBDOMAINS.includes(s));
    expect(stubs.sort()).toEqual(['x3lius-arrangement', 'x3lius-evaluation', 'x3lius-mix-master', 'x3lius-production', 'x3lius-vocal-dna']);
    for (const s of stubs) expect(registry.get(s)).toMatchObject({ class: 'Knowledge', model: 'none' });
    expect(registry.validateAll()).toEqual([]);
  });
});

describe('no hardcoded voice in the Phase 9 code either', () => {
  it('no Suno or creative source file carries a word of the canonical voice claim', async () => {
    const [claim] = await db.sql<{ value: string[] }[]>`select value from canonical_claims where topic = 'x3lius.voice-reference'`;
    const words = claim!.value.flatMap((v) => v.split(/[^A-Za-z]+/)).filter((w) => w.length >= 7);
    const dirs = ['records/x3lius/suno', 'records/x3lius/creative'];
    const files = [...dirs.flatMap((d) => readdirSync(join(REPO_ROOT, d)).map((f) => join(REPO_ROOT, d, f))),
      ...['x3lius-genre-style', 'x3lius-suno', 'suno-submitter'].map((n) => join(REPO_ROOT, 'agents', `${n}.agent.md`))];
    for (const f of files) {
      const text = readFileSync(f, 'utf8').toLowerCase();
      for (const w of words) expect(text.includes(w.toLowerCase()), `${f} contains voice word "${w}"`).toBe(false);
    }
  });
});

describe('the Suno Prompt-Formula agent (x3lius-suno)', () => {
  it('builds its inputs: structure, lyrics and genre/style artifacts (FAKE model)', async () => {
    const deps = depsWith(fakeModel());
    for (const [key, agent] of [['structure', 'x3lius-songwriting'], ['lyrics', 'x3lius-lyrics'], ['genre', 'x3lius-genre-style']] as const) {
      const r = await run(deps, agent, { request: REQUEST, ...(key === 'lyrics' ? { structureArtifactId: ids.structure } : {}) });
      expect(r.status, r.error).toBe('success');
      ids[key] = out(r).artifact.id;
    }
    expect(out(await run(deps, 'x3lius-genre-style', { request: REQUEST })).artifact.schemaId).toBe('x3lius.genre-style/v1');
  });

  it('assembles from the artifacts + canonical Suno rules; the lyrics are rendered, never written by the model', async () => {
    ids.fixture = await promoteSunoFixture('fixture-phase-09-suno-rule', SUNO_RULE, { topic: 'fixture.suno-style-order', value: 'vocal-first', modelTag: 'suno-v5' });
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-suno', {
      request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [ids.lyrics], structureArtifactId: ids.structure, genreStyleArtifactId: ids.genre,
    });
    expect(r.status, r.error).toBe('success');
    const o = out(r);
    ids.formula = o.artifact.id;
    expect(o.artifact.schemaId).toBe('x3lius.suno-prompt/v1');

    const [lyricsRow] = await db.sql<{ schema_id: string; body: LyricsV2 }[]>`select schema_id, body from creative_artifacts where id = ${ids.lyrics}`;
    expect(o.body.lyrics).toBe(renderLyrics([{ schemaId: lyricsRow!.schema_id, body: lyricsRow!.body }]));
    // Every section, in song order: a [label] meta-tag, one line per bar, a blank line between sections.
    const [v1, c1] = lyricsRow!.body.sections;
    expect(o.body.lyrics).toBe(`[Verse 1]\n${v1!.bars.map((b) => b.text).join('\n')}\n\n[Chorus]\n${c1!.bars.map((b) => b.text).join('\n')}`);
    expect(Object.keys((model.calls[0]!.schema.properties as object))).not.toContain('lyrics');

    const prompt = model.calls[0]!.system;
    expect(prompt).toContain(SUNO_RULE);
    const [claim] = await db.sql<{ value: string[] }[]>`select value from canonical_claims where topic = 'x3lius.voice-reference'`;
    for (const d of claim!.value) expect(prompt).toContain(d);
    expect(model.calls[0]!.user).toContain(c1!.bars[3]!.text);

    expect(o.body).toMatchObject({ sunoModel: 'v5', title: '[FAKE] Suno Title', style: '[FAKE] style prompt', excludeStyles: ['[FAKE] excluded'], limits: [] });
    expect(o.body.sources).toEqual([
      expect.objectContaining({ role: 'lyrics', artifactId: ids.lyrics, schemaId: 'x3lius.lyrics/v2' }),
      expect.objectContaining({ role: 'structure', artifactId: ids.structure, schemaId: 'x3lius.song-structure/v1' }),
      expect.objectContaining({ role: 'genre-style', artifactId: ids.genre, schemaId: 'x3lius.genre-style/v1' }),
    ]);
    expect(o.knowledge.perModule).toEqual({ 'x3lius-suno': 1, 'x3lius-genre-style': 0, 'x3lius-vocal-dna': 0 });
    expect(o.knowledge.sparse).toBe(true);
  });

  it('refuses without lyrics artifacts, and refuses an artifact of the wrong schema', async () => {
    const deps = depsWith(fakeModel());
    const none = await run(deps, 'x3lius-suno', { request: REQUEST, sunoModel: 'v5' });
    expect(none.error).toMatch(/x3lius-suno needs lyricsArtifactIds/);
    const wrong = await run(deps, 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [ids.structure] });
    expect(wrong.error).toMatch(/is x3lius\.song-structure\/v1, expected x3lius\.lyrics\/v1/);
  });

  it('a model reply that tries to supply lyrics is refused', async () => {
    const model = fakeModel({ override: (schema, refs) => ('excludeStyles' in (schema.properties as object)
      ? { title: '[FAKE]', style: '[FAKE]', excludeStyles: [], lyrics: '[FAKE] rewritten lyrics', rulesApplied: refs.slice(0, 1).map((ref) => ({ ref, how: '[FAKE]' })), ungroundedChoices: [] }
      : undefined) });
    const r = await run(depsWith(model), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [ids.lyrics] });
    expect(r.error).toMatch(/violates schema x3lius\.suno-prompt-llm\/v1: \$\.lyrics is not allowed/);
  });

  it('enforces a length limit only when a canonical claim states it, for the Suno model it is scoped to', async () => {
    await promoteSunoFixture('fixture-phase-09-suno-style-limit', 'Suno v5 accepts at most 12 characters of style (FIXTURE value).', { topic: 'suno.limit.style-chars', value: 12, modelTag: 'suno-v5' });
    const v5 = await run(depsWith(fakeModel()), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [ids.lyrics] });
    expect(v5.error).toMatch(/style is 19 chars; canonical limit 12 \(canonical_prompts:[0-9a-f-]+#suno\.limit\.style-chars\)/);
    const model45 = fakeModel();
    const v45 = await run(depsWith(model45), 'x3lius-suno', { request: REQUEST, sunoModel: 'v4.5', lyricsArtifactIds: [ids.lyrics] });
    expect(v45.status, v45.error).toBe('success');
    expect(out(v45).body.limits).toEqual([]);
    // Rules and claims tagged for another Suno version never reach a v4.5 prompt.
    expect(model45.calls[0]!.system).not.toContain(SUNO_RULE);
    expect(model45.calls[0]!.system).not.toContain('suno.limit.style-chars');
    expect((out(v45) as unknown as { knowledge: { reasons: string[] } }).knowledge.reasons.join('\n')).toMatch(/excluded 3 canonical entries scoped to another Suno version/);
  });
});

describe('whole-song lyrics (x3lius.lyrics/v2): written against the song structure in one call', () => {
  /** A FAKE lyrics reply built from the default one, with `edit` applied to its sections. */
  const lyricsReply = (edit: (b: { sections: Record<string, unknown>[]; instrumental: string[] }) => void) => fakeModel({
    override: (schema, refs) => {
      if (!('instrumental' in (schema.properties as object))) return undefined;
      const b = fakeBody(schema, refs.slice(0, 1)) as { sections: Record<string, unknown>[]; instrumental: string[] };
      edit(b);
      return b;
    },
  });
  const withStructure = { request: REQUEST, structureArtifactId: '' };
  beforeAll(() => {
    withStructure.structureArtifactId = ids.structure;
  });

  it('reads the structure artifact, writes every section in its order, and records the structure it followed', async () => {
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    const o = out(r);
    expect(o.artifact.schemaId).toBe('x3lius.lyrics/v2');
    const body = o.body as unknown as LyricsV2;
    expect(body.sections.map((x) => x.sectionId)).toEqual(['v1', 'c1']);
    expect(body.sources).toEqual([{ role: 'structure', artifactId: ids.structure, schemaId: 'x3lius.song-structure/v1', version: 1 }]);
    // The model saw the structure, including its selected hook, and was not asked to supply `sources`.
    expect(model.calls[0]!.user).toContain(`SONG STRUCTURE (artifact ${ids.structure} v1)`);
    expect(model.calls[0]!.user).toContain('[FAKE] hook a');
    expect(Object.keys(model.calls[0]!.schema.properties as object)).not.toContain('sources');
  });

  it('a section with no vocals may be listed as instrumental instead', async () => {
    const r = await run(depsWith(lyricsReply((b) => {
      b.sections = b.sections.slice(0, 1);
      b.instrumental = ['c1'];
    })), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    expect((out(r).body as unknown as LyricsV2).instrumental).toEqual(['c1']);
  });

  it.each([
    ['a structure section left out', (b: { sections: Record<string, unknown>[] }) => { b.sections = b.sections.slice(0, 1); }, /structure section c1 has no lyrics and is not listed as instrumental/],
    ['a section the structure does not have', (b: { sections: Record<string, unknown>[] }) => { b.sections[1]!.sectionId = 'x9'; }, /section x9 is not in the structure \(v1, c1\)/],
    ['sections out of order', (b: { sections: Record<string, unknown>[] }) => { b.sections.reverse(); }, /sections are out of structure order: got c1, v1; expected v1, c1/],
    ['a kind that contradicts the structure', (b: { sections: Record<string, unknown>[] }) => { b.sections[1]!.kind = 'verse'; }, /section c1 is verse; the structure says chorus/],
    ['a section id used twice', (b: { sections: Record<string, unknown>[]; instrumental: string[] }) => { b.instrumental = ['v1']; }, /section id v1 appears more than once/],
    ['a section with no bars', (b: { sections: Record<string, unknown>[] }) => { b.sections[0]!.bars = []; }, /section v1 has no bars/],
    ['bars numbered out of order', (b: { sections: Record<string, unknown>[] }) => { (b.sections[1]!.bars as { n: number }[])[0]!.n = 9; }, /section c1: bars\[\]\.n must count 1, 2, 3/],
  ])('refuses %s; nothing is written', async (_, edit, error) => {
    const r = await run(depsWith(lyricsReply(edit)), 'x3lius-lyrics', withStructure);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(error);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('refuses a structureArtifactId that is not a song-structure artifact, or not a string', async () => {
    const deps = depsWith(fakeModel());
    expect((await run(deps, 'x3lius-lyrics', { request: REQUEST, structureArtifactId: ids.genre })).error).toMatch(/is x3lius\.genre-style\/v1, expected x3lius\.song-structure\/v1/);
    expect((await run(deps, 'x3lius-lyrics', { request: REQUEST, structureArtifactId: 7 })).error).toMatch(/structureArtifactId must be an artifact id/);
  });

  it('the formula still renders a pre-v2 (x3lius.lyrics/v1) artifact', async () => {
    const legacy = await insertLegacyLyrics(['[FIXTURE] legacy bar one', '[FIXTURE] legacy bar two']);
    const r = await run(depsWith(fakeModel()), 'x3lius-suno', { request: REQUEST, sunoModel: 'v4.5', lyricsArtifactIds: [legacy] });
    expect(r.status, r.error).toBe('success');
    expect(out(r).body.lyrics).toBe('[Verse 1]\n[FIXTURE] legacy bar one\n[FIXTURE] legacy bar two');
  });
});

describe('mixed-script words are refused before any artifact is written', () => {
  it('a lyrics reply with a word mixing Latin and Cyrillic letters (seen live: "Пeak") is refused', async () => {
    const model = fakeModel({ override: (schema, refs) => {
      if (!('instrumental' in (schema.properties as object))) return undefined;
      const b = fakeBody(schema, refs.slice(0, 1)) as { sections: { bars: { text: string }[] }[] };
      b.sections[0]!.bars[0]!.text = 'Пeak слънцето никога не се връща';
      return b;
    } });
    const r = await run(depsWith(model), 'x3lius-lyrics', { request: REQUEST });
    expect(r.error).toMatch(/mixed-script word "Пeak" at \$\.sections\[0\]\.bars\[0\]\.text/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('a genre/style reply carrying one (seen live: "phonк") is refused', async () => {
    const model = fakeModel({ override: (schema, refs) => ('primaryGenre' in (schema.properties as object) ? { ...fakeBody(schema, refs.slice(0, 1)), subgenres: ['industrial trap', 'phonк'] } : undefined) });
    const r = await run(depsWith(model), 'x3lius-genre-style', { request: REQUEST });
    expect(r.error).toMatch(/mixed-script word "phonк" at \$\.subgenres\[1\]/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('an older lyrics artifact carrying one cannot reach a Suno prompt: the rendered lyrics are checked too', async () => {
    const legacy = await insertLegacyLyrics(['Пeak слънцето никога не се връща']);
    const r = await run(depsWith(fakeModel()), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [legacy] });
    expect(r.error).toMatch(/mixed-script word "Пeak" at \$\.lyrics/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });
});

describe('the Suno Execution agent (suno-submitter)', () => {
  let manualSubmission: string;

  it('manual: records the exact prompt from the formula artifact, and logs it in full to agent_runs', async () => {
    const r = await run(depsWith(fakeModel()), 'suno-submitter', { submit: { formulaArtifactId: ids.formula, adapter: 'manual' } });
    expect(r.status, r.error).toBe('success');
    const o = r.output as { submissionId: string; adapter: string; status: string };
    expect(o).toMatchObject({ adapter: 'manual', status: 'awaiting-takes' });
    manualSubmission = o.submissionId;

    const [a] = await db.sql<{ body: Record<string, unknown> }[]>`select body from creative_artifacts where id = ${ids.formula}`;
    const [s] = await db.sql<{ prompt: unknown; suno_model: string; provider_task_id: string | null }[]>`select prompt, suno_model, provider_task_id from suno_submissions where id = ${manualSubmission}`;
    expect(s).toEqual({ prompt: { title: a!.body.title, style: a!.body.style, excludeStyles: a!.body.excludeStyles, lyrics: a!.body.lyrics }, suno_model: 'v5', provider_task_id: null });

    const [row] = await db.sql<{ output: { logs: { message: string }[] } }[]>`select output from agent_runs where id = ${r.runId}`;
    // The full prompt is on the run log, parseable and equal to what was recorded (jsonb reorders keys, so compare parsed).
    const line = row!.output.logs.map((l) => l.message).find((m) => m.startsWith('submit_suno prompt (manual, v5): '))!;
    expect(JSON.parse(line.slice('submit_suno prompt (manual, v5): '.length))).toEqual(s!.prompt);
  });

  it('the operation must be fully specified: no adapter, a wrong artifact, or both modes at once are refused', async () => {
    const deps = depsWith(fakeModel());
    expect((await run(deps, 'suno-submitter', { submit: { formulaArtifactId: ids.formula } })).error).toMatch(/adapter must be one of manual, sunoapi/);
    expect((await run(deps, 'suno-submitter', { submit: { formulaArtifactId: ids.lyrics, adapter: 'manual' } })).error).toMatch(/expects a x3lius\.suno-prompt\/v1 artifact, got x3lius\.lyrics\/v2/);
    expect((await run(deps, 'suno-submitter', { submit: { formulaArtifactId: ids.formula, adapter: 'manual' }, capture: { submissionId: 'x' } })).error).toMatch(/exactly one of submit, capture/);
  });

  it('manual capture: the operator’s takes are recorded and each gets a STUB score row (no number)', async () => {
    const takes = [{ audioUrl: 'https://cdn1.suno.ai/fixture-a.mp3', title: '[FIXTURE] take a' }, { audioUrl: 'https://cdn1.suno.ai/fixture-b.mp3', durationSeconds: 170 }];
    const r = await run(depsWith(fakeModel()), 'suno-submitter', { capture: { submissionId: manualSubmission, takes } });
    expect(r.status, r.error).toBe('success');
    expect(r.output).toMatchObject({ status: 'captured', inserted: 2, alreadyCaptured: 0, scoring: { status: 'stub', scorer: STUB_SCORER } });
    const scores = await db.sql<{ scorer: string; is_stub: boolean; score: number | null; detail: { note: string } }[]>`
      select ts.scorer, ts.is_stub, ts.score, ts.detail from take_scores ts join suno_takes t on t.id = ts.take_id where t.submission_id = ${manualSubmission}`;
    expect(scores).toHaveLength(2);
    for (const s of scores) {
      expect(s).toMatchObject({ scorer: STUB_SCORER, is_stub: true, score: null });
      expect(s.detail.note).toMatch(/^STUB/);
    }
  });

  it('capturing the same takes again writes nothing new', async () => {
    const r = await run(depsWith(fakeModel()), 'suno-submitter', { capture: { submissionId: manualSubmission, takes: [{ audioUrl: 'https://cdn1.suno.ai/fixture-a.mp3' }] } });
    expect(r.output).toMatchObject({ status: 'captured', inserted: 0, alreadyCaptured: 1 });
    const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from take_scores ts join suno_takes t on t.id = ts.take_id where t.submission_id = ${manualSubmission}`;
    expect(n!.n).toBe(2);
  });

  it('sunoapi (FAKE Suno): submit records the provider task; capture polls — pending first, then takes + stub scores', async () => {
    const suno = fakeSuno([
      { code: 200, msg: 'success', data: { taskId: 'task-xyz' } },
      { code: 200, msg: 'success', data: { taskId: 'task-xyz', status: 'PENDING', response: null } },
      { code: 200, msg: 'success', data: { taskId: 'task-xyz', status: 'SUCCESS', response: { sunoData: [
        { id: 'clip-1', audio_url: 'https://cdn.example.org/clip-1.mp3', title: '[FAKE]', duration: 180.5 },
        { id: 'clip-2', audio_url: 'https://cdn.example.org/clip-2.mp3', title: '[FAKE]', duration: 175 },
      ] } } },
    ]);
    const deps = depsWith(fakeModel(), { env: SUNO_ENV, fetch: suno.fn });
    const sub = await run(deps, 'suno-submitter', { submit: { formulaArtifactId: ids.formula, adapter: 'sunoapi' } });
    expect(sub.status, sub.error).toBe('success');
    const submissionId = (sub.output as { submissionId: string }).submissionId;
    const [s] = await db.sql<{ provider_task_id: string }[]>`select provider_task_id from suno_submissions where id = ${submissionId}`;
    expect(s!.provider_task_id).toBe('task-xyz');
    expect((suno.calls[0]!.body as { model: string }).model).toBe('V5');

    expect((await run(deps, 'suno-submitter', { capture: { submissionId } })).output).toMatchObject({ status: 'pending', inserted: 0 });
    expect((await run(deps, 'suno-submitter', { capture: { submissionId } })).output).toMatchObject({ status: 'captured', inserted: 2, scoring: { status: 'stub' } });
    const takes = await db.sql<{ provider_take_id: string; duration_seconds: string }[]>`select provider_take_id, duration_seconds::text from suno_takes where submission_id = ${submissionId} order by provider_take_id`;
    expect(takes.map((t) => t.provider_take_id)).toEqual(['clip-1', 'clip-2']);
  });

  it('a provider rejection still leaves the full prompt on agent_runs, and no submission row', async () => {
    const before = await db.sql<{ n: number }[]>`select count(*)::int as n from suno_submissions`;
    const deps = depsWith(fakeModel(), { env: SUNO_ENV, fetch: fakeSuno([{ code: 429, msg: 'insufficient credits', data: null }]).fn });
    const r = await run(deps, 'suno-submitter', { submit: { formulaArtifactId: ids.formula, adapter: 'sunoapi' } });
    expect(r.error).toMatch(/sunoapi error 429: insufficient credits/);
    const [row] = await db.sql<{ output: { logs: { message: string }[] } }[]>`select output from agent_runs where id = ${r.runId}`;
    expect(row!.output.logs.map((l) => l.message).join('\n')).toMatch(/submit_suno prompt \(sunoapi, v5\): \{"title":/);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from suno_submissions`)[0]!.n).toBe(before[0]!.n);
  });
});

describe('end to end: one workflow from a brief to a Suno-ready prompt (FAKE model)', () => {
  it(`${SONG_TO_SUNO_WORKFLOW}: songwriting + lyrics + genre/style → formula, each artifact feeding the next`, async () => {
    const wf = loadWorkflow(join(REPO_ROOT, SONG_TO_SUNO_WORKFLOW), registry);
    const r = await runWorkflow(depsWith(fakeModel()), wf, { request: REQUEST, sunoModel: 'v4.5' }, { timeoutMs: 60_000 });
    expect(r.status, r.error).toBe('success');
    const o = r.output as Out;
    expect(o.artifact.schemaId).toBe('x3lius.suno-prompt/v1');
    const steps = await db.sql<{ step_id: string; agent_name: string; output: { result: { artifact: { id: string } } } }[]>`
      select step_id, agent_name, output from agent_runs where workflow_run_id = ${r.workflowRunId} order by created_at`;
    expect(steps.map((s) => s.agent_name)).toEqual(['x3lius-songwriting', 'x3lius-lyrics', 'x3lius-genre-style', 'x3lius-suno']);
    const byStep = Object.fromEntries(steps.map((s) => [s.step_id, s.output.result.artifact.id]));
    // Lyrics are written against the structure the songwriting step produced.
    const [lyricsStep] = await db.sql<{ input: { structureArtifactId: string } }[]>`select input from agent_runs where workflow_run_id = ${r.workflowRunId} and step_id = 'lyrics'`;
    expect(lyricsStep!.input.structureArtifactId).toBe(byStep.structure);
    expect((o.body.sources as { role: string; artifactId: string }[]).map((s) => [s.role, s.artifactId])).toEqual([
      ['lyrics', byStep.lyrics], ['structure', byStep.structure], ['genre-style', byStep.genre],
    ]);
  });
});
