import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { BUILT_SUBDOMAINS, HANDLERS } from '../../core/runtime/handlers.ts';
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
import { sectionLabels } from '../../records/x3lius/creative/lyrics.ts';
import { renderLyrics, SONG_TO_SUNO_WORKFLOW } from '../../records/x3lius/suno/formula.ts';
import { subdomainStub } from '../../records/x3lius/subdomain-stub.ts';
import { STUB_SCORER } from '../../records/x3lius/suno/score-hook.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, FAKE_USAGE, fakeBody, fakeModel } from '../helpers/fake-llm.ts';

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
type LyricsV2 = { sections: { sectionId: string; kind: string; label: string; bars: { text: string }[]; directions: string[] }[]; instrumental: string[]; sources: unknown[] };
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
    const stubs = loadMusicSystem().subdomains.map((s) => s.slug).filter((s) => !BUILT_SUBDOMAINS.includes(s));
    // Phase 11 built Arrangement, Production and Mix/Master (tests/phase-11); Evaluation is Phase 12's.
    expect(stubs.sort()).toEqual(['x3lius-evaluation']);
    for (const s of stubs) expect(HANDLERS[s]).toBe(subdomainStub);
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
    expect((out(v45) as unknown as { knowledge: { reasons: string[] } }).knowledge.reasons.join('\n')).toMatch(/excluded 3 canonical entries scoped to another model or tool/);
  });
});

