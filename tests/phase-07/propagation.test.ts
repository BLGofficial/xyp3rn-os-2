import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createContextEngine, type ContextEngine } from '../../core/context-engine/context-engine.ts';
import { dispatch } from '../../core/orchestrator/dispatch.ts';
import { ENTRYPOINTS, planRequest } from '../../core/orchestrator/orchestrate.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { decideApproval, runGate } from '../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { asRole } from '../../research-intelligence/db.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import { runMusicSystem } from '../../records/x3lius/entrypoint.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 7 proof (task 2): a rule promoted by the 6D gate and tagged for a sub-domain becomes
// consumable context on that sub-domain's context path — through the Context Engine, not hardcoded.
//
// FIXTURE: the guide asks for "a dummy rule tagged domain=Suno". It is synthetic, labelled as such
// in every field, and exists only in this throwaway database (user decision) — never the dev DB.

const FIXTURE_SLUG = 'fixture-phase-07-suno-rule';
const QUERY = 'How should the Suno style prompt order vocal descriptors?';
const STUB_FIXTURE_SLUG = 'fixture-phase-07-evaluation-rule';
const STUB_QUERY = 'Evaluate the new X3LIUS take and score it';

let db: TestDb;
let embedder: Embedder;
let engine: ContextEngine;
let researchRunId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const deps = () => ({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS });

/** A synthetic candidate, marked FIXTURE end to end, promoted through the real gate path. */
const fixtureCandidate = async (note: string, tags: readonly string[], slug = FIXTURE_SLUG, topic = 'fixture.suno-vocal-descriptor-position') => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: `fixture:phase-07/${createHash('sha256').update(note).digest('hex').slice(0, 12)}`,
    title: `[FIXTURE] ${note}`, contentSha256: createHash('sha256').update(`fixture\n${note}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-07-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${note}`, model_tag: 'suno-v4.5', confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 7 wiring proof — not a real observation' },
    claim_topic: topic, claim_value: 'first',
  });
  const f = await recordFinding(db.sql, {
    researchRunId, claim: `[FIXTURE] ${note}`, claim_topic: topic, claim_value: 'first', model_tag: 'suno-v4.5', evidenceIds: [ev],
  });
  return proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: slug, title: `[FIXTURE] ${note}`,
    body: `[FIXTURE — synthetic, Phase 7 wiring proof] ${note}`, domain: 'RECORDS', tags,
  });
};

const approveAndPromote = async (candidateId: string) => {
  const pending = await runGate(db.sql, candidateId);
  expect(pending.outcome).toBe('pending_approval');
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-07-test', reason: 'Fixture for the wiring proof.' });
  return runGate(db.sql, candidateId);
};

