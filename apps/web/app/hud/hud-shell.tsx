'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentsData, HudEvent, StatusData } from '../../server/hud-loaders';
import { HUD_DOMAIN, HUD_STATUS, LENS_DOMAIN, LENSES, ORBIT_ORDER, type HudOwner, type Lens } from '../../lib/hud-theme';
import { askAction } from '../ask-actions';
import { taskAction } from '../catalog-actions';
import { HudGlobe } from './hud-globe';
import { DomainIcon } from './hud-icons';
import { BrandLogo } from '../brand/logo';

export type Motion = 'cinematic' | 'calm' | 'off';
type Props = {
  readonly identity: { readonly name: string; readonly version: string };
  readonly owner: string;
  readonly components: ComponentsData | null;
  readonly componentsError: string | null;
  readonly status: StatusData | null;
  readonly lens: Lens;
};

const OWNERS: readonly HudOwner[] = [...ORBIT_ORDER, 'shared'];
const ACTIVITY_DOMAIN: Record<string, HudOwner> = { song: 'RECORDS', agent: 'CORE', workflow: 'CORE', research: 'RESEARCH_INTELLIGENCE', decision: 'GOVERNANCE' };
// Relative times render only after mount (null on the server): the server's clock and the browser's differ by the
// time the page takes to arrive, and "12s" against "13s" is a hydration mismatch.
const ago = (iso: string, now: number | null) => {
  if (now === null) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: the setting lasts this visit */ } };

/** Hides the app shell under the full-screen HUD from Tab and screen readers (the shell stays mounted). */
const useInertShell = () => useEffect(() => {
  const overflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const els = [document.querySelector('body > header'), document.querySelector('nav[aria-label="Primary"]'), document.querySelector('body > a[href="#main"]')]
    .filter((e): e is Element => e !== null);
  for (const e of els) e.setAttribute('inert', '');
  return () => { document.body.style.overflow = overflow; for (const e of els) e.removeAttribute('inert'); };
}, []);

