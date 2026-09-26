import { notFound } from 'next/navigation';
import { researchLoaders, runtime } from '../../../../lib/server';
import { rerunAction } from '../../../research-actions';
import { ErrorBanner, Status, Time } from '../../../ui';
import { ApprovalForm, AutoRefresh, DecideForm, PromoteForm, TargetList } from '../../research-ui';

export const dynamic = 'force-dynamic';

export default async function Run({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const rl = await researchLoaders();
  const d = await rl.runDetail((await runtime()).sql, params.id);
  if (!d) notFound();
  const domains = rl.promotionDomains();
  const back = `/research/runs/${d.run.id}`;
  const running = d.run.status === 'running';
  const done = d.outcomes.filter((o) => o.status !== 'running').length;
  return (
    <section>
      {running && d.topics.length === 0 && <AutoRefresh seconds={5} />}
      <h1>{d.brief.question}</h1>
      <p className="meta mt-1">
        <Status status={d.run.status} /> · started <Time at={d.run.createdAt} /> · {running ? <>deadline <Time at={d.run.expiresAt} /></> : <>ended <Time at={d.run.completedAt} /></>}
        {' · '}{d.run.selected.length > 0 ? `${done} of ${d.run.selected.length} specialists finished` : 'no specialist selected'}
        {running && d.topics.length === 0 ? ' · this page refreshes every 5 s until a finding appears' : ''}
      </p>
      <p className="mt-2">Intended use: {d.brief.intendedUse ?? <span className="meta">not stated</span>}</p>
      {d.brief.urls.length > 0 && <p className="meta">Source URLs: {d.brief.urls.map((u) => <a key={u} href={u} className="mr-2">{u}</a>)}</p>}
      {d.run.error && <p className="error" role="alert">{d.run.error}{d.evidence.length > 0 ? ' — the evidence below was written before the failure (partial).' : ''}</p>}
      <ErrorBanner error={searchParams.error} />
      <form action={rerunAction} className="mt-2"><input type="hidden" name="runId" value={d.run.id} /><button type="submit">Re-run (a new run of this brief)</button></form>

      <h2>Targets</h2>
      <TargetList targets={d.brief.targets} back={back} />

      <h2>Specialists</h2>
      <table>
        <thead><tr><th>Specialist</th><th>Outcome</th><th>Passages</th><th>Declined</th><th>Failed URLs</th></tr></thead>
        <tbody>
          {d.outcomes.map((o, i) => (
            <tr key={`${o.specialist}-${i}`}>
              <td>{o.specialist}</td>
              <td>{o.status === 'error' ? <span className="status-error">failed</span> : o.passages === 0 ? <span className="status-draft">no sources</span> : <Status status={o.status} />}
                {o.error && <div className="meta">{o.error}</div>}</td>
              <td>{o.passages ?? '—'}</td>
              <td>{o.declined.map((x, j) => <div key={j} className="meta">{x.claim ? `“${x.claim}”: ` : ''}{x.reason}</div>)}</td>
              <td>{o.failedUrls.map((f) => <div key={f.url} className="meta">{f.url}: {f.reason}</div>)}</td>
            </tr>
          ))}
          {d.outcomes.length === 0 && <tr><td colSpan={5} className="meta">{running ? 'starting…' : 'none ran'}</td></tr>}
        </tbody>
      </table>

      <h2>Findings by topic</h2>
      {d.topics.map((t) => (
        <article key={t.topic} className="mt-4">
          <h3 className="font-bold">{t.topic}{t.findings.length > 1 ? ' — the specialists disagree' : ''}</h3>
          <div className={t.findings.length > 1 ? 'grid gap-3 md:grid-cols-2' : ''}>
            {t.findings.map((f) => (
              <div key={f.id} className="card">
                <p><strong>{JSON.stringify(f.claimValue)}</strong> — {f.claim}</p>
                <p className="meta">model tag {f.modelTag} · confidence {f.confidence.toFixed(2)} · {f.evidenceIds.length} evidence</p>
                {f.contradictions.map((c) => <p key={c.id} className="status-scheduled mt-1">contradicts {c.targetType} {c.targetId} ({c.status})</p>)}
                {d.evidence.filter((e) => f.evidenceIds.includes(e.id)).map((e) => (
                  <blockquote key={e.id} className="quote mt-2">
                    {e.quote ? `“${e.quote}”` : <span className="meta">no quote (recorded by hand)</span>}
                    <footer className="meta">
                      {e.specialist} · <a href={e.source.uri}>{e.source.title}</a> ({e.source.kind}, reliability {e.source.reliability ?? 'unknown'})
                      {' · '}{Object.entries(e.confidenceInputs).map(([k, v]) => `${k}: ${String(v)}`).join('; ')}
                    </footer>
                  </blockquote>
                ))}
                {f.decision
                  ? <p className="mt-2">Library: <Status status={f.decision.decision === 'accept' ? 'accepted' : 'rejected'} /> by {f.decision.by} <Time at={f.decision.at} /> — {f.decision.reason}</p>
                  : <DecideForm findingId={f.id} back={back} />}
                {f.candidates.map((c) => (
                  <div key={c.id} className="mt-2">
                    Canonical: <Status status={c.status} />
                    {c.approvalId && c.approvalStatus === 'pending' && <ApprovalForm approvalId={c.approvalId} back={back} />}
                  </div>
                ))}
                {f.decision?.decision === 'accept' && f.candidates.length === 0 && <PromoteForm findingId={f.id} back={back} topic={f.claimTopic} domains={domains} />}
              </div>
            ))}
          </div>
        </article>
      ))}
      {d.topics.length === 0 && <p className="meta">{running ? 'no finding yet' : 'no finding'}</p>}
      {d.unsynthesized.length > 0 && (
        <>
          <h2>Evidence without a topic</h2>
          {d.unsynthesized.map((e) => <blockquote key={e.id} className="quote">{e.quote ? `“${e.quote}” — ` : ''}{e.claim}</blockquote>)}
        </>
      )}
    </section>
  );
}
