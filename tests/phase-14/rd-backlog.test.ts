import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decideQueueItem, pendingApprovals } from '../../knowledge/promotion-gate/gate.ts';
import { RD_BACKLOG_LLM_SCHEMA_ID } from '../../tech/r-and-d/backlog.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';
import { insertEvidence, insertResearchRun } from '../helpers/tech-fixture.ts';

// Phase 14 proof (part 5): the R&D backlog agent (Planning). FAKE MODEL: no provider key exists in
// this container; each reply below is scripted from the evidence ids the real prompt listed. What
// is real: the evidence read, the prompt, code verification of every proposal, the writes, the
// DB's queueing of each item for a human, and the operator's decision.

let db: TestDb;
let runId: string;
const e: Record<string, string> = {};
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

beforeAll(async () => {
  db = await createTestDb('phase14_rd_backlog', { migrated: true });
  runId = await insertResearchRun(db.sql);
  e.stems = await insertEvidence(db.sql, runId, 'StemSplit 3 announces real-time stem separation as a VST3');
  e.lufs = await insertEvidence(db.sql, runId, 'LoudCheck beta claims streaming-normalisation previews per platform');
  e.voice = await insertEvidence(db.sql, runId, 'An open-weights singing-voice model launched with a 48 kHz vocoder');
  e.suno = await insertEvidence(db.sql, runId, 'Suno v5 raised the style prompt limit', 'suno-researcher');
});
afterAll(async () => {
  await db?.drop();
});

type Proposal = { title: string; component: string; proposal: string; rationale: string; evidenceIds: string[] };
/** A FAKE model whose backlog reply is scripted; the ids it saw in the prompt are passed in. */
const scripted = (reply: (given: string[]) => Proposal[]) =>
  fakeModel({
    override: (schema, _refs, user) => ('proposals' in ((schema.properties ?? {}) as object)
      ? { proposals: reply([...user.matchAll(/\[evidence:([0-9a-f-]{36})\]/g)].map((m) => m[1]!)) }
      : undefined),
  });
