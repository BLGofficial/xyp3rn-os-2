import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quoteIdent } from '../../core/db/client.ts';
import type { ToolContext } from '../../core/tool-registry/registry.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { candidateEligibility, resolveContradiction } from '../../research-intelligence/contradictions/engine.ts';
import { validateEvidence, writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { designExperiment, experimentResult, recordTrial, STUB_SCORER } from '../../research-intelligence/experiments/engine.ts';
import { classifySource, normalizeUri, registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { computeFindingConfidence, proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import { createFetchSourceTool } from '../../research-intelligence/tools/fetch-source.ts';
import { createWriteEvidenceTool } from '../../research-intelligence/tools/write-evidence.ts';
import { createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 6C proof. Everything runs against the real ingested build guide, whose Phase 8 voice
// reference is a structured canonical claim (normalizer v2). The page served over HTTP and the
// research claims below are test inputs for the engines' mechanics — the conflicting finding is
// deliberately wrong, as the guide requires.

const VOICE = ['modern brutalism', 'aggressive/confrontational', 'bilingual Bulgarian/English', 'dark melodic trap'];

let db: TestDb;
let server: Server;
let base: string;
let researchRunId: string;
let agentRunId: string;

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

const toolCtx = (): ToolContext => ({ runId: agentRunId, agentName: 'suno-researcher', researchRunId, log: () => {} });

beforeAll(async () => {
  db = await createTestDb('phase06c_engines', { migrated: true });
  const ing = await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  expect(ing.status).toBe('success');
  researchRunId = await as('xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('suno-vocal-control', 'Suno vocal control') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question)
      values (${p!.id}, 'Research the best current method for controlling dark baritone vocals in Suno.') returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
  const [run] = await db.sql<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input, research_run_id)
    values ('suno-researcher', 'Research', 'RESEARCH_INTELLIGENCE', '{}', ${researchRunId}) returning id`;
  agentRunId = run!.id;

  server = createServer((req, res) => {
    const pages: Record<string, string> = {
      '/notes': '<html><head><title>Vocal descriptor order notes</title><script>ignored()</script></head><body><h1>Order</h1><p>Leading the style prompt with the vocal descriptor held timbre across 8 of 10 generations.</p></body></html>',
      '/notes-copy': '<html><head><title>Vocal descriptor order notes</title><script>ignored()</script></head><body><h1>Order</h1><p>Leading the style prompt with the vocal descriptor held timbre across 8 of 10 generations.</p></body></html>',
    };
    const body = pages[req.url ?? ''];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await db?.drop();
});

describe('Evidence Engine: rejects any write missing source, model/version tag, confidence or claim', () => {
  it('lists every missing field at once', () => {
    expect(validateEvidence({})).toEqual([
      'research_source_id is required',
      'claim is required',
      'model_tag is required',
      'confidence must be a number in [0, 1]',
      'confidence_inputs must be a non-empty object showing how confidence was derived',
    ]);
  });

  it('rejects a partial claim structure (topic without value)', () => {
    expect(validateEvidence({ research_source_id: 'x', claim: 'c', model_tag: 'suno-v4.5', confidence: 0.5, confidence_inputs: { a: 1 }, claim_topic: 'suno.x' })).toEqual([
      'claim_topic and claim_value must be given together',
    ]);
  });
});

describe('Source Verification: dedup + explicit reliability rubric', () => {
  it('normalizes URIs so trivially different links dedup', () => {
    expect(normalizeUri('HTTPS://Suno.com/Blog/Post/?utm_source=x&b=2#frag')).toBe('https://suno.com/Blog/Post?b=2');
  });

  it.each([
    ['changelog', 'https://suno.com/changelog', 'official', 0.9],
    ['web', 'https://help.suno.com/en/articles/1', 'vendor', 0.8],
    ['web', 'https://www.reddit.com/r/SunoAI/comments/1', 'community', 0.4],
    ['observation', 'studio:x3lius/session-12', 'studio_observation', 0.7],
    ['web', 'https://random-blog.example.net/post', 'unknown', 0.3],
  ] as const)('%s %s → %s (%s)', (kind, uri, cls, score) => {
    expect(classifySource(kind, uri)).toMatchObject({ class: cls, score, inputs: { kind, host: expect.any(String) } });
  });
});

describe('fetch_source → write_evidence (the only path a specialist has to evidence)', () => {
  it('fetch_source registers the page as a research source with reliability + inputs, and dedups identical content', async () => {
    const tool = createFetchSourceTool({ sql: db.sql });
    const first = (await tool.handler(toolCtx(), { url: `${base}/notes` })) as { research_source_id: string; deduplicated: boolean; title: string; text: string; reliability: number };
    expect(first).toMatchObject({ deduplicated: false, title: 'Vocal descriptor order notes', reliability: 0.3 });
    expect(first.text).toContain('Leading the style prompt with the vocal descriptor');
    expect(first.text).not.toContain('ignored()');
    const again = (await tool.handler(toolCtx(), { url: `${base}/notes-copy` })) as { research_source_id: string; deduplicated: boolean };
    expect(again).toEqual(expect.objectContaining({ research_source_id: first.research_source_id, deduplicated: true }));
  });

  it('write_evidence refuses before touching the DB when a field is missing', async () => {
    const tool = createWriteEvidenceTool({ sql: db.sql });
    await expect(tool.handler(toolCtx(), { claim: 'x', confidence: 0.5, confidence_inputs: { n: 1 } })).rejects.toThrow(
      /evidence rejected: research_source_id is required; model_tag is required/,
    );
  });

  it('write_evidence records a tagged claim linked to its source, research run and agent run', async () => {
    const src = await registerResearchSource(db.sql, { researchRunId, kind: 'web', uri: `${base}/notes`, title: 't', contentSha256: 'c'.repeat(64) });
    const tool = createWriteEvidenceTool({ sql: db.sql });
    const out = (await tool.handler(toolCtx(), {
      research_source_id: src.id,
      claim: 'Leading the style prompt with the vocal descriptor held timbre in 8 of 10 generations.',
      model_tag: 'suno-v4.5',
      confidence: 0.8,
      confidence_inputs: { observed: '8/10 generations' },
      claim_topic: 'suno.vocal-descriptor-position',
      claim_value: 'first',
    })) as { evidence_id: string };
    const [row] = await db.sql<{ research_run_id: string; agent_run_id: string; specialist: string; model_tag: string }[]>`
      select research_run_id, agent_run_id, specialist, model_tag from research_evidence where id = ${out.evidence_id}`;
    expect(row).toEqual({ research_run_id: researchRunId, agent_run_id: agentRunId, specialist: 'suno-researcher', model_tag: 'suno-v4.5' });
  });
});

describe('finding confidence: every input shown, single-source findings capped', () => {
  it('confidence = mean(evidence confidence x source reliability) x corroboration(k)', () => {
    const one = computeFindingConfidence([{ confidence: 0.8, reliability: 0.9, research_source_id: 's1' }]);
    expect(one.confidence).toBeCloseTo(0.8 * 0.9 * 0.75, 6);
    expect(one.inputs).toMatchObject({ independent_sources: 1, corroboration_factor: 0.75 });
    const two = computeFindingConfidence([
      { confidence: 0.8, reliability: 0.9, research_source_id: 's1' },
      { confidence: 0.6, reliability: 0.4, research_source_id: 's2' },
    ]);
    expect(two.confidence).toBeCloseTo(((0.8 * 0.9 + 0.6 * 0.4) / 2) * 1, 6);
  });
});

describe('Contradiction Engine (structured claims; runs on every new finding and candidate)', () => {
  const evidenceFor = async (value: unknown, model_tag: string, topic: string) => {
    const src = await registerResearchSource(db.sql, {
      researchRunId, kind: 'observation', uri: `studio:x3lius/${topic}/${String(value)}/${model_tag}`, title: 'studio note',
      contentSha256: Buffer.from(`${topic}${JSON.stringify(value)}${model_tag}`).toString('hex').padEnd(64, '0').slice(0, 64),
    });
    return writeEvidence(db.sql, { researchRunId, agentRunId, specialist: 'artist-identity-researcher' }, {
      research_source_id: src.id, claim: `claim ${String(value)}`, model_tag, confidence: 0.7, confidence_inputs: { note: 'studio listening' }, claim_topic: topic, claim_value: value,
    });
  };

  it('blocks a finding that deliberately contradicts the live canonical X3LIUS voice reference', async () => {
    const wrong = ['soft pop ballad', 'gentle', 'English only'];
    const ev = await evidenceFor(wrong, 'model-agnostic', 'x3lius.voice-reference');
    const f = await recordFinding(db.sql, {
      researchRunId, claim: 'X3LIUS should sound like a soft English-only pop ballad.', claim_topic: 'x3lius.voice-reference',
      claim_value: wrong, model_tag: 'model-agnostic', evidenceIds: [ev],
    });
    expect(f.contradictions).toEqual([
      expect.objectContaining({ target_type: 'canonical_prompt', detail: expect.objectContaining({ target_slug: 'phase-8-meta-prompt', target_value: VOICE, finding_value: wrong }) }),
    ]);
    const c = await proposeCandidate(db.sql, { findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: 'x3lius-voice-soft-pop', title: 'Soft pop voice', body: 'Soft pop ballad voice.', domain: 'RECORDS' });
    expect(await candidateEligibility(db.sql, c)).toMatchObject({ blocked: true, openContradictions: 1 });
  });

  it('lets a non-conflicting finding through (eligible)', async () => {
    const ev = await evidenceFor('first', 'suno-v4.5', 'suno.vocal-descriptor-position');
    const f = await recordFinding(db.sql, {
      researchRunId, claim: 'Lead the Suno v4.5 style prompt with the vocal descriptor.', claim_topic: 'suno.vocal-descriptor-position',
      claim_value: 'first', model_tag: 'suno-v4.5', evidenceIds: [ev],
    });
    expect(f.contradictions).toEqual([]);
    const c = await proposeCandidate(db.sql, { findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: 'suno-v45-vocal-descriptor-first', title: 'Vocal descriptor first', body: 'Lead the style prompt with the vocal descriptor.', domain: 'RECORDS' });
    expect(await candidateEligibility(db.sql, c)).toMatchObject({ blocked: false, openContradictions: 0 });
  });

  it('scopes by model version: a suno-v5 finding does NOT contradict a suno-v4.5 rule (both can stand)', async () => {
    const ev = await evidenceFor('last', 'suno-v5', 'suno.vocal-descriptor-position');
    const f = await recordFinding(db.sql, {
      researchRunId, claim: 'On Suno v5 the vocal descriptor works best last.', claim_topic: 'suno.vocal-descriptor-position',
      claim_value: 'last', model_tag: 'suno-v5', evidenceIds: [ev],
    });
    expect(f.contradictions).toEqual([]);
  });

  it('same version, different value → contradiction, and both sides are blocked', async () => {
    const ev = await evidenceFor('middle', 'suno-v4.5', 'suno.vocal-descriptor-position');
    const f = await recordFinding(db.sql, {
      researchRunId, claim: 'On Suno v4.5 the vocal descriptor works best mid-prompt.', claim_topic: 'suno.vocal-descriptor-position',
      claim_value: 'middle', model_tag: 'suno-v4.5', evidenceIds: [ev],
    });
    expect(f.contradictions).toEqual([expect.objectContaining({ target_type: 'knowledge_candidate' })]);
    const [first] = await db.sql<{ id: string }[]>`select id from knowledge_candidates where target_slug = 'suno-v45-vocal-descriptor-first'`;
    expect(await candidateEligibility(db.sql, first!.id)).toMatchObject({ blocked: true });
  });

  it('refuses mixed model versions inside one finding', async () => {
    const a = await evidenceFor('x', 'suno-v4.5', 'suno.mixed-probe');
    const b = await evidenceFor('x', 'suno-v5', 'suno.mixed-probe');
    await expect(
      recordFinding(db.sql, { researchRunId, claim: 'mixed', claim_topic: 'suno.mixed-probe', claim_value: 'x', model_tag: 'suno-v4.5', evidenceIds: [a, b] }),
    ).rejects.toThrow(/evidence .* is tagged suno-v5, finding is suno-v4\.5/);
  });

  it('reports canonical rows it could not check instead of passing them silently', async () => {
    const ev = await evidenceFor('y', 'model-agnostic', 'x3lius.unchecked-probe');
    const f = await recordFinding(db.sql, { researchRunId, claim: 'probe', claim_topic: 'x3lius.unchecked-probe', claim_value: 'y', model_tag: 'model-agnostic', evidenceIds: [ev] });
    expect(f.coverage).toEqual({ canonicalRowsWithClaims: 1, canonicalRowsUncheckable: 30 });
  });
});

describe('resolution + role separation', () => {
  it('research cannot write or resolve contradictions (42501); the engine writes them via trigger', async () => {
    const [c] = await db.sql<{ id: string }[]>`select id from contradictions limit 1`;
    await expectPgError(() => as('xyp_research', (tx) => tx`update contradictions set status = 'resolved_manual' where id = ${c!.id}`), '42501');
    await expectPgError(
      () => as('xyp_research', (tx) => tx`insert into contradictions (finding_id, target_type, target_id, detail) select finding_id, target_type, target_id, detail from contradictions limit 1`),
      '42501',
    );
  });

  it('the verifier resolves manually with a reason → candidate becomes eligible; it cannot write findings (42501)', async () => {
    const [c] = await db.sql<{ id: string; candidate: string }[]>`
      select ct.id, kc.id as candidate from contradictions ct join knowledge_candidates kc on kc.finding_id = ct.finding_id
      where kc.target_slug = 'x3lius-voice-soft-pop'`;
    await resolveContradiction(db.sql, c!.id, { method: 'manual', reason: 'Rejected: conflicts with the X3LIUS voice reference; keep canonical.' });
    expect(await candidateEligibility(db.sql, c!.candidate)).toMatchObject({ blocked: false, openContradictions: 0 });
    await expectPgError(
      () => as('xyp_verifier', (tx) => tx`insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
        values (${researchRunId}, 'x', 'suno-v5', 0.5, '{}', 'suno.x', '"x"')`),
      '42501',
    );
  });
});

describe('Experiment Engine (trials recorded by a human; scoring explicitly stubbed until Phase 12)', () => {
  it('designs an A/B, records trials, and never reports a stub-scored experiment as validated', async () => {
    const [cand] = await db.sql<{ id: string }[]>`select id from knowledge_candidates where target_slug = 'suno-v45-vocal-descriptor-first'`;
    const exp = await designExperiment(db.sql, {
      candidateId: cand!.id,
      hypothesis: 'Leading the Suno v4.5 style prompt with the vocal descriptor improves timbre adherence.',
      variantA: { style: 'dark melodic trap, 140 bpm, dark baritone male vocal' },
      variantB: { style: 'dark baritone male vocal, dark melodic trap, 140 bpm' },
      nPerVariant: 2,
    });
    for (const variant of ['a', 'b'] as const) {
      for (const trial of [1, 2]) {
        await recordTrial(db.sql, { experimentId: exp, variant, trial, output: { take: `${variant}${trial}`, notes: 'recorded by hand' } });
      }
    }
    const result = await experimentResult(db.sql, exp);
    expect(result).toMatchObject({ status: 'complete', trials: { a: 2, b: 2 }, validated: false, scoredBy: [STUB_SCORER] });
    expect(result.reason).toMatch(/no evaluator until Phase 12/);
    const scores = await db.sql<{ score: string | null }[]>`select score from experiment_runs where experiment_id = ${exp}`;
    expect(scores.every((s) => s.score === null)).toBe(true);
  });
});
