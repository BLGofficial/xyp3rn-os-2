import type postgres from 'postgres';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { dispatch } from '../../core/orchestrator/dispatch.ts';
import { TRACE_ANALYSIS_SCHEMA_ID, validateTraceAnalysis } from './analysis.ts';

/** External TRACE submits measured values; the OS validates and evaluates, never manufactures measurements. */
export const ingestTrace = async (deps: DispatchDeps, input: unknown) => {
  const value = input as { analysis?: unknown; takeId?: unknown; trackId?: unknown } | null;
  if (!value) throw new Error('TRACE input is required');
  const errors = validateTraceAnalysis(value.analysis);
  if (errors.length) throw new Error(errors.join('; '));
  for (const key of ['takeId', 'trackId'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[key]))) throw new Error(`${key} must be a UUID`);
  // Reject invalid source references before dispatch writes its report and run.
  await deps.sql.begin('read only', async tx => {
    await tx`set local role xyp_trace`;
    if (value.takeId) {
      const [take] = await tx`select id from suno_takes where id=${value.takeId as string}`;
      if (!take) throw new Error('Take not found');
    }
    if (value.trackId) {
      const [track] = await tx`select t.suno_take_id,r.status from tracks t join releases r on r.id=t.release_id where t.id=${value.trackId as string}`;
      if (!track) throw new Error('Track not found');
      if (track.status !== 'draft') throw new Error('Track release must be draft');
      if (value.takeId && track.suno_take_id !== value.takeId) throw new Error('Take does not match the catalog track source');
    }
  });
  const result = await dispatch(deps, 'x3lius-mix-master', { analysis: value.analysis });
  if (result.status !== 'success') throw new Error(result.error);
  const out = result.output as { artifact: { id: string }; body: { checks: { action: string; ref: string; version: number }[]; unset: string[] } };
  return deps.sql.begin(async tx => {
    await tx`set local role xyp_trace`;
    const [row] = await tx<{ id: string }[]>`insert into trace_analyses (analysis, agent_run_id, report_id, take_id, track_id) values (${tx.json(value.analysis as postgres.JSONValue)}, ${result.runId}, ${out.artifact.id}, ${value.takeId as string ?? null}, ${value.trackId as string ?? null}) returning id`;
    if (value.trackId) {
      const updated = await tx`update tracks set mix_report_id = ${out.artifact.id} where id = ${value.trackId as string} returning id`;
      if (!updated.length) throw new Error('Track not found');
    }
    const score = out.body.checks.length ? out.body.checks.filter(c => c.action === 'keep').length / out.body.checks.length : null;
    if (value.takeId && score !== null) await tx`insert into take_scores (take_id, agent_run_id, scorer, is_stub, score, detail) values (${value.takeId as string}, ${result.runId}, 'trace:canonical-mix-rubric/v1', false, ${score}, ${tx.json({ traceId: row!.id, reportId: out.artifact.id, checked: out.body.checks.length, unset: out.body.unset, scope: 'Measured mix/master rubric only; does not evaluate artistic quality' })})`;
    return { schema: TRACE_ANALYSIS_SCHEMA_ID, id: row!.id, reportId: out.artifact.id, agentRunId: result.runId, score, sourceRef: `trace_analyses:${row!.id}`, scope: 'Measured mix/master rubric only' };
  });
};
