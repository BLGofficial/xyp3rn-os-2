import type { ClaimBundle, ClaimItem } from '../../../core/context-engine/context-engine.ts';
import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import { parseRubricBound, RUBRIC_SCOPE, type RubricBound } from '../../../knowledge/ingestion/normalizers/mix-rubric.ts';
import { TRACE_ANALYSIS_SCHEMA_ID, traceMetrics, validateTraceAnalysis, type TraceAnalysis, type TraceMetric } from '../../../tech/trace/analysis.ts';
import { CLAIM_NAMESPACE } from '../creative/types.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';

/**
 * x3lius-mix-master (Phase 11, Creative, deterministic; replaces the Phase 7 stub). It checks one
 * trace.analysis/v1 against the canonical mix/master rubric and writes the result as an
 * x3lius.mix-report/v1 artifact. For every metric the rubric bounds, the report says keep, raise
 * or lower, by how much, and which rubric claim (ref and version) says so. Metrics the rubric
 * doesn't bound are listed as unset, never checked against a default.
 *
 * No threshold lives in code. The bounds are canonical claims `x3lius.<stage>.<metric>`, scoped
 * `trace`, admitted through the gate (records/x3lius/mix-rubric.yaml, or research candidates), so
 * a rubric change is a new canonical version and the next report follows it with no code change.
 */

export const MIX_RUBRIC_FILE = 'records/x3lius/mix-rubric.yaml';
const CONTRACT_FILE = 'tech/trace/analysis.ts';

type Bound = { readonly bound: RubricBound; readonly claim: ClaimItem; readonly ref: string };
export type MixCheck = {
  readonly metric: string; readonly unit: string; readonly measured: number; readonly rubric: RubricBound;
  readonly action: 'keep' | 'raise' | 'lower'; readonly by: number; readonly ref: string; readonly version: number;
};

/** Rounded to 2 decimals so float noise (−9 − −12.3 = 3.3000000000000007) never reaches a report. */
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * @param m - measured metric
 * @param b - its rubric bound
 * @returns the check: raise to min, lower to max, or keep
 */
export const checkMetric = (m: TraceMetric, b: Bound): MixCheck => {
  const { min, max } = b.bound;
  const [action, by] = min !== undefined && m.value < min ? ['raise', min - m.value] as const
    : max !== undefined && m.value > max ? ['lower', m.value - max] as const
      : ['keep', 0] as const;
  return { metric: m.id, unit: m.unit, measured: m.value, rubric: b.bound, action, by: round(by), ref: b.ref, version: b.claim.version };
};

/**
 * Reads the rubric for one stage: current claims under `x3lius.<stage>.`, scoped `trace`.
 * @returns bounds by metric id, plus what was left out and why
 * @throws Error when two current rows bound the same metric (two sources of truth) or a bound is malformed
 */
const readRubric = async (ctx: Parameters<AgentHandler>[0], stage: string, metricIds: ReadonlySet<string>) => {
  const prefix = `${CLAIM_NAMESPACE}${stage}.`;
  const bundle = (await ctx.useTool('retrieve_claims', { topicPrefix: prefix })) as ClaimBundle;
  const bounds = new Map<string, Bound>();
  const excluded: string[] = [];
  const unknown: string[] = [];
  for (const c of bundle.items) {
    if (c.modelScope !== RUBRIC_SCOPE) { excluded.push(c.topic); continue; }
    const metric = c.topic.slice(prefix.length);
    if (!metricIds.has(metric)) { unknown.push(c.topic); continue; }
    const ref = `canonical_prompts:${c.ref.id}#${c.topic}`;
    const prior = bounds.get(metric);
    if (prior) throw new Error(`rubric: ${c.topic} is stated by two canonical rows (${prior.ref}, ${ref}); keep one through the gate`);
    bounds.set(metric, { bound: parseRubricBound(c.value, ref), claim: c, ref });
  }
  return { bounds, excluded, unknown };
};

