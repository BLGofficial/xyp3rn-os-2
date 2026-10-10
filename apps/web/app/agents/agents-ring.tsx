'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentClass, Domain } from '../../../../core/contracts/taxonomy.ts';
import { sofiaStamp } from '../../lib/clock';
import { layoutRing, shortLabel, type RingNode } from '../../lib/ring-layout';
import { ringStateOf } from '../../lib/ring-voice';
import { parseVoiceStatus, type VoiceEvent } from '../../lib/voice-status';
import type { TaskId } from '../../lib/task-catalog';
import { RingCore } from './ring-core';
import { RingOrb } from './ring-orb';
import { BTN_GHOST, BTN_GOLD, JARVIS_URL, JarvisPanel, Label, Panel, TaskStarter, type Launch } from './ring-panel';
import { RingStatus } from './ring-status';
import { RingWeb, type RingFire, type RingState } from './ring-web';

export type AgentRow = {
  readonly name: string;
  readonly cls: AgentClass;
  readonly domain: Domain;
  /** The first sentence of the agent's Role section. */
  readonly role: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly lastRun: { readonly status: string; readonly at: string; readonly latencyMs: number | null } | null;
};
export type DomainInfo = { readonly id: Domain; readonly label: string; readonly color: string };

type Seen = { readonly status: 'running' | 'idle'; readonly at: string };
type Sel = { readonly kind: 'jarvis' } | { readonly kind: 'agent'; readonly name: string } | { readonly kind: 'domain'; readonly id: Domain };
type JarvisState = 'checking' | 'online' | 'offline';

// Class family sets the node colour: those that decide, those that do, those that read and remember.
const CLASS_COLOR: Readonly<Record<AgentClass, string>> = {
  Planning: '#00e5ff', Critic: '#00e5ff', Governance: '#00e5ff', Revision: '#00e5ff',
  Execution: '#f5a623', Creative: '#f5a623',
  Research: '#7f9bb3', Knowledge: '#7f9bb3',
};
const LEGEND: readonly { readonly color: string; readonly label: string }[] = [
  { color: '#00e5ff', label: 'Plan · critique · govern · revise' },
  { color: '#f5a623', label: 'Execute · create' },
  { color: '#7f9bb3', label: 'Research · knowledge' },
];
// Which catalog task a domain's panel starts on. The server owns what each task runs; this only picks the default.
const DOMAIN_TASK: Readonly<Record<Domain, TaskId>> = { RESEARCH_INTELLIGENCE: 'research', RECORDS: 'music', TECH: 'agent', KNOWLEDGE: 'retrieve', CORE: 'retrieve', GOVERNANCE: 'retrieve' };
const ACTIVE_MS = 8000;
const CORE_DISC = '34.6%'; // the golden ring's diameter as a share of the stage width (2 x ORB_R / 680)

