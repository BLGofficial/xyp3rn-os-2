import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { exportVault } from '../../knowledge/vault-io/export.ts';
import { importVault } from '../../knowledge/vault-io/import.ts';
import { retractResearchLink } from '../../research-intelligence/brief.ts';
import { executeResearch, openResearch } from '../../research-intelligence/entrypoint.ts';
import { decideFinding } from '../../research-intelligence/library.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// AOS-04 §9: a song-linked brief survives xyp-vault-export/v1: its links (and a retraction, then a re-link),
// its run, the quoted evidence with the page text it quotes, the finding and the owner's decision. Knowledge
// candidates stay out (canonical knowledge moves only through the gate). FAKE MODEL; stubbed page fetch.

let a: TestDb;
let b: TestDb;
let deps: DispatchDeps;
let storeA: VaultStore;
let storeB: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos04-export-'));
const dir = (n: string) => join(tmp, n);
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const model = fakeModel({
  override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
    ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] page', directness: 'direct' } }], declined: [] }
    : undefined),
});
const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb('aos04_export_a', { migrated: true }), createTestDb('aos04_export_b', { migrated: true })]);
  storeA = createLocalVaultStore(dir('store-a'));
  storeB = createLocalVaultStore(dir('store-b'));
  deps = {
    sql: a.sql, registry, tools: createRuntimeTools({ sql: a.sql, env: {}, fetch: pageFetch, vault: storeA }), handlers: HANDLERS,
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
}, 120_000);
afterAll(async () => {
  await Promise.all([a?.drop(), b?.drop()]);
  rmSync(tmp, { recursive: true, force: true });
});

describe('research in xyp-vault-export/v1', () => {
  it('exports a song-linked brief with its links, run, quoted evidence, page text, finding and decision, and re-imports them', async () => {
    const songId = (await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } })).songId as string;
    const opened = await openResearch(deps, {
      projectSlug: 'aos04-export', question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order',
      urls: ['https://example.org/suno'], specialists: ['suno-researcher'], targets: [{ kind: 'decision', decisionKey: 'F41' }],
    }, { requireIntendedUse: true });
    await ok('records-songs', { link: { songId, researchQuestionId: opened.questionId, role: 'informs' } });
    // A retracted link and its re-link: the import must replay the retraction before the re-link.
    const [link] = await a.sql<{ link_id: string }[]>`select link_id from research_targets where question_id = ${opened.questionId} and kind = 'decision'`;
    await retractResearchLink(a.sql, link!.link_id, '[FIXTURE] linked twice to check the order');
    await a.sql.begin(async (tx) => {
      await tx`set local role xyp_research`;
      await tx`insert into research_links (question_id, decision_key, role) values (${opened.questionId}, 'F41', 'informs')`;
    });
    expect((await executeResearch(deps, opened.researchRunId, { log: () => {} })).status).toBe('success');
    const [f] = await a.sql<{ id: string }[]>`select id from research_findings where research_run_id = ${opened.researchRunId}`;
    await decideFinding(a.sql, f!.id, { decision: 'accept', approver: 'owner', reason: '[FIXTURE] reusable' });

    await exportVault(a.sql, storeA, dir('export-a'));
    const manifest = JSON.parse(readFileSync(join(dir('export-a'), 'manifest.json'), 'utf8')) as { counts: Record<string, number> };
    for (const t of ['research_questions', 'research_runs', 'research_links', 'research_link_retractions', 'research_evidence', 'research_sources', 'research_findings', 'research_finding_evidence']) {
      expect(manifest.counts[t], t).toBeGreaterThan(0);
    }
    expect(manifest.counts.knowledge_candidates).toBeUndefined();

    const r = await importVault(b.sql, storeB, dir('export-a'));
    expect(r).toMatchObject({ inserted: r.records, skipped: 0 });
    const [e] = await b.sql<{ quote: string; text: string }[]>`
      select e.quote, s.text from research_evidence e join research_sources s on s.id = e.research_source_id`;
    expect(e!.quote).toBe('Put the vocal descriptor first.');
    expect(e!.text).toContain('Put the vocal descriptor first.');
    const [d] = await b.sql<{ decision: string }[]>`select decision from current_finding_decisions`;
    expect(d!.decision).toBe('accept');
    expect((await b.sql<{ kind: string }[]>`select kind from research_targets order by kind`).map((t) => t.kind)).toEqual(['decision', 'song']);
    // The same data gives the same file.
    await exportVault(b.sql, storeB, dir('export-b'));
    expect(readFileSync(join(dir('export-b'), 'records.ndjson'), 'utf8')).toBe(readFileSync(join(dir('export-a'), 'records.ndjson'), 'utf8'));
  });
});
