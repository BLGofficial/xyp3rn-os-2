import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
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
import type { CriticOutput } from '../../records/x3lius/evaluation/critic.ts';
import type { RevisionOutput } from '../../records/x3lius/evaluation/revision.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// Phase 12 proof (part 2): the Critic, Revision and the loop, on a throwaway DB holding the real
// guide + X3LIUS manifest.
// FAKE MODEL: every Critic and Revision reply is scripted here. The scripts are stateless: each reads
// the artifact (or the violations) from the request it answers, so the proofs show the loop's
// logic, never a model's judgement.
// FIXTURES: one prose rule each for Lyrics and Suno, and two Suno length claims, promoted through the
// real gate ("[FIXTURE]" in every field), only in this database. The Suno prompts are written
// before the 12-character style limit exists, as they would be before a rule change.

type Json = Record<string, unknown>;
type Written = { artifact: { id: string; version: number; schemaId: string }; body: Json };
type Reported = { ruleRef: string; path: string; quote: string; expected: string; found: string };

const REQUEST = 'Write an X3LIUS song about the city at night';
let db: TestDb;
let embedder: Embedder;
let researchRunId: string;
const rules = { lyrics: '', suno: '', styleLimit: '' };
const prompts: Record<'critic' | 'revision' | 'loop', string> = { critic: '', revision: '', loop: '' };
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

const depsWith = (model = fakeModel()): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (agent: string, input: unknown, model = fakeModel()) => dispatch(depsWith(model), agent, input, { timeoutMs: 60_000 });
const artifactsOf = (runId: string) => db.sql<{ id: string }[]>`select id from creative_artifacts where agent_run_id = ${runId}`;

/** Promotes one [FIXTURE] finding through the real gate; returns the canonical_prompts id. */
const promote = async (slug: string, note: string, module: string, claim: { topic: string; value: unknown; modelTag: string }): Promise<string> => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: `fixture:phase-12/${slug}`, title: `[FIXTURE] ${note}`,
    contentSha256: createHash('sha256').update(`fixture\n${slug}\n${note}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-12-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${note}`, model_tag: claim.modelTag, confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 12 proof — not a real observation' },
    claim_topic: claim.topic, claim_value: claim.value,
  });
  const f = await recordFinding(db.sql, { researchRunId, claim: `[FIXTURE] ${note}`, claim_topic: claim.topic, claim_value: claim.value, model_tag: claim.modelTag, evidenceIds: [ev] });
  const c = await proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: slug, title: `[FIXTURE] ${note}`,
    body: `[FIXTURE — synthetic, Phase 12 proof] ${note}`, domain: 'RECORDS', tags: [module],
  });
  const pending = await runGate(db.sql, c);
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-12-test', reason: 'Fixture for the Phase 12 proof.' });
  const r = await runGate(db.sql, c);
  expect(r.outcome).toBe('promoted');
  await embedPending(db.sql, embedder);
  return r.canonicalPromptId!;
};

const props = (schema: Json) => (schema.properties ?? {}) as Json;
/** The artifact a Critic or Revision request carries ("ARTIFACT <schema> v<n>\n<json>[\n\nVIOLATIONS\n<json>]"). */
const artifactIn = (user: string): Json => JSON.parse(user.slice(user.indexOf('\n') + 1).split('\n\nVIOLATIONS\n')[0]!) as Json;
const violationsIn = (user: string) => JSON.parse(user.split('\n\nVIOLATIONS\n')[1]!) as { key: string; path: string; ruleRef: string }[];
/** A FAKE model whose Critic and Revision replies are scripted; every other call gets the default fake body. */
const scripted = (s: { critic?: (artifact: Json) => Reported[]; revise?: (violations: { key: string; path: string; ruleRef: string }[], artifact: Json) => unknown[] }) =>
  fakeModel({
    override: (schema, _refs, user) => ('violations' in props(schema) ? { violations: s.critic?.(artifactIn(user)) ?? [] }
      : 'edits' in props(schema) ? { edits: s.revise?.(violationsIn(user), artifactIn(user)) ?? [] }
        : undefined),
  });

