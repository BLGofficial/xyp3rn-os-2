import { approvalsOps, runtime } from '../../lib/server';
import { applySplitAction, decideSplitAction } from '../approvals-actions';
import { ErrorBanner, ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

// Roadmap item 2: Jarvis only PROPOSES the next full split set. Nothing is written until you approve it here (the same
// decision as `pnpm gate decide`) and then apply it; an applied or outdated proposal can no longer be applied.
export default async function ApprovalsPage({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const proposals = await (await approvalsOps()).splitProposals((await runtime()).sql);
  const back = '/approvals';
  return (
    <section>
      <h2>Rights split proposals</h2>
      <p className="meta">Jarvis proposes the next full split set for a track. A set always sums to 100, and approving it does not write it: apply it afterwards.</p>
      <ErrorBanner error={searchParams.error} />
      {proposals.length === 0 ? <p className="meta mt-4">No proposals. Ask Jarvis: <code>pnpm jarvis propose-split &lt;trackId&gt; &apos;[…]&apos; &quot;why&quot;</code></p> : (
        <ScrollTable label="Split proposals" className="mt-4">
          <thead><tr><th>Track</th><th>Proposed set</th><th>Why</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {proposals.map((p) => {
              const moved = p.currentVersion !== p.proposedAgainst;
              return (
                <tr key={p.approvalId}>
                  <td>{p.trackTitle ?? p.trackId}<br /><span className="meta">v{p.currentVersion} now · <Time at={p.requestedAt} /></span></td>
                  <td>{p.splits.map((s) => `${s.payee ?? 'unassigned'} ${s.percentage}%`).join(' · ')}</td>
                  <td>{p.reason}<br /><span className="meta">by {p.proposedBy}</span></td>
                  <td>
                    {p.status}
                    {p.decidedBy && <><br /><span className="meta">{p.decidedBy}: {p.decisionReason}</span></>}
                    {p.status !== 'rejected' && moved && <><br /><span className="meta">splits moved since (v{p.proposedAgainst} → v{p.currentVersion})</span></>}
                  </td>
                  <td>
                    {p.status === 'pending' && (
                      <form action={decideSplitAction} className="flex flex-wrap items-end gap-1">
                        <input type="hidden" name="approvalId" value={p.approvalId} />
                        <input type="hidden" name="back" value={back} />
                        <input name="reason" placeholder="why" required size={14} aria-label="decision reason" />
                        <button type="submit" name="decision" value="approve">Approve</button>
                        <button type="submit" name="decision" value="reject" className="btn-quiet">Reject</button>
                      </form>
                    )}
                    {p.status === 'approved' && !moved && (
                      <form action={applySplitAction}>
                        <input type="hidden" name="approvalId" value={p.approvalId} />
                        <input type="hidden" name="back" value={back} />
                        <button type="submit">Apply as v{p.currentVersion + 1}</button>
                      </form>
                    )}
                    {p.status === 'approved' && moved && <span className="meta">applied or outdated</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      )}
    </section>
  );
}
