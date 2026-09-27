import type { Sql } from '../core/db/client.ts';
import { decideQueueItem, OPERATOR_ROLE, runGate, type GateResult } from '../knowledge/promotion-gate/gate.ts';
import { asRole } from './db.ts';
import { proposeCandidate, type CandidateInput } from './synthesis/findings.ts';

/**
 * The two approval tiers (AOS-04 R3). Tier 1, the Findings Library: the owner accepts or rejects a finding,
 * once (xyp_decide_finding, recorded decided in approval_queue); no canonical table changes. Tier 2, canonical:
 * only an accepted finding may become a candidate; the Promotion Gate queues it (D2) and the owner decides.
 */

export type FindingDecision = { readonly decision: 'accept' | 'reject'; readonly approver: string; readonly reason: string };

/**
 * @param sql - pool that may SET ROLE service_role (the operator)
 * @param findingId - the finding
 * @param d - accept or reject, who, why
 * @returns the approval_queue row id
 * @throws Error "finding … is already decided" on a second decision; the DB's refusal for a bad decision or blank reason
 */
export const decideFinding = async (sql: Sql, findingId: string, d: FindingDecision): Promise<{ approvalId: string }> => {
  try {
    const [r] = await asRole(sql, OPERATOR_ROLE, (tx) => tx<{ id: string }[]>`
      select xyp_decide_finding(${findingId}, ${d.decision}, ${d.approver}, ${d.reason})::text as id`);
    return { approvalId: r!.id };
  } catch (e) {
    // approval_queue_item_key: one decision per finding, like an artifact version.
    if ((e as { code?: string }).code === '23505') throw new Error(`finding ${findingId} is already decided; a decision is final (run the brief again for a new finding)`);
    throw e;
  }
};

/**
 * Proposes an accepted finding as a canonical candidate and runs it through the gate.
 * @param sql - pool allowed to SET ROLE xyp_research, service_role and the gate's roles
 * @param input - what the canonical entry would be (claim and model tag come from the finding)
 * @returns the candidate and the gate's result (pending_approval when it passes: D2)
 * @throws Error when the finding's decision is not accept (undecided or rejected)
 */
export const promoteFinding = async (sql: Sql, input: CandidateInput): Promise<{ candidateId: string; gate: GateResult }> => {
  const [d] = await asRole(sql, OPERATOR_ROLE, (tx) => tx<{ decision: string }[]>`
    select decision from current_finding_decisions where finding_id = ${input.findingId}`);
  if (d?.decision !== 'accept') throw new Error(`only an accepted finding can be promoted; finding ${input.findingId} is ${d?.decision ?? 'undecided'}`);
  const candidateId = await proposeCandidate(sql, input);
  return { candidateId, gate: await runGate(sql, candidateId) };
};

/**
 * The owner's decision on a pending canonical approval; on approve the gate re-runs and promotes.
 * @param sql - pool allowed to SET ROLE service_role
 * @param approvalId - the gate's pending approval
 * @param d - approve or reject, who, why
 * @param rerun - what `pnpm gate` passes: run the gate again (and embed a promotion)
 * @returns the decision and the gate's re-run result
 */
export const decidePromotion = (
  sql: Sql,
  approvalId: string,
  d: { readonly decision: 'approve' | 'reject'; readonly approver: string; readonly reason: string },
  rerun: (candidateId: string) => Promise<unknown>,
) => decideQueueItem(sql, approvalId, d, rerun);
