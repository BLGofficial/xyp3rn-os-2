import type { Sql } from '../../../core/db/client.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { JarvisCore, type SplitShare } from '../../../core/src/jarvis/JarvisOrchestrator.ts';
import { decideApproval } from '../../../knowledge/promotion-gate/gate.ts';
import { asRole } from '../../../knowledge/source-registry/vault-tools.ts';

/**
 * The owner's view of Jarvis's split proposals (roadmap item 2). Reads run as xyp_web (SELECT only). A decision is the
 * gate's own xyp_decide_approval (service_role); applying is JarvisCore's apply-split, which writes through the
 * records-catalog agent only for an approved proposal whose track has not moved since it was made.
 */

export const WEB_ROLE = 'xyp_web';
export const MAX_LISTED = 50;

export type SplitProposalView = {
  readonly approvalId: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly trackId: string;
  readonly trackTitle: string | null;
  readonly splits: readonly SplitShare[];
  readonly proposedBy: string;
  readonly reason: string;
  /** The version of the track's splits when this was proposed, and now. */
  readonly proposedAgainst: number;
  readonly currentVersion: number;
};

type Row = {
  id: string; status: SplitProposalView['status']; requested_at: Date; decided_by: string | null; decision_reason: string | null;
  request: { trackId: string; splits: SplitShare[]; currentVersion: number; requestedBy: string; ownerReason: string };
  title: string | null; current: number;
};

/** Pending first, then newest. */
export const splitProposals = (sql: Sql): Promise<SplitProposalView[]> => asRole(sql, WEB_ROLE, async (tx) => {
  const rows = await tx<Row[]>`
    select a.id, a.status::text as status, a.requested_at, a.decided_by, a.decision_reason, a.request, t.title,
           (select coalesce(max(version), 0)::int from rights_splits where track_id = (a.request ->> 'trackId')::uuid) as current
    from approval_queue a left join tracks t on t.id = (a.request ->> 'trackId')::uuid
    where a.item_type::text = 'split_proposal'
    order by (a.status = 'pending') desc, a.requested_at desc limit ${MAX_LISTED}`;
  return rows.map((r) => ({
    approvalId: r.id, status: r.status, requestedAt: r.requested_at.toISOString(), decidedBy: r.decided_by, decisionReason: r.decision_reason,
    trackId: r.request.trackId, trackTitle: r.title, splits: r.request.splits, proposedBy: r.request.requestedBy, reason: r.request.ownerReason,
    proposedAgainst: r.request.currentVersion, currentVersion: r.current,
  }));
}, 'read only');

/**
 * The owner's decision on one split proposal. Only a pending split_proposal is accepted, so this form cannot decide
 * any other kind of approval, and a reason is required.
 * @param owner - the signed-in owner, recorded as the decider
 */
export const decideSplitOp = async (sql: Sql, approvalId: string, decision: 'approve' | 'reject', reason: string, owner: string): Promise<'approved' | 'rejected'> => {
  if (!reason.trim()) throw new Error('Say why: a decision needs a reason.');
  const rows = await asRole(sql, WEB_ROLE, (tx) => tx<{ item_type: string; status: string }[]>`select item_type::text, status::text from approval_queue where id = ${approvalId}`, 'read only');
  const a = rows[0];
  if (!a || a.item_type !== 'split_proposal') throw new Error('That is not a split proposal.');
  if (a.status !== 'pending') throw new Error(`That proposal was already ${a.status}.`);
  return decideApproval(sql, approvalId, { decision, approver: owner, reason: reason.trim() });
};

/**
 * Writes an approved, still-current proposal as the track's next split version, through JarvisCore.
 * @throws Error with Jarvis's reason when it refuses (pending, rejected, moved since, or the database's own rule)
 */
export const applySplitOp = async (deps: DispatchDeps, approvalId: string): Promise<string> => {
  const core = new JarvisCore({ ...deps, engine: { retrieve: async () => { throw new Error('not used'); } } as never });
  const r = await core.interceptAndExecute('http', { type: 'apply-split', approvalId });
  if (r.status !== 'OK') throw new Error(r.summary);
  return r.summary;
};
