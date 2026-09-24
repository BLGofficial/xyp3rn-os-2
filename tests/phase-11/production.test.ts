import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { parseModelRef } from '../../core/llm/providers.ts';
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
import { ARRANGEMENT_SPEC, PRODUCTION_SPEC } from '../../records/x3lius/creative/production.ts';
import { CREATIVE_SUBDOMAINS } from '../../records/x3lius/creative/program.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeBody, fakeModel } from '../helpers/fake-llm.ts';

// Phase 11: Arrangement and Production become Creative agents on the shared program (ARCHITECTURE
// F10: single-class, no hybrid). Proven against a throwaway DB holding the real ingested guide +
// X3LIUS manifest:
// - production conventions reach the model only as canonical rules from the Production module;
// - an arrangement follows the song structure it is given (ids, order, kind, bars), and a
//   production records the arrangement it produced;
// - the checks the schema can't state (routing, energy range, structure order) refuse the run
//   before anything is written.
//
// FAKE MODEL (tests/helpers/fake-llm.ts): proves wiring, never writing.
// FIXTURE: one synthetic Production rule, "[FIXTURE]" in every field, promoted through the real
// gate into x3lius-production, only in this throwaway database.

const REQUEST = 'Produce an X3LIUS track about the city at night';
const FIXTURE_SLUG = 'fixture-phase-11-production-rule';
const FIXTURE_NOTE = 'Give every X3LIUS drum channel its own mixer track.';

let db: TestDb;
let embedder: Embedder;
let fixtureRuleId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const depsWith = (model = fakeModel()): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (agent: string, input: unknown, model = fakeModel()) => dispatch(depsWith(model), agent, input, { timeoutMs: 60_000 });

type Json = Record<string, unknown>;
type Out = {
  artifact: { id: string; version: number; schemaId: string };
  body: Json & { sources: { role: string; artifactId: string; schemaId: string; version: number }[] };
  knowledge: { perModule: Record<string, number>; reasons: string[] };
  context: { ref: string }[];
};
const artifactsOf = (runId: string) => db.sql<{ id: string }[]>`select id from creative_artifacts where agent_run_id = ${runId}`;

const promoteFixtureRule = async (): Promise<string> => {
  const researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-11-fixture', '[FIXTURE] Phase 11 wiring proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${REQUEST}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: 'fixture:phase-11/production-rule', title: `[FIXTURE] ${FIXTURE_NOTE}`,
    contentSha256: createHash('sha256').update(`fixture\n${FIXTURE_NOTE}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-11-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${FIXTURE_NOTE}`, model_tag: 'model-agnostic', confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 11 wiring proof — not a real observation' },
    claim_topic: 'fixture.x3lius-production-drum-routing', claim_value: 'own-mixer-track',
  });
  const f = await recordFinding(db.sql, {
    researchRunId, claim: `[FIXTURE] ${FIXTURE_NOTE}`, claim_topic: 'fixture.x3lius-production-drum-routing', claim_value: 'own-mixer-track', model_tag: 'model-agnostic', evidenceIds: [ev],
  });
  const candidateId = await proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: FIXTURE_SLUG, title: `[FIXTURE] ${FIXTURE_NOTE}`,
    body: `[FIXTURE — synthetic, Phase 11 wiring proof] ${FIXTURE_NOTE}`, domain: 'RECORDS', tags: ['x3lius-production'],
  });
  const pending = await runGate(db.sql, candidateId);
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-11-test', reason: 'Fixture for the wiring proof.' });
  const promoted = await runGate(db.sql, candidateId);
  expect(promoted.outcome).toBe('promoted');
  await embedPending(db.sql, embedder);
  return promoted.canonicalPromptId!;
};

