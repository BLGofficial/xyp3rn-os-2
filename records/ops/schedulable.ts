/**
 * Whether a release may be scheduled (Phase 13 spec §5.2). The DB gate (migration
 * 20260925110000, xyp_releases_guard) is the guarantee; this is the readable report the Rights agent
 * flags with and the Calendar agent refuses with, one function for both.
 */

export const UNASSIGNED = 'UNASSIGNED';

export type SplitView = { readonly payee: string; readonly role: string; readonly percentage: number };
export type TrackView = { readonly id: string; readonly position: number; readonly title: string; readonly splits: readonly SplitView[] };
export type ReleaseView = { readonly id: string; readonly title: string; readonly status: string; readonly releaseDate: string | null; readonly tracks: readonly TrackView[] };
export type TrackReport = { readonly trackId: string; readonly position: number; readonly total: number; readonly unassigned: number; readonly problems: readonly string[]; readonly notes: readonly string[] };
export type ScheduleReport = { readonly schedulable: boolean; readonly problems: readonly string[]; readonly tracks: readonly TrackReport[] };

const cents = (n: number): number => Math.round(n * 100);

/**
 * @param r - the release with its tracks and splits
 * @param opts - `requireDate: false` for the Rights agent, which judges rights; the Calendar agent
 *   supplies the date (default true)
 * @returns blocking problems for the release and per track, plus non-blocking notes
 */
export const checkSchedulable = (r: ReleaseView, opts: { readonly requireDate?: boolean } = {}): ScheduleReport => {
  const problems = [
    ...(r.status === 'draft' ? [] : [`release is ${r.status}, not draft`]),
    ...(r.releaseDate || opts.requireDate === false ? [] : ['no release date']),
    ...(r.tracks.length === 0 ? ['no tracks'] : []),
  ];
  const tracks = [...r.tracks].sort((a, b) => a.position - b.position).map((t): TrackReport => {
    const total = t.splits.reduce((n, s) => n + cents(s.percentage), 0) / 100;
    const unassigned = t.splits.filter((s) => s.payee === UNASSIGNED).reduce((n, s) => n + cents(s.percentage), 0) / 100;
    const roles = new Map<string, string[]>();
    for (const s of t.splits) if (s.payee !== UNASSIGNED) roles.set(s.payee, [...(roles.get(s.payee) ?? []), s.role]);
    return {
      trackId: t.id, position: t.position, total, unassigned,
      problems: [
        ...(t.splits.length === 0 ? ['no splits entered'] : []),
        ...(t.splits.length > 0 && total !== 100 ? [`splits total ${total}%, not 100%`] : []),
        ...(unassigned > 0 ? [`UNASSIGNED share of ${unassigned}%`] : []),
      ],
      notes: [...roles].filter(([, rs]) => rs.length > 1).map(([p, rs]) => `${p} is listed as ${rs.join(' and ')}`),
    };
  });
  return { schedulable: problems.length === 0 && tracks.every((t) => t.problems.length === 0), problems, tracks };
};
