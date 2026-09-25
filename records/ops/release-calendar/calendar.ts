import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import type { RightsFlag } from '../rights-splits/check.ts';

export const CALENDAR_AGENT = 'records-release-calendar';

type RightsCheck = { readonly runId?: unknown; readonly releaseId?: unknown; readonly verdict?: unknown; readonly flags?: readonly RightsFlag[] };

/**
 * records-release-calendar (Phase 13, Execution, deterministic): scheduling only — no marketing, PR
 * or lead-time policy. Performs exactly one of
 * - `{ schedule: { releaseId, releaseDate, rightsCheck } }` — `rightsCheck` is a records-rights-splits
 *   output; anything but a pass for this release is refused here, naming every flag;
 * - `{ unschedule: { releaseId } }`;
 * - `{ release: { releaseId } }` — on or after the release date.
 * The date is the operator's. The DB guard is the hard stop on every path: it re-checks the splits and
 * verifies the Rights run itself, so a forged pass gains nothing.
 * @param ctx - run context; schedule_release (catalog.write) carries the move
 * @param input - one of the shapes above
 * @returns `{ releaseId, status, releaseDate }`
 */
export const releaseCalendar: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const ops = (['schedule', 'unschedule', 'release'] as const).filter((k) => i[k] !== undefined);
  if (ops.length !== 1) throw new Error('records-release-calendar input needs exactly one of schedule, unschedule, release');
  const op = ops[0]!;
  const args = i[op] ?? {};
  if (op !== 'schedule') return { output: await ctx.useTool('schedule_release', { action: op, releaseId: args.releaseId }), tokensUsed: 0 };

  const check = (args.rightsCheck ?? {}) as RightsCheck;
  if (check.releaseId !== args.releaseId) {
    throw new Error(`records-release-calendar: the rights check is for release ${String(check.releaseId)}, not ${String(args.releaseId)}`);
  }
  if (check.verdict !== 'pass') {
    const named = (check.flags ?? []).map((f) => `${f.rule}${f.trackId ? ` (track ${f.trackId})` : ''}: ${f.detail}`);
    throw new Error(`records-release-calendar: release ${String(args.releaseId)} is not cleared by rights check ${String(check.runId)} (${String(check.verdict)})${named.length ? ` — ${named.join('; ')}` : ''}`);
  }
  return {
    output: await ctx.useTool('schedule_release', { action: 'schedule', releaseId: args.releaseId, releaseDate: args.releaseDate, rightsCheckRunId: check.runId }),
    tokensUsed: 0,
  };
};
