import { notFound } from 'next/navigation';
import { researchLoaders, runtime } from '../../../../lib/server';
import { rerunAction } from '../../../research-actions';
import { WithRail } from '../../../shell/right-rail';
import { ErrorBanner, first, Status, Time } from '../../../ui';
import { RunRefresh } from '../../run-refresh';
import { ApprovalForm, AutoRefresh, DecideForm, elapsed, OUTCOME, PromoteForm, TargetChips, TargetList } from '../../research-ui';

export const dynamic = 'force-dynamic';

// The run workbench (AOS-04 design §17): header with the truthful status and recorded times; specialist
// results and findings by topic in the main column; the selected evidence, its source and its provenance
// path in the right column. Acceptance and canonical approval stay separate actions with separate badges.
export default async function Run({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const rl = await researchLoaders();
  const d = await rl.runDetail((await runtime()).sql, params.id);
  if (!d) notFound();
  const domains = rl.promotionDomains();
  const back = `/research/runs/${d.run.id}`;
  const running = d.run.status === 'running';
  const done = d.outcomes.filter((o) => o.outcome !== 'running').length;
  const findings = d.topics.flatMap((t) => t.findings);
  const picked = first(searchParams.evidence);
  const selected = d.evidence.find((e) => e.id === picked) ?? d.evidence[0] ?? null;
  const finding = selected ? findings.find((f) => f.evidenceIds.includes(selected.id)) ?? null : null;

  const rail = (
    <section className="card" aria-labelledby="evidence-h">
      <h2 id="evidence-h" className="mt-0">Selected evidence</h2>
      {selected ? (
        <>
          {selected.quote ? <blockquote className="quote">“{selected.quote}”</blockquote> : <p className="meta">no quote (recorded by hand)</p>}
          <p className="mt-3 text-sm">{selected.claim}</p>
          <dl className="meta mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt>Source</dt><dd className="break-words"><a href={selected.source.uri}>{selected.source.title}</a></dd>
            <dt>Kind</dt><dd>{selected.source.kind}, reliability {selected.source.reliability ?? 'unknown'}</dd>
            <dt>Specialist</dt><dd>{selected.specialist}</dd>
            <dt>Model tag</dt><dd>{selected.modelTag}</dd>
            <dt>Confidence</dt><dd>{selected.confidence.toFixed(2)}: {Object.entries(selected.confidenceInputs).map(([k, v]) => `${k} ${String(v)}`).join('; ')}</dd>
          </dl>
          <h2>Provenance</h2>
          <ol className="flex flex-col gap-1 text-sm" aria-label="Provenance path">
            <li>Brief: {d.brief.question}</li>
            <li>→ Run: <Status status={d.run.status} /></li>
            <li>→ Evidence by {selected.specialist}</li>
            <li>→ Source: {selected.source.title}</li>
            {finding && <li>→ Finding: {finding.claimTopic} = {JSON.stringify(finding.claimValue)}</li>}
            {finding?.decision && <li>→ Library: {finding.decision.decision === 'accept' ? <span className="status-accepted">Accepted in library</span> : <span className="status-rejected">Rejected</span>}</li>}
            {finding?.candidates.map((c) => <li key={c.id}>→ Canonical: <Status status={c.status} />{c.approvalStatus ? <> (approval <Status status={c.approvalStatus} />)</> : null}</li>)}
          </ol>
          <p className="meta mt-2">Only what the records prove; targets are inherited from the brief.</p>
        </>
      ) : <p className="meta">{running ? 'no evidence yet' : 'no evidence was written'}</p>}
    </section>
  );

  return (
    <WithRail rail={rail} label="Selected evidence and its provenance">
      <section>
        {running && <RunRefresh seconds={5} />}
        {running && d.topics.length === 0 && <noscript><AutoRefresh seconds={5} /></noscript>}
        <h1>{d.brief.question}</h1>
        <p className="meta mt-2">
          <Status status={d.run.status} /> · elapsed {elapsed(d.run.elapsedMs)} · started <Time at={d.run.createdAt} /> · {running ? <>deadline <Time at={d.run.expiresAt} /></> : <>ended <Time at={d.run.completedAt} /></>}
          {' · '}{d.run.selected.length > 0 ? `${done} of ${d.run.selected.length} specialists finished` : 'no specialist selected'}
        </p>
        <p className="mt-3">Intended use: {d.brief.intendedUse ?? <span className="meta">not stated</span>}</p>
        <p className="mt-1">Targets: <TargetChips targets={d.brief.targets} /></p>
        {d.brief.urls.length > 0 && <p className="meta mt-1">Source URLs: {d.brief.urls.map((u) => <a key={u} href={u} className="mr-2 break-all">{u}</a>)}</p>}
        {d.run.error && <p className="error" role="alert">{d.run.error}{d.evidence.length > 0 ? ' — the evidence below was written before the failure (partial).' : ''}</p>}
        <ErrorBanner error={searchParams.error} />
        <form action={rerunAction} className="mt-3"><input type="hidden" name="runId" value={d.run.id} /><button type="submit">Re-run (a new run of this brief)</button></form>

        <h2>Specialists</h2>
        <div className="table-scroll" role="region" aria-label="Specialists" tabIndex={0}>
          <table>
            <thead><tr><th>Specialist</th><th>Outcome</th><th>Passages</th><th>Evidence</th><th>Declined</th><th>Failed URLs</th></tr></thead>
            <tbody>
              {d.outcomes.map((o, i) => (
                <tr key={`${o.specialist}-${i}`}>
                  <td>{o.specialist}</td>
                  <td><span className={OUTCOME[o.outcome]!.cls}>{OUTCOME[o.outcome]!.word}{o.outcome === 'declined' ? ` (${o.declined.length})` : ''}</span>{o.error && <div className="meta break-words">{o.error}</div>}</td>
                  <td className="num">{o.passages ?? '—'}</td>
                  <td className="num">{o.evidenceCount}</td>
                  <td>{o.declined.map((x, j) => <div key={j} className="meta">{x.claim ? `“${x.claim}”: ` : ''}{x.reason}</div>)}</td>
                  <td>{o.failedUrls.map((f) => <div key={f.url} className="meta break-all">{f.url}: {f.reason}</div>)}</td>
                </tr>
              ))}
              {d.outcomes.length === 0 && <tr><td colSpan={6} className="meta">{running ? 'starting… (progress not recorded yet)' : 'none ran'}</td></tr>}
            </tbody>
          </table>
        </div>
        <h2>Targets</h2>
        <TargetList targets={d.brief.targets} back={back} />

        <h2>Findings by topic</h2>
        {d.topics.map((t) => (
          <article key={t.topic} className="mt-4">
            <h3>{t.topic}{t.findings.length > 1 ? <span className="status-warning ml-2">the specialists disagree</span> : null}</h3>
            <div className={`mt-2 grid gap-3 ${t.findings.length > 1 ? 'md:grid-cols-2' : ''}`}>
              {t.findings.map((f) => (
                <div key={f.id} className="card">
                  <p><strong>{JSON.stringify(f.claimValue)}</strong> — {f.claim}</p>
                  <p className="meta">model tag {f.modelTag} · confidence {f.confidence.toFixed(2)} · {f.evidenceIds.length} evidence</p>
                  {f.contradictions.map((c) => <p key={c.id} className="mt-1"><span className="status-warning">contradicts {c.targetType}</span> <span className="meta">{c.targetId} ({c.status})</span></p>)}
                  {d.evidence.filter((e) => f.evidenceIds.includes(e.id)).map((e) => (
                    <blockquote key={e.id} className="quote mt-3">
                      {e.quote ? `“${e.quote}”` : <span className="meta">no quote (recorded by hand)</span>}
                      <footer className="meta">
                        {e.specialist} · <a href={e.source.uri}>{e.source.title}</a> ({e.source.kind}, reliability {e.source.reliability ?? 'unknown'})
                        {' · '}<a href={`${back}?evidence=${e.id}#evidence-h`}>Inspect</a>
                      </footer>
                    </blockquote>
                  ))}
                  {f.decision
                    ? <p className="mt-3">Library: <Status status={f.decision.decision === 'accept' ? 'accepted' : 'rejected'} /> by {f.decision.by} <Time at={f.decision.at} /> — {f.decision.reason}</p>
                    : <DecideForm findingId={f.id} back={back} />}
                  {f.candidates.map((c) => (
                    <div key={c.id} className="mt-3">
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
            {d.unsynthesized.map((e) => <blockquote key={e.id} className="quote mt-2">{e.quote ? `“${e.quote}” — ` : ''}{e.claim}</blockquote>)}
          </>
        )}
      </section>
    </WithRail>
  );
}