export function HudShell({ identity, owner, components, componentsError, status: initialStatus, lens: initialLens }: Props) {
  useInertShell();
  const [lens, setLens] = useState<Lens>(initialLens);
  const [hidden, setHidden] = useState<ReadonlySet<HudOwner>>(new Set());
  const [status, setStatus] = useState(initialStatus);
  const [motion, setMotion] = useState<Motion>('cinematic');
  const [contrast, setContrast] = useState<'normal' | 'high'>('normal');
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  const [showGlobe, setShowGlobe] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskType, setTaskType] = useState<'ask' | 'deep' | 'catalog'>('ask');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [taskExecuting, setTaskExecuting] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const search = useRef<HTMLInputElement>(null);

  // Settings per browser; reduced motion always wins.
  useEffect(() => {
    const m = read('hud.motion'); if (m === 'calm' || m === 'off' || m === 'cinematic') setMotion(m);
    if (read('hud.contrast') === 'high') setContrast('high');
  }, []);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(q.matches);
    on(); q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  const effectiveMotion: Motion = reduced ? 'off' : motion;

  // The lens lives in the URL (shareable), without a server round trip.
  const chooseLens = useCallback((l: Lens) => {
    setLens(l);
    const u = new URL(location.href);
    if (l === 'GRAPH') u.searchParams.delete('lens'); else u.searchParams.set('lens', l);
    history.replaceState(null, '', u);
  }, []);

  // Status: re-read every 15 s while the tab is visible, and soon after each live event (counts roll only then).
  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/system/status', { cache: 'no-store' });
      if (r.ok) setStatus(await r.json() as StatusData);
    } catch { /* keep the last reading; its as-of time says how old it is */ }
  }, []);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) { setNow(Date.now()); void refreshStatus(); } };
    const t = setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', refresh); };
  }, [refreshStatus]);

  // Live events (GET /api/events/stream): each recorded row once when it starts and once when it finishes.
  const [live, setLive] = useState<HudEvent[]>([]);
  const [liveState, setLiveState] = useState<'connecting' | 'open' | 'down'>('connecting');
  const [pulse, setPulse] = useState<{ readonly seq: number; readonly event: HudEvent } | null>(null);
  const [scanSweep, setScanSweep] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    let seq = 0; let refresh: ReturnType<typeof setTimeout> | undefined; let sweep: ReturnType<typeof setTimeout> | undefined;
    es.onopen = () => setLiveState('open');
    es.onerror = () => setLiveState('down'); // EventSource reconnects on its own (retry: 5 s)
    es.addEventListener('problem', () => setLiveState('down'));
    es.addEventListener('activity', (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as HudEvent;
      setLiveState('open');
      setLive((l) => [e, ...l.filter((x) => x.key !== e.key)].slice(0, 20));
      setPulse({ seq: ++seq, event: e });
      if (e.kind === 'scan') { setScanSweep(e.status === 'running'); clearTimeout(sweep); if (e.status !== 'running') sweep = setTimeout(() => setScanSweep(false), 1500); }
      clearTimeout(refresh); refresh = setTimeout(() => void refreshStatus(), 800);
    });
    return () => { es.close(); clearTimeout(refresh); clearTimeout(sweep); };
  }, [refreshStatus]);

  // "/" focuses search (not while typing somewhere else).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (e.key === '/' && !(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) { e.preventDefault(); search.current?.focus(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  const byDomain = useMemo(() => {
    const m = new Map<HudOwner, { files: number; matched: number; orphans: number; diagnostics: number }>();
    for (const o of OWNERS) m.set(o, { files: 0, matched: 0, orphans: 0, diagnostics: 0 });
    for (const c of components?.components ?? []) {
      const r = m.get(c.domain)!;
      r.files += c.fileCount; r.diagnostics += c.diagnostics;
      if (c.slug === 'other' || c.slug === 'shared') r.orphans += c.fileCount; else r.matched += c.fileCount;
    }
    return m;
  }, [components]);
  const matchedTotal = [...byDomain.values()].reduce((s, r) => s + r.matched, 0);
  const hiddenFiles = [...hidden].reduce((s, o) => s + (byDomain.get(o)?.files ?? 0), 0);
  const attention = (status?.pulse ?? []).filter((p) => p.state === 'failed' || p.state === 'unavailable');

  const toggle = (o: HudOwner) => setHidden((h) => { const n = new Set(h); if (n.has(o)) n.delete(o); else n.add(o); return n; });

  return (
    <div className="hud" data-motion={effectiveMotion} data-contrast={contrast} data-hud-root>
      {/* A. Brand block */}
      <header className="hud-panel gold flex items-center gap-3 px-4" style={{ gridColumn: 1, gridRow: 1 }} aria-label="XYP3RN Agentic OS">
        <BrandLogo size={52} priority />
        <div className="leading-tight">
          <div className="hud-display hud-gold-text text-[22px]">XYP3RN</div>
          <div className="hud-label hud-2 text-[11px]">Agentic OS <span className="hud-data">v{identity.version}</span></div>
          <div className="hud-label hud-gold-text text-[10px] tracking-[0.3em]">Mercury Edition</div>
        </div>
      </header>

      {/* B. Top bar */}
      <div className="hud-panel hud-bar flex items-center gap-4 px-4" style={{ gridColumn: '2 / 4', gridRow: 1 }}>
        <button type="button" className="hud-label xl:hidden" onClick={() => setDrawer(drawer === 'left' ? null : 'left')} aria-expanded={drawer === 'left'}>Map</button>
        <LensTabs lens={lens} onChoose={chooseLens} />
        <form action="/search" method="get" role="search" aria-label="HUD search" className="flex min-w-0 flex-1 basis-60 items-center gap-2">
          <label className="relative flex-1">
            <span className="sr-only">Search or ask</span>
            <input ref={search} id="hud-q" name="q" type="search" autoComplete="off" placeholder="Search nodes, agents, files, decisions…" />
            <kbd className="hud-data hud-muted pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 border border-[var(--hud-border)] px-1.5 text-[11px]">/</kbd>
          </label>
          <button type="submit" className="hud-label">Search</button>
          <button type="submit" formAction={askAction} className="hud-label" style={{ background: 'linear-gradient(180deg,#F7C948,#D4912A)', color: '#1a1200', borderColor: '#F7C948' }}>Ask</button>
          <button type="button" onClick={() => setTaskModalOpen(true)} className="hud-label flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold" style={{ background: 'linear-gradient(180deg, #72D6F7, #53A2CE)', borderColor: '#72D6F7', color: '#04040b', boxShadow: '0 0 10px rgba(114, 214, 247, 0.3)' }} title="Start a new task directly from the web UI window">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            <span>Start Task</span>
          </button>
        </form>
        <a href="/" className="relative no-underline" aria-label={`${status?.counts.alerts ?? 0} catalog checks open (Command Center)`} title="Open catalog checks (blockers and warnings), from catalog_checks">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17V11a6 6 0 1 1 12 0v6l2 2H4zm4 3a2 2 0 0 0 4 0" fill="none" stroke="#C3D0E4" strokeWidth="1.5" /></svg>
          {(status?.counts.alerts ?? 0) > 0 && <span className="hud-data absolute -right-2 -top-2 bg-[#FF8FA3] px-1 text-[11px] leading-4 text-[#1a0008]">{status!.counts.alerts}</span>}
        </a>
        <OwnerMenu owner={owner} motion={motion} reduced={reduced} contrast={contrast}
          onMotion={(m) => { setMotion(m); write('hud.motion', m); }}
          onContrast={(c) => { setContrast(c); write('hud.contrast', c); }} />
        <p className="hud-label hud-2 hidden text-right text-[10px] leading-tight 2xl:block">Intelligence<br />works for creators.<br /><span className="hud-gold-text">X3LIUS</span></p>
        <button type="button" className="hud-label lg:hidden" onClick={() => setDrawer(drawer === 'right' ? null : 'right')} aria-expanded={drawer === 'right'}>Status</button>
      </div>

      {/* C. Left rail */}
      <nav className="hud-rail" data-drawer="left" data-open={drawer === 'left'} style={{ gridColumn: 1, gridRow: 2 }} aria-label="System map">
        <section className="hud-panel" aria-labelledby="map-h">
          <h2 id="map-h" className="hud-label hud-muted mb-2 mt-0">System map</h2>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            <MapItem active={lens === 'GRAPH'} onClick={() => chooseLens('GRAPH')}>Graph View</MapItem>
            <MapItem href="/command">List View</MapItem>
            <MapItem active={lens === 'AGENTS'} onClick={() => chooseLens('AGENTS')}>Agent Mesh</MapItem>
            <MapItem active={lens === 'WORKFLOWS'} onClick={() => chooseLens('WORKFLOWS')}>Workflow Flow</MapItem>
            <MapItem active={lens === 'KNOWLEDGE'} onClick={() => chooseLens('KNOWLEDGE')}>Knowledge Graph</MapItem>
            <MapItem href="/system">Resource Monitor</MapItem>
            <MapItem href="/">Live Events</MapItem>
          </ul>
        </section>
        <section className="hud-panel" aria-labelledby="filter-h">
          <h2 id="filter-h" className="hud-label hud-muted mb-2 mt-0">Filter nodes</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {OWNERS.map((o) => (
              <li key={o}>
                <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={!hidden.has(o)} onChange={() => toggle(o)} />
                  <span className="inline-block h-2.5 w-2.5" style={{ background: HUD_DOMAIN[o].base, boxShadow: `0 0 6px ${HUD_DOMAIN[o].glow}` }} aria-hidden="true" />
                  <span style={{ color: HUD_DOMAIN[o].label }}>{HUD_DOMAIN[o].title}</span>
                  <span className="hud-data hud-muted ml-auto text-[12px]">{byDomain.get(o)?.files ?? 0}</span>
                </label>
              </li>
            ))}
          </ul>
          {hidden.size > 0 && <p className="hud-data hud-muted mb-0 mt-2 text-[12px]">{hiddenFiles} files hidden · data unchanged</p>}
        </section>
        <section className="hud-panel" aria-labelledby="agents-h">
          <h2 id="agents-h" className="hud-label hud-muted mb-2 mt-0">Agent status</h2>
          {status ? (
            <dl className="m-0">
              <Row k="Registered" v={status.agents.registered} src="agent registry (agents/*.agent.md)" />
              <Row k="Ran · 24h" v={status.agents.ran24h} src="agent_runs, distinct agents in the last 24 h" />
              <Row k="Last run failed" v={status.agents.lastRunFailed} src="agent_runs, agents whose newest run is error" tone={status.agents.lastRunFailed > 0 ? 'failure' : undefined} />
              <Row k="LLM route" v={status.agents.llm} src="frontmatter model ≠ none" />
              <Row k="Deterministic" v={status.agents.deterministic} src="frontmatter model = none" />
            </dl>
          ) : <p className="hud-muted m-0">Status unavailable.</p>}
        </section>
        <section className="hud-panel" aria-label="Manifesto">
          <p className="hud-display m-0 text-[18px] leading-tight">A more creative<br /><span className="hud-gold-text">intelligent tomorrow.</span></p>
          <p className="hud-label hud-muted mb-0 mt-2 text-[10px] leading-relaxed">Technology × Music · Knowledge × Research · Human creativity</p>
        </section>
      </nav>

      {/* Below 960 px the list comes first; the globe waits behind a button. */}
      <section className="hud-panel hud-narrow-only p-4" aria-label="Graph list">
        <p className="m-0">Every entity is in the <a href="/">Graph list</a>, the globe&apos;s text twin.</p>
        <button type="button" className="hud-label mt-2" aria-expanded={showGlobe} onClick={() => setShowGlobe((v) => !v)}>{showGlobe ? 'Hide the globe' : 'Show the globe'}</button>
      </section>

      {/* D. Centre: the globe */}
      <main id="hud-main" className="relative" style={{ gridColumn: 2, gridRow: 2 }} aria-label="Graph view" data-show-globe={showGlobe}>
        <HudGlobe data={components} error={componentsError} hidden={hidden} lens={lens} focus={lens in LENS_DOMAIN ? LENS_DOMAIN[lens as keyof typeof LENS_DOMAIN] ?? null : null}
          identity={identity} motion={effectiveMotion} pulse={pulse} />
      </main>

      {/* E. Right rail */}
      <aside className="hud-rail" data-drawer="right" data-open={drawer === 'right'} style={{ gridColumn: 3, gridRow: 2 }} aria-label="System status and activity">
        <section className="hud-panel" aria-labelledby="status-h">
          <h2 id="status-h" className="hud-label hud-muted mb-1 mt-0">System status</h2>
          {status ? (
            <>
              <p className="hud-label m-0 mb-2 text-[12px]" style={{ color: attention.length ? HUD_STATUS.warning.color : HUD_STATUS.ok.color }}>
                {attention.length ? `${HUD_STATUS.warning.glyph} ${attention.length} ${attention.length > 1 ? 'checks need' : 'check needs'} attention` : `● All systems operational`}
              </p>
              {attention.length > 0 && <ul className="hud-data hud-muted m-0 mb-2 list-none p-0 text-[11px]">{attention.map((a) => <li key={a.label}>{a.label}: {a.detail}</li>)}</ul>}
              <dl className="m-0">
                <Row k="Agents registered" v={status.agents.registered} src="agent registry" />
                <Row k="Workflows run / defined" v={`${status.counts.workflowsRunning} / ${status.counts.workflowsDefined}`} src="workflow_runs running / graph workflow nodes" />
                <Row k="Graph entities" v={status.counts.graphEntities} src="graph_nodes" />
                <Row k="Files matched / indexed" v={`${matchedTotal} / ${components?.totals.files ?? '—'}`} src="knowledge-graph/components.ts path rules" />
                <Row k="Research run / total" v={`${status.counts.researchRunning} / ${status.counts.researchTotal}`} src="research_runs" />
                <Row k="Open briefs" v={status.metrics.cards.find((c) => c.key === 'openBriefs')?.value ?? '—'} src="research_questions, status open" />
                <Row k="Active songs" v={status.metrics.cards.find((c) => c.key === 'activeSongs')?.value ?? '—'} src="current_songs, active statuses" />
                <Row k="Connectors" v="0 · Prompt 11" src="none built yet" />
                <Row k="Server up since" v={new Date(status.bootedAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/Sofia' })} src="web process start (Sofia time)" />
              </dl>
              <Sparkline series={status.runsPerHour} />
            </>
          ) : <p className="hud-muted m-0">Status unavailable.</p>}
        </section>
        <section className="hud-panel" aria-labelledby="live-h">
          <div className="flex items-baseline justify-between">
            <h2 id="live-h" className="hud-label hud-muted mb-2 mt-0">Live activity</h2>
            <span className="hud-label text-[10px]" data-live={liveState} style={{ color: liveState === 'open' ? HUD_STATUS.ok.color : liveState === 'down' ? HUD_STATUS.warning.color : HUD_STATUS.info.color }}>
              {liveState === 'open' ? '● Live' : liveState === 'down' ? '! Reconnecting' : '• Connecting'}
            </span>
            <a href="/" className="hud-label text-[11px]">View all</a>
          </div>
          <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-live="polite">
            {live.slice(0, 5).map((e) => {
              const d = HUD_DOMAIN[(e.domain as HudOwner | null) ?? 'shared'] ?? HUD_DOMAIN.shared;
              const tone = e.status === 'error' ? HUD_STATUS.failure : e.status === 'success' ? HUD_STATUS.ok : HUD_STATUS.info;
              const flash = { '--flash': `${d.glow}55` } as React.CSSProperties;
              return (
                <li key={e.key} className="hud-flash flex items-start gap-2" style={flash} data-live-event={e.kind}>
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center" style={{ background: `${d.base}22`, boxShadow: `inset 0 0 0 1px ${d.base}66` }}><DomainIcon icon={d.icon} color={d.label} size={14} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{e.title}</span>
                    <span className="hud-data block text-[11px]" style={{ color: tone.color }}>{tone.glyph} {e.kind} · {e.status}</span>
                  </span>
                  <span className="hud-data hud-muted text-[11px]">{ago(e.at, now)}</span>
                </li>
              );
            })}
            {(status?.activity ?? []).slice(0, Math.max(0, 6 - live.length)).map((a, i) => {
              const d = HUD_DOMAIN[ACTIVITY_DOMAIN[a.kind] ?? 'shared'];
              return (
                <li key={`${a.at}-${i}`} className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center" style={{ background: `${d.base}22`, boxShadow: `inset 0 0 0 1px ${d.base}66` }}><DomainIcon icon={d.icon} color={d.label} size={14} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{a.href ? <a href={a.href}>{a.title}</a> : a.title}</span>
                    <span className="hud-data hud-muted block text-[11px]">{a.kind} · {a.status}</span>
                  </span>
                  <span className="hud-data hud-muted text-[11px]">{ago(a.at, now)}</span>
                </li>
              );
            })}
            {status && status.activity.length === 0 && live.length === 0 && <li className="hud-muted">No activity recorded yet.</li>}
          </ol>
        </section>
        <section className="hud-panel" aria-labelledby="files-h">
          <h2 id="files-h" className="hud-label hud-muted mb-2 mt-0">Files matched</h2>
          <table className="hud-data w-full table-fixed border-collapse text-[11px]">
            <colgroup><col className="w-[34%]" /><col /><col /><col /><col /></colgroup>
            <thead><tr className="hud-muted"><th className="text-left font-normal">Domain</th><th className="text-right font-normal">Files</th><th className="text-right font-normal">Match</th><th className="text-right font-normal">Other</th><th className="text-right font-normal">Diag</th></tr></thead>
            <tbody>
              {OWNERS.map((o) => {
                const r = byDomain.get(o)!;
                return (
                  <tr key={o}>
                    <td style={{ color: HUD_DOMAIN[o].label }}>
                      {HUD_DOMAIN[o].title.replace('XYP3RN ', '').replace(' Intelligence', '').replace(' Layer', '')}
                      <span className="mt-0.5 block h-[3px] bg-[rgba(148,190,255,0.12)]"><span className="block h-full transition-[width] duration-700" style={{ width: `${r.files ? (100 * r.matched) / r.files : 0}%`, background: HUD_DOMAIN[o].base }} /></span>
                    </td>
                    <td className="text-right">{r.files}</td><td className="text-right">{r.matched}</td><td className="text-right">{r.orphans}</td>
                    <td className="text-right" style={r.diagnostics ? { color: HUD_STATUS.warning.color } : undefined}>{r.diagnostics}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="m-0 mt-3"><span className="hud-metric hud-gold-text">{matchedTotal}</span> <span className="hud-label hud-2">files matched</span></p>
          <p className="hud-label hud-muted m-0 text-[10px]">Every edge has a line number</p>
        </section>
      </aside>

      {/* F. Bottom bar */}
      <footer className="hud-panel hud-bar flex items-center gap-4 px-4" style={{ gridColumn: '1 / 4', gridRow: 3 }}>
        <span className="hud-label hud-muted hidden text-[11px] xl:inline">XYP3RN Agentic OS · Mercury Edition</span>
        <div className="mx-auto flex flex-wrap items-center justify-center gap-2">
          <BottomSection label="APIs & connectors">
            <p className="m-0">Graph API: <span className="hud-data">/api/graph/overview · /node · /components</span>, <span className="hud-data">/api/system/status</span>.</p>
            <p className="m-0 mt-1 hud-muted">No platform connectors yet (Prompt 11).</p>
          </BottomSection>
          <BottomSection label="Data pipeline" sweep={scanSweep || status?.lastScan?.status === 'running'}>
            <p className="hud-data m-0">SCAN → HASH → PARSE → RESOLVE → PROJECT</p>
            <p className="m-0 mt-1">{status?.lastScan ? <>Last scan <strong>{status.lastScan.status}</strong>, started {new Date(status.lastScan.startedAt).toLocaleString('en-GB', { timeZone: 'Europe/Sofia' })}</> : 'No scan recorded yet.'}</p>
          </BottomSection>
          <BottomSection label="Security layer">
            <ul className="m-0 list-none p-0">{(status?.pulse ?? []).filter((p) => p.state === 'configured' || p.state === 'not-configured').map((p) => <li key={p.label}>{p.label}: {p.state === 'configured' ? 'Configured' : 'Not configured'}</li>)}</ul>
            <p className="m-0 mt-1 hud-muted">Least-privilege xyp_* roles; secret values never leave the server.</p>
          </BottomSection>
          <BottomSection label="Infrastructure">
            <ul className="m-0 list-none p-0">{(status?.pulse ?? []).filter((p) => p.label === 'Database' || p.label === 'Migration head' || p.label === 'Agents').map((p) => <li key={p.label}>{p.label}: <span className="hud-data">{p.detail}</span></li>)}</ul>
          </BottomSection>
          <BottomSection label="Local runtime 127.0.0.1">
            <p className="m-0">Next.js on this machine; up since <span className="hud-data">{status ? new Date(status.bootedAt).toLocaleString('en-GB', { timeZone: 'Europe/Sofia' }) : '—'}</span>.</p>
          </BottomSection>
        </div>
        <span className="hud-label hud-muted hidden text-right text-[10px] leading-tight xl:inline">Built by X3LIUS<br />for a higher tomorrow</span>
      </footer>

      {/* Task Launcher Modal */}
      {taskModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
          <div className="hud-panel relative w-full max-w-lg p-6 shadow-2xl border" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--cyan)' }}>
            <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-3 mb-4">
              <div>
                <h2 id="task-modal-title" className="hud-display text-lg m-0 flex items-center gap-2" style={{ color: 'var(--cyan)' }}>
                  <span className="text-amber-400">⚡</span> Jarvis OS Task Launcher
                </h2>
                <p className="hud-label hud-muted text-[11px] m-0 mt-0.5">Start an AI agent task or catalog action directly from this window</p>
              </div>
              <button
                type="button"
                onClick={() => setTaskModalOpen(false)}
                className="hud-label px-2 py-1 text-xs hover:bg-white/10"
              >
                ✕
              </button>
            </div>

            <form action={taskType === 'catalog' ? taskAction : askAction} onSubmit={() => setTaskExecuting(true)}>
              {taskType === 'deep' && <input type="hidden" name="deep" value="on" />}
              {taskType === 'catalog' && <input type="hidden" name="back" value="/" />}

              <div className="mb-4">
                <label className="hud-label block mb-1 text-[11px] text-[var(--text-muted)]">Select Task Mode:</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setTaskType('ask')}
                    className={`hud-label p-2 text-center text-xs transition-all ${taskType === 'ask' ? 'border-[var(--amber)] text-amber-300 bg-amber-500/10 font-bold' : 'hud-muted border-transparent bg-white/5'}`}
                  >
                    ⚡ Fast Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setTaskType('deep')}
                    className={`hud-label p-2 text-center text-xs transition-all ${taskType === 'deep' ? 'border-[var(--cyan)] text-cyan-300 bg-cyan-500/10 font-bold' : 'hud-muted border-transparent bg-white/5'}`}
                  >
                    🧠 Deep Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => setTaskType('catalog')}
                    className={`hud-label p-2 text-center text-xs transition-all ${taskType === 'catalog' ? 'border-[var(--plum)] text-purple-300 bg-purple-500/10 font-bold' : 'hud-muted border-transparent bg-white/5'}`}
                  >
                    📋 Catalog Task
                  </button>
                </div>
              </div>

              <div className="mb-4">
                <label htmlFor="task-prompt-input" className="hud-label block mb-1 text-[11px] text-[var(--text-muted)]">
                  {taskType === 'catalog' ? 'Task Title:' : 'Task Prompt / Instruction:'}
                </label>
                <textarea
                  id="task-prompt-input"
                  name={taskType === 'catalog' ? 'title' : 'q'}
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  required
                  rows={4}
                  placeholder={
                    taskType === 'catalog'
                      ? "Enter task title (e.g. 'Audit song splits for Sofia track', 'Schedule release press package')"
                      : "Enter task prompt (e.g. 'Analyze catalog readiness', 'Check distributor requirements', 'Run code verification')"
                  }
                  className="hud-data w-full p-3 bg-black/60 border border-[var(--hairline)] text-xs rounded text-[var(--text-headline)] focus:outline-none focus:border-[var(--cyan)]"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[var(--hairline)]">
                <span className="hud-data hud-muted text-[10px]">
                  {taskType === 'deep' ? 'Claude Code headless execution' : taskType === 'ask' ? 'Agent router & skill dispatch' : 'Adds task to database'}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTaskModalOpen(false)}
                    className="hud-label px-3 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={taskExecuting || !taskPrompt.trim()}
                    className="hud-label px-4 py-1.5 text-xs font-bold text-black disabled:opacity-50"
                    style={{ background: 'linear-gradient(180deg, #F7C948, #D4912A)', borderColor: '#F7C948' }}
                  >
                    {taskExecuting ? 'Starting Task...' : '▶ Start Task Now'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function LensTabs({ lens, onChoose }: { lens: Lens; onChoose: (l: Lens) => void }) {
  const refs = useRef(new Map<Lens, HTMLButtonElement>());
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const b = refs.current.get(lens);
    if (b) setBar({ left: b.offsetLeft + 8, width: b.offsetWidth - 16 });
  }, [lens]);
  return (
    <>
    <label className="xl:hidden"><span className="sr-only">Graph lens</span>
      <select value={lens} onChange={(e) => onChoose(e.target.value as Lens)} className="hud-label border border-[var(--hud-border)] bg-[rgba(4,10,22,0.72)] px-2 py-1.5 text-[12px] text-[#F4F8FF]">
        {LENSES.map((l) => <option key={l} value={l}>{l === 'GRAPH' ? '◆ Graph' : l.charAt(0) + l.slice(1).toLowerCase()}</option>)}
      </select>
    </label>
    <div role="tablist" aria-label="Graph lens" className="relative hidden shrink-0 items-center xl:flex">
      {LENSES.map((l) => (
        <button key={l} ref={(el) => { if (el) refs.current.set(l, el); }} type="button" role="tab" aria-selected={l === lens} aria-current={l === lens ? 'page' : undefined}
          className="hud-tab hud-label text-[12px]" onClick={() => onChoose(l)}>
          {l === 'GRAPH' ? '◆ Graph' : l.charAt(0) + l.slice(1).toLowerCase()}
        </button>
      ))}
      {bar && <span className="hud-underline" style={{ left: bar.left, width: bar.width }} aria-hidden="true" />}
    </div>
    </>
  );
}

function MapItem({ active, href, onClick, children }: { active?: boolean; href?: string; onClick?: () => void; children: React.ReactNode }) {
  const cls = `hud-label block w-full text-left text-[12px] !border-0 !bg-transparent !px-2 !py-1 no-underline ${active ? 'hud-active-bar !text-[#F4F8FF]' : '!text-[#C3D0E4]'}`;
  return <li>{href ? <a href={href} className={cls}>{children} <span className="hud-muted" aria-hidden="true">↗</span></a> : <button type="button" className={cls} aria-pressed={active} onClick={onClick}>{children}</button>}</li>;
}

function Row({ k, v, src, tone }: { k: string; v: number | string; src: string; tone?: keyof typeof HUD_STATUS }) {
  return (
    <div className="hud-row" title={`Source: ${src}`}>
      <dt className="hud-2 text-[13px]">{k}</dt>
      <dd className="hud-data m-0 text-[13px]" style={tone ? { color: HUD_STATUS[tone].color } : undefined}>{tone ? `${HUD_STATUS[tone].glyph} ` : ''}{typeof v === 'number' ? <Odometer value={v} /> : v}</dd>
    </div>
  );
}

/** A count that rolls to its new value (600 ms) when a real reading changes it; instant with Motion Off. */
function Odometer({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current; from.current = value;
    const off = document.querySelector('[data-hud-root]')?.getAttribute('data-motion') === 'off';
    if (off || start === value) { setShown(value); return; }
    const t0 = performance.now(); let id = 0;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 600); setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3))); if (k < 1) id = requestAnimationFrame(step); };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [value]);
  return <span data-odometer={value}>{shown}</span>;
}

