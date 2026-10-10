import type { Sql } from '../../db/client.ts';
import { asRole } from '../../../knowledge/source-registry/vault-tools.ts';

// "Run monday review": a read-only sweep of the four things the owner has to look at on a Monday. It runs as
// xyp_web (SELECT only), so it can report but never change anything; deciding stays with the owner.

export const READ_ROLE = 'xyp_web';
export const MONDAY_REVIEW = /\brun\b[^.?!]*\bmonday review\b/i;

export type SweepStep = {
  readonly id: 'obsidian-inbox' | 'rights-splits' | 'trace-reports' | 'approval-queue';
  readonly label: string;
  /** 'attention' = something here needs the owner. */
  readonly status: 'ok' | 'attention';
  readonly detail: string;
  readonly items: readonly string[];
};

export type MondayReview = { readonly name: 'monday-review'; readonly attention: number; readonly steps: readonly SweepStep[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const step = (id: SweepStep['id'], label: string, attention: boolean, detail: string, items: readonly string[] = []): SweepStep =>
  ({ id, label, status: attention ? 'attention' : 'ok', detail, items });

export const runMondayReview = (sql: Sql): Promise<MondayReview> => asRole(sql, READ_ROLE, async (tx) => {
  const inbox = await tx<{ n: number; paths: string[] }[]>`
    select count(*)::int n, coalesce((array_agg(source_path order by updated_at desc))[1:5], '{}') paths
    from obsidian_findings where status = 'pending_approval'`;
  const splits = await tx<{ checked: number; bad: { track: string; version: number; sum: string }[] }[]>`
    with sums as (select track_id, version, sum(percentage) total from rights_splits group by 1, 2)
    select count(*)::int checked,
           coalesce(jsonb_agg(jsonb_build_object('track', track_id, 'version', version, 'sum', total)) filter (where total <> 100), '[]'::jsonb) bad
    from sums`;
  const trace = await tx<{ total: number; unlinked: number; latest: Date | null }[]>`
    select count(*)::int total, count(*) filter (where mix_report_artifact_id is null)::int unlinked, max(created_at) latest
    from trace_analyses`;
  const queue = await tx<{ item_type: string; n: number; oldest: Date }[]>`
    select item_type::text, count(*)::int n, min(requested_at) oldest from approval_queue where status = 'pending' group by 1 order by 2 desc`;

  const [i, s, t] = [inbox[0]!, splits[0]!, trace[0]!];
  const pending = queue.reduce((sum, q) => sum + q.n, 0);
  const steps = [
    step('obsidian-inbox', 'Obsidian inbox findings', i.n > 0, i.n ? `${plural(i.n, 'note')} staged and waiting for your decision.` : 'Nothing staged.', i.paths),
    step('rights-splits', 'Rights splits sum to 100', s.bad.length > 0,
      s.bad.length ? `${plural(s.bad.length, 'track version')} off 100 of ${s.checked} checked.` : `${plural(s.checked, 'track version')} checked, all at 100.`,
      s.bad.map((b) => `${b.track} v${b.version}: ${b.sum}`)),
    step('trace-reports', 'TRACE audio reports', t.unlinked > 0,
      t.total ? `${plural(t.total, 'analysis', 'analyses')} received; ${t.unlinked} without a linked mix report.` : 'No TRACE analyses yet.'),
    step('approval-queue', 'Pending approvals', pending > 0, pending ? `${plural(pending, 'item')} awaiting you.` : 'The queue is clear.',
      queue.map((q) => `${q.item_type}: ${q.n} (oldest ${q.oldest.toISOString().slice(0, 10)})`)),
  ];
  return { name: 'monday-review', attention: steps.filter((x) => x.status === 'attention').length, steps };
}, 'read only');

/** Two spoken-length sentences, built from the sweep (no LLM): the outcome first, then what needs the owner. */
export const spokenSummary = (r: MondayReview): string => {
  const need = r.steps.filter((x) => x.status === 'attention');
  if (!need.length) return 'All four checks are clear.';
  return `${need.length} of 4 checks need you. ${need.map((x) => x.detail).join(' ')}`;
};