export function AgentsRing({ agents, domains, initialDomain }: { readonly agents: readonly AgentRow[]; readonly domains: readonly DomainInfo[]; readonly initialDomain: Domain | null }) {
  const meta = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);
  const [domain, setDomain] = useState<Domain | null>(initialDomain);
  const [sel, setSel] = useState<Sel | null>(null);
  const [fire, setFire] = useState<RingFire | null>(null);
  const [runState, setRunState] = useState<RingState>('standby');
  const [voice, setVoice] = useState<VoiceEvent | null>(null);
  const [seen, setSeen] = useState<Readonly<Record<string, Seen>>>({});
  const [link, setLink] = useState<'connecting' | 'live' | 'down'>('connecting');
  const [jarvis, setJarvis] = useState<JarvisState>('checking');
  const [launch, setLaunch] = useState<Launch>({ kind: 'idle' });
  const fireN = useRef(0);
  const lastSeq = useRef(-1);
  const calm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The stream handler outlives renders; it reads the view through refs, not stale closures.
  const view = useRef({ domain, agents });
  view.current = { domain, agents };

  const byDomain = useMemo(() => {
    const m = new Map<Domain, AgentRow[]>(domains.map((d) => [d.id, []]));
    for (const a of agents) m.get(a.domain)!.push(a);
    return m;
  }, [agents, domains]);

  const nodes = useMemo(() => {
    const raw: RingNode[] = domain === null
      ? domains.map((d) => ({ id: d.id, label: d.label, color: d.color, live: byDomain.get(d.id)!.length > 0, r: 9 }))
      : (byDomain.get(domain) ?? []).map((a) => ({ id: a.name, label: shortLabel(a.name), color: CLASS_COLOR[a.cls], live: true }));
    return layoutRing(raw);
  }, [domain, byDomain, domains]);

  const go = useCallback((next: Domain | null) => {
    setDomain(next);
    setSel(next ? { kind: 'domain', id: next } : null);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('domain', next); else url.searchParams.delete('domain');
    window.history.replaceState(null, '', url);
  }, []);

  const pick = useCallback((id: string) => {
    if (meta.has(id as Domain) && view.current.domain === null) {
      const d = id as Domain;
      if (byDomain.get(d)!.length > 0) go(d); else setSel({ kind: 'domain', id: d });
    } else setSel({ kind: 'agent', name: id });
  }, [byDomain, go, meta]);
  const close = useCallback(() => setSel(null), []);

  // Live runs: the HUD's own stream. An agent starting lights its node (or its domain, from the overview).
  useEffect(() => {
    if (typeof EventSource === 'undefined') { setLink('down'); return; }
    const es = new EventSource('/api/v1/hud/stream');
    es.onopen = () => setLink('live');
    es.onerror = () => setLink('down'); // EventSource reconnects on its own
    es.addEventListener('AGENT_RUN_UPDATE', (e) => {
      let d: { status?: string; title?: string; kind?: string; at?: string };
      try { d = JSON.parse((e as MessageEvent<string>).data) as typeof d; } catch { return; }
      if (d.kind !== 'agent' || !d.title) return;
      const status = d.status === 'running' ? 'running' : 'idle';
      setSeen((s) => ({ ...s, [d.title!]: { status, at: d.at ?? '' } }));
      if (status !== 'running') return;
      const a = view.current.agents.find((x) => x.name === d.title);
      if (!a) return;
      const id = view.current.domain === null ? a.domain : view.current.domain === a.domain ? a.name : null;
      if (id) { fireN.current += 1; setFire({ n: fireN.current, ids: [id] }); }
      setRunState('processing');
      clearTimeout(calm.current);
      calm.current = setTimeout(() => setRunState('standby'), ACTIVE_MS);
    });
    return () => { es.close(); clearTimeout(calm.current); };
  }, []);

  // Jarvis's voice status (relayed by /api/voice/stream). A consumer drops any event whose seq it has already seen.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/voice/stream');
    es.addEventListener('voice', (e) => {
      let raw: unknown;
      try { raw = JSON.parse((e as MessageEvent<string>).data); } catch { return; }
      const ev = parseVoiceStatus(raw);
      if (!ev || ev.seq <= lastSeq.current) return;
      lastSeq.current = ev.seq;
      setVoice(ev);
    });
    return () => es.close();
  }, []);

  // Is Jarvis answering? A no-cors request resolves for any reply (even a refusal) and fails only when nothing listens.
  const probe = useCallback(async () => {
    try { await fetch(`${JARVIS_URL}/`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2500) }); setJarvis('online'); } catch { setJarvis('offline'); }
  }, []);
  useEffect(() => {
    void probe();
    const t = setInterval(() => { if (!document.hidden) void probe(); }, 15_000);
    return () => clearInterval(t);
  }, [probe]);

  // Start Jarvis: the server launches galaxy/server.py (a fixed command) and answers once it responds, or says why not.
  const startJarvis = useCallback(async () => {
    setLaunch({ kind: 'starting' });
    try {
      const r = await fetch('/api/jarvis/start', { method: 'POST', signal: AbortSignal.timeout(20_000) });
      const data = (await r.json().catch(() => ({}))) as { detail?: string; logFile?: string; error?: string };
      if (!r.ok) throw new Error([data.detail ?? data.error ?? 'Jarvis could not be started.', data.logFile ? `Its log: ${data.logFile}` : ''].filter(Boolean).join(' '));
      setLaunch({ kind: 'idle' });
      await probe();
    } catch (e) {
      setLaunch({ kind: 'error', message: e instanceof DOMException || e instanceof TypeError ? 'The server did not answer. Check it is running, then try again.' : e instanceof Error ? e.message : 'Jarvis could not be started.' });
      await probe();
    }
  }, [probe]);

  // Voice wins while Jarvis is awake; otherwise the ring follows agent runs, then rests.
  const state: RingState = (voice && ringStateOf(voice.status)) || runState;
  const running = Object.values(seen).filter((s) => s.status === 'running').length;
  const agent = sel?.kind === 'agent' ? agents.find((a) => a.name === sel.name) ?? null : null;
  const domainSel = sel?.kind === 'domain' ? sel.id : null;
  const dot = jarvis === 'online' ? '#34d399' : jarvis === 'offline' ? '#ff5a4a' : '#c9a84c';

  return (
    <section aria-labelledby="ring-h" className="ring-stage rounded-control border border-line p-3" style={{ background: 'radial-gradient(ellipse 95% 88% at 50% 42%, #122c43 0%, #0c1d30 38%, #07111f 72%, #050b14 100%)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2 text-[#dfeaf3]">
        <div className="flex items-center gap-3">
          <h2 id="ring-h" className="m-0 text-[13px] font-medium uppercase tracking-[0.1em]">
            {domain === null ? 'Domains' : `${meta.get(domain)!.label} · ${byDomain.get(domain)!.length} agents`}
          </h2>
          {domain !== null && <button type="button" onClick={() => go(null)} className={BTN_GHOST}>← All domains</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span role="status" className="text-[#93a8ba]">{link === 'live' ? `Live · ${running} running` : link === 'connecting' ? 'Connecting…' : 'Live feed offline'}</span>
          <button type="button" onClick={() => setSel({ kind: 'jarvis' })} className={BTN_GHOST} aria-label={`Jarvis is ${jarvis}. Open the Jarvis panel`}>
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />Jarvis
          </button>
          {jarvis === 'offline'
            ? <button type="button" onClick={() => { setSel({ kind: 'jarvis' }); void startJarvis(); }} disabled={launch.kind === 'starting'} className={BTN_GOLD}>{launch.kind === 'starting' ? 'Starting Jarvis…' : 'Start Jarvis'}</button>
            : <a href={JARVIS_URL} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>Open Jarvis ↗</a>}
          <a href="/tasks" className={BTN_GHOST}>Tasks</a>
          <a href="/workflows" className={BTN_GHOST}>Workflows</a>
        </div>
      </div>

      {/* One box, one coordinate system: the nodes, the golden ring and the particle core all draw in 680 x 480, so
          they stay concentric at any size. The web is the lowest layer, so the ring's glow washes over its lines. */}
      <div className="relative mx-auto" style={{ aspectRatio: '680 / 480', width: 'min(100%, max(560px, calc((100vh - 230px) * 1.4167)))' }}>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ mixBlendMode: 'screen', background: `radial-gradient(circle at 50% 50%, rgba(13,210,255,${state === 'speaking' ? 0.3 : 0.18}) 0%, rgba(13,170,228,0.08) 30%, rgba(8,17,31,0) 62%)`, transition: 'background .6s ease' }} />
        <div className="absolute inset-0"><RingWeb nodes={nodes} state={state} fire={fire} onSelect={pick} /></div>
        <div className="pointer-events-none absolute inset-0"><RingOrb state={state} /></div>
        <RingCore state={state} />
        {/* The core is a button: it opens Jarvis's panel. It sits inside the nodes' moat, so no node is covered. */}
        <button type="button" onClick={() => setSel({ kind: 'jarvis' })} aria-label="Jarvis core. Open the Jarvis panel" title="Jarvis"
          className="absolute min-h-0 rounded-full border-0 bg-transparent p-0 hover:bg-white/[0.03]" style={{ left: '50%', top: '50%', width: CORE_DISC, aspectRatio: '1', transform: 'translate(-50%, -50%)', cursor: 'pointer' }} />

        {sel?.kind === 'jarvis' && (
          <Panel key="jarvis" title="Jarvis" subtitle="Voice agent" color="#f5a623" onClose={close}><JarvisPanel status={jarvis} voice={voice?.status ?? null} launch={launch} onStart={() => void startJarvis()} /></Panel>
        )}
        {agent && (
          <Panel key={agent.name} title={agent.name} subtitle={`${agent.cls} · ${meta.get(agent.domain)!.label}`} color={CLASS_COLOR[agent.cls]} onClose={close}>
            <AgentFacts agent={agent} seen={seen[agent.name]} />
            <a href={`/?node=${encodeURIComponent(`agent:${agent.name}`)}`} className={BTN_GHOST}>View in the knowledge graph</a>
            <TaskStarter defaultTask={DOMAIN_TASK[agent.domain]} color={CLASS_COLOR[agent.cls]} scope={`This agent is in ${meta.get(agent.domain)!.label}; the orchestrator picks which specialists run.`} />
          </Panel>
        )}
        {domainSel && (
          <Panel key={domainSel} title={meta.get(domainSel)!.label} subtitle={`Domain · ${byDomain.get(domainSel)!.length} agents`} color={meta.get(domainSel)!.color} onClose={close}>
            <DomainFacts agents={byDomain.get(domainSel)!} />
            <TaskStarter defaultTask={DOMAIN_TASK[domainSel]} color={meta.get(domainSel)!.color} scope="" />
          </Panel>
        )}
      </div>
      <div className="relative -mt-3 mx-auto" style={{ height: 100 }}>
        <RingStatus state={state} hint={domain === null ? 'CLICK A DOMAIN · CLICK THE CORE FOR JARVIS' : 'CLICK AN AGENT · CLICK THE CORE FOR JARVIS'} />
      </div>
      <ul className="flex flex-wrap justify-center gap-x-5 gap-y-1 px-1 pt-1 text-[12px] text-[#93a8ba]" aria-label="Colour key">
        {domain === null
          ? domains.map((d) => <li key={d.id} className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />{d.label}</li>)
          : LEGEND.map((l) => <li key={l.label} className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />{l.label}</li>)}
      </ul>
      {/* The graph is decorative; this is its keyboard and screen-reader equivalent. */}
      <nav className="sr-only" aria-label={domain === null ? 'Domains' : `${meta.get(domain)!.label} agents`}>
        <ul>{nodes.map((n) => <li key={n.id}><button type="button" onClick={() => pick(n.id)}>{n.label}</button></li>)}</ul>
      </nav>
    </section>
  );
}

