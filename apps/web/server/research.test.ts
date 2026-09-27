import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../../../tests/helpers/fake-llm.ts';
import { openResearch } from '../../../research-intelligence/entrypoint.ts';
import { songCreate } from './ops.ts';
import { library, previewSelection, researchFor, researchIndex, runDetail } from './research-loaders.ts';
import { decideFindingOp, decidePromotionOp, promoteOp, rerun, retractLinkOp, startBrief, sweepOnBoot } from './research-ops.ts';

// AOS-04 §8: what the Research screens read (as xyp_web, read only) and write (open a brief and run it in
// the background, the owner's decisions), against a throwaway migrated database. FAKE MODEL; stubbed page fetch.

let db: TestDb;
let deps: DispatchDeps;
let songId: string;
let recipeLineageId: string;
let runId: string;
let findingId: string;
const vaultDir = mkdtempSync(join(tmpdir(), 'aos04-web-vault-'));
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const model = fakeModel({
  override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
    ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] page', directness: 'direct' } }], declined: [] }
    : undefined),
});
const quiet = () => {};
const waitFor = async (ok: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const settled = (id: string) => waitFor(async () => (await runDetail(db.sql, id))!.run.status !== 'running');

beforeAll(async () => {
  db = await createTestDb('aos04_web', { migrated: true });
  deps = {
    sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), handlers: HANDLERS,
    tools: createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch, vault: createLocalVaultStore(vaultDir) }),
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
  songId = (await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })).songId;
  const r = await dispatch(deps, 'x3lius-studio-editor', { recipe: { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap', excludeStyles: [] } });
  recipeLineageId = (r.output as { lineageId: string }).lineageId;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('research ops and loaders (AOS-04 §8)', () => {
  it('startBrief returns once the run is open; the run finishes in the background; runDetail shows it', async () => {
    ({ researchRunId: runId } = await startBrief(deps, {
      projectSlug: 'web', question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order', urls: ['https://example.org/suno'],
      specialists: ['suno-researcher'], songIds: [songId], targets: [{ kind: 'lineage', artifactLineageId: recipeLineageId }, { kind: 'decision', decisionKey: 'F41' }],
    }, quiet));
    const first = await runDetail(db.sql, runId);
    expect(['running', 'success']).toContain(first!.run.status);
    await settled(runId);
    const d = (await runDetail(db.sql, runId))!;
    expect(d.run.status).toBe('success');
    expect(d.brief.targets.map((t) => [t.kind, t.label])).toEqual([['decision', 'F41'], ['lineage', '[FIXTURE] Night drive'], ['song', '[FIXTURE] Night City']]);
    expect(d.evidence[0]!.quote).toBe('Put the vocal descriptor first.');
    expect(d.evidence[0]!.source).toMatchObject({ kind: 'web', uri: 'https://example.org/suno' });
    expect(d.outcomes).toEqual([expect.objectContaining({ specialist: 'suno-researcher', status: 'success', passages: 1, declined: [], failedUrls: [] })]);
    expect(d.topics.map((t) => t.topic)).toEqual(['suno.vocal-descriptor-position']);
    findingId = d.topics[0]!.findings[0]!.id;
    expect(d.topics[0]!.findings[0]).toMatchObject({ decision: null, candidates: [], evidenceIds: [d.evidence[0]!.id] });
  });

  it('refuses a bad brief with the field-level message and writes nothing', async () => {
    const before = await db.sql`select id from research_questions`;
    await expect(startBrief(deps, { projectSlug: 'web', question: '[FIXTURE] q', intendedUse: '', urls: [] }, quiet)).rejects.toThrow(/intendedUse is required/);
    await expect(startBrief(deps, { projectSlug: 'web', question: '[FIXTURE] q', intendedUse: '[FIXTURE] u', specialists: [] }, quiet)).rejects.toThrow(/specialists: pick at least one/);
    expect(await db.sql`select id from research_questions`).toHaveLength(before.length);
  });

  it('accept → library; promote → pending; approve → promoted, as the owner', async () => {
    await decideFindingOp(db.sql, findingId, 'accept', '[FIXTURE] reusable', 'owner');
    // The form posts the domain as text: an unknown one is refused before a candidate is written.
    await expect(promoteOp(db.sql, { findingId, proposed_kind: 'canonical_prompt', target_slug: 'web-descriptor-first', title: '[FIXTURE] t', body: '[FIXTURE] b', domain: 'NOPE' }))
      .rejects.toThrow(/domain must be one of CORE, KNOWLEDGE/);
    expect(await db.sql`select 1 from knowledge_candidates`).toHaveLength(0);
    expect((await library(db.sql)).map((l) => l.findingId)).toEqual([findingId]);
    const p = await promoteOp(db.sql, { findingId, proposed_kind: 'canonical_prompt', target_slug: 'web-descriptor-first', title: '[FIXTURE] t', body: '[FIXTURE] b', domain: 'RECORDS' });
    expect(p.gate.outcome).toBe('pending_approval');
    const pending = (await runDetail(db.sql, runId))!.topics[0]!.findings[0]!;
    expect(pending.candidates).toEqual([expect.objectContaining({ status: 'pending_approval', approvalId: p.gate.approvalId, approvalStatus: 'pending' })]);
    expect(pending.decision).toMatchObject({ decision: 'accept', by: 'owner', reason: '[FIXTURE] reusable' });
    await decidePromotionOp(db.sql, p.gate.approvalId!, 'approve', '[FIXTURE] yes', 'owner');
    const [row] = await library(db.sql);
    expect(row).toMatchObject({ canonicalStatus: 'promoted', quotes: [{ quote: 'Put the vocal descriptor first.', uri: 'https://example.org/suno', title: '[FIXTURE] Suno tips' }] });
    expect(row!.targets.map((t) => t.kind)).toEqual(['decision', 'lineage', 'song']);
  });

  it('filters the library by target; researchFor(song | lineage) lists the brief and its findings', async () => {
    expect(await library(db.sql, { kind: 'song', target: songId })).toHaveLength(1);
    expect(await library(db.sql, { kind: 'decision', target: 'F1' })).toHaveLength(0);
    for (const t of [{ songId }, { lineageId: recipeLineageId }]) {
      const r = await researchFor(db.sql, t);
      expect(r.briefs.map((b) => b.latestRun?.id)).toEqual([runId]);
      expect(r.findings.map((f) => f.findingId)).toEqual([findingId]);
    }
  });

  it('the index lists briefs with targets and latest run, the specialists, workflows, decisions, songs and lineages; the preview scores a question', async () => {
    const r = await researchIndex(db.sql, deps.registry);
    expect(r.briefs.map((b) => b.latestRun?.status)).toEqual(['success']);
    expect(r.specialists).toHaveLength(20);
    expect(r.workflows).toContain('build-suno-package');
    expect(r.decisions).toContain('F41');
    expect(r.decisions.indexOf('F9')).toBeLessThan(r.decisions.indexOf('F10'));
    expect(r.songs).toEqual([{ id: songId, title: '[FIXTURE] Night City' }]);
    expect(r.lineages).toEqual([{ id: recipeLineageId, name: '[FIXTURE] Night drive', kind: 'recipe' }]);
    expect(previewSelection(deps.registry, 'How do Suno meta-tags work?').selected.map((s) => s.name)).toContain('suno-researcher');
  });

  it('re-runs a brief as a new brief with the same fields and live links', async () => {
    const [link] = await db.sql<{ link_id: string }[]>`
      select t.link_id from research_targets t join research_runs r on r.question_id = t.question_id where r.id = ${runId} and t.kind = 'decision'`;
    await retractLinkOp(db.sql, link!.link_id, '[FIXTURE] not this decision');
    const again = await rerun(deps, runId, quiet);
    await settled(again.researchRunId);
    const d = (await runDetail(db.sql, again.researchRunId))!;
    expect(d.brief.questionId).not.toBe((await runDetail(db.sql, runId))!.brief.questionId);
    expect(d.brief).toMatchObject({ question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order' });
    expect(d.brief.targets.map((t) => t.kind)).toEqual(['lineage', 'song']);
    expect(d.run.status).toBe('success');
  });

  it('the boot sweep seals a run a stopped server left past its deadline, and only that one', async () => {
    // Opened but never executed, as when the server stops between the two.
    const left = await openResearch(deps, { projectSlug: 'web', question: '[FIXTURE] left running', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    const live = await openResearch(deps, { projectSlug: 'web', question: '[FIXTURE] still in time', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    await db.sql`update research_runs set expires_at = now() - interval '1 minute' where id = ${left.researchRunId}`;
    expect(await sweepOnBoot(db.sql)).toEqual([left.researchRunId]);
    expect((await runDetail(db.sql, left.researchRunId))!.run).toMatchObject({ status: 'error', error: expect.stringMatching(/^abandoned: no result by /) });
    expect((await runDetail(db.sql, live.researchRunId))!.run.status).toBe('running');
  });

  it('runDetail of an unknown run is null', async () => {
    expect(await runDetail(db.sql, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await runDetail(db.sql, 'not-a-uuid')).toBeNull();
  });
});

describe('the §17 workbench and list (AOS-04 Plan B, Task 7)', () => {
  let outcomesRun: string;
  beforeAll(async () => {
    // A run whose five specialists ended five different ways, then sealed 90 s after it opened.
    const opened = await openResearch(deps, { projectSlug: 'web', question: '[FIXTURE] five ways to end', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'], targets: [{ kind: 'decision', decisionKey: 'F40' }] });
    outcomesRun = opened.researchRunId;
    const step = (agent: string, status: 'success' | 'error', result: unknown, error: string | null) => db.sql`
      insert into agent_runs (agent_name, class, domain, input, output, status, error_detail, research_run_id, completed_at)
      values (${agent}, 'Research', 'RESEARCH_INTELLIGENCE', '{}', ${db.sql.json({ result, logs: [] } as never)}, ${status}, ${error}, ${outcomesRun}, now())`;
    const done = (evidenceIds: string[], declined: { reason: string }[], passages: number) => ({ status: passages === 0 ? 'no-sources' : 'done', evidenceIds, declined, failedUrls: [], passages });
    await step('suno-researcher', 'success', done(['00000000-0000-0000-0000-000000000001'], [], 1), null);
    await step('genre-style-researcher', 'success', done([], [{ reason: 'no sources: the brief lists no URL' }], 0), null);
    await step('prompt-engineering-researcher', 'success', done([], [{ reason: 'research_evidence: quote not found verbatim' }], 2), null);
    await step('evaluation-researcher', 'error', null, 'LLM runner unavailable: OPENROUTER_API_KEY is not set');
    await step('voice-cloning-researcher', 'error', null, 'timeout after 1800000ms');
    await db.sql`update research_runs set status = 'error', error_detail = '[FIXTURE] specialist step failed', completed_at = created_at + interval '90 seconds' where id = ${outcomesRun}`;
  });

  it('names each specialist\'s outcome: completed, no sources, declined, failed, timed out', async () => {
    const d = (await runDetail(db.sql, outcomesRun))!;
    expect(Object.fromEntries(d.outcomes.map((o) => [o.specialist, o.outcome]))).toEqual({
      'suno-researcher': 'completed', 'genre-style-researcher': 'no-sources', 'prompt-engineering-researcher': 'declined',
      'evaluation-researcher': 'failed', 'voice-cloning-researcher': 'timed-out',
    });
    expect(d.outcomes.find((o) => o.specialist === 'suno-researcher')!.evidenceCount).toBe(1);
  });

  it('reports elapsed time from the recorded start and end, never an estimate', async () => {
    const d = (await runDetail(db.sql, outcomesRun))!;
    expect(d.run.elapsedMs).toBe(90_000);
    // A running run's elapsed time runs to the moment it was read.
    const live = await openResearch(deps, { projectSlug: 'web', question: '[FIXTURE] still open', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    const l = (await runDetail(db.sql, live.researchRunId))!;
    expect(l.run.status).toBe('running');
    expect(l.run.elapsedMs).toBe(Date.parse(l.asOf) - Date.parse(l.run.createdAt));
  });

  it('filters the brief list by latest-run status and by target', async () => {
    const byStatus = await researchIndex(db.sql, deps.registry, { status: 'error' });
    expect(byStatus.briefs.map((b) => b.question)).toContain('[FIXTURE] five ways to end');
    expect(byStatus.briefs.every((b) => b.latestRun?.status === 'error')).toBe(true);
    const byTarget = await researchIndex(db.sql, deps.registry, { kind: 'decision', target: 'F40' });
    expect(byTarget.briefs.map((b) => b.question)).toEqual(['[FIXTURE] five ways to end']);
    expect((await researchIndex(db.sql, deps.registry, { kind: 'decision', target: 'F1' })).briefs).toEqual([]);
  });
});
