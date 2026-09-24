import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { BUILT_SUBDOMAINS, HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { selectNormalizer } from '../../knowledge/ingestion/normalizers/index.ts';
import { detectMixRubric, MIX_RUBRIC_NORMALIZER_ID, normalizeMixRubric } from '../../knowledge/ingestion/normalizers/mix-rubric.ts';
import { FIRST_PARTY_ADMISSION_ERROR } from '../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { checkMetric, MIX_RUBRIC_FILE, mixMaster } from '../../records/x3lius/mix-master/agent.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { TRACE_ANALYSIS_SCHEMA_ID, TRACE_BANDS, TRACE_METRICS, traceMetrics, validateTraceAnalysis, type TraceAnalysis } from '../../tech/trace/analysis.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// Phase 11: the TRACE-shaped analysis contract (trace.analysis/v1, owned by TECH), the X3LIUS
// mix/master rubric as canonical claims (xyp-mix-rubric/v1, admitted through the gate), and the
// deterministic x3lius-mix-master agent that checks one against the other (ARCHITECTURE F10, F24).
//
// FIXTURE: the analysis and the rubric below are synthetic ("[FIXTURE]" in every text field; the
// numbers are made up) and are admitted only into this throwaway database. The real rubric is
// operator-authored (records/x3lius/mix-rubric.yaml).

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const ANALYSIS: TraceAnalysis = {
  schema: 'trace.analysis/v1',
  producer: { tool: '[FIXTURE] TRACE', version: '0.0.0' },
  subject: { stage: 'master', label: '[FIXTURE] night drive, master bounce 3' },
  audio: { sampleRateHz: 48000, durationSec: 182.5 },
  loudness: { integratedLufs: -12.3, shortTermMaxLufs: -9.1, momentaryMaxLufs: -7.4, rangeLu: 5.2, truePeakDbtp: -0.2 },
  tonalBalanceDb: { sub: -9.5, bass: -4.1, 'low-mid': -8.7, mid: -9.9, 'high-mid': -13.2, presence: -16.8, air: -19.4 },
  stereo: {
    correlation: 0.62, widthPct: 31,
    bands: {
      sub: { correlation: 0.97, widthPct: 7 }, bass: { correlation: 0.93, widthPct: 9 }, 'low-mid': { correlation: 0.81, widthPct: 18 },
      mid: { correlation: 0.64, widthPct: 30 }, 'high-mid': { correlation: 0.52, widthPct: 38 }, presence: { correlation: 0.48, widthPct: 41 }, air: { correlation: 0.41, widthPct: 44 },
    },
  },
  dynamics: { crestFactorDb: 9.8 },
};
const analysisWith = (edit: (a: Mutable<TraceAnalysis>) => void): TraceAnalysis => {
  const a = structuredClone(ANALYSIS) as Mutable<TraceAnalysis>;
  edit(a);
  return a;
};

const RUBRIC = (integrated = '{ min: -10, max: -8 }') => `# [FIXTURE] synthetic rubric for the Phase 11 tests
mix_rubric: xyp-mix-rubric/v1
artist: X3LIUS
date: 2026-09-24
module: x3lius-mix-master
master:
  loudness.integrated-lufs: ${integrated}
  loudness.true-peak-dbtp: { max: -1 }
  loudness.range-lu: { min: 4 }
  stereo.sub.width-pct: { max: 5 }
mix:
  loudness.true-peak-dbtp: { max: -6 }
`;
const MASTER_TOPICS = ['x3lius.master.loudness.integrated-lufs', 'x3lius.master.loudness.range-lu', 'x3lius.master.loudness.true-peak-dbtp', 'x3lius.master.stereo.sub.width-pct'];
const TOPIC = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/; // knowledge_candidates_claim_topic_check

type Check = { metric: string; unit: string; measured: number; rubric: { min?: number; max?: number }; action: string; by: number; ref: string; version: number };
type MixOut = {
  subdomain: string; status: string; artifact: { id: string; version: number; schemaId: string };
  body: { stage: string; analysis: TraceAnalysis; checks: Check[]; unset: string[] };
  knowledge: { rubricClaims: number; unset: number; reasons: string[] };
  context: { ref: string; topic: string; version: number }[];
};

describe('trace.analysis/v1: the one TRACE contract', () => {
  it('accepts a complete analysis and flattens it into every contract metric, in order', () => {
    expect(validateTraceAnalysis(ANALYSIS)).toEqual([]);
    expect(TRACE_METRICS).toHaveLength(5 + TRACE_BANDS.length + 2 + 2 * TRACE_BANDS.length + 1);
    expect(new Set(TRACE_METRICS.map((m) => m.id)).size).toBe(TRACE_METRICS.length);
    // Every metric id makes a valid claim topic under either stage, so research can propose a bound.
    for (const m of TRACE_METRICS) for (const s of ['mix', 'master']) expect(`x3lius.${s}.${m.id}`).toMatch(TOPIC);
    const m = traceMetrics(ANALYSIS);
    expect(m.map((x) => x.id)).toEqual(TRACE_METRICS.map((x) => x.id));
    expect(m.find((x) => x.id === 'loudness.integrated-lufs')).toEqual({ id: 'loudness.integrated-lufs', unit: 'LUFS', value: -12.3 });
    expect(m.find((x) => x.id === 'stereo.sub.width-pct')).toEqual({ id: 'stereo.sub.width-pct', unit: '%', value: 7 });
    expect(m.find((x) => x.id === 'tonal.low-mid-db')?.value).toBe(-8.7);
  });

  it.each([
    ['another contract id', (a: Mutable<TraceAnalysis>) => { (a as { schema: string }).schema = 'trace.analysis/v2'; }, /\$\.schema must be one of trace\.analysis\/v1/],
    ['an unknown stage', (a: Mutable<TraceAnalysis>) => { (a.subject as { stage: string }).stage = 'stems'; }, /\$\.subject\.stage must be one of mix, master/],
    ['a missing band', (a: Mutable<TraceAnalysis>) => { delete (a.tonalBalanceDb as Partial<Record<string, number>>).air; }, /\$\.tonalBalanceDb\.air is required/],
    ['an extra field', (a: Mutable<TraceAnalysis>) => { (a.loudness as Record<string, number>).peakDbfs = -1; }, /\$\.loudness\.peakDbfs is not allowed/],
    ['a string for a number', (a: Mutable<TraceAnalysis>) => { (a.loudness as Record<string, unknown>).integratedLufs = '-9'; }, /\$\.loudness\.integratedLufs must be number/],
    ['a correlation above 1', (a: Mutable<TraceAnalysis>) => { a.stereo.correlation = 1.2; }, /\$\.stereo\.correlation must be from -1 to 1/],
    ['a band width above 100 %', (a: Mutable<TraceAnalysis>) => { a.stereo.bands.air.widthPct = 120; }, /\$\.stereo\.bands\.air\.widthPct must be from 0 to 100/],
    ['a band louder than the full band', (a: Mutable<TraceAnalysis>) => { a.tonalBalanceDb.bass = 1.5; }, /\$\.tonalBalanceDb\.bass must be ≤ 0/],
    ['a negative loudness range', (a: Mutable<TraceAnalysis>) => { a.loudness.rangeLu = -1; }, /\$\.loudness\.rangeLu must not be negative/],
    ['a zero sample rate', (a: Mutable<TraceAnalysis>) => { a.audio.sampleRateHz = 0; }, /\$\.audio\.sampleRateHz must be positive/],
    ['an empty label', (a: Mutable<TraceAnalysis>) => { a.subject.label = ' '; }, /\$\.subject\.label must not be empty/],
  ])('refuses %s', (_, edit, error) => {
    expect(validateTraceAnalysis(analysisWith(edit)).join('; ')).toMatch(error);
  });
});

describe('mix rubric normalizer (xyp-mix-rubric/v1): bounds as claims scoped trace, one row', () => {
  it('is selected for a rubric file and only for one', () => {
    expect(MIX_RUBRIC_NORMALIZER_ID).toBe('xyp-mix-rubric-v1');
    expect(selectNormalizer([RUBRIC()])?.id).toBe(MIX_RUBRIC_NORMALIZER_ID);
    expect(detectMixRubric(['mix_rubric: something-else/v1'])).toBe(false);
    expect(detectMixRubric([RUBRIC(), 'a second page'])).toBe(false);
  });

  it('yields one prompt in the manifest’s Mix/Master module with one claim per bound', () => {
    const doc = normalizeMixRubric([RUBRIC()]);
    expect(doc.modules).toEqual([]);
    expect(doc.prompts).toHaveLength(1);
    const p = doc.prompts[0]!;
    expect(p).toMatchObject({ moduleSlug: 'x3lius-mix-master', slug: 'x3lius-mix-rubric', title: 'X3LIUS Mix/Master Rubric', modelTag: 'trace', tags: ['x3lius-mix-master'] });
    expect(p.structured).toEqual({
      schema: 'xyp-mix-rubric/v1',
      analysis: 'trace.analysis/v1',
      claims: [
        { topic: 'x3lius.mix.loudness.true-peak-dbtp', value: { max: -6 }, model_scope: 'trace' },
        { topic: 'x3lius.master.loudness.integrated-lufs', value: { min: -10, max: -8 }, model_scope: 'trace' },
        { topic: 'x3lius.master.loudness.true-peak-dbtp', value: { max: -1 }, model_scope: 'trace' },
        { topic: 'x3lius.master.loudness.range-lu', value: { min: 4 }, model_scope: 'trace' },
        { topic: 'x3lius.master.stereo.sub.width-pct', value: { max: 5 }, model_scope: 'trace' },
      ],
    });
    expect(p.body).toContain('Master: loudness.integrated-lufs -10 to -8 LUFS; loudness.true-peak-dbtp at most -1 dBTP');
    expect(p.body).toContain('Mix: loudness.true-peak-dbtp at most -6 dBTP.');
  });

  it.each([
    ['a placeholder bound', (t: string) => t.replace('{ max: -1 }', '{ max: REQUIRED }'), /master\.loudness\.true-peak-dbtp\.max is a placeholder \("REQUIRED"\): give the real value/],
    ['a metric outside the contract', (t: string) => t.replace('loudness.range-lu', 'loudness.vibe'), /master: loudness\.vibe is not a trace\.analysis\/v1 metric/],
    ['min above max', (t: string) => t.replace('{ min: -10, max: -8 }', '{ min: -8, max: -10 }'), /min -8 is above max -10/],
    ['a bound with no side', (t: string) => t.replace('{ min: 4 }', '{}'), /master\.loudness\.range-lu needs min, max or both/],
    ['an unknown bound field', (t: string) => t.replace('{ min: 4 }', '{ min: 4, target: 5 }'), /master\.loudness\.range-lu: unknown field: target/],
    ['a non-number bound', (t: string) => t.replace('{ min: 4 }', '{ min: loud }'), /master\.loudness\.range-lu\.min must be a number/],
    ['an unknown top-level field', (t: string) => `${t}stems:\n  x: 1\n`, /unknown field: stems/],
    ['no stage at all', (t: string) => t.replace(/master:[\s\S]*$/, ''), /state at least one stage: mix or master/],
    ['an empty stage', (t: string) => t.replace(/mix:\n.*\n$/, 'mix: {}\n'), /mix must be a mapping of trace\.analysis\/v1 metric ids to bounds/],
  ])('refuses %s, loudly (never half-normalized)', (_, edit, error) => {
    expect(() => normalizeMixRubric([edit(RUBRIC())])).toThrow(error);
  });

  it('the operator draft names only contract metrics (its values are the operator’s to give)', () => {
    const draft = readFileSync(join(REPO_ROOT, MIX_RUBRIC_FILE), 'utf8');
    expect(detectMixRubric([draft])).toBe(true);
    // Structure only: every placeholder becomes a number, so any key the contract lacks still fails.
    expect(() => normalizeMixRubric([draft.replaceAll('REQUIRED', '0')])).not.toThrow();
  });
});

describe('checkMetric: nearest bound, signed by action', () => {
  const claim = { version: 3 } as Parameters<typeof checkMetric>[1]['claim'];
  const b = (bound: { min?: number; max?: number }) => ({ bound, claim, ref: 'canonical_prompts:x#t' });
  const m = (value: number) => ({ id: 'loudness.integrated-lufs', unit: 'LUFS', value });
  it.each([
    [-12.3, { min: -10, max: -8 }, 'raise', 2.3],
    [-7.2, { min: -10, max: -8 }, 'lower', 0.8],
    [-9, { min: -10, max: -8 }, 'keep', 0],
    [-8, { min: -10, max: -8 }, 'keep', 0],
    [-20, { max: -8 }, 'keep', 0],
    [-20, { min: -10 }, 'raise', 10],
  ])('%d against %j → %s %d', (value, bound, action, by) => {
    expect(checkMetric(m(value), b(bound))).toEqual({ metric: 'loudness.integrated-lufs', unit: 'LUFS', measured: value, rubric: bound, action, by, ref: 'canonical_prompts:x#t', version: 3 });
  });
});

describe('x3lius-mix-master reads the rubric strictly', () => {
  const item = (id: string, topic: string, value: unknown, modelScope = 'trace') => ({ ref: { table: 'canonical_prompts', id }, slug: 's', version: 1, title: 't', module: 'x3lius-mix-master', topic, value, modelScope, source: null });
  const ctxWith = (items: unknown[]) => {
    const writes: unknown[] = [];
    const ctx = {
      agent: { model: 'none' },
      useTool: async (name: string, args: unknown) => {
        if (name === 'retrieve_claims') return { topicPrefix: (args as { topicPrefix: string }).topicPrefix, items };
        if (name === 'write_artifact') { writes.push(args); return { artifact_id: 'a', lineage_id: 'l', version: 1 }; }
        return undefined;
      },
    } as unknown as Parameters<typeof mixMaster>[0];
    return { ctx, writes };
  };
  const A = '00000000-0000-0000-0000-00000000000a';
  const B = '00000000-0000-0000-0000-00000000000b';

  it('refuses a metric bounded by two canonical rows, before writing anything', async () => {
    const { ctx, writes } = ctxWith([item(A, 'x3lius.master.loudness.integrated-lufs', { max: -8 }), item(B, 'x3lius.master.loudness.integrated-lufs', { max: -9 })]);
    await expect(mixMaster(ctx, { analysis: ANALYSIS })).rejects.toThrow(/x3lius\.master\.loudness\.integrated-lufs is stated by two canonical rows .*keep one through the gate/);
    expect(writes).toEqual([]);
  });

  it('refuses a malformed bound in a canonical claim', async () => {
    const { ctx } = ctxWith([item(A, 'x3lius.master.loudness.range-lu', { min: 'loud' })]);
    await expect(mixMaster(ctx, { analysis: ANALYSIS })).rejects.toThrow(/loudness\.range-lu\.min must be a number/);
  });

  it('leaves out claims not scoped trace and reports claims naming no contract metric', async () => {
    const { ctx } = ctxWith([
      item(A, 'x3lius.master.loudness.true-peak-dbtp', { max: -1 }),
      item(A, 'x3lius.master.loudness.integrated-lufs', { max: -30 }, 'model-agnostic'),
      item(A, 'x3lius.master.vibe', { min: 1 }),
    ]);
    const r = await mixMaster(ctx, { analysis: ANALYSIS });
    const o = r.output as MixOut;
    expect(o.body.checks.map((c) => c.metric)).toEqual(['loudness.true-peak-dbtp']);
    expect(o.knowledge.reasons.join('\n')).toMatch(/excluded 1 claim\(s\) not scoped trace: x3lius\.master\.loudness\.integrated-lufs/);
    expect(o.knowledge.reasons.join('\n')).toMatch(/ignored 1 claim\(s\) naming no trace\.analysis\/v1 metric: x3lius\.master\.vibe/);
  });
});

let db: TestDb;
let dir: string;
let embedder: Embedder;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const depsWith = (model = fakeModel()): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (agent: string, input: unknown, deps = depsWith()) => dispatch(deps, agent, input, { timeoutMs: 60_000 });
const admit = async (text: string, name: string, origin: 'first_party' | 'third_party' = 'first_party') => {
  const path = join(dir, name);
  writeFileSync(path, text);
  const r = await ingestSource(db.sql, { kind: 'file', path, origin } as Parameters<typeof ingestSource>[1]);
  await embedPending(db.sql, embedder);
  return r;
};
const rubricRows = () => db.sql<{ id: string; version: number; module: string }[]>`
  select cp.id, cp.version, m.slug as module from canonical_prompts cp join modules m on m.id = cp.module_id
  where cp.slug = 'x3lius-mix-rubric' order by cp.version`;
const artifactCount = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from creative_artifacts where schema_id = 'x3lius.mix-report/v1'`)[0]!.n;

beforeAll(async () => {
  db = await createTestDb('phase11_mix_master', { migrated: true });
  dir = mkdtempSync(join(tmpdir(), 'phase11-'));
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
});
afterAll(async () => {
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('x3lius-mix-master against the canonical rubric', () => {
  it('refuses a bare request: it needs a trace.analysis/v1 and names the contract', async () => {
    const r = await run('x3lius-mix-master', { request: 'Master the new X3LIUS track to -9 LUFS' });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/x3lius-mix-master needs analysis: a trace\.analysis\/v1 object \(tech\/trace\/analysis\.ts\)/);
  });

  it('refuses an invalid analysis with every violation named, and writes nothing', async () => {
    const before = await artifactCount();
    const r = await run('x3lius-mix-master', { analysis: analysisWith((a) => { a.stereo.correlation = 3; a.loudness.rangeLu = -2; }) });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/analysis is not a valid trace\.analysis\/v1: .*\$\.analysis\.loudness\.rangeLu must not be negative.*\$\.analysis\.stereo\.correlation must be from -1 to 1/);
    expect(await artifactCount()).toBe(before);
  });

  it('with no rubric admitted, every metric is unset: no threshold comes from code', async () => {
    const r = await run('x3lius-mix-master', { analysis: ANALYSIS });
    expect(r.status, r.error).toBe('success');
    const o = r.output as MixOut;
    expect(o.body.checks).toEqual([]);
    expect(o.body.unset).toEqual(TRACE_METRICS.map((m) => m.id));
    expect(o.knowledge.reasons.join('\n')).toContain(`no canonical master rubric: admit ${MIX_RUBRIC_FILE}`);
  });

  it('only first-party origin admits a rubric file; third-party material goes through Research Intelligence', async () => {
    const r = await admit(RUBRIC(), 'third.yaml', 'third_party');
    expect(r.status).toBe('error');
    expect(r.error).toContain(FIRST_PARTY_ADMISSION_ERROR);
  });

  it('admission writes one versioned row in the manifest’s Mix/Master module, its claims scoped trace', async () => {
    const r = await admit(RUBRIC(), 'mix-rubric.yaml');
    expect(r.status, r.error).toBe('success');
    const rows = await rubricRows();
    expect(rows).toEqual([expect.objectContaining({ version: 1, module: 'x3lius-mix-master' })]);
    const [kv] = await db.sql<{ version: number; promoted_via: string }[]>`
      select version, promoted_via from knowledge_versions where canonical_table = 'canonical_prompts' and canonical_id = ${rows[0]!.id}`;
    expect(kv).toEqual({ version: 1, promoted_via: 'gate' });
    const claims = await db.sql<{ topic: string; model_scope: string }[]>`
      select topic, model_scope from canonical_claims where canonical_prompt_id = ${rows[0]!.id} order by topic`;
    expect(claims.map((c) => c.topic)).toEqual([...MASTER_TOPICS, 'x3lius.mix.loudness.true-peak-dbtp']);
    expect(new Set(claims.map((c) => c.model_scope))).toEqual(new Set(['trace']));
  });

  it('checks a master analysis: keep, raise or lower by how much, each citing its claim and version (no LLM)', async () => {
    const [row] = await rubricRows();
    const r = await run('x3lius-mix-master', { analysis: ANALYSIS });
    expect(r.status, r.error).toBe('success');
    const o = r.output as MixOut;
    const ref = (m: string) => `canonical_prompts:${row!.id}#x3lius.master.${m}`;
    expect(o.body.checks).toEqual([
      { metric: 'loudness.integrated-lufs', unit: 'LUFS', measured: -12.3, rubric: { min: -10, max: -8 }, action: 'raise', by: 2.3, ref: ref('loudness.integrated-lufs'), version: 1 },
      { metric: 'loudness.range-lu', unit: 'LU', measured: 5.2, rubric: { min: 4 }, action: 'keep', by: 0, ref: ref('loudness.range-lu'), version: 1 },
      { metric: 'loudness.true-peak-dbtp', unit: 'dBTP', measured: -0.2, rubric: { max: -1 }, action: 'lower', by: 0.8, ref: ref('loudness.true-peak-dbtp'), version: 1 },
      { metric: 'stereo.sub.width-pct', unit: '%', measured: 7, rubric: { max: 5 }, action: 'lower', by: 2, ref: ref('stereo.sub.width-pct'), version: 1 },
    ]);
    expect(o.body.unset).toHaveLength(TRACE_METRICS.length - 4);
    expect(o.body.unset).not.toContain('loudness.integrated-lufs');
    expect(o.knowledge).toMatchObject({ rubricClaims: 4, unset: TRACE_METRICS.length - 4 });
    expect(o.context.map((c) => c.topic).sort()).toEqual(MASTER_TOPICS);

    // The report is an artifact: schema-validated, the analysis kept with it, written by this run.
    const [a] = await db.sql<{ schema_id: string; agent_name: string; body: MixOut['body']; model: string }[]>`
      select schema_id, agent_name, body, model from creative_artifacts where id = ${o.artifact.id}`;
    expect(a).toMatchObject({ schema_id: 'x3lius.mix-report/v1', agent_name: 'x3lius-mix-master', model: 'none' });
    expect(a!.body).toEqual(o.body);
    expect(a!.body.analysis.schema).toBe(TRACE_ANALYSIS_SCHEMA_ID);
    const [log] = await db.sql<{ output: { logs: { message: string }[] }; tokens_used: number }[]>`select output, tokens_used from agent_runs where id = ${r.runId}`;
    expect(log!.tokens_used).toBe(0);
    expect(log!.output.logs.map((l) => l.message)).toContainEqual(
      'x3lius-mix-master: master "[FIXTURE] night drive, master bounce 3": 4 checked, 3 to move (raise loudness.integrated-lufs by 2.3 LUFS; lower loudness.true-peak-dbtp by 0.8 dBTP; lower stereo.sub.width-pct by 2 %), 25 unset',
    );
  });

  it('a mix analysis is checked against the mix bounds only', async () => {
    const r = await run('x3lius-mix-master', { analysis: analysisWith((a) => { a.subject.stage = 'mix'; }) });
    expect(r.status, r.error).toBe('success');
    const o = r.output as MixOut;
    expect(o.body.checks).toEqual([expect.objectContaining({ metric: 'loudness.true-peak-dbtp', rubric: { max: -6 }, action: 'lower', by: 5.8 })]);
  });

  it('the rubric never reaches a creative prompt: it is scoped to the TRACE check', async () => {
    const model = fakeModel();
    const r = await run('x3lius-lyrics', { request: 'An X3LIUS track about the city at night' }, depsWith(model));
    expect(r.status, r.error).toBe('success');
    expect(model.calls[0]!.system).not.toContain('x3lius.master.');
    expect(model.calls[0]!.system).not.toContain('x3lius.mix.');
    expect((r.output as { knowledge: { reasons: string[] } }).knowledge.reasons.join('\n')).toMatch(/excluded 5 canonical entries scoped to a specific model or tool/);
  });

  it('a rubric change is a new version, and the next report cites it', async () => {
    const changed = await admit(RUBRIC('{ min: -13, max: -11 }'), 'mix-rubric-v2.yaml');
    expect(changed.status, changed.error).toBe('success');
    const rows = await rubricRows();
    expect(rows.map((x) => x.version)).toEqual([1, 2]);
    const o = (await run('x3lius-mix-master', { analysis: ANALYSIS })).output as MixOut;
    expect(o.body.checks[0]).toMatchObject({ metric: 'loudness.integrated-lufs', rubric: { min: -13, max: -11 }, action: 'keep', by: 0, ref: `canonical_prompts:${rows[1]!.id}#x3lius.master.loudness.integrated-lufs`, version: 2 });
  });
});

describe('registry: Phase 11 Mix/Master', () => {
  it('x3lius-mix-master is a deterministic Creative agent that reads claims and writes its report', () => {
    expect(registry.get('x3lius-mix-master')).toMatchObject({ class: 'Creative', domain: 'RECORDS', model: 'none', tools: ['retrieve_claims', 'write_artifact', 'log_message'] });
    expect(HANDLERS['x3lius-mix-master']).toBe(mixMaster);
    expect(BUILT_SUBDOMAINS).toContain('x3lius-mix-master');
    expect(loadMusicSystem().subdomains.find((s) => s.slug === 'x3lius-mix-master')).toMatchObject({ builtIn: '11' });
    expect(registry.validateAll()).toEqual([]);
  });
});
