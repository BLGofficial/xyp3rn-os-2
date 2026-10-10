'use client';

import { useEffect, useRef } from 'react';
import { VIEW, type Placed } from '../../lib/ring-layout';

/**
 * The agent ring's drawing: orbit rings, circuit traces and one node per agent or domain, joined to the centre by a
 * spoke. The centre is left empty: the golden ring and particle core are drawn over it by ring-orb.tsx and ring-core.tsx. Imperative SVG on one animation clock, as in APEX-UI's ReasoningWeb (MIT, R. Mouradian), written here in
 * TypeScript and cut down to the one mode this app uses. Two differences from that source: the nodes come from `nodes`
 * (the source's id lookup was built once from its own roster, so a custom roster could never be lit), and nothing
 * animates under prefers-reduced-motion. Decorative: the real, keyboard-reachable list is rendered by the parent.
 */

export type RingState = 'standby' | 'listening' | 'processing' | 'speaking';
/** Light these nodes. `n` changes on every call so the same ids can be fired twice running. */
export type RingFire = { readonly n: number; readonly ids: readonly string[] };

type Props = {
  readonly nodes: readonly Placed[];
  readonly state: RingState;
  readonly fire: RingFire | null;
  readonly onSelect: (id: string) => void;
};

const NS = 'http://www.w3.org/2000/svg';
const LEVEL: Readonly<Record<RingState, number>> = { standby: 0.32, listening: 0.6, processing: 0.85, speaking: 0.78 };
const P = {
  ring: '#1b5f78', pcb: '#1c5f7a', pcbDot: '#37d6ef', fieldMesh: '#143f4f', fieldDot: '#2bd0e6', mesh: '#1a5468',
  spoke: '#22566b', spokeHot: '#33eaff', link: '#5eead4', label: '#dfeaf3', labelDorm: '#546a7d', mote: '#5fe0f2', moteHot: '#bff6ff',
} as const;
const AX = VIEW.cx;
const AY = VIEW.cy;
const DORMANT_R = 5.5;

type Live = Placed & { spoke: SVGPathElement; halo: SVGCircleElement; circ: SVGCircleElement; haloR: number; phase: number; until: number };
type Mote = { el: SVGCircleElement; born: number; spoke: SVGPathElement; len: number };

const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
};