const lyrics = async () => {
  const r = await run('x3lius-lyrics', { request: REQUEST });
  expect(r.status, r.error).toBe('success');
  return (r.output as Written).artifact;
};
const sunoPrompt = async () => {
  const l = await lyrics();
  const r = await run('x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [l.id] });
  expect(r.status, r.error).toBe('success');
  return (r.output as Written).artifact;
};
const critiqueRow = (id: string) => db.sql<{ checked: number; passed: number; artifact_id: string }[]>`select checked, passed, artifact_id from critiques where id = ${id}`;

beforeAll(async () => {
  db = await createTestDb('phase12_critic_revision', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-12-fixture', '[FIXTURE] Phase 12 proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${REQUEST}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
  rules.lyrics = await promote('fixture-phase-12-lyrics-rule', 'Every X3LIUS bar names a place in the city.', 'x3lius-lyrics',
    { topic: 'fixture.x3lius-lyrics-city-bars', value: 'names-a-place', modelTag: 'model-agnostic' });
  rules.suno = await promote('fixture-phase-12-suno-rule', 'Open the X3LIUS style prompt with the vocal descriptor.', 'x3lius-suno',
    { topic: 'fixture.x3lius-suno-vocal-first', value: 'vocal-first', modelTag: 'model-agnostic' });
  await promote('fixture-phase-12-suno-title-limit', 'Suno v5 accepts at most 80 characters of title (FIXTURE value).', 'x3lius-suno',
    { topic: 'suno.limit.title-chars', value: 80, modelTag: 'suno-v5' });
  for (const k of ['critic', 'revision', 'loop'] as const) prompts[k] = (await sunoPrompt()).id;
  // The rule change: the style limit arrives after those prompts were written ([FAKE] style is 19 chars).
  const limitId = await promote('fixture-phase-12-suno-style-limit', 'Suno v5 accepts at most 12 characters of style (FIXTURE value).', 'x3lius-suno',
    { topic: 'suno.limit.style-chars', value: 12, modelTag: 'suno-v5' });
  rules.styleLimit = `canonical_prompts:${limitId}#suno.limit.style-chars`;
}, 600_000);
afterAll(async () => {
  await db?.drop();
});

describe('Critic (x3lius-evaluation)', () => {
  it('a Suno prompt: a code-found length violation and a verified model-found one, each tied to its rule', async () => {
    const model = scripted({
      critic: () => [
        { ruleRef: `canonical_prompts:${rules.suno}`, path: '/style', quote: '[FAKE] style prompt', expected: 'the vocal descriptor first', found: 'a placeholder' },
        { ruleRef: `canonical_prompts:${rules.suno}`, path: '/title', quote: 'not in the title', expected: 'x', found: 'y' },
      ],
    });
    const r = await run('x3lius-evaluation', { artifactId: prompts.critic }, model);
    expect(r.status, r.error).toBe('success');
    const out = r.output as CriticOutput;
    expect(out.body.violations.map(({ ruleRef, method, path }) => ({ ruleRef, method, path }))).toEqual([
      { ruleRef: rules.styleLimit, method: 'code', path: '/style' },
      { ruleRef: `canonical_prompts:${rules.suno}`, method: 'model', path: '/style' },
    ]);
    expect(out.body.violations[0]).toMatchObject({ expected: 'at most 12 characters (suno.limit.style-chars)', found: '19 characters' });
    expect(out.body.unverified).toEqual([expect.objectContaining({ path: '/title', reason: 'the quote does not appear at that path' })]);
    const codeRefs = out.body.rules.filter((x) => x.method === 'code').map((x) => x.ref);
    expect(codeRefs).toHaveLength(2);
    expect(codeRefs).toEqual(expect.arrayContaining([rules.styleLimit, expect.stringContaining('#suno.limit.title-chars')]));
    expect(out.critique.counts).toEqual({ checked: out.body.rules.length, passed: out.body.rules.length - 2, violations: 2 });
    const [row] = await critiqueRow(out.critique.id);
    expect(row).toEqual({ checked: out.critique.counts.checked, passed: out.critique.counts.passed, artifact_id: prompts.critic });
    // The model judges only what code doesn't: it is sent the prose rule, never the length claims.
    const system = model.calls.at(-1)!.system;
    expect(system).toContain(`[canonical_prompts:${rules.suno}]`);
    expect(system).not.toContain('suno.limit.style-chars');
  });

  it('refuses a bare request and a previous critique of another version', async () => {
    expect((await run('x3lius-evaluation', { request: 'Evaluate the new X3LIUS take' })).error).toMatch(/critiques one artifact version: input \{ artifactId/);
    const l = await lyrics();
    const first = (await run('x3lius-evaluation', { artifactId: l.id })).output as CriticOutput;
    expect((await run('x3lius-evaluation', { artifactId: l.id, previousCritiqueId: first.critique.id })).error).toMatch(/not the parent of/);
  });
});

describe('Revision (x3lius-revision)', () => {
  it('writes v2 with the edit, naming the critique it answers; derived Suno lengths are recomputed', async () => {
    const critic = scripted({ critic: (a) => (String(a.title).startsWith('[FAKE]') ? [{ ruleRef: `canonical_prompts:${rules.suno}`, path: '/title', quote: '[FAKE] Suno Title', expected: 'a real title', found: 'a placeholder' }] : []) });
    const c = (await run('x3lius-evaluation', { artifactId: prompts.revision }, critic)).output as CriticOutput;
    const titleKey = c.body.violations.find((x) => x.path === '/title')!.key;
    const reviser = scripted({ revise: () => [{ path: '/title', replacement: 'Neon Night Drive', violationKeys: [titleKey] }] });
    const r = await run('x3lius-revision', { critiqueId: c.critique.id }, reviser);
    expect(r.status, r.error).toBe('success');
    const out = r.output as RevisionOutput;
    expect(out.artifact).toMatchObject({ version: 2, schemaId: 'x3lius.suno-prompt/v1' });
    expect(out.body.title).toBe('Neon Night Drive');
    expect((out.body.limits as { field: string; actual: number }[]).find((l) => l.field === 'title')?.actual).toBe('Neon Night Drive'.length);
    const [row] = await db.sql<{ parent_id: string; critique_id: string; agent_name: string }[]>`select parent_id, critique_id, agent_name from creative_artifacts where id = ${out.artifact.id}`;
    expect(row).toEqual({ parent_id: prompts.revision, critique_id: c.critique.id, agent_name: 'x3lius-revision' });
    // Revision sees the violations with their keys, and the artifact without its trace.
    expect(reviser.calls.at(-1)!.user).toContain(`"key":"${titleKey}"`);
    expect(reviser.calls.at(-1)!.user).not.toContain('rulesApplied');
  });

  it('refuses an edit outside every violation, and writes nothing', async () => {
    const l = await lyrics();
    const critic = scripted({ critic: (a) => [{ ruleRef: `canonical_prompts:${rules.lyrics}`, path: '/sections/0/bars/0/text', quote: String(((a.sections as Json[])[0]!.bars as Json[])[0]!.text), expected: 'a place', found: 'none' }] });
    const c = (await run('x3lius-evaluation', { artifactId: l.id }, critic)).output as CriticOutput;
    const r = await run('x3lius-revision', { critiqueId: c.critique.id }, scripted({ revise: (vs) => [{ path: '/sections/1/bars/0/text', replacement: 'Canal Street', violationKeys: [vs[0]!.key] }] }));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/revision refused: edit 0 \(\/sections\/1\/bars\/0\/text\) is not at or inside a field a violation points to/);
    expect(await artifactsOf(r.runId)).toEqual([]);
  });

  it('refuses a bare request', async () => {
    expect((await run('x3lius-revision', { request: 'fix it' })).error).toMatch(/revises from one critique: input \{ critiqueId \}/);
  });
});
