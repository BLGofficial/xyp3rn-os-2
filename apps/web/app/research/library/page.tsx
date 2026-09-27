import { researchLoaders, runtime } from '../../../lib/server';
import { ErrorBanner, Status, Time, first } from '../../ui';
import { PromoteForm, TargetChips } from '../research-ui';

export const dynamic = 'force-dynamic';

// The Findings Library (AOS-04 design §17): accepted findings, filtered by target and topic. Accepted is not
// canonical: each card shows the library decision and the canonical status as two separate badges.
export default async function Library({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const kind = first(searchParams.kind);
  const target = first(searchParams.target);
  const topic = first(searchParams.topic);
  const rl = await researchLoaders();
  const rows = await rl.library((await runtime()).sql, { ...(kind ? { kind } : {}), ...(target ? { target } : {}), ...(topic ? { topic } : {}) });
  const domains = rl.promotionDomains();
  const filtered = Boolean(kind || target || topic);
  return (
    <section>
      <h1>Findings Library</h1>
      <p className="meta mt-2 max-w-[80ch]">Findings you accepted. Accepted is not canonical: canonical status is shown separately and changes only when you approve a promotion.</p>
      <ErrorBanner error={searchParams.error} />
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3" aria-label="Filter the library">
        <label className="field">Target kind
          <select name="kind" defaultValue={kind ?? ''}><option value="">any</option><option>song</option><option>lineage</option><option>workflow</option><option>decision</option></select>
        </label>
        <label className="field">Target (id, workflow@sha or F-key) <input name="target" defaultValue={target ?? ''} /></label>
        <label className="field">Topic (exact) <input name="topic" defaultValue={topic ?? ''} placeholder="suno.vocal-descriptor-position" /></label>
        <button type="submit" className="border-control bg-transparent text-ink-1 hover:bg-hover">Filter</button>
        {filtered && <a href="/research/library" className="self-center text-sm">Clear filters</a>}
      </form>
      {rows.map((l) => (
        <article key={l.findingId} className="card mt-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="max-w-[72ch]"><strong>{l.claimTopic}</strong> = {JSON.stringify(l.claimValue)} — {l.claim}</p>
            <div className="flex flex-wrap gap-2">
              <span className="status-accepted">Accepted in library</span>
              <span className="meta self-center">canonical:</span> <Status status={l.canonicalStatus} />
            </div>
          </div>
          <p className="meta mt-1">
            from <a href={`/research/runs/${l.runId}`}>{l.question}</a> · model tag {l.modelTag} · confidence {l.confidence.toFixed(2)} · {l.evidenceCount} evidence · accepted <Time at={l.decidedAt} />
          </p>
          <p className="mt-2">Targets (inherited from the brief): <TargetChips targets={l.targets} /></p>
          {l.quotes.map((q, i) => <blockquote key={i} className="quote mt-3">“{q.quote}” <footer className="meta"><a href={q.uri}>{q.title}</a></footer></blockquote>)}
          {l.canonicalStatus === 'candidate' && <p className="meta mt-3">A promotion is pending: decide it on <a href={`/research/runs/${l.runId}`}>the run page</a>.</p>}
          {l.canonicalStatus === 'none' && <PromoteForm findingId={l.findingId} back="/research/library" topic={l.claimTopic} domains={domains} />}
        </article>
      ))}
      {rows.length === 0 && <p className="meta mt-4">no accepted finding{filtered ? ' for these filters' : ' yet'}</p>}
    </section>
  );
}