export function RingWeb({ nodes, state, fire, onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const fireRef = useRef<((ids: readonly string[]) => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const defs = mk('defs');
    defs.innerHTML =
      '<filter id="rw-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<filter id="rw-soft" x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation="9"/></filter>' +
      '<filter id="rw-line" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
    const [ringsG, pcbG, fillG, meshG, spokesG, pulsesG, nodesG] = Array.from({ length: 7 }, () => mk('g'));
    svg.append(defs, pcbG!, ringsG!, fillG!, meshG!, spokesG!, pulsesG!, nodesG!);
    [pcbG!, meshG!, spokesG!].forEach((g) => g.setAttribute('filter', 'url(#rw-line)'));

    let seed = 11;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const spokePath = (bx: number, by: number, bend: number) => {
      const mx = (AX + bx) / 2, my = (AY + by) / 2, dx = bx - AX, dy = by - AY, l = Math.hypot(dx, dy) || 1;
      return `M${AX} ${AY} Q${mx + (-dy / l) * bend} ${my + (dx / l) * bend} ${bx} ${by}`;
    };

    const motes: Mote[] = [];
    const spawn = (spoke: SVGPathElement, faint: boolean) => {
      if (reduced) return;
      const el = mk('circle', { r: faint ? 0.9 : 1.4, fill: faint ? P.mote : P.moteHot, filter: 'url(#rw-glow)' });
      pulsesG!.append(el);
      motes.push({ el, born: performance.now(), spoke, len: spoke.getTotalLength() });
    };

    [72, 128, 186].forEach((r) => ringsG!.append(mk('circle', { cx: AX, cy: AY, r, fill: 'none', stroke: P.ring, opacity: 0.32, 'stroke-width': 1, 'stroke-dasharray': '1 7' })));
    // Circuit traces fanning out to both edges, each ending in a glowing terminal.
    [-1, 1].forEach((side) => {
      for (let i = 0; i < 6; i += 1) {
        const y = AY + (i - 2.5) * 52 + (rnd() * 16 - 8);
        const startX = AX + side * (126 + rnd() * 34);
        const midX = side < 0 ? 40 + rnd() * 56 : 584 + rnd() * 56;
        const y2 = y + (rnd() * 30 - 15);
        const jogX = side < 0 ? 10 + rnd() * 18 : 652 + rnd() * 18;
        pcbG!.append(mk('path', { d: `M${startX} ${y} H${midX} V${y2} H${jogX}`, fill: 'none', stroke: P.pcb, opacity: 0.5, 'stroke-width': 1 }));
        pcbG!.append(mk('circle', { cx: jogX, cy: y2, r: 2.4, fill: P.pcbDot, opacity: 0.85 }));
        pcbG!.append(mk('circle', { cx: startX, cy: y, r: 1.3, fill: P.fieldDot, opacity: 0.45 }));
      }
    });
    // Sparse neuron texture, kept local so it never tangles with the spokes.
    const field: { x: number; y: number }[] = [];
    for (let i = 0; i < 15; i += 1) {
      const x = 36 + rnd() * 608, y = 34 + rnd() * 412;
      if (Math.hypot(x - AX, y - AY) > 175) field.push({ x, y });
    }
    field.forEach((f) => {
      let near: { x: number; y: number } | null = null, nd = Infinity;
      field.forEach((g) => { if (g !== f) { const d = Math.hypot(g.x - f.x, g.y - f.y); if (d < nd) { nd = d; near = g; } } });
      if (near && nd < 110) meshG!.append(mk('line', { x1: f.x, y1: f.y, x2: (near as { x: number }).x, y2: (near as { y: number }).y, stroke: P.fieldMesh, 'stroke-width': 1, opacity: 0.45 }));
      const c = mk('circle', { cx: f.x, cy: f.y, r: 1.1, fill: P.fieldDot });
      if (!reduced) c.style.animation = `rwTwinkle 4s ease-in-out ${(rnd() * 4).toFixed(2)}s infinite`;
      fillG!.append(c);
    });

    const live: Live[] = nodes.map((n) => ({ ...n, phase: rnd() * 6.283, until: 0, haloR: 0 } as Live));
    const byId = new Map(live.map((n) => [n.id, n]));
    // One nearest neighbour per node: networked, not tangled.
    live.forEach((n) => {
      const o = live.filter((m) => m !== n).map((m) => ({ m, d: Math.hypot(m.x - n.x, m.y - n.y) })).sort((a, b) => a.d - b.d)[0];
      if (o && n.id < o.m.id && o.d < 150) meshG!.append(mk('line', { x1: n.x, y1: n.y, x2: o.m.x, y2: o.m.y, stroke: P.mesh, 'stroke-width': 1, opacity: 0.5 }));
    });
    live.forEach((n) => {
      const rr = n.live ? n.r : DORMANT_R;
      n.spoke = mk('path', { d: spokePath(n.x, n.y, n.bend), fill: 'none', stroke: P.spoke, 'stroke-width': 1, opacity: n.live ? 0.78 : 0.4 });
      spokesG!.append(n.spoke);
      n.haloR = rr + 1.5;
      n.halo = mk('circle', { cx: n.x, cy: n.y, r: n.haloR, fill: n.color, filter: 'url(#rw-glow)', opacity: n.live ? 0.34 : 0.2 });
      nodesG!.append(n.halo);
      n.circ = mk('circle', { cx: n.x, cy: n.y, r: rr, fill: 'none', stroke: n.color, 'stroke-width': n.live ? 2 : 1.3, opacity: n.live ? 1 : 0.6 });
      if (!n.live) n.circ.setAttribute('stroke-dasharray', '2 2');
      nodesG!.append(n.circ);
      const dx = n.x - AX, dy = n.y - AY, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, off = rr + 11;
      const above = uy > 0.82; // the bottom-most nodes label above, clear of the edge
      const t = mk('text', {
        x: above ? n.x : n.x + ux * off,
        y: above ? n.y - (rr + 9) : n.y + uy * off + (Math.abs(uy) < 0.3 ? 4 : 0),
        'text-anchor': above ? 'middle' : ux > 0.3 ? 'start' : ux < -0.3 ? 'end' : 'middle',
        'font-size': 12, 'font-family': 'inherit', fill: n.live ? P.label : P.labelDorm, opacity: n.live ? 1 : 0.75,
      });
      t.textContent = n.label;
      nodesG!.append(t);
      // The SVG ignores pointer events; each node's generous transparent hit area opts back in.
      const hit = mk('circle', { cx: n.x, cy: n.y, r: Math.max(rr + 13, 17), fill: 'transparent' });
      hit.style.pointerEvents = 'all';
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => selectRef.current(n.id));
      nodesG!.append(hit);
    });

    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, ms)); };
    fireRef.current = (ids) => {
      ids.forEach((id, k) => {
        const n = byId.get(id);
        if (!n) return;
        const rr = n.live ? n.r : DORMANT_R;
        later(() => {
          n.spoke.setAttribute('stroke', P.spokeHot); n.spoke.setAttribute('stroke-width', '1.6'); n.spoke.setAttribute('opacity', '0.7');
          n.until = performance.now() + 1150;
          const stream = () => { if (performance.now() < n.until) { spawn(n.spoke, false); later(stream, 105); } };
          stream();
          later(() => { n.circ.setAttribute('filter', 'url(#rw-glow)'); n.circ.setAttribute('r', String(rr + 3)); n.circ.setAttribute('stroke-width', n.live ? '3' : '2'); n.circ.setAttribute('opacity', '1'); }, 560);
          later(() => {
            n.spoke.setAttribute('stroke', P.spoke); n.spoke.setAttribute('stroke-width', '1'); n.spoke.setAttribute('opacity', String(n.live ? 0.78 : 0.4));
            n.circ.removeAttribute('filter'); n.circ.setAttribute('r', String(rr)); n.circ.setAttribute('stroke-width', n.live ? '2' : '1.3'); n.circ.setAttribute('opacity', n.live ? '1' : '0.6');
          }, 2050);
        }, k * 210);
      });
      // A transient link between agents working the same turn, so they read as collaborating.
      const co = ids.map((id) => byId.get(id)).filter((n): n is Live => !!n);
      for (let i = 0; i < co.length - 1; i += 1) {
        const a = co[i]!, b = co[i + 1]!;
        const ln = mk('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: P.link, 'stroke-width': 1.3, opacity: 0 });
        pulsesG!.append(ln);
        later(() => ln.setAttribute('opacity', '0.6'), 560);
        later(() => ln.remove(), 2400);
      }
    };

    let raf = 0, last = performance.now(), phase = 0, nextAmbient = last + 1200;
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const lvl = LEVEL[stateRef.current];
      const awake = stateRef.current !== 'standby';
      phase += dt * (0.85 + 1.9 * lvl); // one clock, faster when awake: accumulated, so there is no jump in period
      const k = (Math.sin(phase) + 1) / 2;
      for (const n of live) {
        const kk = (Math.sin(phase * 0.85 + n.phase) + 1) / 2; // each node breathes on its own phase
        n.halo.setAttribute('opacity', String((n.live ? 0.16 : 0.09) + (n.live ? 0.3 : 0.18) * kk));
        n.halo.setAttribute('r', String(n.haloR + 2 * kk));
      }
      if (t > nextAmbient && motes.length < (awake ? 18 : 8) && live.length > 0) {
        const pick = () => live[(Math.random() * live.length) | 0]!.spoke;
        spawn(pick(), true);
        if (awake && Math.random() < 0.6) spawn(pick(), true);
        nextAmbient = t + (470 - 330 * lvl) * (0.5 + Math.random() * 0.7);
      }
      for (let i = motes.length - 1; i >= 0; i -= 1) {
        const m = motes[i]!, pr = (t - m.born) / 620;
        if (pr >= 1) { m.el.remove(); motes.splice(i, 1); continue; }
        const q = m.spoke.getPointAtLength(pr * m.len);
        m.el.setAttribute('cx', String(q.x)); m.el.setAttribute('cy', String(q.y));
        m.el.setAttribute('opacity', String((0.9) * Math.sin(pr * Math.PI)));
      }
      raf = requestAnimationFrame(loop);
    };
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      fireRef.current = null;
      svg.replaceChildren();
    };
  }, [nodes]);

  // Declared after the build effect: when the nodes and the fire change together, the build runs first.
  useEffect(() => {
    if (fire) fireRef.current?.(fire.ids);
  }, [fire]);

  return (
    <>
      <style>{'@keyframes rwTwinkle{0%,100%{opacity:.14}50%{opacity:.42}}'}</style>
      <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="xMidYMid meet"
        style={{ fontFamily: 'inherit', pointerEvents: 'none', overflow: 'visible' }} aria-hidden="true" />
    </>
  );
}
