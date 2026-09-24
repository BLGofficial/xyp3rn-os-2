import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createContextEngine, type ContextEngine } from '../../core/context-engine/context-engine.ts';
import { parseModelRef, PROVIDERS } from '../../core/llm/providers.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { parseScope } from '../../core/orchestrator/scope-select.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { decideApproval, runGate } from '../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { asRole } from '../../research-intelligence/db.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import { CREATIVE_SUBDOMAINS, MIN_SCOPED_RULES } from '../../records/x3lius/creative/program.ts';
import { runMusicSystem } from '../../records/x3lius/entrypoint.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 8: Songwriting, Lyrics and (F15) Composition become Creative agents. What is proven here,
// against a throwaway DB holding the real ingested guide + X3LIUS manifest:
// - the voice reaches the model only from canonical knowledge (the guide's voice claim, and rules
//   the gate promoted into the sub-domain), and no agent source file carries it;
// - output is a schema-validated JSON artifact, written insert-only with the refs it was built from;
// - sparse knowledge is flagged in the artifact, never papered over.
//
// FAKE MODEL: no provider key exists in this container. Every LLM call goes through the real
// runner and transport into a FAKE fetch that returns a schema-shaped reply prefixed "[FAKE]" and
// cites the first rule ref it was given. It proves the wiring, not the writing: the real verse is
// the keyed-session proof (docs/handoffs/PHASE-08.md).
//
// FIXTURE: one synthetic rule, marked [FIXTURE] in every field, promoted through the real gate
// into x3lius-lyrics — only in this throwaway database, never the dev DB (Phase 7 precedent).

const FIXTURE_SLUG = 'fixture-phase-08-lyrics-rule';
const FIXTURE_NOTE = 'End every second bar of an X3LIUS verse on an internal half-rhyme.';
const REQUEST = 'Write the first verse for an X3LIUS track about the city at night';
const USAGE = { input: 100, output: 20 };
const REF = /\[(canonical_prompts:[0-9a-f-]{36}(?:#[a-z0-9.-]+)?)\]/g;

let db: TestDb;
let embedder: Embedder;
let engine: ContextEngine;
let researchRunId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

type Json = Record<string, unknown>;
type FakeCall = { url: string; system: string; user: string; schema: Json };

/** A schema-valid [FAKE] body for whichever creative schema the request carries. */
const fakeBody = (schema: Json, cited: readonly string[]): Json => {
  const props = (schema.properties ?? {}) as Json;
  const common = { rulesApplied: cited.map((ref) => ({ ref, how: '[FAKE] cited to exercise traceability' })), ungroundedChoices: ['[FAKE] everything not covered by a cited rule'] };
  if ('instrumental' in props) {
    return {
      sections: [{
        sectionId: 'v1', kind: 'verse', rhymeScheme: 'ABAB', devices: [{ bar: 2, device: '[FAKE] half-rhyme', note: '[FAKE]' }], directions: [],
        bars: [1, 2, 3, 4].map((n) => ({ n, text: `[FAKE] bar ${n}`, language: 'en', rhymeTag: n % 2 ? 'A' : 'B' })),
      }],
      instrumental: [], ...common,
    };
  }
  if ('sections' in props) {
    return {
      title: '[FAKE] Title', theme: { statement: '[FAKE] theme', perspective: 'first person' },
      sections: [{ id: 'v1', kind: 'verse', bars: 16, purpose: '[FAKE]' }, { id: 'c1', kind: 'chorus', bars: 8, purpose: '[FAKE]' }],
      hook: { candidates: [{ text: '[FAKE] hook a', language: 'en', rationale: '[FAKE]' }, { text: '[FAKE] hook b', language: 'mixed', rationale: '[FAKE]' }], selectedIndex: 1, selectionReason: '[FAKE]' },
      ...common,
    };
  }
  if ('progressions' in props) {
    return {
      key: { tonic: 'C#', mode: 'minor' }, tempoBpm: 140, timeSignature: '4/4',
      progressions: [{ section: 'verse', chords: ['C#m', 'A', 'E', 'B'], barsPerChord: 2 }],
      melody: { range: '[FAKE] A3–E5', contour: '[FAKE] descending', motif: '[FAKE] 3-note cell' }, ...common,
    };
  }
  throw new Error(`fake model: unknown schema ${JSON.stringify(Object.keys(props))}`);
};

/** FAKE fetch speaking both wire formats. `cite` picks refs from the prompt; `override` replaces the reply. */
const fakeModel = (opts: { cite?: (refs: string[]) => string[]; override?: (schema: Json, refs: string[]) => unknown } = {}) => {
  const calls: FakeCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body)) as Json;
    const anthropic = url.startsWith('https://api.anthropic.com');
    const messages = body.messages as { role: string; content: string }[];
    const call: FakeCall = anthropic
      ? { url, system: body.system as string, user: messages[0]!.content, schema: ((body.output_config as Json).format as Json).schema as Json }
      : { url, system: messages[0]!.content, user: messages[1]!.content, schema: ((body.response_format as Json).json_schema as Json).schema as Json };
    calls.push(call);
    const refs = [...call.system.matchAll(REF)].map((m) => m[1]!);
    const text = JSON.stringify(opts.override ? opts.override(call.schema, refs) : fakeBody(call.schema, (opts.cite ?? ((r) => r.slice(0, 1)))(refs)));
    const payload = anthropic
      ? { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: USAGE.input, output_tokens: USAGE.output } }
      : { id: 'fake', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};

const FAKE_KEYS = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.keyEnv, 'fake-key']));
const depsWith = (model: ReturnType<typeof fakeModel> | null, env: Record<string, string> = FAKE_KEYS): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env, ...(model ? { fetch: model.fn } : {}) }),
});
const run = (deps: DispatchDeps, agent: string, request = REQUEST) => dispatch(deps, agent, { request }, { timeoutMs: 60_000 });

