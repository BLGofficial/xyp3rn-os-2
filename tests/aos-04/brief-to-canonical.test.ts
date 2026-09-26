import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { runGate } from '../../knowledge/promotion-gate/gate.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { exportVault } from '../../knowledge/vault-io/export.ts';
import { importVault } from '../../knowledge/vault-io/import.ts';
import { executeResearch, openResearch } from '../../research-intelligence/entrypoint.ts';
import { decideFinding, decidePromotion, promoteFinding } from '../../research-intelligence/library.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// AOS-04 gate (PLAN.md §5 Phase 4): "reusable findings retain their sources and cannot silently become
// canonical without approval". One flow, through the real agents, engines and gate: a brief linked to a
// song, a recipe lineage and a decision, with one URL → a run whose fabricated quote is declined → a finding
// that chains to quoted evidence and a source with its text → accepted into the Findings Library (canonical
// unchanged) → promoted (pending, canonical unchanged) → approved (a canonical row chaining back to the quote)
// → the brief survives an export into a fresh database.
// FAKE MODEL: its two claims are scripted against the passage list the real prompt carries. The page fetch is
// stubbed; retrieve_context is the real one over the ingested build guide (embedder included).
// Honest note: written after the features it drives, so it was never red. The DB, program, synthesis, run,
// library and export tests were red first.

let a: TestDb;
let b: TestDb;
let deps: DispatchDeps;
let storeA: VaultStore;
let storeB: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos04-gate-'));
const dir = (n: string) => join(tmp, n);
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const URL_ = 'https://example.org/suno-style-order';
const PAGE = '<html><head><title>[FIXTURE] Suno style order</title></head><body><p>[FIXTURE] Put the vocal descriptor first. Genre tags can follow it.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const claim = (passage: number, quote: string, claimText: string) => ({
  passage, quote, claim: claimText, claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6,
  confidence_inputs: { basis: '[FAKE] one page', directness: 'direct' },
});
// The page's number in the passage list the real prompt built; one real quote, one the page never says.
const model = fakeModel({
  override: (schema, _refs, user) => {
    if (!('claims' in ((schema.properties ?? {}) as object))) return undefined;
    const n = Number(/\[(\d+)\] \[FIXTURE\] Suno style order </.exec(user)?.[1]);
    return { claims: [claim(n, 'Put the vocal descriptor first.', '[FAKE] the vocal descriptor goes first'), claim(n, 'Always put the vocal descriptor first, it doubles adherence.', '[FAKE] fabricated')], declined: [] };
  },
});
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const counts = async (sql: TestDb['sql']) => {
  const [c] = await sql<{ prompts: number; modules: number; versions: number }[]>`
    select (select count(*)::int from canonical_prompts) as prompts, (select count(*)::int from modules) as modules,
           (select count(*)::int from knowledge_versions) as versions`;
  return c!;
};

type Journey = { songId: string; recipeLineageId: string; questionId: string; researchRunId: string; findingId: string; approvalId: string };
const j = {} as Journey;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb('aos04_gate_a', { migrated: true }), createTestDb('aos04_gate_b', { migrated: true })]);
  await ingestSource(a.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  await embedPending(a.sql, await loadEmbedder());
  storeA = createLocalVaultStore(dir('store-a'));
  storeB = createLocalVaultStore(dir('store-b'));
  deps = {
    sql: a.sql, registry, tools: createRuntimeTools({ sql: a.sql, env: {}, fetch: pageFetch, vault: storeA }), handlers: HANDLERS,
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
}, 300_000);
afterAll(async () => {
  await Promise.all([a?.drop(), b?.drop()]);
  rmSync(tmp, { recursive: true, force: true });
});