function Sparkline({ series }: { series: readonly number[] }) {
  const max = Math.max(1, ...series);
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 240},${38 - (v / max) * 34}`).join(' ');
  const total = series.reduce((s, v) => s + v, 0);
  return (
    <figure className="m-0 mt-3">
      <svg viewBox="0 0 240 40" className="block h-10 w-full" role="img" aria-label={`Agent runs per hour, last 24 hours: ${total} in total, peak ${max === 1 && total === 0 ? 0 : max} in an hour`}>
        <defs><linearGradient id="spark" x1="0" x2="1"><stop offset="0" stopColor="#D4912A" /><stop offset="1" stopColor="#FFF1B8" /></linearGradient></defs>
        <polyline points={pts} fill="none" stroke="url(#spark)" strokeWidth="1.5" pathLength={1} className="hud-spark" />
      </svg>
      <figcaption className="hud-data hud-muted text-[11px]">Agent runs / hour · 24 h · {total} total</figcaption>
    </figure>
  );
}

function OwnerMenu({ owner, motion, reduced, contrast, onMotion, onContrast }: {
  owner: string; motion: Motion; reduced: boolean; contrast: 'normal' | 'high'; onMotion: (m: Motion) => void; onContrast: (c: 'normal' | 'high') => void;
}) {
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2" aria-label={`Owner menu: ${owner}`}>
        <span className="grid h-8 w-8 place-items-center rounded-full" style={{ boxShadow: '0 0 0 2px #F7C948, 0 0 10px rgba(247,201,72,.5)' }}>
          <span className="hud-display text-[12px]">{owner.slice(0, 1)}</span>
        </span>
        <span className="hidden leading-tight xl:block"><span className="hud-label block text-[12px]">{owner}</span><span className="hud-label hud-muted block text-[10px]">Session active</span></span>
      </summary>
      <div className="hud-panel absolute right-0 top-10 z-20 w-60 p-3">
        <fieldset className="m-0 border-0 p-0">
          <legend className="hud-label hud-muted text-[11px]">Motion</legend>
          {(['cinematic', 'calm', 'off'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-[13px] capitalize"><input type="radio" name="hud-motion" checked={motion === m} onChange={() => onMotion(m)} disabled={reduced} />{m}</label>
          ))}
          {reduced && <p className="hud-muted m-0 mt-1 text-[12px]">Your system asks for reduced motion: Off.</p>}
        </fieldset>
        <div className="hud-sep" />
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={contrast === 'high'} onChange={(e) => onContrast(e.target.checked ? 'high' : 'normal')} />High contrast</label>
      </div>
    </details>
  );
}

function BottomSection({ label, children, sweep }: { label: string; children: React.ReactNode; sweep?: boolean }) {
  return (
    <details className="relative">
      <summary data-sweep={sweep ? 'true' : undefined} className="hud-label hud-sweepable cursor-pointer list-none border border-[var(--hud-border)] bg-[rgba(20,38,70,0.55)] px-3 py-1.5 text-[11px]" style={{ clipPath: 'polygon(8px 0,100% 0,100% 100%,0 100%,0 8px)' }}>{label}</summary>
      <div className="hud-panel absolute bottom-10 left-1/2 z-20 w-80 -translate-x-1/2 p-3 text-[13px]">{children}</div>
    </details>
  );
}
