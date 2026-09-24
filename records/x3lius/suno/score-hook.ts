import type postgres from 'postgres';

/**
 * The take → scoring hook (Phase 9). Evaluation isn't built until Phase 12, so every captured take
 * gets one STUB take_scores row: it marks where the Critic plugs in and carries no number
 * (is_stub, score null — the table refuses a stub with a score). The Phase 12 Critic appends real
 * rows next to it; nothing here pretends to judge a take.
 */
export const STUB_SCORER = 'stub:phase-12-critic';

/**
 * @param tx - transaction already running as xyp_execution
 * @param takeIds - takes captured in this transaction
 * @param agentRunId - the capture run
 * @returns the stub score row ids
 */
export const recordStubScores = async (tx: postgres.TransactionSql, takeIds: readonly string[], agentRunId: string): Promise<string[]> => {
  if (takeIds.length === 0) return [];
  const detail = { note: 'STUB: no scoring until the Phase 12 Critic. This row marks the hook, not a judgement.', phase: 12 };
  const rows = await tx<{ id: string }[]>`
    insert into take_scores (take_id, agent_run_id, scorer, is_stub, score, detail)
    select t, ${agentRunId}, ${STUB_SCORER}, true, null, ${tx.json(detail)} from unnest(${takeIds}::uuid[]) as t
    returning id`;
  return rows.map((r) => r.id);
};