beforeAll(async () => {
  db = await createTestDb('phase11_production', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  fixtureRuleId = await promoteFixtureRule();
});
afterAll(async () => {
  await db?.drop();
});

describe('x3lius-arrangement', () => {
  it('from a bare brief: an x3lius.arrangement/v1 artifact from its own module + Vocal DNA, no sources', async () => {
    const r = await run('x3lius-arrangement', { request: REQUEST });
    expect(r.status, r.error).toBe('success');
    const o = r.output as Out;
    expect(o.artifact).toMatchObject({ schemaId: 'x3lius.arrangement/v1', version: 1 });
    expect(Object.keys(o.knowledge.perModule)).toEqual(['x3lius-arrangement', 'x3lius-vocal-dna']);
    expect(o.body.sources).toEqual([]);
  });

  it('against a song structure: its sections in its order, kind and bars copied from it, the version recorded', async () => {
    const structure = await run('x3lius-songwriting', { request: REQUEST });
    expect(structure.status, structure.error).toBe('success');
    const s = (structure.output as Out).artifact;
    const model = fakeModel({
      // The model disagrees about kind and bars; the structure wins.
      override: (schema, refs) => {
        const b = fakeBody(schema, refs.slice(0, 1)) as { sections: Json[] };
        return { ...b, sections: b.sections.map((x) => ({ ...x, kind: 'bridge', bars: 99 })) };
      },
    });
    const r = await run('x3lius-arrangement', { request: REQUEST, structureArtifactId: s.id }, model);
    expect(r.status, r.error).toBe('success');
    expect(model.calls[0]!.user).toContain(`SONG STRUCTURE (artifact ${s.id} v1)`);
    const o = r.output as Out;
    expect((o.body.sections as Json[]).map(({ sectionId, kind, bars }) => ({ sectionId, kind, bars }))).toEqual([
      { sectionId: 'v1', kind: 'verse', bars: 16 }, { sectionId: 'c1', kind: 'chorus', bars: 8 },
    ]);
    expect(o.body.sources).toEqual([{ role: 'structure', artifactId: s.id, schemaId: 'x3lius.song-structure/v1', version: 1 }]);
  });

  it('refuses sections out of the structure’s order, and writes nothing', async () => {
    const s = ((await run('x3lius-songwriting', { request: REQUEST })).output as Out).artifact;
    const model = fakeModel({ override: (schema, refs) => { const b = fakeBody(schema, refs.slice(0, 1)) as { sections: Json[] }; return { ...b, sections: [...b.sections].reverse() }; } });
    const r = await run('x3lius-arrangement', { request: REQUEST, structureArtifactId: s.id }, model);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/sections \[c1, v1\] do not follow the song structure \[v1, c1\] in order/);
    expect(await artifactsOf(r.runId)).toEqual([]);
  });

  it('refuses an upstream artifact of another kind', async () => {
    const other = ((await run('x3lius-arrangement', { request: REQUEST })).output as Out).artifact;
    const r = await run('x3lius-arrangement', { request: REQUEST, structureArtifactId: other.id });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/is x3lius\.arrangement\/v1, expected x3lius\.song-structure\/v1/);
  });

  it('refuses an energy outside 1–10', async () => {
    const model = fakeModel({ override: (schema, refs) => { const b = fakeBody(schema, refs.slice(0, 1)) as { sections: Json[] }; return { ...b, sections: b.sections.map((x) => ({ ...x, energy: 11 })) }; } });
    const r = await run('x3lius-arrangement', { request: REQUEST }, model);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/section v1: energy 11 is outside 1–10/);
  });
});

describe('x3lius-production', () => {
  it('reads Production, Arrangement and Vocal DNA; a promoted Production rule reaches the prompt and the artifact', async () => {
    const arrangement = ((await run('x3lius-arrangement', { request: REQUEST })).output as Out).artifact;
    const model = fakeModel({ cite: (refs) => refs.filter((x) => x === `canonical_prompts:${fixtureRuleId}`) });
    const r = await run('x3lius-production', { request: REQUEST, arrangementArtifactId: arrangement.id }, model);
    expect(r.status, r.error).toBe('success');
    const o = r.output as Out;
    expect(o.artifact).toMatchObject({ schemaId: 'x3lius.production/v1', version: 1 });
    expect(o.knowledge.perModule).toEqual({ 'x3lius-production': 1, 'x3lius-arrangement': 0, 'x3lius-vocal-dna': 0 });
    expect(model.calls[0]!.system).toContain(`[canonical_prompts:${fixtureRuleId}] ${FIXTURE_SLUG} (x3lius-production): [FIXTURE — synthetic, Phase 11 wiring proof] ${FIXTURE_NOTE}`);
    expect(model.calls[0]!.user).toContain(`ARRANGEMENT (artifact ${arrangement.id} v1)`);
    expect(o.body.rulesApplied).toEqual([expect.objectContaining({ ref: `canonical_prompts:${fixtureRuleId}` })]);
    expect(o.body.sources).toEqual([{ role: 'arrangement', artifactId: arrangement.id, schemaId: 'x3lius.arrangement/v1', version: 1 }]);
    expect(o.body.flStudio).toEqual({ channels: [{ name: '[FAKE] 808', generator: '[FAKE] sampler', mixerTrack: 1 }], mixerTracks: [{ track: 1, name: '[FAKE] 808 bus', effects: ['[FAKE] eq'] }] });
  });

  it('refuses a channel routed to a mixer track it does not list, and writes nothing', async () => {
    const model = fakeModel({
      override: (schema, refs) => {
        const b = fakeBody(schema, refs.slice(0, 1)) as { flStudio: { channels: Json[]; mixerTracks: Json[] } };
        return { ...b, flStudio: { ...b.flStudio, channels: [{ name: '[FAKE] hats', generator: '[FAKE]', mixerTrack: 9 }] } };
      },
    });
    const r = await run('x3lius-production', { request: REQUEST }, model);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/channel "\[FAKE\] hats" routes to mixer track 9, which mixerTracks does not list/);
    expect(await artifactsOf(r.runId)).toEqual([]);
  });

  it('refuses repeated mixer track numbers', async () => {
    const model = fakeModel({
      override: (schema, refs) => {
        const b = fakeBody(schema, refs.slice(0, 1)) as { flStudio: { channels: Json[]; mixerTracks: Json[] } };
        return { ...b, flStudio: { ...b.flStudio, mixerTracks: [...b.flStudio.mixerTracks, { track: 1, name: '[FAKE] dup', effects: [] }] } };
      },
    });
    const r = await run('x3lius-production', { request: REQUEST }, model);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/mixer track numbers repeat: 1, 1/);
  });
});

