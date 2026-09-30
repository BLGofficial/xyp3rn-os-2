'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Domain } from '../../../../core/contracts/taxonomy';
import type { ComponentsData } from '../../server/hud-loaders';
import { bend, clampZoom, layout, satellites, toScreen, toWorld, zoomAt, type Item, type Pt, type View } from '../../lib/hud-layout';
import { HUD_DOMAIN, HUD_STATUS, levelAt, ORBIT_ORDER, ZOOM, type HudOwner, type Lens } from '../../lib/hud-theme';
import { DomainIcon, XGlyph } from './hud-icons';
import type { Motion } from './hud-shell';

/**
 * The Mercury HUD's centre (F52): a compact glass globe, the six domain medallions on their compass bearings, each
 * domain's sub-components (built: solid dot and file count; reserved: hollow and dimmed), and links that are
 * disclosed aggregates of graph_edges rows. The canvas draws light only; every label and control is HTML placed
 * from the same layout, so Tab, focus and screen readers work. Nothing here invents data: no random nodes, no
 * decorative light along links, no numbers that aren't in the API's answer.
 */

type Comp = ComponentsData['components'][number];
type Props = {
  readonly data: ComponentsData | null; readonly error: string | null; readonly hidden: ReadonlySet<HudOwner>;
  readonly lens: Lens; readonly focus: Domain | null; readonly identity: { readonly name: string; readonly version: string };
  readonly motion: Motion;
};

const EASE = (t: number) => 1 - (1 - t) ** 4; // close to cubic-bezier(0.22, 1, 0.36, 1)
const LENS_RELATIONS: Partial<Record<Lens, readonly string[]>> = { AGENTS: ['step_uses_agent'], WORKFLOWS: ['depends_on', 'part_of', 'step_uses_agent'] };

/** One cached glow sprite per hue (additive bloom without a filter per frame). */
const sprites = new Map<string, HTMLCanvasElement>();
const glowSprite = (hue: string) => {
  let s = sprites.get(hue);
  if (!s) {
    s = document.createElement('canvas'); s.width = s.height = 128;
    const g = s.getContext('2d')!; const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, `${hue}cc`); r.addColorStop(0.35, `${hue}44`); r.addColorStop(1, `${hue}00`);
    g.fillStyle = r; g.fillRect(0, 0, 128, 128); sprites.set(hue, s);
  }
  return s;
};

