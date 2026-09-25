import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';

export const CATALOG_AGENT = 'records-catalog';

/**
 * records-catalog (Phase 13, Execution, deterministic): the write half of the Catalog agent (F10).
 * Performs exactly the operation it is given, one of
 * - `{ register: <registration> }` — the lookup's output (register_track);
 * - `{ splits: { trackId, splits } }` — the track's next split set (write_splits);
 * - `{ assign: { trackId, isrc } | { releaseId, upc } }` — a code, once (assign_codes).
 * It creates no content and chooses nothing.
 * @param ctx - run context; the three catalog.write tools carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const catalog: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (['register', 'splits', 'assign'] as const).filter((k) => i[k] !== undefined);
  if (ops.length !== 1) throw new Error('records-catalog input needs exactly one of register, splits, assign');
  const tool = { register: 'register_track', splits: 'write_splits', assign: 'assign_codes' }[ops[0]!];
  return { output: await ctx.useTool(tool, i[ops[0]!]), tokensUsed: 0 };
};
