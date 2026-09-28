'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { arcControl, clampZoom, DOMAIN_DIRECTION, ease, facing, FOCUS_MS, hitRadius, layout, opacity, project, rimRadius, rotate, SPREAD, step, type Owner } from '../../lib/sphere.ts';
import { ACCENT, DOMAIN_LABEL, SURFACE, TEXT } from '../../lib/tokens.ts';
import type { OverviewData } from '../../server/graph-loaders.ts';
import { DOMAIN_STYLE } from '../shell/domains';

// The Mercury graph sphere (Jarvis Prompt 01; AOS-04 design §13.2, §14, §18). It draws /api/graph/overview and
// nothing else: graph_nodes rows, groups that name their query and members, graph_edges rows and grouping links,
// and the application hub from package.json. Nothing moves on its own: the camera turns only on a drag, the keys,
// or a selection (a 550 ms eased turn to face it; immediate under reduced motion). The Graph list below is the
// accessible equivalent: everything drawn here is also text there and in the inspector.

type Load = { readonly state: 'loading' } | { readonly state: 'error'; readonly reason: string } | { readonly state: 'ready'; readonly data: OverviewData };
type Mark = {
  readonly id: string; readonly kind: string; readonly title: string; readonly owner: Owner; readonly href: string;
  readonly group: { readonly count: number; readonly query: string; readonly memberIds: readonly string[] } | null;
};
type View = { readonly yaw: number; readonly pitch: number; readonly zoom: number };

const REST: View = { yaw: 0, pitch: 0, zoom: 1 };
// Clockwise from north, then the far side: the keyboard's up/down order follows the compass.
const OWNER_ORDER: readonly Owner[] = ['CORE', 'KNOWLEDGE', 'GOVERNANCE', 'RECORDS', 'TECH', 'RESEARCH_INTELLIGENCE', 'shared'];
const KIND_ORDER = ['domain', 'module', 'workflow', 'workflow_step', 'agent'];
const KIND_WORD: Readonly<Record<string, string>> = { domain: 'domain', module: 'component', workflow: 'workflow', workflow_step: 'workflow step', agent: 'agent' };
const hue = (o: Owner) => (o === 'shared' ? TEXT.secondary : DOMAIN_LABEL[o]);
const BASE_R: Readonly<Record<string, number>> = { domain: 9, module: 5, workflow: 6, agent: 4, workflow_step: 3 };
const markRadius = (m: Mark) => (m.group ? 5 + Math.min(9, Math.log2(m.group.count + 1) * 1.5) : BASE_R[m.kind] ?? 4);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// A label anchored at x, shifted by how far across it sits (left-aligned at the left edge, right-aligned at the right),
// so it never runs out of the drawing whatever the width.
const inside = (x: number, width: number, dy = '-50%') => {
  const at = Math.min(width - 4, Math.max(4, x));
  return { left: at, transform: `translate(${-Math.round((at / width) * 100)}%, ${dy})` };
};
const describe = (m: Mark) =>
  m.group ? `${m.title}: ${m.group.count} ${m.group.count === 1 ? 'entity' : 'entities'} (group · ${m.group.query})` : `${m.title} · ${KIND_WORD[m.kind] ?? m.kind} · ${DOMAIN_STYLE[m.owner].label}`;

/**
 * @param selected - the inspector's node (?node=), highlighted with its drawn neighbours
 * @param scanKey - changes when the index changes (the last scan and its node count): the overview is fetched again
 */
