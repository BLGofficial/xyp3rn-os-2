import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';

/**
 * suno-submitter (Execution, deterministic): performs exactly the operation it is given, one of
 * - `{ submit: { formulaArtifactId, adapter } }` — send a formula artifact to Suno;
 * - `{ capture: { submissionId, takes? } }` — record a submission's takes (+ the scoring hook).
 * It creates no content and chooses nothing: the artifact and the adapter come from the caller.
 * @param ctx - run context; tools submit_suno / capture_suno_takes carry the side effects
 * @param input - one of the two shapes above
 * @returns the tool's result as the run output
 */
export const sunoSubmitter: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as { submit?: unknown; capture?: unknown };
  if ((i.submit === undefined) === (i.capture === undefined)) {
    throw new Error('suno-submitter input needs exactly one of submit, capture');
  }
  const output = i.submit !== undefined ? await ctx.useTool('submit_suno', i.submit) : await ctx.useTool('capture_suno_takes', i.capture);
  return { output, tokensUsed: 0 };
};
