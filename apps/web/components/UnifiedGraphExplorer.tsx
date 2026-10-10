'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// /vault's graph: every indexed note and asset, clustered around one centroid per category, with the Obsidian drafts
// the watcher staged. Canvas 2D with a small force layout (no graph library): a pull to the node's centroid, pairwise
// repulsion, link springs. Live: /api/v1/hud/stream (agent runs) and /api/v1/vault/stream (the watcher's new notes).
// Clicking a draft opens its markdown and the "Approve to Promotion Gate" button, which only queues it for the operator.

const GROUPS = ['AGENTS', 'HANDOFFS', 'ARTIST-OS', 'SKILLS', 'SONGS', 'OBSIDIAN DRAFTS', 'OTHER'] as const;
type Group = (typeof GROUPS)[number];
const COLORS: Record<Group, string> = {
  AGENTS: '#D4AF37', HANDOFFS: '#00D9F5', 'ARTIST-OS': '#E752C2', SKILLS: '#A855F7', SONGS: '#458CFF', 'OBSIDIAN DRAFTS': '#7CE38B', OTHER: '#8A94A6',
};
const MAX_RUN_NODES = 60;
const BORN_MS = 2500;

type GNode = {
  id: string; label: string; group: Group; x: number; y: number; vx: number; vy: number; r: number; bornAt: number; live: boolean;
  draftId?: string; status?: string; href?: string;
};
type Edge = { a: string; b: string };
type Detail = { id: string; sourcePath: string; status: string; rawContent: string };

const groupOf = (g: unknown): Group => (typeof g === 'string' && (GROUPS as readonly string[]).includes(g) ? (g as Group) : 'OTHER');
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

const toNode = (raw: unknown, cx: number, cy: number): GNode | null => {
  const n = rec(raw), meta = rec(n.metadata);
  if (typeof n.id !== 'string') return null;
  const draftId = meta.kind === 'obsidian_draft' && typeof meta.draftId === 'string' ? meta.draftId : undefined;
  const group = draftId ? 'OBSIDIAN DRAFTS' : groupOf(n.group);
  return {
    id: n.id, label: String(n.label ?? n.id), group, x: cx + (Math.random() - 0.5) * 80, y: cy + (Math.random() - 0.5) * 80, vx: 0, vy: 0,
    r: draftId ? 6 : 4.5, bornAt: performance.now(), live: false, ...(draftId ? { draftId } : {}),
    ...(typeof meta.status === 'string' ? { status: meta.status } : {}),
    ...(typeof meta.href === 'string' && meta.href.startsWith('/') ? { href: meta.href } : {}),
  };
};