export function HudGlobe({ data, error, hidden, lens, focus, identity, motion }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ z: 1, focus: { x: 0, y: 0 } });
  const [rot, setRot] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverFile, setHoverFile] = useState<{ comp: Comp; i: number; at: Pt } | null>(null);
  const [boot, setBoot] = useState(1);
  const [pointer, setPointer] = useState<Pt>({ x: 0, y: 0 });
  const [tick, setTick] = useState(0);

  // Size: the canvas fills the centre cell.
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e!.contentRect.width), h: Math.round(e!.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const comps = useMemo(() => data?.components ?? [], [data]);
  const byId = useMemo(() => new Map(comps.map((c) => [c.id, c])), [comps]);
  const items = useMemo(() => {
    const out = {} as Record<Domain, Item[]>;
    for (const d of ORBIT_ORDER) out[d] = comps.filter((c) => c.domain === d && (c.slug !== 'other' || c.fileCount > 0)).map((c) => ({ id: c.id, group: c.group }));
    return out;
  }, [comps]);
  const L = useMemo(() => layout(size.w || 1, size.h || 1, items), [size, items]);
  const C = L.centre;
  const level = levelAt(view.z);
  const fit = useCallback((): View => ({ z: ZOOM.fit, focus: C }), [C]);

  // The first view: the URL's zoom and centre (?z=1.8&c=RECORDS), else FIT.
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current || size.w === 0) return;
    inited.current = true;
    const q = new URLSearchParams(location.search);
    const c = q.get('c') as Domain | null;
    const z = Number(q.get('z'));
    setView({ z: Number.isFinite(z) && z > 0 ? clampZoom(z) : ZOOM.fit, focus: c && c in L.medallion ? L.medallion[c] : C });
  }, [size.w, L, C]);
  // Keep the focus on the centre when the canvas resizes at FIT.
  useEffect(() => { setView((v) => (v.z === ZOOM.fit && !focus ? { ...v, focus: C } : v)); }, [C, focus]);

  // Animated view changes (350 ms), instant with motion off.
  const anim = useRef<number | null>(null);
  const animateTo = useCallback((to: View) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    if (motion === 'off') { setView(to); return; }
    const from = { ...view }; const t0 = performance.now();
    const step = (t: number) => {
      const k = EASE(Math.min(1, (t - t0) / 350));
      setView({ z: from.z + (to.z - from.z) * k, focus: { x: from.focus.x + (to.focus.x - from.focus.x) * k, y: from.focus.y + (to.focus.y - from.focus.y) * k } });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [motion, view]);

  // A domain lens turns the view to its sector; the graph lens returns to FIT.
  const lastLens = useRef<string | null>(null);
  useEffect(() => {
    if (!inited.current || size.w === 0) return;
    const key = `${lens}:${focus ?? ''}`;
    if (lastLens.current === key) return;
    const first = lastLens.current === null; lastLens.current = key;
    if (first && new URLSearchParams(location.search).has('z')) return; // the URL's view wins on load
    animateTo(focus ? { z: 1.6, focus: { x: (L.medallion[focus].x * 2 + C.x) / 3, y: (L.medallion[focus].y * 2 + C.y) / 3 } } : fit());
  }, [lens, focus, L, C, fit, animateTo, size.w]);

  // The view lives in the URL (z and the focused domain), written when it settles.
  useEffect(() => {
    const t = setTimeout(() => {
      const u = new URL(location.href);
      if (Math.abs(view.z - ZOOM.fit) < 0.01 && Math.hypot(view.focus.x - C.x, view.focus.y - C.y) < 1) { u.searchParams.delete('z'); u.searchParams.delete('c'); }
      else { u.searchParams.set('z', view.z.toFixed(2)); if (focus) u.searchParams.set('c', focus); else u.searchParams.delete('c'); }
      history.replaceState(null, '', u);
    }, 400);
    return () => clearTimeout(t);
  }, [view, focus, C]);

  // Boot (Cinematic, once per session, ~1.8 s, any key or click skips it).
  useEffect(() => {
    let seen = false; try { seen = sessionStorage.getItem('hud.booted') === '1'; sessionStorage.setItem('hud.booted', '1'); } catch { /* no storage: boot every load */ }
    if (motion !== 'cinematic' || seen) return;
    setBoot(0);
    const t0 = performance.now(); let id = 0;
    const skip = () => setBoot(1);
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 1800); setBoot((b) => (b >= 1 ? 1 : k)); if (k < 1) id = requestAnimationFrame(step); };
    id = requestAnimationFrame(step);
    addEventListener('keydown', skip, { once: true }); addEventListener('pointerdown', skip, { once: true });
    return () => { cancelAnimationFrame(id); removeEventListener('keydown', skip); removeEventListener('pointerdown', skip); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ambient (Cinematic only): a clock for the rim shimmer and the breathing glows; paused while the tab is hidden.
  useEffect(() => {
    if (motion !== 'cinematic') return;
    let id = 0;
    const loop = () => { if (!document.hidden) setTick(performance.now()); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [motion]);

  const visible = useCallback((d: HudOwner) => !hidden.has(d), [hidden]);
  const relations = LENS_RELATIONS[lens];
  const links = useMemo(() => (data?.links ?? []).filter((l) => {
    const a = byId.get(l.from), b = byId.get(l.to);
    return a && b && L.anchors.has(l.from) && L.anchors.has(l.to) && visible(a.domain) && visible(b.domain) && (!relations || relations.includes(l.relation));
  }), [data, byId, L, visible, relations]);
  const exp = expanded ? byId.get(expanded) : undefined;
  const sats = useMemo(() => (exp && L.anchors.has(exp.id) ? satellites(L.anchors.get(exp.id)!.dot, exp.files.length) : []), [exp, L]);

  // Draw: one pass per change (and per ambient frame in Cinematic).
  useEffect(() => {
    const cv = canvas.current; if (!cv || size.w === 0) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== size.w * dpr) { cv.width = size.w * dpr; cv.height = size.h * dpr; }
    const g = cv.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * (C.x - view.focus.x * view.z), dpr * (C.y - view.focus.y * view.z));
    const now = tick / 1000;
    const ambient = motion === 'cinematic';
    const par = ambient ? { x: ((pointer.x - C.x) / size.w) * 6, y: ((pointer.y - C.y) / size.h) * 6 } : { x: 0, y: 0 };
    const R = L.r;
    const rim = Math.min(1, boot / 0.3);

    // Globe: glass body, inner glow, wireframe (drifts ≤ 6 px toward the pointer), rim (draws itself at boot).
    const body = g.createRadialGradient(C.x - R * 0.3, C.y - R * 0.35, R * 0.1, C.x, C.y, R);
    body.addColorStop(0, 'rgba(120,190,255,0.16)'); body.addColorStop(0.7, 'rgba(40,90,170,0.08)'); body.addColorStop(1, 'rgba(10,30,70,0.02)');
    g.fillStyle = body; g.beginPath(); g.arc(C.x, C.y, R, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(C.x, C.y, R, 0, Math.PI * 2); g.clip();
    g.strokeStyle = 'rgba(168,210,255,0.10)'; g.lineWidth = 1 / view.z;
    for (let k = -3; k <= 3; k++) { const lat = (k / 4) * (Math.PI / 2); g.beginPath(); g.ellipse(C.x + par.x, C.y + par.y + R * Math.sin(lat), R * Math.cos(lat), R * Math.cos(lat) * 0.22, 0, 0, Math.PI * 2); g.stroke(); }
    for (let k = 0; k < 6; k++) { const a = rot + (k * Math.PI) / 6; g.beginPath(); g.ellipse(C.x + par.x, C.y + par.y, Math.abs(R * Math.cos(a)), R, 0, 0, Math.PI * 2); g.stroke(); }
    g.restore();
    g.strokeStyle = 'rgba(200,236,255,0.55)'; g.lineWidth = 1.4 / view.z;
    g.beginPath(); g.arc(C.x, C.y, R, -Math.PI / 2, -Math.PI / 2 + rim * Math.PI * 2); g.stroke();
    if (ambient) { // rim shimmer: one bright arc every 8 s
      const s = ((now % 8) / 8) * Math.PI * 2 - Math.PI / 2;
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2 / view.z; g.beginPath(); g.arc(C.x, C.y, R, s, s + 0.35); g.stroke();
    }
    g.globalCompositeOperation = 'lighter';
    g.drawImage(glowSprite('#F7C948'), C.x - R * 0.45, C.y - R * 0.45, R * 0.9, R * 0.9);
    g.globalCompositeOperation = 'source-over';

    const dim = (d: HudOwner) => (focus && d !== focus ? 0.3 : 1) * (visible(d) ? 1 : 0);
    const litBy = (id: string) => !hover || id === hover;

    // Links: aggregated graph_edges, thickness by count, a gradient from the source hue to the target hue.
    if (boot > 0.6 && level !== 'Constellation') {
      for (const l of links) {
        const a = L.anchors.get(l.from)!.dot, b = L.anchors.get(l.to)!.dot;
        const ca = byId.get(l.from)!, cb = byId.get(l.to)!;
        const on = !hover || l.from === hover || l.to === hover;
        const grad = g.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, HUD_DOMAIN[ca.domain].glow); grad.addColorStop(1, HUD_DOMAIN[cb.domain].glow);
        g.globalAlpha = (on ? 0.55 : 0.08) * Math.min(dim(ca.domain), dim(cb.domain) || 1) * Math.min(1, (boot - 0.6) / 0.2);
        g.strokeStyle = grad; g.lineWidth = (0.6 + Math.log2(l.count + 1) * 0.8) / Math.sqrt(view.z);
        const k = bend(a, b, C);
        g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(k.x, k.y, b.x, b.y); g.stroke();
      }
      g.globalAlpha = 1;
    }

    // Medallions (glow, breathing ±8% in Cinematic), spokes and sub-component dots.
    ORBIT_ORDER.forEach((d, i) => {
      const lit = Math.min(1, Math.max(0, (boot - 0.3 - i * 0.045) / 0.1));
      const alpha = dim(d) * lit; if (alpha <= 0) return;
      const m = L.medallion[d]; const t = HUD_DOMAIN[d];
      const breathe = ambient ? 1 + 0.08 * Math.sin((now / 4) * Math.PI * 2 + i) : 1;
      g.globalAlpha = alpha; g.globalCompositeOperation = 'lighter';
      const s = 110 * breathe; g.drawImage(glowSprite(t.glow), m.x - s / 2, m.y - s / 2, s, s);
      g.globalCompositeOperation = 'source-over';
      if (level === 'Constellation') { g.globalAlpha = 1; return; }
      const spoke = Math.min(1, Math.max(0, (boot - 0.6) / 0.2));
      for (const it of items[d]) {
        const an = L.anchors.get(it.id)!; const c = byId.get(it.id)!;
        const on = litBy(it.id) ? 1 : 0.35;
        g.globalAlpha = alpha * spoke * 0.35 * on; g.strokeStyle = t.base; g.lineWidth = 1 / view.z;
        g.beginPath(); g.moveTo(m.x, m.y); g.lineTo(an.dot.x, an.dot.y); g.stroke();
        g.globalAlpha = alpha * spoke * on;
        g.beginPath(); g.arc(an.dot.x, an.dot.y, 3.2, 0, Math.PI * 2);
        if (c.status === 'built') { g.fillStyle = t.base; g.fill(); g.globalCompositeOperation = 'lighter'; g.drawImage(glowSprite(t.glow), an.dot.x - 9, an.dot.y - 9, 18, 18); g.globalCompositeOperation = 'source-over'; }
        else { g.strokeStyle = t.base; g.globalAlpha *= 0.55; g.lineWidth = 1 / view.z; g.stroke(); }
        if (c.diagnostics > 0 && level !== 'System') { g.globalAlpha = alpha; g.fillStyle = HUD_STATUS.warning.color; g.fillRect(an.dot.x + 5, an.dot.y - 8, 3, 3); }
      }
      g.globalAlpha = 1;
    });

    // Satellites: the expanded component's real files.
    if (exp) {
      const t = HUD_DOMAIN[exp.domain];
      sats.forEach((p, i) => {
        const on = hoverFile?.comp.id === exp.id && hoverFile.i === i;
        g.fillStyle = on ? '#FFFFFF' : t.base; g.globalAlpha = on ? 1 : 0.85;
        g.beginPath(); g.arc(p.x, p.y, on ? 3.4 : 2.2, 0, Math.PI * 2); g.fill();
      });
      g.globalAlpha = 1;
    }
  }, [size, view, L, C, links, items, byId, boot, tick, motion, pointer, rot, hover, level, focus, visible, exp, sats, hoverFile]);

  // Minimap: the whole orbit at 160×100 and the viewport.
  useEffect(() => {
    const cv = mini.current; if (!cv || size.w === 0) return;
    const g = cv.getContext('2d')!; const s = Math.min(160 / size.w, 100 / size.h);
    g.clearRect(0, 0, 160, 100); g.save(); g.translate((160 - size.w * s) / 2, (100 - size.h * s) / 2); g.scale(s, s);
    g.strokeStyle = 'rgba(200,236,255,.5)'; g.lineWidth = 1 / s; g.beginPath(); g.arc(C.x, C.y, L.r, 0, Math.PI * 2); g.stroke();
    for (const d of ORBIT_ORDER) { g.fillStyle = HUD_DOMAIN[d].base; g.fillRect(L.medallion[d].x - 12, L.medallion[d].y - 12, 24, 24); }
    const tl = toWorld({ x: 0, y: 0 }, view, C), br = toWorld({ x: size.w, y: size.h }, view, C);
    g.strokeStyle = '#F7C948'; g.lineWidth = 2 / s; g.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    g.restore();
  }, [size, view, L, C]);

  // Input: wheel zooms toward the cursor; drag pans; Shift or right drag turns the wireframe; double-click zooms in.
  const drag = useRef<{ x: number; y: number; turn: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = wrap.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onWheel = (e: React.WheelEvent) => { const p = local(e); setView((v) => zoomAt(v, C, p, v.z * Math.exp(-e.deltaY * 0.0015))); };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    drag.current = { ...local(e), turn: e.shiftKey || e.button === 2 };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e); setPointer(p);
    const d = drag.current;
    if (d) {
      const dx = p.x - d.x, dy = p.y - d.y; drag.current = { ...d, x: p.x, y: p.y };
      if (d.turn) setRot((r) => r + dx * 0.01); else setView((v) => ({ ...v, focus: { x: v.focus.x - dx / v.z, y: v.focus.y - dy / v.z } }));
      return;
    }
    if (exp) { // hover a satellite: nearest within 7 px on screen
      const w = toWorld(p, view, C); let best = -1, bd = 7 / view.z;
      sats.forEach((s, i) => { const dd = Math.hypot(s.x - w.x, s.y - w.y); if (dd < bd) { bd = dd; best = i; } });
      setHoverFile(best >= 0 ? { comp: exp, i: best, at: p } : null);
    }
  };
  const onPointerUp = () => { drag.current = null; };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    if (hoverFile) { const f = hoverFile.comp.files[hoverFile.i]; if (f?.fileId) location.href = `/index/files/${f.fileId}`; return; }
    setExpanded(null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== wrap.current) return;
    const pan = 40 / view.z;
    const k: Record<string, () => void> = {
      '+': () => animateTo(zoomAt(view, C, C, view.z * 1.25)), '=': () => animateTo(zoomAt(view, C, C, view.z * 1.25)),
      '-': () => animateTo(zoomAt(view, C, C, view.z / 1.25)), '0': () => animateTo(fit()),
      ArrowLeft: () => setView((v) => ({ ...v, focus: { ...v.focus, x: v.focus.x - pan } })), ArrowRight: () => setView((v) => ({ ...v, focus: { ...v.focus, x: v.focus.x + pan } })),
      ArrowUp: () => setView((v) => ({ ...v, focus: { ...v.focus, y: v.focus.y - pan } })), ArrowDown: () => setView((v) => ({ ...v, focus: { ...v.focus, y: v.focus.y + pan } })),
      Escape: () => { setExpanded(null); setHover(null); },
    };
    const f = k[e.key]; if (f) { e.preventDefault(); if (e.shiftKey && e.key.startsWith('Arrow')) setRot((r) => r + (e.key === 'ArrowLeft' ? -0.2 : 0.2)); else f(); }
  };
  const onMini = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1 && e.type !== 'pointerdown') return;
    const r = e.currentTarget.getBoundingClientRect(); const s = Math.min(160 / size.w, 100 / size.h);
    const x = (e.clientX - r.left - (160 - size.w * s) / 2) / s, y = (e.clientY - r.top - (100 - size.h * s) / 2) / s;
    setView((v) => ({ ...v, focus: { x, y } }));
  };

  const at = (p: Pt) => toScreen(p, view, C);
  const labelsIn = Math.min(1, Math.max(0, (boot - 0.75) / 0.25));
  const empty = data !== null && data.totals.files === 0;
  const hoverComp = hover ? byId.get(hover) : undefined;
  const shared = byId.get('shared');

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden outline-none" tabIndex={0} aria-label="Graph globe: + and − zoom, 0 fits, arrows pan, Shift+arrows turn"
      data-hud-globe data-level={level} data-zoom={view.z.toFixed(2)}
      onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClick={onClick} onDoubleClick={(e) => animateTo(zoomAt(view, C, local(e), view.z * 2))} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
      style={{ cursor: drag.current ? 'grabbing' : hoverFile ? 'pointer' : 'grab' }}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" data-globe-r={L.r.toFixed(1)} />

      {size.w === 0 && <p className="hud-label hud-muted absolute inset-0 grid place-items-center">Loading the graph…</p>}
      {error && (
        <div className="hud-panel absolute left-1/2 top-6 z-10 -translate-x-1/2 px-4 py-3" role="alert">
          <p className="m-0" style={{ color: HUD_STATUS.failure.color }}>{HUD_STATUS.failure.glyph} Graph unavailable: {error}</p>
          <p className="hud-muted m-0 text-[13px]"><a href="/">The list lists every entity.</a></p>
        </div>
      )}
      {empty && <p className="hud-panel absolute left-1/2 top-6 z-10 m-0 -translate-x-1/2 px-4 py-2">No files indexed yet · <a href="/system">Rescan</a></p>}

      {/* Hub: the application identity (package.json), configuration, never connected. */}
      {size.w > 0 && (
        <div className="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: at(C).x, top: at(C).y, opacity: Math.min(1, boot / 0.35) }}
          title={`${identity.name} v${identity.version}: the application itself (package.json). Configuration, not an agent or a server; never connected.`}>
          <XGlyph size={Math.round(46 * Math.min(1.6, Math.max(0.8, view.z)))} id="hub" />
          <span className="hud-display hud-gold-text mt-1 text-[13px]">XYP3RN</span>
          <span className="hud-label hud-2 text-[10px]">Agentic OS</span>
        </div>
      )}

      {/* Medallions */}
      {size.w > 0 && ORBIT_ORDER.map((d, i) => {
        const t = HUD_DOMAIN[d]; const p = at(L.medallion[d]);
        const total = comps.filter((c) => c.domain === d).reduce((s, c) => s + c.fileCount, 0);
        const lit = Math.min(1, Math.max(0, (boot - 0.3 - i * 0.045) / 0.1));
        const outward = L.medallion[d].y < C.y ? 'bottom' : 'top';
        return (
          <div key={d} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: p.x, top: p.y, opacity: lit * (hidden.has(d) ? 0 : focus && d !== focus ? 0.35 : 1), transition: 'opacity 250ms' }} data-medallion={d}>
            <div className="grid h-[60px] w-[60px] place-items-center rounded-full" style={{ background: 'rgba(4,10,22,0.72)', boxShadow: `0 0 0 1.5px ${t.base}, 0 0 18px ${t.glow}66, inset 0 0 14px ${t.glow}33` }}>
              <DomainIcon icon={t.icon} color={t.label} size={26} />
            </div>
            <div className={`absolute left-1/2 w-56 -translate-x-1/2 text-center ${outward === 'bottom' ? 'top-[66px]' : 'bottom-[66px]'}`}>
              <div className="hud-display text-[15px] leading-tight" style={{ color: t.label, textShadow: `0 0 1px rgba(0,0,0,.9), 0 0 10px ${t.glow}4d` }}>{t.title}</div>
              <div className="hud-label hud-muted text-[10px]">{t.tagline}</div>
              {level === 'Constellation' && <div className="hud-data text-[12px]" style={{ color: t.label }}>{total} files</div>}
            </div>
          </div>
        );
      })}

      {/* Sub-component labels (HTML buttons at the canvas dots). */}
      {size.w > 0 && level !== 'Constellation' && [...L.anchors.values()].map((an) => {
        const c = byId.get(an.id)!; const t = HUD_DOMAIN[an.domain]; const p = at(an.dot);
        if (hidden.has(an.domain)) return null;
        return (
          <button key={an.id} type="button" data-component={c.id}
            className="hud-label absolute !border-0 !p-0 text-[11px] leading-none"
            style={{ left: an.align === 'left' ? p.x + 8 : undefined, right: an.align === 'right' ? size.w - p.x + 8 : undefined, top: p.y - 8, background: 'rgba(4,10,22,0.72)', boxShadow: `inset 0 0 0 1px ${t.base}55`, padding: '3px 6px', color: c.status === 'built' ? t.label : '#8FA3BF', opacity: labelsIn * (focus && an.domain !== focus ? 0.35 : 1), minHeight: 18 }}
            aria-expanded={expanded === c.id}
            aria-label={`${c.label}, ${c.status === 'built' ? `${c.fileCount} files` : 'reserved, no code yet'}${c.diagnostics ? `, ${c.diagnostics} diagnostics` : ''}`}
            onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(c.id)} onBlur={() => setHover(null)}
            onClick={() => c.status === 'built' && setExpanded(expanded === c.id ? null : c.id)}>
            {c.label}
            {c.status === 'reserved' ? <span className="ml-1 opacity-80">· reserved</span>
              : level !== 'System' && <span className="hud-data ml-1" style={{ color: t.glow }}>{c.fileCount} files</span>}
          </button>
        );
      })}

      {/* Shared / unassigned: the far side, as a count. */}
      {shared && shared.fileCount > 0 && !hidden.has('shared') && (
        <p className="hud-data absolute bottom-3 left-3 m-0 text-[12px]" style={{ color: HUD_DOMAIN.shared.label }}>● Shared / unassigned · {shared.fileCount} files (far side)</p>
      )}

      {/* Hover card: a component's files, top five by connections, diagnostics. */}
      {hoverComp && L.anchors.has(hoverComp.id) && (() => {
        const p = at(L.anchors.get(hoverComp.id)!.dot); const left = Math.min(size.w - 300, Math.max(8, p.x + 16));
        return (
          <div className="hud-panel pointer-events-none absolute z-10 w-72 p-3 text-[12px]" style={{ left, top: Math.min(size.h - 180, p.y + 14) }} role="tooltip">
            <p className="hud-label m-0" style={{ color: HUD_DOMAIN[hoverComp.domain].label }}>{hoverComp.label}</p>
            <p className="hud-data m-0">{hoverComp.status === 'built' ? `${hoverComp.fileCount} files` : 'Reserved: no code yet'}{hoverComp.diagnostics ? ` · ${hoverComp.diagnostics} diagnostics` : ''}</p>
            {hoverComp.rules.length > 0 && <p className="hud-data hud-muted m-0 truncate">rule: {hoverComp.rules.join(', ')}</p>}
            {hoverComp.topFiles.length > 0 && (
              <ol className="hud-data m-0 mt-1 list-none p-0">{hoverComp.topFiles.map((f) => <li key={f.id} className="truncate">{f.edges} · {f.path}</li>)}</ol>
            )}
            {hoverComp.status === 'built' && <p className="hud-muted m-0 mt-1">Click to show its files.</p>}
          </div>
        );
      })()}

      {/* Satellite tooltip: path and sha256 prefix; click opens the checksum-verified viewer. */}
      {hoverFile && (() => {
        const f = hoverFile.comp.files[hoverFile.i]; if (!f) return null;
        return (
          <div className="hud-panel pointer-events-none absolute z-10 p-2 text-[12px]" style={{ left: Math.min(size.w - 320, hoverFile.at.x + 12), top: hoverFile.at.y + 12 }} role="tooltip">
            <span className="hud-data block">{f.path}</span>
            <span className="hud-data hud-muted block">sha256 {f.sha ?? '—'}</span>
          </div>
        );
      })()}
      {exp && exp.fileCount > exp.files.length && (
        <p className="hud-data absolute left-3 top-3 m-0 text-[12px]">{exp.label}: showing {exp.files.length} of {exp.fileCount} · <a href={`/?kind=file&domain=${exp.domain}`}>+{exp.fileCount - exp.files.length} more in the list</a></p>
      )}

      {/* Zoom cluster */}
      <div className="hud-panel absolute bottom-3 right-3 flex items-end gap-2 p-2" onPointerDown={(e) => e.stopPropagation()}>
        <canvas ref={mini} width={160} height={100} className="cursor-move" aria-label="Minimap: drag to pan" role="img" onPointerDown={onMini} onPointerMove={onMini} />
        <div className="flex flex-col items-center gap-1">
          <button type="button" aria-label="Zoom in" className="hud-data !px-2 !py-0.5" onClick={() => animateTo(zoomAt(view, C, C, view.z * 1.25))}>+</button>
          <input type="range" aria-label="Zoom" min={ZOOM.min} max={ZOOM.max} step={0.05} value={view.z} onChange={(e) => setView((v) => zoomAt(v, C, C, Number(e.target.value)))}
            style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 64, width: 16 }} />
          <button type="button" aria-label="Zoom out" className="hud-data !px-2 !py-0.5" onClick={() => animateTo(zoomAt(view, C, C, view.z / 1.25))}>−</button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="hud-data text-center text-[12px]" data-zoom-readout>{Math.round(view.z * 100)}%</span>
          <button type="button" className="hud-label !px-2 !py-0.5 text-[11px]" onClick={() => animateTo(fit())}>Fit</button>
          <button type="button" className="hud-label !px-2 !py-0.5 text-[11px]" onClick={() => animateTo({ ...view, z: 1 })}>1:1</button>
          <span className="hud-label hud-muted text-[10px]" data-level-label>{level}</span>
        </div>
      </div>
    </div>
  );
}
