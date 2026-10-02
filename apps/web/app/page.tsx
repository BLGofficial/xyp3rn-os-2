import { DOMAINS, type Domain } from '../../../core/contracts/taxonomy.ts';
import { catalogLoaders, graphLoaders, runtime, shellLoaders } from '../lib/server';
import { CommandInput } from './graph/command-input';
import { Sphere } from './graph/sphere';
import { DomainChip, GraphList, Inspector, kindWord, LENS_HINT, Pager } from './graph-ui';
import { WithRail } from './shell/right-rail';
import { ErrorBanner, first, ScrollTable, Status, Time } from './ui';

export const dynamic = 'force-dynamic';

const ALERT_HREF = (a: { subjectKind: string; subjectId: string; releaseId: string | null }) =>
  a.subjectKind === 'song' ? `/songs/${a.subjectId}` : `/releases/${a.releaseId ?? a.subjectId}`;
const PULSE_WORD: Readonly<Record<string, string>> = { ok: 'ok', failed: 'failed', configured: 'Configured', 'not-configured': 'Not configured', unavailable: 'Unavailable' };

// The Command Center (AOS-02 §6, AOS-04 §13.1): the metric strip, then what is in flight, blocked or due;
// the system pulse and recent activity in the right rail. Every figure is read from the database at the
// time shown; nothing is cached, estimated or filled in.
export default async function Command({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rt = await runtime();
  const sl = await shellLoaders();
  const [d, m, pulse, activity] = await Promise.all([
    (await catalogLoaders()).dashboard(rt.sql), sl.metrics(rt.sql), sl.pulse(rt.sql, process.env, rt.deps.registry), sl.activity(rt.sql, 12),
  ]);
  // The graph (AOS-04 Plan C1): a List view filtered by domain or a Creative lens group; ?node= opens the inspector
  // in the right rail in place of pulse and activity (§13.1).
  const gl = await graphLoaders();
  const dp = first(searchParams.domain);
  const domain = dp === 'shared' || (DOMAINS as readonly string[]).includes(dp ?? '') ? (dp as Domain | 'shared') : undefined;
  // A kind filter (a sphere group opens its members here): a known kind's shape, never free text in SQL.
  const kp = first(searchParams.kind);
  const kind = kp && /^[a-z_]{1,40}$/.test(kp) ? kp : undefined;
  const lens = first(searchParams.lens) === 'creative' ? ('creative' as const) : undefined;
  const group = lens ? first(searchParams.group) : undefined;
  const page = Math.max(1, Math.trunc(Number(first(searchParams.page))) || 1);
  const nodeId = first(searchParams.node);
  const [list, cov, lensData, detail] = await Promise.all([
    lens && !group ? null : gl.listNodes(rt.sql, { domain, kind, lens, group, page, perPage: 25 }),
    gl.coverage(rt.sql),
    lens ? gl.lensGroups(rt.sql) : null,
    nodeId ? gl.nodeDetail(rt.sql, nodeId) : null,
  ]);
  const qs = (o: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams(Object.entries(o).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '').map(([k, v]) => [k, String(v)])).toString();
    return q ? `/?${q}` : '/';
  };
  const inspect = (id: string) => `${qs({ domain, kind, lens, group, page: page > 1 ? page : undefined, node: id })}#inspector-h`;
  const blockers = d.alerts.filter((a) => a.severity === 'blocker');
  const warnings = d.alerts.filter((a) => a.severity === 'warning');
  const rail = nodeId ? (
    <>
      {detail ? <Inspector d={detail} limit={12} /> : <section className="card"><h2 className="mt-0">Not in the index</h2><p className="meta">No entity has the id <code className="break-all">{nodeId}</code>.</p></section>}
      <p className="text-sm"><a href={qs({ domain, kind, lens, group, page: page > 1 ? page : undefined })}>Close the inspector</a> <span className="meta">(back to pulse and activity)</span></p>
    </>
  ) : (
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
    <WithRail rail={rail} label={nodeId ? 'Inspector' : 'System pulse and recent activity'}>
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

        <section aria-labelledby="graph-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="graph-h">Graph</h2>
            <nav aria-label="Graph lens" className="flex gap-4 text-sm">
              <a href={qs({ domain })} aria-current={lens ? undefined : 'page'}>System lens</a>
              <a href={qs({ lens: 'creative' })} aria-current={lens ? 'page' : undefined}>Creative lens</a>
            </nav>
          </div>
          <p className="meta" data-coverage>
            {cov.nodes} entities in the index · {cov.lastScan ? <>last scan <Time at={cov.lastScan.finishedAt ?? cov.lastScan.startedAt} /> ({cov.lastScan.status})</> : 'no scan yet'} · <a href="/system">coverage and diagnostics</a>
          </p>
          {!lens && <Sphere selected={nodeId ?? null} scanKey={`${cov.lastScan?.id ?? 'none'}:${cov.nodes}`} />}
          {(domain || kind) && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              Showing {kind && <span>{kindWord(kind)}</span>} {domain && <DomainChip domain={domain === 'shared' ? null : domain} />} <a href={qs({})}>clear the filter</a>
            </p>
          )}
          {lensData && (
            <div className="mt-3">
              <p className="meta">
                {lensData.anchor ? <>Under <a href={lensData.anchor.href}>{lensData.anchor.title}</a> (Records). </> : 'No X3LIUS Music System module is registered in this database, so the groups stand alone. '}
                {LENS_HINT}
              </p>
              <ul className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {lensData.groups.map((g) => (
                  <li key={g.key}>
                    <a href={qs({ lens: 'creative', group: g.key })} aria-current={group === g.key ? 'true' : undefined} className="card block p-3 no-underline" data-lens-group={g.key}>
                      <span className="flex items-baseline justify-between gap-2"><span className="text-ink-1">{g.label}</span><span className="num text-ink-1">{g.count}</span></span>
                      <span className="meta block">group · {g.query}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {list && (
            <div className="mt-3">
              <GraphList nodes={list.nodes} inspect={inspect} />
              <Pager page={list.page} perPage={list.perPage} total={list.total} at={(p) => qs({ domain, kind, lens, group, page: p })} />
            </div>
          )}
        </section>

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
            <ScrollTable label="Open tasks">
              <tbody>
                {d.openTasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td className="meta">{t.songTitle ? <a href={`/songs/${t.songId}`}>{t.songTitle}</a> : t.releaseTitle ? <a href={`/releases/${t.releaseId}`}>{t.releaseTitle}</a> : 'general'}</td>
                    <td className="meta">{t.dueDate ?? 'no date'}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
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
        <CommandInput />
      </section>
    </WithRail>
  );
}
