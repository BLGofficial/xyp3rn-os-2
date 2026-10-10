'use server';

import { attempt, local, text } from './action-kit';
import { approvalsOps, runtime } from '../lib/server';

// The owner's two writes on a split proposal (roadmap item 2): decide it, then apply it. A refusal (the form's, Jarvis's
// or the database's reason) comes back as ?error=.

export async function decideSplitAction(form: FormData) {
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'reject';
  return attempt(local(text(form, 'back'), '/approvals'), async () => {
    const rt = await runtime();
    return (await approvalsOps()).decideSplitOp(rt.sql, text(form, 'approvalId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function applySplitAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/approvals'), async () => (await approvalsOps()).applySplitOp((await runtime()).deps, text(form, 'approvalId')));
}
