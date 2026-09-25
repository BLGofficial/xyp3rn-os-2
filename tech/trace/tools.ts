import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { validateTraceAnalysis, type TraceAnalysis } from './analysis.ts';

/** The DB role the TRACE intake writes as (migration 20260925120000): trace_analyses only. */
export const TRACE_INTAKE_ROLE = 'xyp_trace_intake';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const asIntake = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(TRACE_INTAKE_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * record_trace_analysis (trace.write, Phase 14): stores one trace.analysis/v1 as received, after the
 * contract's own validator (tech/trace/analysis.ts) passes it, optionally with the Suno take whose
 * render it measured. The row's schema id is the body's own.
 * @param deps - pool; writes as xyp_trace_intake
 * @returns the tool definition
 */
export const createRecordTraceAnalysisTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'record_trace_analysis',
    capability: 'trace.write',
    description: 'Store one trace.analysis/v1 as received (validated first), optionally with its Suno take.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { analysis?: unknown; takeId?: unknown };
      const errors = validateTraceAnalysis(a.analysis, '$.analysis');
      if (errors.length > 0) throw new Error(`record_trace_analysis: not a valid trace.analysis/v1: ${errors.join('; ')}`);
      if (a.takeId !== undefined && a.takeId !== null && (typeof a.takeId !== 'string' || !UUID.test(a.takeId))) {
        throw new Error('record_trace_analysis: takeId must be a uuid or null');
      }
      const analysis = a.analysis as TraceAnalysis;
      const [row] = await asIntake(deps.sql, (tx) => tx<{ id: string }[]>`
        insert into trace_analyses (schema_id, body, take_id, agent_run_id)
        values (${analysis.schema}, ${tx.json(analysis as unknown as postgres.JSONValue)}, ${(a.takeId as string | null | undefined) ?? null}, ${ctx.runId})
        returning id`);
      ctx.log('info', `record_trace_analysis: ${row!.id} (${analysis.subject.stage} "${analysis.subject.label}", ${analysis.producer.tool} ${analysis.producer.version})`);
      return { analysisId: row!.id, stage: analysis.subject.stage, label: analysis.subject.label };
    },
  });

/**
 * link_trace_report (trace.write, Phase 14): links an analysis to the mix report that checked it,
 * once. The DB refuses a second link, and a report that isn't a x3lius.mix-report/v1 of this very
 * analysis.
 * @param deps - pool; writes as xyp_trace_intake (UPDATE of that one column only)
 * @returns the tool definition
 */
export const createLinkTraceReportTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'link_trace_report',
    capability: 'trace.write',
    description: 'Link a stored trace analysis to the x3lius.mix-report/v1 that checked it, once.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { analysisId?: unknown; mixReportArtifactId?: unknown };
      for (const k of ['analysisId', 'mixReportArtifactId'] as const) {
        if (typeof a[k] !== 'string' || !UUID.test(a[k] as string)) throw new Error(`link_trace_report: ${k} must be a uuid`);
      }
      const rows = await asIntake(deps.sql, (tx) => tx`
        update trace_analyses set mix_report_artifact_id = ${a.mixReportArtifactId as string} where id = ${a.analysisId as string} returning id`);
      if (rows.length === 0) throw new Error(`link_trace_report: no analysis ${String(a.analysisId)}`);
      ctx.log('info', `link_trace_report: analysis ${String(a.analysisId)} → report ${String(a.mixReportArtifactId)}`);
      return { analysisId: a.analysisId, mixReportArtifactId: a.mixReportArtifactId };
    },
  });
