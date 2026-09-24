import { connect } from '../../core/db/client.ts';
import { loadEmbedder } from '../vector-retrieval/embedder.ts';
import { embedPending } from '../vector-retrieval/pipeline.ts';
import { decideApproval, OPERATOR_ROLE, runGate } from './gate.ts';

// Operator access to the Promotion Gate (the approval UI is Phase 16, the API Phase 15):
//   pnpm gate run    <candidateId>                                  — run a candidate through the gate
//   pnpm gate queue                                                 — pending approvals with the gate's reasons
//   pnpm gate decide <approvalId> approve|reject "<approver>" "<reason>" — decide, then re-run the gate
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
      out = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${OPERATOR_ROLE}`);
        return tx`
          select id as approval_id, item_type::text, item_id, requested_at,
                 request->'gate_reasons' as gate_reasons, request->>'target_slug' as target_slug, request->'confidence' as confidence
          from approval_queue where status = 'pending' order by requested_at`;
      });
      break;
    case 'decide': {
      if (arg2 !== 'approve' && arg2 !== 'reject') throw new Error('decision must be approve or reject');
      const status = await decideApproval(sql, arg1!, { decision: arg2, approver: arg3 ?? '', reason: arg4 ?? '' });
      const [item] = await sql<{ item_id: string }[]>`select item_id from approval_queue where id = ${arg1!}`;
      out = { approval: status, gate: await runAndPropagate(item!.item_id) };
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
