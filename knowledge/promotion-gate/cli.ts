import { connect } from '../../core/db/client.ts';
import { loadEmbedder } from '../vector-retrieval/embedder.ts';
import { embedPending } from '../vector-retrieval/pipeline.ts';
import { decideQueueItem, pendingApprovals, runGate } from './gate.ts';

// Operator access to the Promotion Gate (the approval UI is Phase 16, the API Phase 15):
//   pnpm gate run    <candidateId>                                  — run a candidate through the gate
//   pnpm gate queue                                                 — pending approvals with the gate's reasons (or the
//                                                                     evaluation loop's escalation request)
//   pnpm gate decide <approvalId> approve|reject "<approver>" "<reason>" — decide; a knowledge candidate is re-run
//                                                                     through the gate, a release schedule (Phase 13) is applied
//                                                                     (approve → scheduled, reject → draft), a critique escalation
//                                                                     (Phase 12) is recorded
// A promotion is embedded straight away so retrieval sees it (propagation; `pnpm embed` does the same).

const [cmd, arg1, arg2, arg3, arg4] = process.argv.slice(2);
const sql = connect(undefined, { max: 2 });

const runAndPropagate = async (candidateId: string) => {
  const r = await runGate(sql, candidateId);
  const embedded = r.outcome === 'promoted' ? await embedPending(sql, await loadEmbedder()) : undefined;
  return { ...r, ...(embedded ? { embedded } : {}) };
};

try {
  let out: unknown;
  switch (cmd) {
    case 'run':
      out = await runAndPropagate(arg1!);
      break;
    case 'queue':
      out = await pendingApprovals(sql);
      break;
    case 'decide': {
      if (arg2 !== 'approve' && arg2 !== 'reject') throw new Error('decision must be approve or reject');
      out = await decideQueueItem(sql, arg1!, { decision: arg2, approver: arg3 ?? '', reason: arg4 ?? '' }, runAndPropagate);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'} — see the usage comment in knowledge/promotion-gate/cli.ts`);
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
