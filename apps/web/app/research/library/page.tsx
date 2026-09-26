import { researchLoaders, runtime } from '../../../lib/server';
import { ErrorBanner, Status, Time, first } from '../../ui';
import { PromoteForm, TargetChips } from '../research-ui';

export const dynamic = 'force-dynamic';

export default async function Library({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const kind = first(searchParams.kind);
  const target = first(searchParams.target);
  const rl = await researchLoaders();
  const rows = await rl.library((await runtime()).sql, { ...(kind ? { kind } : {}), ...(target ? { target } : {}) });
  const domains = rl.promotionDomains();
  return (
    <section>
      <h1>Findings Library</h1>
      <p className="meta mt-1">Findings you accepted. Accepted is not canonical: canonical status is shown separately and changes only when you approve a promotion.</p>
      <ErrorBanner error={searchParams.error} />
      <form method="get" className="mt-2 flex flex-wrap items-end gap-2">
        <label className="field">Target kind
          <select name="kind" defaultValue={kind ?? ''}><option value="">any</option><option>song</option><option>lineage</option><option>workflow</option><option>decision</option></select>
        </label>
        <label className="field">Target (id, workflow@sha or F-key) <input name="target" defaultValue={target ?? ''} /></label>
        <button type="submit">Filter</button>
      </form>
      {rows.map((l) => (
        <article key={l.findingId} className="card mt-4">
          <p><strong>{l.claimTopic}</strong> = {JSON.stringify(l.claimValue)} — {l.claim}</p>
          <p className="meta">
            from <a href={`/research/runs/${l.runId}`}>{l.question}</a> · model tag {l.modelTag} · confidence {l.confidence.toFixed(2)} · {l.evidenceCount} evidence
            {' · '}accepted <Time at={l.decidedAt} /> · canonical: <Status status={l.canonicalStatus} />
          </p>
          <p className="mt-1">Targets (inherited from the brief): <TargetChips targets={l.targets} /></p>
          {l.quotes.map((q, i) => <blockquote key={i} className="quote mt-2">“{q.quote}” <footer className="meta"><a href={q.uri}>{q.title}</a></footer></blockquote>)}
          {l.canonicalStatus === 'candidate' && <p className="meta mt-2">A promotion is pending: decide it on <a href={`/research/runs/${l.runId}`}>the run page</a>.</p>}
          {l.canonicalStatus === 'none' && <PromoteForm findingId={l.findingId} back="/research/library" topic={l.claimTopic} domains={domains} />}
        </article>
      ))}
      {rows.length === 0 && <p className="meta mt-4">no accepted finding{kind || target ? ' for this filter' : ' yet'}</p>}
    </section>
  );
}