type CreativeOutput = {
  subdomain: string; status: string; artifact: { id: string; version: number; schemaId: string };
  body: Json & { rulesApplied: { ref: string }[] };
  knowledge: { sparse: boolean; threshold: number; scopedRules: number; perModule: Record<string, number>; voiceClaims: number; reasons: string[] };
  context: { kind: string; ref: string; slug: string | null }[];
  model: { ref: string; served: string };
};
const artifactsOf = (runId: string) => db.sql<Json[]>`select * from creative_artifacts where agent_run_id = ${runId}`;
const voiceClaims = () => db.sql<{ canonical_prompt_id: string; topic: string; value: string[] }[]>`
  select canonical_prompt_id, topic, value from canonical_claims where topic like 'x3lius.%'`;

const promoteFixtureRule = async () => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: 'fixture:phase-08/lyrics-rule', title: `[FIXTURE] ${FIXTURE_NOTE}`,
    contentSha256: createHash('sha256').update(`fixture\n${FIXTURE_NOTE}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-08-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${FIXTURE_NOTE}`, model_tag: 'model-agnostic', confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 8 wiring proof — not a real observation' },
    claim_topic: 'fixture.x3lius-lyrics-bar-ending', claim_value: 'internal-half-rhyme',
  });
  const f = await recordFinding(db.sql, {
    researchRunId, claim: `[FIXTURE] ${FIXTURE_NOTE}`, claim_topic: 'fixture.x3lius-lyrics-bar-ending', claim_value: 'internal-half-rhyme', model_tag: 'model-agnostic', evidenceIds: [ev],
  });
  const candidateId = await proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: FIXTURE_SLUG, title: `[FIXTURE] ${FIXTURE_NOTE}`,
    body: `[FIXTURE — synthetic, Phase 8 wiring proof] ${FIXTURE_NOTE}`, domain: 'RECORDS', tags: ['x3lius-lyrics'],
  });
  const pending = await runGate(db.sql, candidateId);
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-08-test', reason: 'Fixture for the wiring proof.' });
  const promoted = await runGate(db.sql, candidateId);
  expect(promoted.outcome).toBe('promoted');
  await embedPending(db.sql, embedder);
  return promoted.canonicalPromptId!;
};