export default function UnifiedGraphExplorer({ className = '' }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const nodes = useRef(new Map<string, GNode>());
  const edges = useRef<Edge[]>([]);
  const hidden = useRef(new Set<Group>());
  const hovered = useRef<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const alpha = useRef(1);
  const size = useRef({ w: 800, h: 520 });
  const [version, setVersion] = useState(0);
  const [off, setOff] = useState<ReadonlySet<Group>>(new Set());
  const [selected, setSelected] = useState<GNode | null>(null);
  const [live, setLive] = useState<'CONNECTING' | 'LIVE' | 'OFFLINE'>('CONNECTING');
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [approve, setApprove] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' });

  const reheat = useCallback(() => { alpha.current = 1; setVersion((v) => v + 1); }, []);
  const center = () => ({ cx: size.current.w / 2, cy: size.current.h / 2 });

  // Centroids on a ring, one per category.
  const centroid = (g: Group) => {
    const { cx, cy } = center(), i = GROUPS.indexOf(g), a = (i / GROUPS.length) * Math.PI * 2 - Math.PI / 2;
    const R = Math.min(size.current.w, size.current.h) * 0.3;
    return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
  };

  const upsert = useCallback((raw: unknown): GNode | null => {
    const { cx, cy } = center();
    const fresh = toNode(raw, cx, cy);
    if (!fresh) return null;
    const old = nodes.current.get(fresh.id);
    if (old) { old.label = fresh.label; if (fresh.status) old.status = fresh.status; return old; }
    const c = centroid(fresh.group);
    fresh.x = c.x + (Math.random() - 0.5) * 60; fresh.y = c.y + (Math.random() - 0.5) * 60;
    nodes.current.set(fresh.id, fresh);
    return fresh;
  }, []);

  // Initial graph.
  useEffect(() => {
    const c = new AbortController();
    fetch('/api/v1/vault/graph', { signal: c.signal, headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`graph request failed: ${r.status}`))))
      .then((j: unknown) => {
        const body = rec(j);
        for (const n of Array.isArray(body.nodes) ? body.nodes : []) upsert(n);
        edges.current = (Array.isArray(body.links) ? body.links : []).map(rec)
          .filter((l) => typeof l.source === 'string' && typeof l.target === 'string' && nodes.current.has(l.source) && nodes.current.has(l.target))
          .map((l) => ({ a: l.source as string, b: l.target as string }));
        reheat();
      })
      .catch((e: unknown) => { if ((e as { name?: string }).name !== 'AbortError') setLoadError('The graph could not be loaded.'); });
    return () => c.abort();
  }, [upsert, reheat]);

  // Live: agent runs and the watcher's new notes.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const hud = new EventSource('/api/v1/hud/stream');
    const vault = new EventSource('/api/v1/vault/stream');
    let open = 0;
    const up = () => { open++; setLive('LIVE'); };
    const down = () => setLive(open > 0 ? 'LIVE' : 'OFFLINE');
    hud.onopen = up; vault.onopen = up; hud.onerror = down; vault.onerror = down;
    hud.addEventListener('AGENT_RUN_UPDATE', (e) => {
      const d = rec(parse((e as MessageEvent<string>).data));
      if (typeof d.title !== 'string') return;
      const n = upsert({ id: `run:${String(d.kind ?? 'run')}:${d.title}`, label: d.title, group: 'AGENTS', metadata: {} });
      if (!n) return;
      n.live = d.status === 'running';
      if (n.live) n.bornAt = performance.now();
      const runs = [...nodes.current.values()].filter((x) => x.id.startsWith('run:'));
      for (const old of runs.slice(0, Math.max(0, runs.length - MAX_RUN_NODES))) nodes.current.delete(old.id);
      reheat();
    });
    vault.addEventListener('NODE_CREATED', (e) => {
      const n = upsert(rec(parse((e as MessageEvent<string>).data)).node);
      if (!n) return;
      n.bornAt = performance.now();
      if (selectedId.current === n.id) setSelected({ ...n });
      reheat();
    });
    return () => { hud.close(); vault.close(); };
  }, [upsert, reheat]);

  // Simulation + drawing.
  useEffect(() => {
    const el = canvas.current, wrap = box.current;
    if (!el || !wrap) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
      size.current = { w, h };
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      alpha.current = Math.max(alpha.current, 0.4);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const step = () => {
      const vis = [...nodes.current.values()].filter((n) => !hidden.current.has(n.group));
      const k = alpha.current;
      for (const n of vis) {
        const c = centroid(n.group);
        n.vx += (c.x - n.x) * 0.012 * k; n.vy += (c.y - n.y) * 0.012 * k;
      }
      // Pairwise repulsion; skipped past 700 visible nodes, where the centroid pull alone keeps clusters apart.
      if (vis.length <= 700) {
        for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
          const a = vis[i]!, b = vis[j]!;
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 > 2500) continue;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
          const f = (40 / d2) * k, d = Math.sqrt(d2);
          a.vx += (dx / d) * f * d; a.vy += (dy / d) * f * d; b.vx -= (dx / d) * f * d; b.vy -= (dy / d) * f * d;
        }
      }
      for (const e of edges.current) {
        const a = nodes.current.get(e.a), b = nodes.current.get(e.b);
        if (!a || !b || hidden.current.has(a.group) || hidden.current.has(b.group)) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 46) * 0.01 * k;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const n of vis) { n.vx *= 0.8; n.vy *= 0.8; n.x += n.vx; n.y += n.vy; }
      alpha.current *= 0.992;
      if (alpha.current < 0.004) alpha.current = 0;
    };

    const draw = (now: number) => {
      const { w, h } = size.current;
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
      for (const g of GROUPS) {
        if (hidden.current.has(g)) continue;
        const c = centroid(g);
        ctx.fillStyle = `${COLORS[g]}33`; ctx.fillText(g, c.x, c.y - 70);
      }
      ctx.lineWidth = 1;
      for (const e of edges.current) {
        const a = nodes.current.get(e.a), b = nodes.current.get(e.b);
        if (!a || !b || hidden.current.has(a.group) || hidden.current.has(b.group)) continue;
        ctx.strokeStyle = 'rgba(160,175,200,0.16)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (const n of nodes.current.values()) {
        if (hidden.current.has(n.group)) continue;
        const color = COLORS[n.group], age = now - n.bornAt;
        if (age < BORN_MS) { // a new node announces itself with an expanding ring
          const t = age / BORN_MS;
          ctx.strokeStyle = color; ctx.globalAlpha = 1 - t; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + t * 26, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (n.live) {
          const pulse = 1 + 0.5 * Math.sin(now / 220);
          ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 * pulse, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        }
        ctx.fillStyle = color; ctx.globalAlpha = n.draftId && n.status !== 'pending_approval' ? 0.55 : 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (hovered.current === n.id || selectedId.current === n.id ? 2 : 0), 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
        if (hovered.current === n.id || selectedId.current === n.id) {
          ctx.fillStyle = '#E8EDF4'; ctx.fillText(n.label.length > 42 ? `${n.label.slice(0, 41)}…` : n.label, n.x, n.y - n.r - 7);
        }
      }
    };

    let raf = 0;
    const frame = (now: number) => { if (alpha.current > 0) step(); draw(now); raf = requestAnimationFrame(frame); };
    if (reduced) {
      // No animation: settle the layout in one go, redraw only when something changes.
      const settle = () => { alpha.current = 1; for (let i = 0; i < 300; i++) step(); alpha.current = 0; draw(performance.now()); };
      settle();
      const id = setInterval(() => { if (alpha.current > 0) settle(); else draw(performance.now()); }, 500);
      return () => { clearInterval(id); ro.disconnect(); };
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const hit = (ev: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): GNode | null => {
    const rect = ev.currentTarget.getBoundingClientRect(), x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    let best: GNode | null = null, bd = 1e9;
    for (const n of nodes.current.values()) {
      if (hidden.current.has(n.group)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= n.r + 5 && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  const select = (n: GNode | null) => {
    selectedId.current = n?.id ?? null;
    setSelected(n ? { ...n } : null);
    setApprove({ busy: false, message: '' });
    setDetail(null);
    setDetailState('idle');
  };

  // The drawer's markdown, for a draft.
  useEffect(() => {
    if (!selected?.draftId) return;
    const c = new AbortController();
    setDetailState('loading');
    fetch(`/api/v1/vault/drafts/${selected.draftId}`, { signal: c.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Detail) => { setDetail(d); setDetailState('idle'); })
      .catch((e: unknown) => { if ((e as { name?: string }).name !== 'AbortError') setDetailState('error'); });
    return () => c.abort();
  }, [selected?.id, selected?.draftId, selected?.status]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') select(null); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const toggle = (g: Group) => {
    const next = new Set(off);
    if (next.has(g)) next.delete(g); else next.add(g);
    hidden.current = next;
    setOff(next);
    reheat();
  };

  const approveDraft = async () => {
    if (!selected?.draftId) return;
    setApprove({ busy: true, message: '' });
    try {
      const res = await fetch(`/api/v1/vault/drafts/${selected.draftId}/approve`, { method: 'POST' });
      const out = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? `The server answered ${res.status}`);
      const n = nodes.current.get(selected.id);
      if (n) n.status = 'queued';
      setSelected((s) => (s ? { ...s, status: 'queued' } : s));
      setDetail((d) => (d ? { ...d, status: 'queued' } : d));
      setApprove({ busy: false, message: 'Queued for the Promotion Gate. The operator decides it (pnpm gate queue).' });
    } catch (e) {
      setApprove({ busy: false, message: e instanceof Error ? e.message : 'Could not queue the note.' });
    }
  };

  const count = (g: Group) => { void version; let c = 0; for (const n of nodes.current.values()) if (n.group === g) c++; return c; };
  const pending = detail?.status === 'pending_approval';

  return (
    <div className={`relative flex h-[min(72vh,680px)] min-h-[420px] overflow-hidden rounded-control border border-line bg-[#05070d] text-ink-1 ${className}`}>
      <aside aria-label="Graph filters" className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-black/30 p-3 text-[13px] max-md:w-36">
        <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-[0.1em] text-ink-3">
          <span>Filters</span>
          <span role="status" className={live === 'LIVE' ? 'text-[#7CE38B]' : 'text-ink-3'}>{live}</span>
        </div>
        {GROUPS.map((g) => (
          <label key={g} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-white/5">
            <input type="checkbox" checked={!off.has(g)} onChange={() => toggle(g)} />
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[g] }} />
            <span className="min-w-0 flex-1 truncate">{g}</span>
            <span className="text-[11px] text-ink-3">{count(g)}</span>
          </label>
        ))}
        {loadError && <p role="alert" className="mt-2 text-[12px] text-[#ff5a4a]">{loadError}</p>}
      </aside>

      <div ref={box} className="relative min-w-0 flex-1">
        <canvas ref={canvas} role="img" aria-label="Knowledge graph clustered by category. Select a node for details."
          className="absolute inset-0 h-full w-full cursor-default touch-none"
          onPointerMove={(e) => { const n = hit(e); hovered.current = n?.id ?? null; e.currentTarget.style.cursor = n ? 'pointer' : 'default'; }}
          onPointerLeave={() => { hovered.current = null; }}
          onClick={(e) => { const n = hit(e); if (n) select(n); }} />
      </div>

      {selected && (
        <section role="dialog" aria-label={`${selected.label} details`} className="absolute inset-y-0 right-0 z-10 flex w-[min(420px,100%)] flex-col border-l border-line bg-canvas/95 backdrop-blur-md">
          <header className="flex items-start gap-2 border-b border-line p-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.1em]" style={{ color: COLORS[selected.group] }}>{selected.group}</div>
              <div className="break-words text-[14px] font-medium">{selected.label}</div>
              {detail && <div className="break-all text-[11px] text-ink-3">{detail.sourcePath} · {detail.status}</div>}
            </div>
            <button type="button" onClick={() => select(null)} aria-label="Close" className="btn-quiet shrink-0">×</button>
          </header>
          {selected.draftId ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {detailState === 'loading' && <p className="text-[13px] text-ink-3">Loading the note…</p>}
                {detailState === 'error' && <p role="alert" className="text-[13px] text-[#ff5a4a]">The note could not be loaded.</p>}
                {/* The note is shown as text, never rendered as HTML: it is the owner's file, but still untrusted input. */}
                {detail && <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink-2">{detail.rawContent}</pre>}
              </div>
              <footer className="flex flex-col gap-2 border-t border-line p-3">
                {approve.message && <p role="status" className="text-[12.5px] text-ink-2">{approve.message}</p>}
                <button type="button" onClick={approveDraft} disabled={!pending || approve.busy}
                  title={pending ? 'Queue this note for the Promotion Gate' : 'Only a note that is pending approval can be sent'} className="btn-quiet">
                  {approve.busy ? 'Sending…' : pending ? 'Approve to Promotion Gate' : detail ? `Already ${detail.status}` : 'Approve to Promotion Gate'}
                </button>
                <p className="text-[11px] text-ink-3">Queues the note for the operator; nothing becomes canonical until the gate admits it.</p>
              </footer>
            </>
          ) : (
            <div className="p-3 text-[13px] text-ink-2">
              {selected.live && <p className="mb-2 text-[#D4AF37]">Running now.</p>}
              {selected.href ? <a href={selected.href}>Open →</a> : <p className="text-ink-3">No page for this node.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
