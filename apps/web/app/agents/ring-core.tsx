'use client';

import { useEffect, useRef } from 'react';
import { VIEW } from '../../lib/ring-layout';
import { ORB_R } from './ring-orb';
import type { RingState } from './ring-web';

/**
 * The cyan particle core inside the golden ring. APEX-UI draws it with react-three-fiber and a bloom pass; this is
 * the same picture on a 2D canvas (a Fibonacci sphere, turned, with additive blending), so it needs no extra
 * dependency. It boils faster and swells a little the more active the web is. Under prefers-reduced-motion it
 * is drawn once and stays still.
 */

const LEVEL: Readonly<Record<RingState, number>> = { standby: 0.32, listening: 0.6, processing: 0.85, speaking: 0.78 };
const COUNT = 380;
const BALL = ORB_R * 0.4; // a small, loose cloud in the middle of the ring, as in the source

export function RingCore({ state }: { readonly state: RingState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A filled cloud, denser at the heart: points on a Fibonacci sphere, pulled to a random depth inside it.
    const pts = Array.from({ length: COUNT }, (_, i) => {
      const y = 1 - (i / (COUNT - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963; // golden angle
      const d = Math.pow(Math.random(), 0.7);
      return { x: Math.cos(th) * r * d, y: y * d, z: Math.sin(th) * r * d, ph: Math.random() * 6.283 };
    });
    let w = 1, h = 1, dpr = 1;
    const size = () => {
      const b = cv.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, b.width); h = Math.max(1, b.height);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    };
    let ang = 0, last = performance.now(), raf = 0;
    const draw = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const lvl = LEVEL[stateRef.current];
      ang += dt * (0.25 + 0.9 * lvl);
      const unit = w / VIEW.w; // canvas units to pixels
      const cx = w / 2, cy = h / 2, R = BALL * unit * (0.9 + 0.2 * lvl);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
      glow.addColorStop(0, `rgba(13,210,255,${0.16 + 0.16 * lvl})`);
      glow.addColorStop(1, 'rgba(13,210,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const ca = Math.cos(ang), sa = Math.sin(ang), tilt = 0.4, ct = Math.cos(tilt), st = Math.sin(tilt);
      const boil = 0.08 + 0.1 * lvl, speed = 1.2 + 2.4 * lvl, px = Math.max(1.5, 1.9 * unit);
      for (const p of pts) {
        const x1 = p.x * ca + p.z * sa, z1 = -p.x * sa + p.z * ca; // turn about the vertical axis
        const y2 = p.y * ct - z1 * st, z2 = p.y * st + z1 * ct;    // then tip toward the viewer
        const k = 1 + boil * Math.sin(t / 1000 * speed + p.ph);
        const persp = 1 / (1 - z2 * 0.18);
        const depth = (z2 + 1) / 2;
        ctx.fillStyle = `rgba(95,224,242,${0.12 + 0.7 * depth * depth})`;
        ctx.fillRect(cx + x1 * R * k * persp, cy + y2 * R * k * persp, px, px);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    size();
    const ro = new ResizeObserver(() => { size(); if (reduced) draw(performance.now()); });
    ro.observe(cv);
    draw(performance.now());
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
