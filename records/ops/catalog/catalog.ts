import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';

export const CATALOG_AGENT = 'records-catalog';

// Operation → the one tool that performs it. Phase 13's three, then AOS-02's catalog metadata (B1, B3).
const OPERATIONS = {
  register: 'register_track', splits: 'write_splits', assign: 'assign_codes',
  person: 'add_person', alias: 'add_alias', credit: 'write_credit', uncredit: 'retract_credit',
  link: 'write_platform_link', unlink: 'retract_platform_link', artwork: 'set_artwork', delivery: 'record_delivery',
} as const;

/**
 * records-catalog (Phase 13, Execution, deterministic): the write half of the Catalog agent (F10).
 * Performs exactly the operation it is given, one of
 * - `{ register: <registration> }` — the lookup's output (register_track);
 * - `{ splits: { trackId, splits } }` — the track's next split set (write_splits);
 * - `{ assign: { trackId, isrc } | { releaseId, upc } }` — a code, once (assign_codes);
 * - since AOS-02: `person`, `alias`, `credit`, `uncredit`, `link`, `unlink`, `artwork`, `delivery`
 *   (records/ops/metadata-tools.ts).
 * It creates no content and chooses nothing.
 * @param ctx - run context; its catalog.write tools carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const catalog: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const names = Object.keys(OPERATIONS) as (keyof typeof OPERATIONS)[];
  const ops = names.filter((k) => i[k] !== undefined);
  if (ops.length !== 1 || Object.keys(i).length !== 1) throw new Error(`records-catalog input needs exactly one of ${names.join(', ')}`);
  return { output: await ctx.useTool(OPERATIONS[ops[0]!], i[ops[0]!]), tokensUsed: 0 };
};