function DomainFacts({ agents }: { agents: readonly AgentRow[] }) {
  const classes = new Map<string, number>();
  for (const a of agents) classes.set(a.cls, (classes.get(a.cls) ?? 0) + 1);
  return (
    <div>
      <Label color="#7f9bb3">Agents by class</Label>
      {agents.length === 0 ? <p className="m-0 text-white/60">No agents are registered in this domain yet.</p> : (
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          {[...classes].sort((a, b) => b[1] - a[1]).map(([c, n]) => <div key={c} className="contents"><dt className="text-white/70">{c}</dt><dd className="m-0 tabular-nums">{n}</dd></div>)}
        </dl>
      )}
    </div>
  );
}

function AgentFacts({ agent, seen }: { agent: AgentRow; seen: Seen | undefined }) {
  const last = agent.lastRun;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-white/75">{agent.role}</p>
      <p className="m-0 text-[12px] text-white/50">{agent.model === 'none' ? 'Deterministic: no model' : `Model ${agent.model}`}</p>
      <p className="m-0">
        {seen?.status === 'running' ? <span className="text-[#7df1ae]">Running now</span> : last
          ? <><span className={`status-${last.status}`}>{last.status}</span> <span className="text-[12px] text-white/50">{sofiaStamp(Date.parse(last.at))}{last.latencyMs !== null ? ` · ${last.latencyMs} ms` : ''}</span></>
          : <span className="text-[12px] text-white/50">Never run</span>}
      </p>
      {agent.tools.length > 0 && <p className="m-0 break-words text-[12px] text-white/50">Tools: {agent.tools.join(', ')}</p>}
    </div>
  );
}