beforeAll(async () => {
  db = await createTestDb('phase08_creative', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  engine = createContextEngine(db.sql, embedder);
  researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-08-fixture', '[FIXTURE] Phase 8 wiring proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${REQUEST}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
});
afterAll(async () => {
  await db?.drop();
});

describe('registry: three Creative agents replace their stubs under the same names', () => {
  const creative = ['x3lius-songwriting', 'x3lius-lyrics', 'x3lius-composition'];

  it('Phase 8 built exactly Songwriting, Lyrics and (F15) Composition (later phases add more)', () => {
    expect(CREATIVE_SUBDOMAINS).toEqual(expect.arrayContaining(creative));
    expect(Object.keys(LLM_PROGRAMS)).toEqual(expect.arrayContaining(creative));
    expect(loadMusicSystem().subdomains.filter((s) => s.builtIn === '8').map((s) => s.slug).sort()).toEqual([...creative].sort());
  });

  it.each(creative.map((c) => [c]))('%s: Creative, RECORDS, LLM-backed, context + artifact tools, routable by its Scope', (name) => {
    const a = registry.get(name)!;
    // Lyrics also reads the song-structure artifact it writes against (whole-song lyrics, x3lius.lyrics/v2).
    const reads = name === 'x3lius-lyrics' ? ['read_artifact'] : [];
    expect(a).toMatchObject({ name, class: 'Creative', domain: 'RECORDS', tools: ['retrieve_context', 'retrieve_claims', ...reads, 'write_artifact', 'log_message'] });
    expect(() => parseModelRef(a.model)).not.toThrow();
    expect(HANDLERS[name]).toBeUndefined();
    expect(() => parseScope(name, a.sections.Scope ?? '')).not.toThrow();
  });

  it('every sub-domain no phase has built yet stays a read-only Knowledge stub; the registry validates', () => {
    const stubs = loadMusicSystem().subdomains.map((s) => s.slug).filter((s) => !CREATIVE_SUBDOMAINS.includes(s));
    expect(stubs.length + CREATIVE_SUBDOMAINS.length).toBe(10);
    for (const s of stubs) expect(registry.get(s)).toMatchObject({ class: 'Knowledge', model: 'none' });
    expect(registry.validateAll()).toEqual([]);
  });

  it('write_artifact is artifact.write: granted to Creative, refused to Knowledge', () => {
    const tools = createRuntimeTools({ sql: db.sql });
    expect(tools.authorize('Creative', 'write_artifact')).toEqual({ allow: true, capability: 'artifact.write' });
    expect(tools.authorize('Knowledge', 'write_artifact')).toMatchObject({ allow: false });
    expect(tools.authorize('Knowledge', 'retrieve_claims')).toEqual({ allow: true, capability: 'context.read' });
  });
});

describe('no hardcoded voice: the descriptors live in canonical knowledge, not in code', () => {
  it('the guide’s voice claim is canonical, and no creative source file carries any of its words', async () => {
    const claims = await voiceClaims();
    expect(claims.map((c) => c.topic)).toEqual(['x3lius.voice-reference']);
    const words = claims.flatMap((c) => c.value.flatMap((v) => v.split(/[^A-Za-z]+/))).filter((w) => w.length >= 7);
    expect(words.length).toBeGreaterThan(3);
    const files = [
      ...readdirSync(join(REPO_ROOT, 'records/x3lius/creative')).map((f) => join(REPO_ROOT, 'records/x3lius/creative', f)),
      ...readdirSync(join(REPO_ROOT, 'core/llm')).map((f) => join(REPO_ROOT, 'core/llm', f)),
      ...['x3lius-songwriting', 'x3lius-lyrics', 'x3lius-composition'].map((n) => join(REPO_ROOT, 'agents', `${n}.agent.md`)),
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8').toLowerCase();
      for (const w of words) expect(text.includes(w.toLowerCase()), `${f} contains voice word "${w}"`).toBe(false);
    }
  });
});

describe('Context Engine: exact claim lookup by topic (retrieve_claims)', () => {
  it('returns the current voice claim with its canonical row and source; nothing for an unknown namespace', async () => {
    const b = await engine.claims('x3lius.');
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ topic: 'x3lius.voice-reference', slug: 'phase-8-meta-prompt', ref: { table: 'canonical_prompts' }, source: { uri: 'XYP3RN_Agentic_OS_Build_Sequence.pdf' } });
    expect((await engine.claims('nobody.')).items).toEqual([]);
  });

  it('refuses a malformed topic prefix', async () => {
    await expect(engine.claims('')).rejects.toThrow(/topic prefix/);
    await expect(engine.claims("x'; drop")).rejects.toThrow(/topic prefix/);
  });
});

