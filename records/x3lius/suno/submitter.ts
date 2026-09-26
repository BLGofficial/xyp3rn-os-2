import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';

const OPS = { submit: 'submit_suno', capture: 'capture_suno_takes', rate: 'rate_take' } as const;

/**
 * suno-submitter (Execution, deterministic): performs exactly the operation it is given, one of
 * - `{ submit: { packageId, adapter } }` — hand a ready Suno prompt package to Suno (AOS-03: packages only);
 * - `{ capture: { submissionId, takes? } }` — record a submission's takes (+ the scoring hook);
 * - `{ rate: { takeId, rating, keep?, change? } }` — record the owner's rating of a take (AOS-03).
 * It creates no content and chooses nothing: the package, the adapter and the rating come from the caller.
 * @param ctx - run context; tools submit_suno / capture_suno_takes / rate_take carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const sunoSubmitter: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (Object.keys(OPS) as (keyof typeof OPS)[]).filter((k) => i[k] !== undefined);
  if (ops.length !== 1) throw new Error(`suno-submitter input needs exactly one of ${Object.keys(OPS).join(', ')}`);
  const output = await ctx.useTool(OPS[ops[0]!], i[ops[0]!]);
  return { output, tokensUsed: 0 };
};