/**
 * @param ctx - run context
 * @param input - `{ analysis: trace.analysis/v1, request? }`
 * @returns `{ subdomain, status: 'checked', artifact, body: { stage, analysis, checks, unset }, knowledge, context }`
 */
export const mixMaster: AgentHandler = async (ctx, input) => {
  const o = (input ?? {}) as { analysis?: unknown; request?: unknown };
  if (o.analysis === undefined) {
    throw new Error(`x3lius-mix-master needs analysis: a ${TRACE_ANALYSIS_SCHEMA_ID} object (${CONTRACT_FILE}). TRACE itself is wired in Phase 14.`);
  }
  const errors = validateTraceAnalysis(o.analysis, '$.analysis');
  if (errors.length > 0) throw new Error(`analysis is not a valid ${TRACE_ANALYSIS_SCHEMA_ID}: ${errors.join('; ')}`);
  const analysis = o.analysis as TraceAnalysis;
  const stage = analysis.subject.stage;
  const metrics = traceMetrics(analysis);
  const { bounds, excluded, unknown } = await readRubric(ctx, stage, new Set(metrics.map((m) => m.id)));

  const checks = metrics.filter((m) => bounds.has(m.id)).map((m) => checkMetric(m, bounds.get(m.id)!));
  const unset = metrics.filter((m) => !bounds.has(m.id)).map((m) => m.id);
  const moves = checks.filter((c) => c.action !== 'keep');
  const knowledge = {
    rubricClaims: bounds.size,
    unset: unset.length,
    reasons: [
      `${stage}: ${bounds.size} rubric claim(s) under ${CLAIM_NAMESPACE}${stage}.* scoped ${RUBRIC_SCOPE}`,
      ...(bounds.size === 0 ? [`no canonical ${stage} rubric: admit ${MIX_RUBRIC_FILE} (pnpm ingest --file ${MIX_RUBRIC_FILE} --origin first_party)`] : []),
      ...(excluded.length > 0 ? [`excluded ${excluded.length} claim(s) not scoped ${RUBRIC_SCOPE}: ${excluded.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`ignored ${unknown.length} claim(s) naming no ${TRACE_ANALYSIS_SCHEMA_ID} metric: ${unknown.join(', ')}`] : []),
    ],
  };
  await ctx.useTool('log_message', {
    message: `x3lius-mix-master: ${stage} "${analysis.subject.label}": ${checks.length} checked, ${moves.length} to move${moves.length > 0 ? ` (${moves.map((c) => `${c.action} ${c.metric} by ${c.by} ${c.unit}`).join('; ')})` : ''}, ${unset.length} unset`,
  });
  if (bounds.size === 0 || unknown.length > 0) await ctx.useTool('log_message', { level: 'warn', message: `x3lius-mix-master: ${knowledge.reasons.slice(1).join(' | ')}` });

  const body = { stage, analysis, checks, unset };
  const context = [...bounds.values()].map(({ claim: c, ref }) => ({ kind: 'claim', ref, module: c.module, slug: c.slug, topic: c.topic, value: c.value, modelScope: c.modelScope, version: c.version, source: c.source }));
  const brief = typeof o.request === 'string' && o.request.trim() !== '' ? o.request : `${stage} check of "${analysis.subject.label}" (${analysis.producer.tool} ${analysis.producer.version})`;
  const written = (await ctx.useTool('write_artifact', { schemaId: MIX_REPORT_SCHEMA_ID, brief, body, contextRefs: context, knowledge, model: ctx.agent.model })) as { artifact_id: string; lineage_id: string; version: number };
  return {
    output: {
      subdomain: 'x3lius-mix-master',
      status: 'checked',
      artifact: { id: written.artifact_id, lineageId: written.lineage_id, version: written.version, schemaId: MIX_REPORT_SCHEMA_ID },
      body,
      knowledge,
      context,
    },
    tokensUsed: 0,
  };
};
