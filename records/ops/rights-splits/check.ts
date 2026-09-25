import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import type { CatalogRecord } from '../tools.ts';

export const RIGHTS_AGENT = 'records-rights-splits';

/** The rules checked, in order. Each one is reported, checked or not: no verdict rests on an unstated rule. */
export const RIGHTS_RULES = ['rights.release-has-tracks', 'rights.split-set-present', 'rights.no-unassigned-share', 'rights.sum-100'] as const;
export type RightsRule = (typeof RIGHTS_RULES)[number];

export type RightsFlag = { readonly rule: RightsRule; readonly trackId?: string; readonly detail: string; readonly unassignedPercentage?: number };
export type RightsVerdict = {
  readonly releaseId: string;
  readonly verdict: 'pass' | 'flag';
  /** skipped: nothing to check (the split rules on a release with no tracks, or on tracks with no set). */
  readonly rules: ReadonlyArray<{ readonly id: RightsRule; readonly status: 'pass' | 'flag' | 'skipped' }>;
  readonly flags: readonly RightsFlag[];
};

/** Thousandths: numeric(6,3) is exact, so the sum is compared exactly, never as floats. */
const milli = (n: number): number => Math.round(n * 1000);

/**
 * The Rights check as a pure function over one catalog record.
 * @param record - read_catalog's answer for the release
 * @returns the verdict: pass only when every rule passes
 */
export const checkRights = (record: CatalogRecord): RightsVerdict => {
  const flags: RightsFlag[] = [];
  const { tracks } = record;
  if (tracks.length === 0) flags.push({ rule: 'rights.release-has-tracks', detail: 'the release has no tracks' });
  for (const t of tracks) {
    if (!t.splits) {
      flags.push({ rule: 'rights.split-set-present', trackId: t.id, detail: `track ${t.position} "${t.title}" has no split set` });
      continue;
    }
    const unassigned = t.splits.rows.filter((r) => r.payee === null).reduce((s, r) => s + milli(r.percentage), 0);
    if (unassigned > 0) {
      flags.push({
        rule: 'rights.no-unassigned-share', trackId: t.id, unassignedPercentage: unassigned / 1000,
        detail: `track ${t.position} "${t.title}" has ${unassigned / 1000}% unassigned (split set v${t.splits.version})`,
      });
    }
    const sum = t.splits.rows.reduce((s, r) => s + milli(r.percentage), 0);
    if (sum !== 100_000) {
      flags.push({ rule: 'rights.sum-100', trackId: t.id, detail: `track ${t.position} "${t.title}" split set v${t.splits.version} sums to ${sum / 1000}, not 100` });
    }
  }
  const withSets = tracks.filter((t) => t.splits).length;
  const status = (id: RightsRule, applicable: boolean) =>
    flags.some((f) => f.rule === id) ? ('flag' as const) : applicable ? ('pass' as const) : ('skipped' as const);
  return {
    releaseId: record.release.id,
    verdict: flags.length === 0 ? 'pass' : 'flag',
    rules: [
      { id: 'rights.release-has-tracks', status: status('rights.release-has-tracks', true) },
      { id: 'rights.split-set-present', status: status('rights.split-set-present', tracks.length > 0) },
      { id: 'rights.no-unassigned-share', status: status('rights.no-unassigned-share', withSets > 0) },
      { id: 'rights.sum-100', status: status('rights.sum-100', withSets > 0) },
    ],
    flags,
  };
};

/**
 * records-rights-splits (Phase 13, Governance, deterministic): validates a release's rights splits
 * and flags every unassigned percentage before the release can be scheduled. A `flag` verdict is a
 * successful run: the flags are data on agent_runs.output. The output carries this run's id, which
 * the calendar records on the release and the DB verifies (rule 5 of the scheduling guard).
 * @param ctx - run context; read_catalog (catalog.read) is its only read
 * @param input - `{ releaseId }`
 * @returns `{ runId, ...RightsVerdict }`
 */
export const rightsCheck: AgentHandler = async (ctx, input) => {
  const releaseId = (input as { releaseId?: unknown } | null)?.releaseId;
  const record = (await ctx.useTool('read_catalog', { releaseId })) as CatalogRecord;
  const verdict = checkRights(record);
  await ctx.useTool('log_message', {
    message: `records-rights-splits: release ${verdict.releaseId} ${verdict.verdict}${verdict.flags.length ? `: ${verdict.flags.map((f) => f.detail).join('; ')}` : ''}`,
  });
  return { output: { runId: ctx.runId, ...verdict }, tokensUsed: 0 };
};
