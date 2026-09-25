import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';

export const AUDIO_TOOLS_AGENT = 'tech-audio-tools';
export const TRACE_SERVICE_USAGE =
  'TRACE analyses arrive over the TRACE service, not as text: run `pnpm trace:serve` (XYP_TRACE_TOKEN set), then POST /v1/trace/analyses with a trace.analysis/v1 body (tech/trace/schemas/trace.analysis.v1.schema.json); the answer is a trace.report/v1.';

/**
 * tech-audio-tools (Phase 14, Execution, deterministic): the TRACE intake. Performs exactly one of
 * - `{ record: { analysis, takeId } }` — store a trace.analysis/v1 as received (record_trace_analysis);
 * - `{ link: { analysisId, mixReportArtifactId } }` — link the report that checked it (link_trace_report).
 * It measures nothing and judges nothing: TRACE measures, X3LIUS Mix/Master checks the rubric.
 * @param ctx - run context; the two trace.write tools carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const audioTools: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (['record', 'link'] as const).filter((k) => i[k] !== undefined);
  if (ops.length !== 1) {
    throw new Error(`tech-audio-tools input needs exactly one of record, link${typeof i.request === 'string' ? `. ${TRACE_SERVICE_USAGE}` : ''}`);
  }
  const tool = ops[0] === 'record' ? 'record_trace_analysis' : 'link_trace_report';
  return { output: await ctx.useTool(tool, i[ops[0]!]), tokensUsed: 0 };
};
