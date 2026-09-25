import { catalogLoaders, runtime } from '../lib/server';
import { ErrorBanner, Status, Time } from './ui';

export const dynamic = 'force-dynamic';

const ALERT_HREF = (a: { subjectKind: string; subjectId: string; releaseId: string | null }) =>
  a.subjectKind === 'song' ? `/songs/${a.subjectId}` : `/releases/${a.releaseId ?? a.subjectId}`;

// The Command Center (AOS-02 §6): what is in flight, what is blocked, what is due. Every figure is
// read from the database at the time shown; nothing here is cached or estimated.
export default async function Command({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const d = await (await catalogLoaders()).dashboard((await runtime()).sql);
  const blockers = d.alerts.filter((a) => a.severity === 'blocker');
  const warnings = d.alerts.filter((a) => a.severity === 'warning');
  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h1>Command Center</h1>
        <span className="meta">as of <Time at={d.asOf} /> · source: songs, releases, tasks, catalog_checks</span>
      </div>
      <ErrorBanner error={searchParams.error} />

      <h2>Songs by status</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {d.songsByStatus.map((g) => (
          <div key={g.status} className="border-2 border-rule p-2">
            <div className="flex justify-between text-xs uppercase tracking-widest"><span>{g.status}</span><span className="text-records">{g.songs.length}</span></div>
            <ul className="mt-2 text-sm">{g.songs.slice(0, 6).map((s) => <li key={s.id}><a href={`/songs/${s.id}`}>{s.title}</a></li>)}</ul>
            {g.songs.length > 6 && <div className="meta">+{g.songs.length - 6} more</div>}
          </div>
        ))}
      </div>

      <h2>Releases</h2>
      <table>
        <thead><tr><th>Release</th><th>Kind</th><th>Status</th><th>Date</th><th>Blockers</th><th>Warnings</th></tr></thead>
        <tbody>
          {d.releases.map((r) => (
            <tr key={r.id}>
              <td><a href={`/releases/${r.id}`}>{r.title}</a> <span className="meta">{r.artist}</span></td>
              <td>{r.kind}</td><td><Status status={r.status} /></td><td>{r.releaseDate ?? '—'}</td>
              <td className={r.blockers ? 'text-records' : ''}>{r.blockers}</td><td>{r.warnings}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Alerts ({blockers.length} blocking, {warnings.length} to look at)</h2>
      <table>
        <tbody>
          {d.alerts.slice(0, 40).map((a, i) => (
            <tr key={`${a.subjectId}:${a.code}:${i}`}>
              <td className={a.severity === 'blocker' ? 'text-records' : 'meta'}>{a.severity}</td>
              <td>{a.subjectKind}</td>
              <td><a href={ALERT_HREF(a)}>{a.subjectTitle}</a></td>
              <td>{a.message}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
  );
}
