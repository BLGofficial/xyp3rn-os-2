import { researchLoaders, runtime } from '../../lib/server';
import { ErrorBanner, Status, Time, first } from '../ui';
import { BriefForm, TargetChips } from './research-ui';

export const dynamic = 'force-dynamic';

// The brief list (AOS-04 design §17): filters by latest-run status and target, readable rows with intended
// use, targets and latest run, then the new-brief form with the specialist preview.
export default async function Research({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rl = await researchLoaders();
  const rt = await runtime();
  const status = first(searchParams.status);
  const kind = first(searchParams.kind);
  const target = first(searchParams.target);
  const r = await rl.researchIndex(rt.sql, rt.deps.registry, { ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(target ? { target } : {}) });
  const q = first(searchParams.q) ?? '';
  const preview = q ? rl.previewSelection(rt.deps.registry, q) : null;
  const filtered = Boolean(status || kind || target);
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1>Research</h1>
        <a href="#new-brief" className="inline-flex min-h-[44px] items-center rounded-control border border-mercury bg-mercury px-4 text-sm font-medium text-canvas no-underline hover:bg-ink-1">New brief</a>
      </div>
      <p className="meta mt-2 max-w-[80ch]">
        A brief asks a question for a stated use. The selected specialists read the brief&apos;s URLs and the canonical knowledge, and every claim quotes its source.
        Findings enter the <a href="/research/library">Findings Library</a> only when you accept them, and become canonical only when you approve their promotion. Read at <Time at={r.asOf} />.
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Briefs</h2>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-3" aria-label="Filter briefs">
        <label className="field">Latest run
          <select name="status" defaultValue={status ?? ''}><option value="">any</option><option>running</option><option>success</option><option>error</option></select>
        </label>
        <label className="field">Target kind
          <select name="kind" defaultValue={kind ?? ''}><option value="">any</option><option>song</option><option>lineage</option><option>workflow</option><option>decision</option></select>
        </label>
        <label className="field">Target (id, workflow@sha or F-key) <input name="target" defaultValue={target ?? ''} /></label>
        <button type="submit" className="btn-quiet">Filter</button>
        {filtered && <a href="/research" className="self-center text-sm">Clear filters</a>}
      </form>
      <div className="table-scroll" role="region" aria-label="Briefs" tabIndex={0}>
        <table>
          <thead><tr><th>Question</th><th>Intended use</th><th>Targets</th><th>Latest run</th><th>Opened</th></tr></thead>
          <tbody>
            {r.briefs.map((b) => (
              <tr key={b.questionId}>
                <td className="min-w-[16rem]">{b.latestRun ? <a href={`/research/runs/${b.latestRun.id}`}>{b.question}</a> : b.question}</td>
                <td className="min-w-[12rem]">{b.intendedUse ?? <span className="meta">not stated (before AOS-04)</span>}</td>
                <td><TargetChips targets={b.targets} /></td>
                <td>{b.latestRun ? <Status status={b.latestRun.status} /> : <span className="meta">none</span>}</td>
                <td className="meta whitespace-nowrap"><Time at={b.createdAt} /></td>
              </tr>
            ))}
            {r.briefs.length === 0 && <tr><td colSpan={5} className="meta">{filtered ? 'no brief matches these filters' : 'no brief yet'}</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 id="new-brief">New brief</h2>
      <form method="get" action="/research#new-brief" className="mt-2 flex flex-wrap items-end gap-3">
        <label className="field grow">Preview the specialists for a question <input name="q" defaultValue={q} className="w-full" /></label>
        <button type="submit" className="btn-quiet">Preview</button>
      </form>
      {preview && (
        <p className="meta mt-2">
          Keyword selection (threshold {preview.threshold}): {preview.selected.length > 0 ? preview.selected.map((s) => `${s.name} (${s.score})`).join(', ') : 'nobody matches; tick your own picks below'}
        </p>
      )}
      <BriefForm question={q} preview={preview} specialists={r.specialists} workflows={r.workflows} decisions={r.decisions} songs={r.songs} lineages={r.lineages} />
    </section>
  );
}