describe('registry: Phase 11 Creative agents replace their stubs under the same names', () => {
  const built = ['x3lius-arrangement', 'x3lius-production'];

  it.each(built.map((b) => [b]))('%s: Creative, RECORDS, LLM-backed, context + artifact tools, routable by its Scope', (name) => {
    const a = registry.get(name)!;
    expect(a).toMatchObject({ name, class: 'Creative', domain: 'RECORDS', tools: ['retrieve_context', 'retrieve_claims', 'read_artifact', 'write_artifact', 'log_message'] });
    expect(() => parseModelRef(a.model)).not.toThrow();
    expect(CREATIVE_SUBDOMAINS).toContain(name);
    expect(LLM_PROGRAMS[name]).toBeTypeOf('function');
    expect(HANDLERS[name]).toBeUndefined();
    expect(() => parseScope(name, a.sections.Scope ?? '')).not.toThrow();
  });

  it('Phase 11 built exactly Arrangement, Production and Mix/Master; only Evaluation (Phase 12) is still a stub', () => {
    const system = loadMusicSystem();
    expect(system.subdomains.filter((s) => s.builtIn === '11').map((s) => s.slug).sort()).toEqual(['x3lius-arrangement', 'x3lius-mix-master', 'x3lius-production']);
    expect(registry.get('x3lius-evaluation')).toMatchObject({ class: 'Knowledge', model: 'none' });
    expect(registry.validateAll()).toEqual([]);
  });
});

describe('upstream checks in finalize (no model, no DB)', () => {
  const source = { role: 'up', artifactId: 'a', schemaId: 's', version: 1 };
  const prepared = (body: Json) => ({ brief: REQUEST, userSections: [], state: { source, body } });
  const arranged = (...ids: string[]) => ({ sections: ids.map((sectionId) => ({ sectionId, kind: 'verse', bars: 8, energy: 5 })) });

  it('arrangement: compares section ids one by one, so ids containing ", " cannot join to the same string', () => {
    const structure = { sections: [{ id: 'a, b', kind: 'verse', bars: 8 }, { id: 'c', kind: 'chorus', bars: 8 }] };
    expect(ARRANGEMENT_SPEC.finalize!(arranged('a', 'b, c'), prepared(structure), []).violations).toEqual([
      'sections [a, b, c] do not follow the song structure [a, b, c] in order',
    ]);
    expect(ARRANGEMENT_SPEC.finalize!(arranged('a, b', 'c'), prepared(structure), []).violations).toEqual([]);
  });

  const production = (drums: Json[], soundDesign: Json[], channels: Json[]) => ({ tempoBpm: 140, drums, soundDesign, flStudio: { channels, mixerTracks: [] } });
  const withElements = { sections: [{ sectionId: 'v1', elements: [{ element: '808', role: 'bass' }] }] };
  const drum = { element: '808', sound: 's', pattern: 'p' };
  const channel = { name: '808', generator: 'g', mixerTrack: 1 };

  it('production: refuses empty drums and sound design, or no channels, when the arrangement lists elements', () => {
    expect(PRODUCTION_SPEC.finalize!(production([], [], []), prepared(withElements), []).violations).toEqual([
      'the arrangement lists 1 element(s), but drums and soundDesign are both empty',
      'the arrangement lists 1 element(s), but flStudio.channels is empty',
    ]);
    expect(PRODUCTION_SPEC.finalize!(production([drum], [], [channel]), prepared(withElements), []).violations).toEqual([]);
  });

  it('production: an arrangement with no elements, or none given, asks for nothing', () => {
    expect(PRODUCTION_SPEC.finalize!(production([], [], []), prepared({ sections: [{ sectionId: 'v1', elements: [] }] }), []).violations).toEqual([]);
    expect(PRODUCTION_SPEC.finalize!(production([], [], []), { brief: REQUEST, userSections: [], state: { source: null, body: null } }, []).violations).toEqual([]);
  });
});