export function Sphere({ selected, scanKey }: { selected: string | null; scanKey: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(REST);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [reduced, setReduced] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const anim = useRef(0);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; moved: boolean; pointer: number } | null>(null);
  const userSelected = useRef(false);
  const suppressClick = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Measured, not assumed: below 960 px the sphere is behind a disclosure and measures 0 until opened.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // The box's height is CSS (340 px, 520 px from 960 px): the server-rendered skeleton and the drawn sphere take
    // the same space, so loading shifts nothing below it.
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.floor(e!.contentRect.width), height: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = size.width > 0;
  useEffect(() => {
    if (!visible) return;
    const ac = new AbortController();
    setLoad({ state: 'loading' });
    (async () => {
      try {
        const res = await fetch('/api/graph/overview', { cache: 'no-store', signal: ac.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setLoad({ state: 'error', reason: `${body?.error ?? 'the request failed'} (HTTP ${res.status})` });
          return;
        }
        setLoad({ state: 'ready', data: (await res.json()) as OverviewData });
      } catch (e) {
        if (!ac.signal.aborted) setLoad({ state: 'error', reason: e instanceof Error ? e.message : 'the request failed' });
      }
    })();
    return () => ac.abort();
  }, [visible, scanKey]);

  const data = load.state === 'ready' ? load.data : null;
  const marks = useMemo<Mark[]>(() => {
    if (!data) return [];
    const nodes: Mark[] = data.nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, owner: n.ownerDomain ?? 'shared', href: n.href, group: null }));
    const groups: Mark[] = data.groups.map((g) => ({ id: g.id, kind: 'group', title: g.label, owner: g.domain, href: g.href, group: { count: g.count, query: g.query, memberIds: g.memberIds } }));
    const rank = (m: Mark) => (m.group ? KIND_ORDER.length : Math.max(0, KIND_ORDER.indexOf(m.kind)));
    return [...nodes, ...groups].sort((a, b) =>
      OWNER_ORDER.indexOf(a.owner) - OWNER_ORDER.indexOf(b.owner) || rank(a) - rank(b) || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
  }, [data]);
  const byId = useMemo(() => new Map(marks.map((m) => [m.id, m])), [marks]);
  const positions = useMemo(() => layout(marks.map((m) => ({ id: m.id, domain: m.owner, anchor: m.kind === 'domain' }))), [marks]);
  const order = useMemo(() => marks.map((m) => ({ id: m.id, domain: m.owner })), [marks]);

  // The selected entity, or the group that lists it when it isn't drawn on its own.
  const selectedMark = useMemo(() => {
    if (!selected) return null;
    return byId.get(selected) ?? marks.find((m) => m.group?.memberIds.includes(selected)) ?? null;
  }, [selected, byId, marks]);
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (!data || !selectedMark) return s;
    for (const e of data.edges) {
      if (e.fromId === selectedMark.id) s.add(e.toId);
      if (e.toId === selectedMark.id) s.add(e.fromId);
    }
    return s;
  }, [data, selectedMark]);

  const turnTo = useCallback((target: { yaw: number; pitch: number }) => {
    cancelAnimationFrame(anim.current);
    const from = viewRef.current;
    const dYaw = wrapAngle(target.yaw - from.yaw);
    const dPitch = target.pitch - from.pitch;
    if (reduced || document.hidden) {
      setView((v) => ({ ...v, yaw: from.yaw + dYaw, pitch: target.pitch }));
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = ease((now - t0) / FOCUS_MS);
      setView((v) => ({ ...v, yaw: from.yaw + dYaw * k, pitch: from.pitch + dPitch * k }));
      if (k < 1) anim.current = requestAnimationFrame(tick);
    };
    anim.current = requestAnimationFrame(tick);
  }, [reduced]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  // A selection the viewer can't see (the far side, or past the rim) turns the sphere to face it: the focus
  // transition. One already in view stays put, so selecting never moves the camera without a reason.
  // Below 1280 px the inspector is below the page.
  useEffect(() => {
    if (!selectedMark) return;
    const p = positions.get(selectedMark.id);
    const now = viewRef.current;
    if (p && rotate(p, now.yaw, now.pitch).z < 0.3) turnTo(facing(p));
    if (userSelected.current) {
      userSelected.current = false;
      if (!window.matchMedia('(min-width: 1280px)').matches) document.getElementById('inspector-h')?.scrollIntoView({ block: 'start' });
    }
  }, [selectedMark, positions, turnTo]);

  const open = useCallback((m: Mark) => {
    if (m.group) {
      router.push(m.href);
      return;
    }
    const q = new URLSearchParams(params.toString());
    q.set('node', m.id);
    userSelected.current = true;
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  }, [params, pathname, router]);
  const clear = useCallback(() => {
    const q = new URLSearchParams(params.toString());
    q.delete('node');
    const s = q.toString();
    router.push(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const turn = 0.26;
    if (e.shiftKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      const dy = e.key === 'ArrowLeft' ? -turn : e.key === 'ArrowRight' ? turn : 0;
      const dp = e.key === 'ArrowUp' ? -turn : e.key === 'ArrowDown' ? turn : 0;
      setView((v) => ({ ...v, yaw: v.yaw + dy, pitch: Math.max(-1.4, Math.min(1.4, v.pitch + dp)) }));
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setFocusId(step(order, focusId, e.key));
    } else if (e.key === 'Enter' && focusId) {
      e.preventDefault();
      const m = byId.get(focusId);
      if (m) open(m);
    } else if (e.key === 'Escape') {
      if (focusId || hoverId) {
        setFocusId(null);
        setHoverId(null);
      } else if (selected) clear();
    } else if (e.key === '+' || e.key === '=') {
      setView((v) => ({ ...v, zoom: clampZoom(v.zoom * 1.25) }));
    } else if (e.key === '-' || e.key === '_') {
      setView((v) => ({ ...v, zoom: clampZoom(v.zoom / 1.25) }));
    } else if (e.key === 'r' || e.key === 'R') {
      cancelAnimationFrame(anim.current);
      setView(REST);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelAnimationFrame(anim.current);
    drag.current = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false, pointer: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      // Captured only once it is a drag, so a plain click still reaches the node under it.
      e.currentTarget.setPointerCapture(d.pointer);
    }
    if (d.moved) setView((v) => ({ ...v, yaw: d.yaw + dx * 0.008, pitch: Math.max(-1.4, Math.min(1.4, d.pitch + dy * 0.008)) }));
  };
  const endDrag = () => {
    // The click that ends a drag is not a selection.
    const d = drag.current;
    drag.current = null;
    if (d?.moved) suppressClick.current = true;
  };
  const onMarkClick = (m: Mark) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setFocusId(m.id);
    open(m);
  };

  const { width, height } = size;
  const v = { width, height, zoom: view.zoom };
  const cx = width / 2;
  const cy = height / 2;
  const rim = rimRadius(v);
  const shown = marks.map((m) => {
    const r = rotate(positions.get(m.id)!, view.yaw, view.pitch);
    return { m, p: project(r, v) };
  });
  const at = new Map(shown.map((s) => [s.m.id, s.p]));
  const active = byId.get(focusId ?? '') ?? byId.get(hoverId ?? '') ?? null;
  const activeAt = active ? at.get(active.id) : undefined;
  const empty = data !== null && data.nodes.every((n) => n.kind === 'domain') && data.groups.length === 0;

  return (
    <section aria-labelledby="sphere-h" className="mt-3">
      <h3 id="sphere-h" className="sr-only">Graph sphere</h3>
      <button type="button" className="btn-quiet md:hidden" aria-expanded={opened} aria-controls="sphere-body" onClick={() => setOpened((o) => !o)}>
        {opened ? 'Hide the sphere' : 'Show the sphere'}
      </button>
      <div id="sphere-body" className={`${opened ? 'block' : 'hidden'} md:block`}>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Sphere view">
          <button type="button" className="btn-quiet" onClick={() => { cancelAnimationFrame(anim.current); setView(REST); }}>Reset view</button>
          <button type="button" className="btn-quiet" aria-label="Zoom in" onClick={() => setView((x) => ({ ...x, zoom: clampZoom(x.zoom * 1.25) }))}>+</button>
          <button type="button" className="btn-quiet" aria-label="Zoom out" onClick={() => setView((x) => ({ ...x, zoom: clampZoom(x.zoom / 1.25) }))}>−</button>
          <span className="meta" data-sphere-coverage>
            {data
              ? <>Showing {data.counts.drawn} of {data.counts.indexed} entities; {data.counts.grouped} in {data.groups.length} {data.groups.length === 1 ? 'group' : 'groups'}{data.edgesTruncated ? ` · ${data.edges.length} of ${data.edgesTotal} links drawn` : ''}{data.demoted.length > 0 ? ` · grouped to fit: ${data.demoted.map((k) => KIND_WORD[k] ?? k).join(', ')}` : ''}</>
              : load.state === 'loading' ? 'Loading the graph…' : 'Graph unavailable'}
          </span>
        </div>
        <div ref={wrap} className="relative mt-2 h-[340px] w-full md:h-[520px]">
          {load.state === 'loading' && (
            <div aria-busy="true" className="panel flex h-full items-center justify-center" data-sphere-state="loading">
              <p className="meta">Loading the graph…</p>
            </div>
          )}
          {load.state === 'error' && (
            <div role="alert" className="panel flex h-full items-center justify-center p-6" data-sphere-state="error">
              <p>Graph unavailable: {load.reason}. The list below lists every entity.</p>
            </div>
          )}
          {data && width > 0 && (
            <div
              role="application" aria-label="Graph sphere" aria-describedby="sphere-help" tabIndex={0} onKeyDown={onKey}
              className="panel relative h-full overflow-hidden focus-visible:outline-2"
              data-sphere-state={empty ? 'empty' : 'populated'} data-motion={reduced ? 'reduced' : 'full'}
              onBlur={() => setFocusId(null)}
            >
              <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block touch-none select-none" aria-hidden="true"
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onPointerLeave={() => setHoverId(null)}>
                <defs>
                  <radialGradient id="sphere-fill" cx="42%" cy="38%" r="70%">
                    <stop offset="0%" stopColor={ACCENT.mercury} stopOpacity="0.07" />
                    <stop offset="100%" stopColor={SURFACE.canvas} stopOpacity="0" />
                  </radialGradient>
                </defs>
                <circle cx={cx} cy={cy} r={rim} fill="url(#sphere-fill)" stroke={ACCENT.mercury} strokeOpacity={0.35} strokeWidth={1.25} />
                {OWNER_ORDER.map((o) => {
                  // A domain's sector: its cap seen at an angle (an ellipse foreshortened by the facing).
                  const n = rotate(DOMAIN_DIRECTION[o], view.yaw, view.pitch);
                  const p = project(n, v);
                  const major = rim * Math.sin(SPREAD + 0.08) * p.scale;
                  return (
                    <ellipse key={o} cx={p.x} cy={p.y} rx={Math.max(1, major * Math.abs(n.z))} ry={major}
                      transform={`rotate(${(Math.atan2(-n.y, n.x) * 180) / Math.PI} ${p.x} ${p.y})`}
                      fill={hue(o)} fillOpacity={0.05 * opacity(p.depth)} stroke={hue(o)} strokeOpacity={0.22 * opacity(p.depth)} strokeWidth={1} />
                  );
                })}
                {data.edges.map((e) => {
                  const a = positions.get(e.fromId);
                  const b = positions.get(e.toId);
                  if (!a || !b) return null;
                  const pa = at.get(e.fromId)!;
                  const pb = at.get(e.toId)!;
                  const c = project(rotate(arcControl(a, b), view.yaw, view.pitch), v);
                  const lit = selectedMark !== null && (e.fromId === selectedMark.id || e.toId === selectedMark.id);
                  return (
                    <path key={e.id} d={`M${pa.x},${pa.y} Q${c.x},${c.y} ${pb.x},${pb.y}`} fill="none"
                      stroke={lit ? ACCENT.mercury : TEXT.secondary} strokeWidth={lit ? 1.5 : 0.75}
                      strokeOpacity={(lit ? 0.95 : 0.3) * opacity((pa.depth + pb.depth) / 2)} strokeDasharray={e.grouping ? '3 3' : undefined} />
                  );
                })}
                <g aria-hidden="true">
                  <path d={`M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} Z`} fill={ACCENT.champagne} fillOpacity={0.9}
                    onPointerEnter={() => setHoverId(null)} data-sphere-hub>
                    <title>{`${data.hub.title} ${data.hub.version}: the application, from package.json. Not an agent, a server or a database row.`}</title>
                  </path>
                </g>
                {[...shown].sort((x, y) => x.p.depth - y.p.depth).map(({ m, p }) => {
                  const r = markRadius(m) * p.scale;
                  const colour = hue(m.owner);
                  const isSel = selectedMark?.id === m.id;
                  const isNb = neighbours.has(m.id);
                  const isFocus = focusId === m.id;
                  const alpha = selectedMark && !isSel && !isNb ? opacity(p.depth) * 0.55 : opacity(p.depth);
                  return (
                    <g key={m.id} data-sphere-node={m.id} data-kind={m.kind} className="cursor-pointer transition-opacity duration-150" style={{ opacity: alpha }}
                      onPointerEnter={() => setHoverId(m.id)} onClick={() => onMarkClick(m)}>
                      {m.group ? (
                        <circle cx={p.x} cy={p.y} r={r} fill={colour} fillOpacity={0.1} stroke={colour} strokeWidth={1.5} strokeDasharray="2 2" />
                      ) : m.kind === 'domain' ? (
                        <>
                          <circle cx={p.x} cy={p.y} r={r + 3} fill="none" stroke={colour} strokeOpacity={0.6} strokeWidth={1} />
                          <circle cx={p.x} cy={p.y} r={r} fill={colour} />
                        </>
                      ) : m.kind === 'module' ? (
                        <rect x={p.x - r} y={p.y - r} width={2 * r} height={2 * r} rx={1.5} fill={SURFACE.surfaceRaised} stroke={colour} strokeWidth={1.5} />
                      ) : m.kind === 'workflow' ? (
                        <path d={`M${p.x},${p.y - r * 1.3} L${p.x + r * 1.3},${p.y} L${p.x},${p.y + r * 1.3} L${p.x - r * 1.3},${p.y} Z`} fill={SURFACE.surfaceRaised} stroke={colour} strokeWidth={1.5} />
                      ) : m.kind === 'workflow_step' ? (
                        <circle cx={p.x} cy={p.y} r={r} fill={colour} fillOpacity={0.8} />
                      ) : (
                        <circle cx={p.x} cy={p.y} r={r} fill={SURFACE.surfaceRaised} stroke={colour} strokeWidth={1.5} />
                      )}
                      {isSel && <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke={ACCENT.mercury} strokeWidth={2} data-sphere-selected />}
                      {isNb && !isSel && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={ACCENT.mercury} strokeOpacity={0.6} strokeWidth={1} />}
                      {isFocus && <circle cx={p.x} cy={p.y} r={r + 9} fill="none" stroke={ACCENT.focus} strokeWidth={2} data-sphere-focus />}
                      <circle cx={p.x} cy={p.y} r={hitRadius(r)} fill="transparent" />
                    </g>
                  );
                })}
              </svg>
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                {OWNER_ORDER.filter((o) => o !== 'shared').map((o) => {
                  const p = at.get(`domain:${o}`);
                  if (!p) return null;
                  const out = Math.hypot(p.x - cx, p.y - cy) || 1;
                  return (
                    <span key={o} className="absolute whitespace-nowrap text-[12px] font-medium" data-sphere-label={o}
                      style={{ ...inside(p.x + ((p.x - cx) / out) * 18, width), top: p.y + ((p.y - cy) / out) * 18, color: hue(o), opacity: opacity(p.depth) }}>
                      {DOMAIN_STYLE[o].label}
                    </span>
                  );
                })}
                <span className="absolute whitespace-nowrap text-[11px] text-champagne" style={{ left: cx, top: cy + 12, transform: 'translateX(-50%)' }}>{data.hub.title}</span>
                {active && activeAt && (
                  <span className="absolute max-w-[280px] rounded-control border border-control bg-raised px-2 py-1 text-[12px] text-ink-1" data-sphere-active
                    style={{ ...inside(activeAt.x, width, '0'), top: Math.max(4, activeAt.y - 40) }}>
                    {describe(active)}
                  </span>
                )}
              </div>
              <p className="sr-only" aria-live="polite">{active ? `${describe(active)}. Enter opens it.` : ''}</p>
              {empty && (
                <p className="absolute inset-x-0 bottom-3 text-center text-sm" data-sphere-empty>
                  No entities indexed yet · <a href="/system">Scan now on System</a>
                </p>
              )}
            </div>
          )}
        </div>
        <p id="sphere-help" className="meta mt-2">
          Centre: {data ? `${data.hub.title} ${data.hub.version}` : 'the application'}, its identity from package.json (not an agent, a server or a row).
          Shapes: ◉ domain · ▢ component · ◇ workflow · • workflow step · ○ agent · dashed ring: a group (it opens its members in the list).
          Keys: Tab to the sphere; arrows move between nodes (left/right within a domain, up/down across); Enter opens the inspector; Esc clears;
          Shift+arrows turn the sphere; + and − zoom; R resets. Drag to turn it; nothing moves on its own.
        </p>
      </div>
    </section>
  );
}
