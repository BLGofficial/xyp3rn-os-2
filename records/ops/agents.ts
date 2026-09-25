import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';
import { checkSchedulable, type ReleaseView, type ScheduleReport } from './schedulable.ts';

/** Records ops agents (Phase 13): deterministic; every write goes through a tool under its own DB role. */

/**
 * records-catalog (Execution): registers a track, then tells the operator to enter its splits.
 * @param ctx - run context (tools: register_track)
 * @param input - register_track's arguments
 * @returns register_track's result plus `next`
 */
export const recordsCatalog: AgentHandler = async (ctx, input) => {
  const out = (await ctx.useTool('register_track', input)) as { release: { id: string; status: string }; track: { id: string; position: number } };
  return { output: { ...out, next: `enter splits: pnpm records splits ${out.track.id} <file.yaml>` } };
};

/**
 * records-rights-splits (Governance): the schedulability report; flags the release when it is blocked.
 * @param ctx - run context (tools: read_release, flag_release)
 * @param input - `{ releaseId }`
 * @returns the report, plus `flagId` when a flag was written
 */
export const recordsRightsSplits: AgentHandler = async (ctx, input) => {
  const releaseId = (input as { releaseId?: unknown } | null)?.releaseId;
  const view = (await ctx.useTool('read_release', { releaseId })) as ReleaseView;
  // Rights only: the release date is the Calendar agent's input, so a draft with no date yet is not flagged for it.
  const report = checkSchedulable(view, { requireDate: false });
  if (report.schedulable) return { output: report };
  const { flag_id } = (await ctx.useTool('flag_release', { releaseId, report })) as { flag_id: string };
  return { output: { ...report, flagId: flag_id } };
};

const explain = (r: ScheduleReport): string =>
  [...r.problems, ...r.tracks.flatMap((t) => t.problems.map((p) => `track ${t.position}: ${p}`))].join('; ');

/**
 * records-release-calendar (Execution): proposes a date and queues it for the operator. It runs the
 * same check the Rights agent uses first, so a blocked release gets a readable refusal; the DB gate
 * is the guarantee.
 * @param ctx - run context (tools: read_release, propose_schedule)
 * @param input - `{ releaseId, releaseDate }`
 * @returns `{ release: { id, status, releaseDate }, approvalId }`
 * @throws Error naming every blocking problem
 */
export const recordsReleaseCalendar: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as { releaseId?: unknown; releaseDate?: unknown };
  const view = (await ctx.useTool('read_release', { releaseId: i.releaseId })) as ReleaseView;
  const report = checkSchedulable({ ...view, releaseDate: typeof i.releaseDate === 'string' ? i.releaseDate : null });
  if (!report.schedulable) {
    throw new Error(`release ${view.id} is not schedulable: ${explain(report)}. Run records-rights-splits to flag it, fix the splits (pnpm records splits), then propose again.`);
  }
  const { approvalId } = (await ctx.useTool('propose_schedule', { releaseId: view.id, releaseDate: i.releaseDate })) as { approvalId: string };
  return { output: { release: { id: view.id, status: 'pending_schedule', releaseDate: i.releaseDate }, approvalId } };
};