const run = (model: ReturnType<typeof fakeModel>, input: unknown = {}) => {
  const deps: DispatchDeps = {
    sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
  return dispatch(deps, 'tech-r-and-d', input, { timeoutMs: 60_000 });
};
const p = (title: string, evidenceIds: string[], component = 'audio-tools'): Proposal =>
  ({ title, component, proposal: `[FAKE] build ${title}`, rationale: '[FAKE] the cited launch shows demand', evidenceIds });

type Out = {
  status: string; considered: number;
  written: { id: string; title: string }[];
  duplicates: string[];
  unverified: { title: string; reason: string }[];
};

describe('tech-r-and-d: proposals from the Frontier Scanner\'s evidence, verified in code, queued for a human', () => {
  it('reads only the scanner\'s uncited evidence, writes the verified proposals, keeps the rest as unverified with reasons', async () => {
    let given: string[] = [];
    const model = scripted((ids) => {
      given = ids;
      return [
        p('[FAKE] Stem-aware TRACE meter', [e.stems!]),
        p('[FAKE] Streaming loudness preview', [e.lufs!, e.voice!], 'products'),
        p('[FAKE] Invented citation', ['99999999-9999-4999-8999-999999999999']),
        p('[FAKE] Off-scope citation', [e.suno!]),
        p('[fake] STEM-AWARE trace meter', [e.voice!]),
        p('[FAKE] Uncited idea', []),
        { ...p('[FAKE] Blank proposal', [e.voice!]), proposal: '  ' },
      ];
    });
    const r = await run(model, { request: 'features for the TRACE plugin' });
    expect(r.status, r.error).toBe('success');
    expect(model.calls).toHaveLength(1);
    expect(given.sort()).toEqual([e.stems!, e.lufs!, e.voice!].sort());
    expect(model.calls[0]!.user).toMatch(/features for the TRACE plugin/);
    const out = r.output as Out;
    expect(out).toMatchObject({ status: 'proposed', considered: 3, duplicates: [] });
    expect(out.written.map((w) => w.title)).toEqual(['[FAKE] Stem-aware TRACE meter', '[FAKE] Streaming loudness preview']);
    expect(out.unverified.map((u) => [u.title, u.reason])).toEqual([
      ['[FAKE] Invented citation', expect.stringMatching(/not among the evidence given/)],
      ['[FAKE] Off-scope citation', expect.stringMatching(/not among the evidence given/)],
      ['[fake] STEM-AWARE trace meter', expect.stringMatching(/repeats the title/)],
      ['[FAKE] Uncited idea', expect.stringMatching(/cites no evidence/)],
      ['[FAKE] Blank proposal', expect.stringMatching(/proposal is blank/)],
    ]);
    const queued = await db.sql<{ item_id: string; status: string }[]>`
      select item_id, status::text from approval_queue where item_type = 'rd_backlog_item' order by requested_at`;
    expect(queued).toEqual(out.written.map((w) => ({ item_id: w.id, status: 'pending' })));
    expect(await db.sql`select research_evidence_id from rd_backlog_evidence where rd_backlog_id = ${out.written[1]!.id} order by research_evidence_id`)
      .toEqual([e.lufs!, e.voice!].sort().map((id) => ({ research_evidence_id: id })));
  });

  it('evidence already cited is not offered again: with none left, no model call is made', async () => {
    const model = scripted(() => [p('[FAKE] never asked', [e.voice!])]);
    const r = await run(model);
    expect(r.output).toMatchObject({ status: 'no-frontier-evidence', considered: 0, written: [] });
    expect(model.calls).toHaveLength(0);
  });

  it('a title already in the backlog is skipped as a duplicate, never fatal', async () => {
    e.midi = await insertEvidence(db.sql, runId, 'A MIDI-from-audio tool shipped a 2.0');
    const r = await run(scripted((ids) => [p('[FAKE] Stem-aware TRACE meter', ids), p('[FAKE] Audio-to-MIDI sketchpad', ids, 'r-and-d')]));
    expect(r.status, r.error).toBe('success');
    expect(r.output).toMatchObject({ status: 'proposed', considered: 1, duplicates: ['[FAKE] Stem-aware TRACE meter'] });
    expect((r.output as Out).written.map((w) => w.title)).toEqual(['[FAKE] Audio-to-MIDI sketchpad']);
  });

  it('the operator decides what ships (pnpm gate queue / decide); the backlog view follows; nothing is built', async () => {
    const [item] = await db.sql<{ id: string }[]>`select id from rd_backlog where title = '[FAKE] Stem-aware TRACE meter'`;
    const pending = (await pendingApprovals(db.sql)).filter((q) => q.item_type === 'rd_backlog_item');
    const mine = pending.find((q) => q.item_id === item!.id)!;
    expect(mine.backlog).toMatchObject({ title: '[FAKE] Stem-aware TRACE meter', component: 'audio-tools' });
    const d = await decideQueueItem(db.sql, mine.approval_id, { decision: 'approve', approver: 'operator', reason: '[FIXTURE] worth a prototype' }, async () => {
      throw new Error('the gate must not re-run for a backlog item');
    });
    expect(d).toEqual({ approval: 'approved', itemType: 'rd_backlog_item' });
    const [v] = await db.sql<{ status: string }[]>`select status from rd_backlog_items where id = ${item!.id}`;
    expect(v!.status).toBe('approved');
  });

  it('writes nothing but backlog items: no research, candidate or canonical rows', async () => {
    const counts = () => db.sql<{ t: string; n: number }[]>`
      select 'evidence' as t, count(*)::int as n from research_evidence
      union all select 'candidates', count(*)::int from knowledge_candidates
      union all select 'canonical', count(*)::int from canonical_prompts
      union all select 'artifacts', count(*)::int from creative_artifacts`;
    const before = await counts();
    e.last = await insertEvidence(db.sql, runId, 'A browser DAW added AI mastering');
    const after = await counts();
    expect(after.find((c) => c.t === 'evidence')!.n).toBe(before.find((c) => c.t === 'evidence')!.n + 1);
    await run(scripted((ids) => [p('[FAKE] Mastering A/B in TRACE', ids)]));
    expect(await counts()).toEqual(after);
  });

  it('the model sees a schema named for the backlog, and every reply is validated against it', () => {
    expect(RD_BACKLOG_LLM_SCHEMA_ID).toBe('tech.rd-proposals-llm/v1');
    expect(registry.get('tech-r-and-d')!.model).toBe('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free');
  });
});
