import { catalogLoaders, runtime, shellLoaders } from '../lib/server';
import { WithRail } from './shell/right-rail';
import { ErrorBanner, Status, Time } from './ui';

export const dynamic = 'force-dynamic';

const ALERT_HREF = (a: { subjectKind: string; subjectId: string; releaseId: string | null }) =>
  a.subjectKind === 'song' ? `/songs/${a.subjectId}` : `/releases/${a.releaseId ?? a.subjectId}`;
const PULSE_WORD: Readonly<Record<string, string>> = { ok: 'ok', failed: 'failed', configured: 'Configured', 'not-configured': 'Not configured', unavailable: 'Unavailable' };

// The Command Center (AOS-02 §6, AOS-04 §13.1): the metric strip, then what is in flight, blocked or due;
// the system pulse and recent activity in the right rail. Every figure is read from the database at the
// time shown; nothing is cached, estimated or filled in.
export default async function Command({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const rt = await runtime();
  const sl = await shellLoaders();
  const [d, m, pulse, activity] = await Promise.all([
    (await catalogLoaders()).dashboard(rt.sql), sl.metrics(rt.sql), sl.pulse(rt.sql, process.env, rt.deps.registry), sl.activity(rt.sql, 12),
  ]);
  const blockers = d.alerts.filter((a) => a.severity === 'blocker');
  const warnings = d.alerts.filter((a) => a.severity === 'warning');
  const rail = (
    <>
      <section className="card" aria-labelledby="pulse-h">
        <h2 id="pulse-h" className="mt-0">System pulse</h2>
        <ul className="flex flex-col gap-3">
          {pulse.map((p) => (
            <li key={p.label} className="text-sm">
              <div className="flex items-center justify-between gap-2"><span>{p.label}</span><span className={`status-${p.state}`}>{PULSE_WORD[p.state]}</span></div>
              <div className="meta break-words">{p.detail} · <Time at={p.asOf} /></div>
            </li>
          ))}
        </ul>
        <p className="meta mt-3">Only what was checked: a configured key is not a reachable provider.</p>
      </section>
      <section className="card" aria-labelledby="activity-h">
        <h2 id="activity-h" className="mt-0">Recent activity</h2>
        <ul className="flex flex-col gap-3">
          {activity.map((a, i) => (
            <li key={`${a.at}-${i}`} className="text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words">{a.href ? <a href={a.href}>{a.title}</a> : a.title}</span>
                <Status status={a.status} />
              </div>
              <div className="meta">{a.kind} · <Time at={a.at} /></div>
            </li>
          ))}
          {activity.length === 0 && <li className="meta">nothing recorded yet</li>}
        </ul>
      </section>
    </>
  );
  return (
    <WithRail rail={rail} label="System pulse and recent activity">
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1>Command Center</h1>
          <span className="meta">as of <Time at={d.asOf} /> · source: songs, releases, tasks, catalog_checks</span>
        </div>
        <ErrorBanner error={searchParams.error} />

        <h2>At a glance</h2>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4">
          {m.cards.map((c) => (
            <article key={c.key} data-metric={c.key} className="card flex flex-col gap-2 p-4 xl:p-5">
              <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-3">{c.label}</h3>
              {c.value === null ? (
                <p className="font-display text-2xl text-warn">unavailable</p>
              ) : (
                <p className="num font-display text-[32px] font-semibold leading-none text-ink-1">
                  {c.value}
                  {c.secondary && <span className="ml-2 align-middle font-sans text-sm font-normal text-ink-2">· {c.secondary.value} {c.secondary.label}</span>}
                </p>
              )}
              {c.error && <p className="meta text-warn">{c.error}</p>}
              <p className="meta">{c.definition}</p>
              <p className="meta mt-auto">source: {c.source} · as of <Time at={m.asOf} /></p>
              <a href={c.href} className="text-sm" aria-label={`Open: ${c.label}`}>Open →</a>
            </article>
          ))}
        </div>

        <h2>Songs by status</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {d.songsByStatus.map((g) => (
            <div key={g.status} className="card p-3">
              <div className="flex justify-between text-xs uppercase tracking-[0.08em] text-ink-3"><span>{g.status}</span><span className="num text-ink-1">{g.songs.length}</span></div>
              <ul className="mt-2 text-sm">{g.songs.slice(0, 6).map((s) => <li key={s.id}><a href={`/songs/${s.id}`}>{s.title}</a></li>)}</ul>
              {g.songs.length > 6 && <div className="meta">+{g.songs.length - 6} more</div>}
            </div>
          ))}
        </div>

        <h2>Releases</h2>
        <div className="table-scroll" role="region" aria-label="Releases" tabIndex={0}>
          <table>
            <thead><tr><th>Release</th><th>Kind</th><th>Status</th><th>Date</th><th>Blockers</th><th>Warnings</th></tr></thead>
            <tbody>
              {d.releases.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/releases/${r.id}`}>{r.title}</a> <span className="meta">{r.artist}</span></td>
                  <td>{r.kind}</td><td><Status status={r.status} /></td><td className="num">{r.releaseDate ?? '—'}</td>
                  <td className={`num ${r.blockers ? 'text-fail' : ''}`}>{r.blockers}</td><td className="num">{r.warnings}</td>
                </tr>
              ))}
              {d.releases.length === 0 && <tr><td colSpan={6} className="meta">no release yet</td></tr>}
            </tbody>
          </table>
        </div>

        <h2>Alerts ({blockers.length} blocking, {warnings.length} to look at)</h2>
        <div className="table-scroll" role="region" aria-label="Alerts" tabIndex={0}>
          <table>
            <tbody>
              {d.alerts.slice(0, 40).map((a, i) => (
                <tr key={`${a.subjectId}:${a.code}:${i}`}>
                  <td><span className={a.severity === 'blocker' ? 'status-blocked' : 'status-warning'}>{a.severity}</span></td>
                  <td>{a.subjectKind}</td>
                  <td><a href={ALERT_HREF(a)}>{a.subjectTitle}</a></td>
                  <td>{a.message}</td>
                </tr>
              ))}
              {d.alerts.length === 0 && <tr><td colSpan={4} className="meta">nothing to look at</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h2>Open tasks</h2>
            <table>
              <tbody>
                {d.openTasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td className="meta">{t.songTitle ? <a href={`/songs/${t.songId}`}>{t.songTitle}</a> : t.releaseTitle ? <a href={`/releases/${t.releaseId}`}>{t.releaseTitle}</a> : 'general'}</td>
                    <td className="meta">{t.dueDate ?? 'no date'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <a href="/tasks" className="meta">all tasks →</a>
          </div>
          <div>
            <h2>Recent research</h2>
            <ul className="text-sm">
              {d.research.findings.map((f) => <li key={f.id} className="mb-1">{f.claim} <span className="meta">({f.confidence.toFixed(2)} · <Time at={f.createdAt} />)</span></li>)}
              {d.research.questions.map((q) => <li key={q.id} className="mb-1">? {q.question} <span className="meta"><Time at={q.createdAt} /></span></li>)}
              {d.research.findings.length + d.research.questions.length === 0 && <li className="meta">none yet</li>}
            </ul>
            <h2>Connectors</h2>
            <p className="meta">{d.connectors.length === 0 ? 'none connected; platform and distributor connectors arrive in AOS-06' : ''}</p>
          </div>
        </div>
      </section>
    </WithRail>
  );
}