describe('x3lius-lyrics end to end (FAKE model, real runner, real context, real artifact table)', () => {
  let fixtureId: string;

  it('sparse knowledge: generates, and the artifact says plainly that the voice is thin', async () => {
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics');
    expect(r.status, r.error).toBe('success');
    const out = r.output as CreativeOutput;
    expect(out).toMatchObject({ subdomain: 'x3lius-lyrics', status: 'generated', artifact: { version: 1, schemaId: 'x3lius.lyrics/v2' } });
    expect(out.knowledge).toMatchObject({ sparse: true, threshold: MIN_SCOPED_RULES, scopedRules: 0, perModule: { 'x3lius-lyrics': 0, 'x3lius-vocal-dna': 0 }, voiceClaims: 1 });
    expect(out.knowledge.reasons.join('\n')).toMatch(/x3lius-lyrics: 0 rules/);

    // The voice reached the model from the canonical claim — every descriptor, with its ref.
    const [claim] = await voiceClaims();
    const prompt = model.calls[0]!.system;
    for (const d of claim!.value) expect(prompt).toContain(d);
    expect(prompt).toContain(`[canonical_prompts:${claim!.canonical_prompt_id}#x3lius.voice-reference]`);
    expect(model.calls[0]!.user).toContain(REQUEST);
    // A bare brief (no structure artifact): the sections the brief asks for, following no structure.
    expect(model.calls[0]!.user).not.toContain('SONG STRUCTURE');
    expect(out.body.sources).toEqual([]);

    const [a] = await artifactsOf(r.runId);
    expect(a).toMatchObject({ id: out.artifact.id, schema_id: 'x3lius.lyrics/v2', agent_name: 'x3lius-lyrics', version: 1, brief: REQUEST, model: registry.get('x3lius-lyrics')!.model });
    expect(a!.body).toEqual(out.body);
    expect(a!.knowledge).toMatchObject({ sparse: true });
    expect((a!.context_refs as { ref: string }[]).map((c) => c.ref)).toEqual(out.context.map((c) => c.ref));
    const [row] = await db.sql<{ tokens_used: number }[]>`select tokens_used from agent_runs where id = ${r.runId}`;
    expect(row!.tokens_used).toBe(USAGE.input + USAGE.output);
  });

  it('a rule the gate promotes into x3lius-lyrics reaches the prompt and the artifact’s refs', async () => {
    fixtureId = await promoteFixtureRule();
    const model = fakeModel();
    const r = await run(depsWith(model), 'x3lius-lyrics');
    expect(r.status, r.error).toBe('success');
    const out = r.output as CreativeOutput;
    expect(model.calls[0]!.system).toContain(FIXTURE_NOTE);
    expect(out.context).toContainEqual(expect.objectContaining({ kind: 'rule', ref: `canonical_prompts:${fixtureId}`, slug: FIXTURE_SLUG }));
    expect(out.knowledge).toMatchObject({ scopedRules: 1, perModule: { 'x3lius-lyrics': 1 }, sparse: 1 < MIN_SCOPED_RULES });
    expect(out.body.rulesApplied.map((x) => x.ref)).toEqual([`canonical_prompts:${fixtureId}`]);
  });

  it('a reply citing a rule it was not given is refused; nothing is written', async () => {
    const r = await run(depsWith(fakeModel({ cite: () => ['canonical_prompts:00000000-0000-0000-0000-000000000000'] })), 'x3lius-lyrics');
    expect(r).toMatchObject({ status: 'error' });
    expect(r.error).toMatch(/cites refs it was not given: canonical_prompts:00000000-0000-0000-0000-000000000000/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('a ref cited with its brackets (as shown in the prompt) is accepted and stored normalized', async () => {
    // Seen live (Nemotron via OpenRouter, 2026-09-24): the model copied "[ref]" including the brackets.
    const r = await run(depsWith(fakeModel({ cite: (refs) => refs.slice(0, 1).map((x) => ` [${x}] `) })), 'x3lius-lyrics');
    expect(r.status, r.error).toBe('success');
    const out = r.output as CreativeOutput;
    expect(out.body.rulesApplied.map((x) => x.ref)).toEqual([`canonical_prompts:${fixtureId}`]);
    const [a] = await artifactsOf(r.runId);
    expect((a!.body as CreativeOutput['body']).rulesApplied.map((x) => x.ref)).toEqual([`canonical_prompts:${fixtureId}`]);
  });

  it('a ref cited by its claim topic or rule slug resolves only when exactly one given entry has it', async () => {
    // Seen live (Nemotron via OpenRouter, 2026-09-24): the model cited "x3lius.voice-reference" instead of the full ref.
    const [claim] = await voiceClaims();
    const r = await run(depsWith(fakeModel({ cite: () => ['x3lius.voice-reference', FIXTURE_SLUG] })), 'x3lius-lyrics');
    expect(r.status, r.error).toBe('success');
    expect((r.output as CreativeOutput).body.rulesApplied.map((x) => x.ref)).toEqual([
      `canonical_prompts:${claim!.canonical_prompt_id}#x3lius.voice-reference`, `canonical_prompts:${fixtureId}`,
    ]);
    for (const alias of ['voice-reference', 'fixture', 'x3lius.']) {
      const bad = await run(depsWith(fakeModel({ cite: () => [alias] })), 'x3lius-lyrics');
      expect(bad.error).toMatch(new RegExp(`cites refs it was not given: ${alias.replace('.', '\\.')}$`));
      expect(await artifactsOf(bad.runId)).toHaveLength(0);
    }
  });

  it('a prose / wrong-shape reply is refused; nothing is written', async () => {
    const r = await run(depsWith(fakeModel({ override: () => ({ verse: 'free text' }) })), 'x3lius-lyrics');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/violates schema x3lius\.lyrics-llm\/v2/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });

  it('no key: the run fails naming the variable, after logging what context it pulled; nothing is written', async () => {
    const { keyEnv } = PROVIDERS[parseModelRef(registry.get('x3lius-lyrics')!.model).provider];
    const r = await run(depsWith(null, {}), 'x3lius-lyrics');
    expect(r.status).toBe('error');
    expect(r.error).toContain(`LLM runner unavailable: ${keyEnv} is not set (agent x3lius-lyrics`);
    const [row] = await db.sql<{ output: { logs: { message: string }[] } }[]>`select output from agent_runs where id = ${r.runId}`;
    expect(row!.output.logs.map((l) => l.message).join('\n')).toMatch(/context pulled: .*canonical_prompts:/);
    expect(await artifactsOf(r.runId)).toHaveLength(0);
  });
});

describe('x3lius-songwriting and x3lius-composition', () => {
  it.each([
    ['x3lius-songwriting', 'x3lius.song-structure/v1', 'Write the hook and chorus for an X3LIUS song about the city at night'],
    ['x3lius-composition', 'x3lius.composition/v1', 'Pick the chord progression and melody for the X3LIUS intro'],
  ])('%s writes a %s artifact from canonical context', async (agent, schemaId, request) => {
    const model = fakeModel();
    const r = await run(depsWith(model), agent, request);
    expect(r.status, r.error).toBe('success');
    const out = r.output as CreativeOutput;
    expect(out).toMatchObject({ subdomain: agent, status: 'generated', artifact: { schemaId } });
    expect(out.knowledge.perModule).toHaveProperty(agent);
    expect(out.knowledge.perModule).toHaveProperty('x3lius-vocal-dna');
    const [claim] = await voiceClaims();
    for (const d of claim!.value) expect(model.calls[0]!.system).toContain(d);
    expect(await artifactsOf(r.runId)).toHaveLength(1);
  });

  it('songwriting refuses a hook selection outside its own candidates', async () => {
    const model = fakeModel({ override: (schema, refs) => ({ ...fakeBody(schema, refs.slice(0, 1)), hook: { candidates: [{ text: '[FAKE]', language: 'en', rationale: '[FAKE]' }], selectedIndex: 3, selectionReason: '[FAKE]' } }) });
    const r = await run(depsWith(model), 'x3lius-songwriting', 'Write the hook for an X3LIUS song');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/hook\.selectedIndex 3 is not one of 1 candidate/);
  });
});

describe('front door: pnpm ask → RECORDS → X3LIUS entrypoint → Creative agent', () => {
  it('a lyrics request is routed to x3lius-lyrics, which generates', async () => {
    const r = await runMusicSystem(depsWith(fakeModel()), { request: 'Write rhymes and lyric bars for X3LIUS' });
    expect(r, r.reason).toMatchObject({ status: 'success', selected: ['x3lius-lyrics'] });
    expect(r.outputs['x3lius-lyrics']).toMatchObject({ status: 'generated', artifact: { schemaId: 'x3lius.lyrics/v2' } });
  });
});
