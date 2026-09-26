import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decisionKeys, retractResearchLink, validateBrief, workflowFiles } from '../../research-intelligence/brief.ts';
import { executeResearch, openResearch, runResearch, sweepResearch } from '../../research-intelligence/entrypoint.ts';
import { SPECIALISTS } from '../../research-intelligence/specialists/program.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';
import { insertArtifact } from '../helpers/records-fixture.ts';

// AOS-04 §6: the brief (validated before any write), links, the owner's selection, the specialist steps
// with LLM_TIMEOUT_MS, synthesis, sealing, the deadline sweep. FAKE MODEL, stubbed page fetch.

let db: TestDb;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const answer = fakeModel({
  override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
    ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] page', directness: 'direct' } }], declined: [] }
    : undefined),
});
const deps = (model = answer): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const known = () => ({ specialists: new Set<string>(SPECIALISTS), decisions: decisionKeys(REPO_ROOT) });
const RECIPE = { name: '[FIXTURE] r', style: '[FIXTURE] s', excludeStyles: [], mood: [], production: [], notes: [] };

beforeAll(async () => {
  db = await createTestDb('aos04_run', { migrated: true });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('the brief', () => {
  it('reads decision keys from ARCHITECTURE.md and the checked-in workflows', () => {
    expect(decisionKeys(REPO_ROOT).has('F41')).toBe(true);
    expect(workflowFiles(REPO_ROOT).map((w) => w.name)).toContain('build-suno-package');
  });

  it('refuses a bad brief before writing, naming each field', async () => {
    const bad = { projectSlug: 'x', question: '[FIXTURE] q', intendedUse: ' ', urls: ['file:///c'], specialists: ['nobody'], targets: [{ kind: 'decision' as const, decisionKey: 'F999' }, { kind: 'workflow' as const, workflowName: 'no-such-flow' }] };
    expect(validateBrief(bad, known(), { requireIntendedUse: true })).toEqual([
      'intendedUse is required',
      'urls[0] is not an http(s) URL: file:///c',
      'specialists: unknown nobody',
      'targets[0]: no decision F999 in docs/ARCHITECTURE.md',
      'targets[1]: no workflow no-such-flow',
    ]);
    const before = await db.sql`select id from research_questions`;
    await expect(openResearch(deps(), bad, { requireIntendedUse: true })).rejects.toThrow(/intendedUse is required/);
    expect(await db.sql`select id from research_questions`).toHaveLength(before.length);
  });

  it('refuses a lineage target that is not a root (the DB guard), writing nothing', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', RECIPE);
    const [v2] = await db.sql<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, parent_id)
      select schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, id from creative_artifacts where id = ${root}
      returning id`;
    const before = await db.sql`select id from research_questions`;
    await expect(openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] q', intendedUse: '[FIXTURE] u', targets: [{ kind: 'lineage', artifactLineageId: v2!.id }] }))
      .rejects.toThrow(/not a lineage root/);
    expect(await db.sql`select id from research_questions`).toHaveLength(before.length);
  });
});

describe('open → execute', () => {
  it('opens a brief with links and the owner selection, raises the deadline, runs the specialists and synthesizes', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { ...RECIPE, name: '[FIXTURE] r2' });
    const opened = await openResearch(deps(), {
      projectSlug: 'aos04', question: '[FIXTURE] Where does the vocal descriptor go in a Suno style prompt?', intendedUse: '[FIXTURE] recipe order',
      urls: ['https://example.org/suno'], specialists: ['suno-researcher'],
      targets: [{ kind: 'lineage', artifactLineageId: root }, { kind: 'workflow', workflowName: 'build-suno-package' }, { kind: 'decision', decisionKey: 'F41', role: 'informs' }],
    }, { requireIntendedUse: true });
    expect(opened.selected).toEqual(['suno-researcher']);
    const [run] = await db.sql<{ status: string; mins: number; selection: { owner?: boolean } }[]>`
      select status::text, extract(epoch from expires_at - created_at) / 60 as mins, selection from research_runs where id = ${opened.researchRunId}`;
    expect(run!.status).toBe('running');
    expect(Number(run!.mins)).toBeGreaterThan(30);
    expect(run!.selection.owner).toBe(true);
    const targets = await db.sql<{ kind: string; target: string }[]>`select kind, target from research_targets where question_id = ${opened.questionId} order by kind`;
    expect(targets.map((t) => t.kind)).toEqual(['decision', 'lineage', 'workflow']);
    expect(targets[2]!.target).toMatch(/^build-suno-package@[0-9a-f]{64}$/);

    const r = await executeResearch(deps(), opened.researchRunId, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: ['suno-researcher'] });
    const f = await db.sql<{ claim_topic: string }[]>`select claim_topic from research_findings where research_run_id = ${opened.researchRunId}`;
    expect(f).toEqual([{ claim_topic: 'suno.vocal-descriptor-position' }]);
    const [steps] = await db.sql<{ input: { intendedUse: string; urls: string[] } }[]>`
      select a.input from agent_runs a where a.research_run_id = ${opened.researchRunId} and a.agent_name = 'suno-researcher'`;
    expect(steps!.input).toMatchObject({ intendedUse: '[FIXTURE] recipe order', urls: ['https://example.org/suno'] });
  });

  it('a second execute of a sealed run runs nothing and reports the seal', async () => {
    const opened = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] twice', intendedUse: '[FIXTURE] u', urls: ['https://example.org/suno'], specialists: ['suno-researcher'] });
    await executeResearch(deps(), opened.researchRunId, { log: () => {} });
    const calls = answer.calls.length;
    const again = await executeResearch(deps(), opened.researchRunId, { log: () => {} });
    expect(again).toMatchObject({ status: 'success', selected: ['suno-researcher'] });
    expect(answer.calls.length).toBe(calls);
  });

  it('a provider failure (429 after retries) seals the run and keeps the earlier specialist\'s evidence as findings', async () => {
    // The first model call answers; every later one is the free route overloaded (HTTP 429, retried twice).
    let n = 0;
    const overloaded = {
      calls: [],
      fn: (async (input, init) => (++n === 1 ? answer.fn(input, init)
        : new Response(JSON.stringify({ error: { code: 429, message: 'Provider returned error: rate-limited upstream' } }), { status: 429, headers: { 'content-type': 'application/json' } }))) as typeof fetch,
    };
    const opened = await openResearch(deps(overloaded), { projectSlug: 'aos04', question: '[FIXTURE] overloaded', intendedUse: '[FIXTURE] u', urls: ['https://example.org/suno'], specialists: ['suno-researcher', 'prompt-engineering-researcher'] });
    const r = await executeResearch(deps(overloaded), opened.researchRunId, { log: () => {} });
    expect(r.status).toBe('error');
    const [run] = await db.sql<{ status: string; error_detail: string }[]>`select status::text, error_detail from research_runs where id = ${opened.researchRunId}`;
    expect(run!.status).toBe('error');
    expect(run!.error_detail).toMatch(/^specialist step .* failed: .*429.*after 3 attempts/);
    expect(await db.sql`select 1 from research_findings where research_run_id = ${opened.researchRunId}`).toHaveLength(1);
  }, 30_000);

  it('keeps the Phase 6A call shape: runResearch({ question, projectSlug }) still works', async () => {
    const r = await runResearch(deps(), { question: '[FIXTURE] What should we eat tonight?', projectSlug: 'aos04' }, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: [] });
  });
});

describe('retractResearchLink', () => {
  it('unlinks a target with a reason; a blank reason is refused', async () => {
    const opened = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] link', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'], targets: [{ kind: 'decision', decisionKey: 'F40' }] });
    const [t] = await db.sql<{ link_id: string }[]>`select link_id from research_targets where question_id = ${opened.questionId}`;
    await expect(retractResearchLink(db.sql, t!.link_id, ' ')).rejects.toThrow(/needs a reason/);
    await retractResearchLink(db.sql, t!.link_id, '[FIXTURE] wrong decision');
    expect(await db.sql`select 1 from research_targets where question_id = ${opened.questionId}`).toHaveLength(0);
  });
});

describe('sweepResearch', () => {
  it('seals only runs past their deadline, as abandoned', async () => {
    const live = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] live', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    const dead = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] dead', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    await db.sql`update research_runs set expires_at = now() - interval '1 minute' where id = ${dead.researchRunId}`;
    const sealed = await sweepResearch(db.sql);
    expect(sealed).toEqual([dead.researchRunId]);
    const rows = await db.sql<{ id: string; status: string; error_detail: string | null }[]>`
      select id, status::text, error_detail from research_runs where id in (${live.researchRunId}, ${dead.researchRunId})`;
    expect(rows.find((x) => x.id === dead.researchRunId)).toMatchObject({ status: 'error', error_detail: expect.stringMatching(/^abandoned: no result by /) });
    expect(rows.find((x) => x.id === live.researchRunId)!.status).toBe('running');
  });
});