describe('AOS-04 gate: a brief to a canonical row, sources kept, nothing canonical without the owner', () => {
  it('1. a brief linked to a song, a recipe lineage and a decision', async () => {
    j.songId = (await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } })).songId;
    j.recipeLineageId = (await ok('x3lius-studio-editor', { recipe: { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, male baritone', excludeStyles: [] } })).lineageId;
    const opened = await openResearch(deps, {
      projectSlug: 'aos04-gate', question: 'Where should the vocal descriptor go in a Suno style prompt?', intendedUse: '[FIXTURE] fix the order of the Night drive recipe',
      urls: [URL_], specialists: ['suno-researcher'],
      targets: [{ kind: 'lineage', artifactLineageId: j.recipeLineageId, role: 'informs' }, { kind: 'decision', decisionKey: 'F41' }],
    }, { requireIntendedUse: true });
    Object.assign(j, { questionId: opened.questionId, researchRunId: opened.researchRunId });
    await ok('records-songs', { link: { songId: j.songId, researchQuestionId: j.questionId, role: 'research' } });
    const t = await a.sql<{ kind: string }[]>`select kind from research_targets where question_id = ${j.questionId} order by kind`;
    expect(t.map((x) => x.kind)).toEqual(['decision', 'lineage', 'song']);
  });

  it('2. the run writes the real quote, declines the fabricated one, and synthesizes one finding', async () => {
    const r = await executeResearch(deps, j.researchRunId, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: ['suno-researcher'] });
    const ev = await a.sql<{ quote: string }[]>`select quote from research_evidence where research_run_id = ${j.researchRunId}`;
    expect(ev).toEqual([{ quote: 'Put the vocal descriptor first.' }]);
    const [step] = await a.sql<{ result: { declined: { reason: string }[]; passages: number } }[]>`
      select output->'result' as result from agent_runs where research_run_id = ${j.researchRunId} and agent_name = 'suno-researcher'`;
    expect(step!.result.declined).toEqual([expect.objectContaining({ reason: expect.stringMatching(/quote not found verbatim/) })]);
    // The real retrieval ran: the build guide's canonical rows were offered alongside the page.
    expect(step!.result.passages).toBeGreaterThan(1);
    const [f] = await a.sql<{ id: string }[]>`select id from research_findings where research_run_id = ${j.researchRunId}`;
    j.findingId = f!.id;
  });

  it('3. accepted into the Findings Library, then promoted to a pending approval: canonical unchanged both times', async () => {
    const before = await counts(a.sql);
    await decideFinding(a.sql, j.findingId, { decision: 'accept', approver: 'owner', reason: '[FIXTURE] matches the studio notes' });
    expect(await counts(a.sql)).toEqual(before);
    const p = await promoteFinding(a.sql, {
      findingId: j.findingId, proposed_kind: 'canonical_prompt', target_slug: 'suno-vocal-descriptor-first',
      title: '[FIXTURE] Lead the style prompt with the vocal descriptor', body: '[FIXTURE] Put the vocal descriptor first in a Suno style prompt.', domain: 'RECORDS',
    });
    expect(p.gate.outcome).toBe('pending_approval');
    expect(await counts(a.sql)).toEqual(before);
    j.approvalId = p.gate.approvalId!;
  });

  it('4. the owner approves: one canonical row with its history, chaining back to the quote and the page text', async () => {
    const before = await counts(a.sql);
    const d = await decidePromotion(a.sql, j.approvalId, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] make it canonical' }, (id) => runGate(a.sql, id));
    expect(d.approval).toBe('approved');
    // The first gate promotion into RECORDS also creates its records-validated-rules module; each new row has its history row.
    expect(await counts(a.sql)).toEqual({ prompts: before.prompts + 1, modules: before.modules + 1, versions: before.versions + 2 });
    const chain = await a.sql<{ quote: string; text: string; uri: string }[]>`
      select e.quote, s.text, s.uri
      from canonical_prompts cp
      join knowledge_candidates kc on kc.target_slug = cp.slug
      join research_findings f on f.id = kc.finding_id
      join research_finding_evidence fe on fe.finding_id = f.id
      join research_evidence e on e.id = fe.evidence_id
      join research_sources s on s.id = e.research_source_id
      where cp.slug = 'suno-vocal-descriptor-first'`;
    expect(chain).toEqual([{ quote: 'Put the vocal descriptor first.', text: expect.stringContaining('Put the vocal descriptor first.'), uri: URL_ }]);
    const [lib] = await a.sql<{ canonical_status: string }[]>`select canonical_status from findings_library where finding_id = ${j.findingId}`;
    expect(lib!.canonical_status).toBe('promoted');
  });

  it('5. the brief survives xyp-vault-export/v1: B has its targets, the quote with its page text, and the decision', async () => {
    await exportVault(a.sql, storeA, dir('export-a'));
    const r = await importVault(b.sql, storeB, dir('export-a'));
    expect(r).toMatchObject({ inserted: r.records, skipped: 0 });
    const t = await b.sql<{ kind: string }[]>`select kind from research_targets where question_id = ${j.questionId} order by kind`;
    expect(t.map((x) => x.kind)).toEqual(['decision', 'lineage', 'song']);
    const [e] = await b.sql<{ quote: string; text: string }[]>`
      select e.quote, s.text from research_evidence e join research_sources s on s.id = e.research_source_id where e.research_run_id = ${j.researchRunId}`;
    expect(e).toEqual({ quote: 'Put the vocal descriptor first.', text: expect.stringContaining('Put the vocal descriptor first.') });
    const [d] = await b.sql<{ decision: string }[]>`select decision from current_finding_decisions where finding_id = ${j.findingId}`;
    expect(d!.decision).toBe('accept');
    // Canonical knowledge never travels in a Vault export: B's canonical tables are untouched.
    expect(await counts(b.sql)).toEqual({ prompts: 0, modules: 0, versions: 0 });
  });
});
