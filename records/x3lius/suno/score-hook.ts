import type postgres from 'postgres';

/**
 * The take → scoring hook (Phase 9). A take is audio; the Phase 12 Critic reads structured
 * artifacts, so an honest take score needs a trace.analysis/v1 of the render (Phase 14's TRACE
 * integration). Until then every captured take gets one STUB take_scores row: it marks where that
 * scorer plugs in and carries no number (is_stub, score null — the table refuses a stub with a
 * score). Rows written before Phase 12 keep their old marker, stub:phase-12-critic; rows are never
 * rewritten.
 */
export const STUB_SCORER = 'stub:needs-trace-analysis';

/**
 * @param tx - transaction already running as xyp_execution
 * @param takeIds - takes captured in this transaction
 * @param agentRunId - the capture run
 * @returns the stub score row ids
 */
export const recordStubScores = async (tx: postgres.TransactionSql, takeIds: readonly string[], agentRunId: string): Promise<string[]> => {
  if (takeIds.length === 0) return [];
  const detail = { note: 'STUB: no take scoring until a TRACE analysis of the render exists (Phase 14). This row marks the hook, not a judgement.', phase: 14 };
  const rows = await tx<{ id: string }[]>`
    insert into take_scores (take_id, agent_run_id, scorer, is_stub, score, detail)
    select t, ${agentRunId}, ${STUB_SCORER}, true, null, ${tx.json(detail)} from unnest(${takeIds}::uuid[]) as t
    returning id`;
  return rows.map((r) => r.id);
};