describe('whole-song lyrics (x3lius.lyrics/v2): one model call per structure section, one artifact', () => {
  type SectionReply = { instrumental: boolean; bars: { n: number; text: string }[]; devices: { bar: number; device: string; note: string }[]; directions: string[] };
  /** A FAKE model whose per-section reply for section `id` gets `edit` applied. */
  const sectionReply = (id: string, edit: (b: SectionReply) => void) => fakeModel({
    override: (schema, refs, user) => {
      if (!('bars' in (schema.properties as object)) || !user.includes(`WRITE NOW: section ${id} (`)) return undefined;
      const b = fakeBody(schema, refs.slice(0, 1), user) as unknown as SectionReply;
      edit(b);
      return b;
    },
  });
  const withStructure = { request: REQUEST, structureArtifactId: '' };
  beforeAll(() => {
    withStructure.structureArtifactId = ids.structure;
  });

  it('writes each structure section in its own call, in order, each seeing what was written before it', async () => {
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    const o = out(r);
    expect(o.artifact.schemaId).toBe('x3lius.lyrics/v2');

    // The fake structure has two sections (v1 verse, c1 chorus): two calls, each on the per-section schema.
    expect(model.calls).toHaveLength(2);
    // No label: code derives it from the structure, so a section id can never reach Suno as a tag.
    for (const c of model.calls) expect(Object.keys(c.schema.properties as object).sort()).toEqual(['bars', 'devices', 'directions', 'instrumental', 'rhymeScheme', 'rulesApplied', 'ungroundedChoices']);
    expect(model.calls[0]!.user).toContain('WRITE NOW: section v1 (verse, 16 bars)');
    expect(model.calls[1]!.user).toContain('WRITE NOW: section c1 (chorus, 8 bars)');
    // Every call carries the structure (with its selected hook); the second also carries the first section's words.
    for (const c of model.calls) {
      expect(c.user).toContain(`SONG STRUCTURE (artifact ${ids.structure} v1)`);
      expect(c.user).toContain('[FAKE] hook a');
    }
    expect(model.calls[0]!.user).toContain('LYRICS WRITTEN SO FAR\n(none yet: this is the first section)');
    expect(model.calls[1]!.user).toContain('[FAKE] v1 bar 4');

    // Ids and kinds come from the structure, not the model; one trace entry per call, prefixed with its section.
    const body = o.body as unknown as LyricsV2 & { rulesApplied: { ref: string; how: string }[]; ungroundedChoices: string[] };
    expect(body.sections.map((x) => [x.sectionId, x.kind, x.label])).toEqual([['v1', 'verse', 'Verse 1'], ['c1', 'chorus', 'Chorus']]);
    expect(body.instrumental).toEqual([]);
    expect(body.sources).toEqual([{ role: 'structure', artifactId: ids.structure, schemaId: 'x3lius.song-structure/v1', version: 1 }]);
    expect(body.rulesApplied.map((x) => x.how.slice(0, 5))).toEqual(['[v1] ', '[c1] ']);
    expect(body.ungroundedChoices.every((u) => /^\[(v1|c1)\] /.test(u))).toBe(true);

    // Usage adds up across calls; the run log shows each section as it lands.
    const [row] = await db.sql<{ tokens_used: number; output: { logs: { message: string }[] } }[]>`select tokens_used, output from agent_runs where id = ${r.runId}`;
    expect(row!.tokens_used).toBe(2 * (FAKE_USAGE.input + FAKE_USAGE.output));
    const logs = row!.output.logs.map((l) => l.message);
    expect(logs).toContainEqual(expect.stringMatching(/^x3lius-lyrics: section v1 \(verse\) 1\/2: 4 bars in \d+ms$/));
    expect(logs).toContainEqual(expect.stringMatching(/^x3lius-lyrics: section c1 \(chorus\) 2\/2: 4 bars in \d+ms$/));
  });

  it('a section the model marks instrumental is listed as such, and later calls are told so', async () => {
    const model = sectionReply('v1', (b) => {
      b.instrumental = true;
      b.bars = [];
    });
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    const body = out(r).body as unknown as LyricsV2;
    expect(body.sections.map((x) => x.sectionId)).toEqual(['c1']);
    expect(body.instrumental).toEqual(['v1']);
    expect(model.calls[1]!.user).toContain('(v1, verse: instrumental)');
  });

  it.each([
    ['a section marked instrumental that still has bars', (b: SectionReply) => { b.instrumental = true; }, /section c1: marked instrumental but has 4 bars/],
    ['a sung section with no bars', (b: SectionReply) => { b.bars = []; }, /section c1 has no bars/],
    ['bars numbered out of order', (b: SectionReply) => { b.bars[0]!.n = 9; }, /section c1: bars\[\]\.n must count 1, 2, 3/],
    ['a reply off the per-section schema', (b: SectionReply) => { (b as unknown as Record<string, unknown>).sections = []; }, /section c1: .*violates schema x3lius\.lyrics-section-llm\/v2: \$\.sections is not allowed/],
  ])('refuses %s, naming the section; nothing is written', async (_, edit, error) => {
    const r = await run(depsWith(sectionReply('c1', edit)), 'x3lius-lyrics', withStructure);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(error);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  /** A FAKE model whose first `times` replies for section `id` get `edit`; later replies are clean. */
  const firstReplies = (id: string, times: number, edit: (b: SectionReply) => void) => {
    let n = 0;
    return fakeModel({
      override: (schema, refs, user) => {
        if (!('bars' in (schema.properties as object)) || !user.includes(`WRITE NOW: section ${id} (`)) return undefined;
        const b = fakeBody(schema, refs.slice(0, 1), user) as unknown as SectionReply;
        if (n++ < times) edit(b);
        return b;
      },
    });
  };

  it.each([
    ['a lyric line (seen live: "горниotope")', (b: SectionReply) => { b.bars[2]!.text = 'горниotope над града'; }, '"горниotope" (bar 3)'],
  ])('a mixed-script word in %s gets that section re-asked once with the words named; the fixed reply is kept', async (_, edit, named) => {
    const model = firstReplies('c1', 1, edit);
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    // v1, c1, then c1 again with a CORRECTION naming the word and showing the previous lines.
    expect(model.calls).toHaveLength(3);
    const retry = model.calls[2]!.user;
    expect(retry).toContain('WRITE NOW: section c1 (chorus, 8 bars)');
    expect(retry).toContain(`CORRECTION\nYour previous reply for section c1 mixed Latin and Cyrillic letters inside a word: ${named}.`);
    expect(retry).toContain('[FAKE] c1 bar 1');
    const body = out(r).body as unknown as LyricsV2;
    expect(body.sections[1]!.bars.map((b) => b.text)).toEqual([1, 2, 3, 4].map((n) => `[FAKE] c1 bar ${n}`));
    expect(body.sections[1]!.label).toBe('Chorus');
    const [row] = await db.sql<{ tokens_used: number; output: { logs: { level: string; message: string }[] } }[]>`select tokens_used, output from agent_runs where id = ${r.runId}`;
    expect(row!.tokens_used).toBe(3 * (FAKE_USAGE.input + FAKE_USAGE.output));
    expect(row!.output.logs).toContainEqual(expect.objectContaining({ level: 'warn', message: `x3lius-lyrics: section c1: mixed-script word ${named}; asking once for a corrected section` }));
  });

  it('still mixed after the one correction: the run fails naming the section and the word; nothing is written', async () => {
    const model = firstReplies('c1', 2, (b) => { b.bars[0]!.text = 'Пeak слънцето'; });
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/section c1: mixed-script word "Пeak" \(bar 1\) is still there after one correction/);
    expect(model.calls).toHaveLength(3);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('a mixed-script word outside Suno text (a device note) is no reason to re-ask: one call per section, written with a warning', async () => {
    const model = firstReplies('v1', 1, (b) => { b.devices = [{ bar: 1, device: 'loanword', note: 'French loan Лieux' }]; });
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    expect(model.calls).toHaveLength(2);
    expect((r.output as { warnings: unknown[] }).warnings).toEqual([{ kind: 'mixed-script', word: 'Лieux', path: '$.sections[0].devices[0].note' }]);
  });

  it('every creative prompt asks for one alphabet per word', async () => {
    for (const agent of ['x3lius-songwriting', 'x3lius-lyrics', 'x3lius-genre-style']) {
      const model = fakeModel();
      await run(depsWith(model), agent, { request: REQUEST });
      expect(model.calls[0]!.system).toContain('Write every word in a single alphabet: never mix Latin and Cyrillic letters inside one word.');
    }
  });

  it('refuses a structureArtifactId that is not a song-structure artifact, or not a string', async () => {
    const deps = depsWith(fakeModel());
    expect((await run(deps, 'x3lius-lyrics', { request: REQUEST, structureArtifactId: ids.genre })).error).toMatch(/is x3lius\.genre-style\/v1, expected x3lius\.song-structure\/v1/);
    expect((await run(deps, 'x3lius-lyrics', { request: REQUEST, structureArtifactId: 7 })).error).toMatch(/structureArtifactId must be an artifact id/);
  });

  it('a bare brief (no structure) is still one call writing the sections it asks for; labels still come from code', async () => {
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics', { request: REQUEST });
    expect(r.status, r.error).toBe('success');
    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!.schema.properties as object)).toContain('sections');
    const body = out(r).body as unknown as LyricsV2;
    expect(body.sources).toEqual([]);
    expect(body.sections.map((x) => x.label)).toEqual(['Verse 1', 'Chorus']);
  });

  it('section labels (the Suno [tags]) come from the section kinds: verses numbered in order, every other kind by name', () => {
    // The live structure from proof §7 (whose labels reached Suno as [v1], [pre1], [outro] when the model wrote them).
    expect(sectionLabels(['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus', 'bridge', 'chorus', 'outro'])).toEqual(
      ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Chorus', 'Outro'],
    );
    expect(sectionLabels(['hook', 'post-chorus', 'breakdown', 'verse'])).toEqual(['Hook', 'Post-Chorus', 'Breakdown', 'Verse 1']);
  });

  it('stage directions go in directions: kept on the artifact, never in the lyrics Suno sings', async () => {
    // Seen live (proof §7): the outro's "Synth decays... concrete breath fades" was written as a sung line.
    const model = firstReplies('c1', 1, (b) => { b.directions = ['[FAKE] synth decays, city ambience swallows the mix']; });
    const r = await run(depsWith(model), 'x3lius-lyrics', withStructure);
    expect(r.status, r.error).toBe('success');
    expect(model.calls[0]!.system).toContain('bars hold only the words that are sung or spoken');
    const body = out(r).body as unknown as LyricsV2;
    expect(body.sections.map((x) => x.directions)).toEqual([[], ['[FAKE] synth decays, city ambience swallows the mix']]);
    // v4.5: an earlier test promotes a [FIXTURE] 12-char style limit for v5.
    const suno = await run(depsWith(fakeModel()), 'x3lius-suno', { request: REQUEST, sunoModel: 'v4.5', lyricsArtifactIds: [out(r).artifact.id] });
    expect(suno.status, suno.error).toBe('success');
    expect(out(suno).body.lyrics).not.toContain('synth decays');
    expect(out(suno).body.lyrics).toBe(`[Verse 1]\n${body.sections[0]!.bars.map((b) => b.text).join('\n')}\n\n[Chorus]\n${body.sections[1]!.bars.map((b) => b.text).join('\n')}`);
  });

  it('the formula still renders a pre-v2 (x3lius.lyrics/v1) artifact', async () => {
    const legacy = await insertLegacyLyrics(['[FIXTURE] legacy bar one', '[FIXTURE] legacy bar two']);
    const r = await run(depsWith(fakeModel()), 'x3lius-suno', { request: REQUEST, sunoModel: 'v4.5', lyricsArtifactIds: [legacy] });
    expect(r.status, r.error).toBe('success');
    expect(out(r).body.lyrics).toBe('[Verse 1]\n[FIXTURE] legacy bar one\n[FIXTURE] legacy bar two');
  });
});

describe('mixed-script words: refused in text Suno receives, a warning on the artifact anywhere else', () => {
  /** A FAKE model whose reply for the schema carrying `marker` gets `edit` applied. */
  const editing = (marker: string, edit: (b: Record<string, unknown>) => void) => fakeModel({
    override: (schema, refs) => {
      if (!(marker in (schema.properties as object))) return undefined;
      const b = fakeBody(schema, refs.slice(0, 1));
      edit(b);
      return b;
    },
  });
  type Section = { bars: { text: string }[]; devices: { bar: number; device: string; note: string }[] };

  it.each([
    ['a lyric bar (seen live: "Пeak")', (b: Record<string, unknown>) => { (b.sections as Section[])[0]!.bars[0]!.text = 'Пeak слънцето никога не се връща'; }, 'Пeak', '$.sections[0].bars[0].text'],
  ])('lyrics: refused in %s; nothing is written', async (_, edit, word, path) => {
    const r = await run(depsWith(editing('instrumental', edit)), 'x3lius-lyrics', { request: REQUEST });
    expect(r.error).toContain(`mixed-script word "${word}" at ${path}`);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('lyrics: in a device note (seen live: "Лieux") it is written, with the word recorded as a warning', async () => {
    const r = await run(depsWith(editing('instrumental', (b) => {
      (b.sections as Section[])[0]!.devices = [{ bar: 1, device: 'loanword', note: 'French loan Лieux opens the verse' }];
    })), 'x3lius-lyrics', { request: REQUEST });
    expect(r.status, r.error).toBe('success');
    const warning = { kind: 'mixed-script', word: 'Лieux', path: '$.sections[0].devices[0].note' };
    expect((r.output as { warnings: unknown[] }).warnings).toEqual([warning]);
    const [a] = await db.sql<{ warnings: unknown[] }[]>`select warnings from creative_artifacts where agent_run_id = ${r.runId}`;
    expect(a!.warnings).toEqual([warning]);
    const [row] = await db.sql<{ output: { logs: { level: string; message: string }[] } }[]>`select output from agent_runs where id = ${r.runId}`;
    expect(row!.output.logs).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringContaining('mixed-script word "Лieux" at $.sections[0].devices[0].note') }));
  });

  it('genre/style: nothing in it reaches Suno verbatim (seen live: "phonк"), so it is a warning', async () => {
    const r = await run(depsWith(editing('primaryGenre', (b) => { b.subgenres = ['industrial trap', 'phonк']; })), 'x3lius-genre-style', { request: REQUEST });
    expect(r.status, r.error).toBe('success');
    expect((r.output as { warnings: unknown[] }).warnings).toEqual([{ kind: 'mixed-script', word: 'phonк', path: '$.subgenres[1]' }]);
  });

  it('a clean artifact carries no warnings', async () => {
    const r = await run(depsWith(fakeModel()), 'x3lius-genre-style', { request: REQUEST });
    expect((r.output as { warnings: unknown[] }).warnings).toEqual([]);
    const [a] = await db.sql<{ warnings: unknown[] }[]>`select warnings from creative_artifacts where agent_run_id = ${r.runId}`;
    expect(a!.warnings).toEqual([]);
  });

  it('formula: refused in the style it writes; nothing is written', async () => {
    const r = await run(depsWith(editing('excludeStyles', (b) => { b.style = 'dark phonк trap'; })), 'x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [ids.lyrics] });
    expect(r.error).toContain('mixed-script word "phonк" at $.style');
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('formula: an older lyrics artifact carrying one cannot reach a Suno prompt (the rendered lyrics are checked)', async () => {
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