beforeAll(async () => {
  db = await createTestDb('phase07_propagation', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  // The whole guide is embedded up front, so an empty scope proves filtering, not an empty index.
  await embedPending(db.sql, embedder);
  engine = createContextEngine(db.sql, embedder);
  researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-07-fixture', '[FIXTURE] Phase 7 wiring proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${QUERY}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
});
afterAll(async () => {
  await db?.drop();
});

describe('the X3LIUS Music System module is gate-written canonical knowledge', () => {
  it('admits the parent + 10 sub-domain modules through the gate, each with history and a subdomain_of edge', async () => {
    const mods = await db.sql<{ slug: string; promoted_via: string; mode: string }[]>`
      select m.slug, m.promoted_via::text, kv.approval->>'mode' as mode from modules m
      join knowledge_versions kv on kv.canonical_table = 'modules' and kv.canonical_id = m.id
      where m.slug like 'x3lius-%' order by m.slug`;
    expect(mods).toHaveLength(11);
    expect(mods.every((m) => m.promoted_via === 'gate' && m.mode === 'first-party-ingest')).toBe(true);
    const [e] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from relations r join modules p on p.id::text = r.object_id
      where r.predicate = 'subdomain_of' and r.subject_type = 'module' and p.slug = 'x3lius-music-system'`;
    expect(e!.n).toBe(10);
  });

  it('re-ingesting the unchanged manifest is a no-op', async () => {
    const r = await ingestSource(db.sql, { kind: 'file', path: MUSIC_SYSTEM_MANIFEST, origin: 'first_party' });
    expect(r.status).toBe('noop');
  });

  it('an empty sub-domain answers with an empty scoped context, not with unrelated knowledge', async () => {
    expect((await engine.retrieve(QUERY)).items.length).toBeGreaterThan(0); // the global index is populated
    const b = await engine.retrieve(QUERY, { scope: { modules: ['x3lius-suno'] } });
    expect(b).toMatchObject({ scope: { modules: ['x3lius-suno'] }, items: [] });
  });
});

describe('propagation: a promoted rule tagged x3lius-suno reaches the Suno sub-domain context path', () => {
  let v1: string;
  let v2: string;

  it('the gate places the rule in the sub-domain module its tag names, and says so', async () => {
    const r = await approveAndPromote(await fixtureCandidate('Lead the Suno v4.5 style prompt with the vocal descriptor.', ['x3lius-suno']));
    expect(r.outcome).toBe('promoted');
    v1 = r.canonicalPromptId!;
    const [row] = await db.sql<{ module: string }[]>`
      select m.slug as module from canonical_prompts cp join modules m on m.id = cp.module_id where cp.id = ${v1}`;
    expect(row!.module).toBe('x3lius-suno');
    expect(r.steps.find((s) => s.step === 'canonical-write')!.reason).toMatch(/sub-domain x3lius-suno/);
    const [q] = await db.sql<{ payload: { scope_module: string } }[]>`
      select payload from regression_queue where promotion_run_id = ${r.promotionRunId} and kind = 'retrieval'`;
    expect(q!.payload.scope_module).toBe('x3lius-suno');
  });

  it('once embedded, the Suno scope returns it — and every item stays inside the scope; Lyrics does not see it', async () => {
    await embedPending(db.sql, embedder);
    const suno = await engine.retrieve(QUERY, { scope: { modules: ['x3lius-suno'] } });
    expect(suno.items.map((i) => i.slug)).toContain(FIXTURE_SLUG);
    expect(suno.items.every((i) => i.slug === 'x3lius-suno' || (i.ref.table === 'canonical_prompts' && i.slug === FIXTURE_SLUG))).toBe(true);
    const lyrics = await engine.retrieve(QUERY, { scope: { modules: ['x3lius-lyrics'] } });
    expect(lyrics.items.map((i) => i.slug)).not.toContain(FIXTURE_SLUG);
  });

  // Phase 9 turned x3lius-suno into a Creative agent (tests/phase-09) and Phase 11 did the same to
  // Mix/Master, so the stub-agent half of this proof runs on the sub-domain that is still a stub:
  // Evaluation (built in Phase 12), with its own FIXTURE rule promoted the same way.
  it('through the Agent Registry: a stub sub-domain returns its promoted rule as consumable context and says it is a stub', async () => {
    const r0 = await approveAndPromote(await fixtureCandidate('Score X3LIUS takes against the hook rubric first.', ['x3lius-evaluation'], STUB_FIXTURE_SLUG, 'fixture.evaluation-hook-first'));
    expect(r0.outcome).toBe('promoted');
    await embedPending(db.sql, embedder);
    const r = await dispatch(deps(), 'x3lius-evaluation', { request: STUB_QUERY });
    expect(r.status, r.error).toBe('success');
    const out = r.output as { subdomain: string; status: string; builtIn: string | null; context: { slug: string }[] };
    expect(out).toMatchObject({ subdomain: 'x3lius-evaluation', status: 'stub', builtIn: '12' });
    expect(out.context.map((i) => i.slug)).toContain(STUB_FIXTURE_SLUG);
    expect(out.context.map((i) => i.slug)).not.toContain(FIXTURE_SLUG);
  });

  it('end to end from a raw request: route → RECORDS → X3LIUS entrypoint → x3lius-evaluation', async () => {
    expect(planRequest(STUB_QUERY, ENTRYPOINTS)).toMatchObject({ action: 'run-service', service: 'x3lius-music-system' });
    const r = await runMusicSystem(deps(), { request: STUB_QUERY });
    expect(r).toMatchObject({ status: 'success', selected: ['x3lius-evaluation'] });
    const out = r.outputs['x3lius-evaluation'] as { context: { slug: string }[] };
    expect(out.context.map((i) => i.slug)).toContain(STUB_FIXTURE_SLUG);
  });

  it('only the current version is consumable: v2 replaces v1 on the scoped path', async () => {
    const r = await approveAndPromote(await fixtureCandidate('Corroborated: lead the Suno v4.5 style prompt with the vocal descriptor.', ['x3lius-suno']));
    expect(r.version).toBe(2);
    await embedPending(db.sql, embedder);
    const ids = (await engine.retrieve(QUERY, { scope: { modules: ['x3lius-suno'] } })).items.filter((i) => i.slug === FIXTURE_SLUG).map((i) => i.ref.id);
    expect(ids).toEqual([r.canonicalPromptId]);
    expect(ids).not.toContain(v1);
    v2 = r.canonicalPromptId!;
  });

  it('F16: the global (unscoped) path serves only the current version too', async () => {
    const ids = (await engine.retrieve(QUERY)).items.filter((i) => i.slug === FIXTURE_SLUG).map((i) => i.ref.id);
    expect(ids).toEqual([v2]);
  });

  it('a request no sub-domain matches is answered with clarify, never a default sub-domain', async () => {
    const r = await runMusicSystem(deps(), { request: 'Plan the X3LIUS release calendar' });
    expect(r).toMatchObject({ status: 'clarify', selected: [] });
  });

  it('refuses a rule tagged with two sub-domains before queueing it (one sub-domain per rule)', async () => {
    const c = await fixtureCandidate('Two sub-domain tags on one rule.', ['x3lius-suno', 'x3lius-lyrics'], 'fixture-phase-07-two-subdomains');
    await expect(runGate(db.sql, c)).rejects.toThrow(/2 sub-domains \(x3lius-lyrics, x3lius-suno\)/);
    expect(await db.sql`select 1 from approval_queue where item_id = ${c}`).toHaveLength(0);
  });
});
