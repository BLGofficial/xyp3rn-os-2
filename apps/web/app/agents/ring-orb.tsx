'use client';

import { VIEW } from '../../lib/ring-layout';
import './ring-orb.css';
import type { RingState } from './ring-web';

/**
 * The golden ring round the core: the frame of APEX-UI's ApexOrb (MIT, R. Mouradian), written in TypeScript. The
 * source draws in a 900 x 520 space; it is scaled into the web's 680 x 480 canvas so the ring sits just inside the
 * nodes' moat and the two layers share one coordinate system. Decorative: the parent exposes the real controls.
 */

const GOLD = '#f5a623';
const GOLD_BRIGHT = '#ffd080';
const SRC = { w: 900, h: 520, cx: 450, cy: 260, r: 155 } as const;
const OUTER = [178, 194, 212, 230, 250] as const;
const SCALE = 0.76;
/** The golden ring's radius in the web's canvas units: the particle core sizes itself from it. */
export const ORB_R = SRC.r * SCALE;

export function RingOrb({ state }: { readonly state: RingState }) {
  const active = state !== 'standby';
  const thinking = state === 'processing';
  const { cx, cy, r: R } = SRC;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true"
      data-state={state} style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id="ro-ringFill" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GOLD} stopOpacity="0" />
          <stop offset="70%" stopColor={GOLD} stopOpacity="0.04" />
          <stop offset="88%" stopColor={GOLD} stopOpacity="0.18" />
          <stop offset="100%" stopColor={GOLD_BRIGHT} stopOpacity="0.5" />
        </radialGradient>
        <radialGradient id="ro-ambBg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={GOLD} stopOpacity="0.08" />
          <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
        </radialGradient>
        <filter id="ro-ringBlur" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g transform={`translate(${VIEW.cx} ${VIEW.cy}) scale(${SCALE}) translate(${-cx} ${-cy})`}>
        <ellipse cx={cx} cy={cy} rx={R + 130} ry={R + 90} fill="url(#ro-ambBg)" className="ro-ambient" />
        {OUTER.map((r, i) => (
          <circle key={r} cx={cx} cy={cy} r={r} stroke={GOLD} strokeWidth={i === 0 ? 0.8 : 0.4} strokeOpacity={0.15 - i * 0.02} fill="none" strokeDasharray={i % 2 ? '3 7' : 'none'} />
        ))}
        <line x1={cx} y1={cy - OUTER[4] - 10} x2={cx} y2={cy - OUTER[4] + 10} stroke={GOLD} strokeWidth="1" opacity="0.3" />
        <line x1={cx} y1={cy + OUTER[4] - 10} x2={cx} y2={cy + OUTER[4] + 10} stroke={GOLD} strokeWidth="1" opacity="0.3" />
        {[0, 1, 2, 3].map((i) => (
          <circle key={i} cx={cx} cy={cy} r={R} stroke={GOLD} strokeWidth={active ? 1.5 : 0.8} fill="none" opacity={active ? 0.55 : 0.18} className={`ro-sound-wave ro-wave-${i}`} />
        ))}
        {thinking && (
          <circle cx={cx} cy={cy} r={R + 22} stroke={GOLD} strokeWidth="1" strokeOpacity="0.45" strokeDasharray="8 14" fill="none" className="ro-orbit-cw" style={{ transformOrigin: `${cx}px ${cy}px` }} />
        )}
        <circle cx={cx} cy={cy} r={R} fill="url(#ro-ringFill)" className="ro-ring-breathe" />
        <circle cx={cx} cy={cy} r={R} stroke={GOLD} strokeWidth="18" strokeOpacity="0.08" fill="none" filter="url(#ro-ringBlur)" className="ro-ring-glow" />
        <circle cx={cx} cy={cy} r={R} stroke={GOLD} strokeWidth="6" strokeOpacity="0.4" fill="none" filter="url(#ro-ringBlur)" />
        <circle cx={cx} cy={cy} r={R} stroke={GOLD_BRIGHT} strokeWidth="2.5" strokeOpacity="0.95" fill="none" className="ro-ring-bright" />
        <circle cx={cx} cy={cy} r={R * 0.58} stroke={GOLD} strokeWidth="1.5" strokeOpacity={active ? 0.45 : 0.15} fill="none" strokeDasharray="55 25" className="ro-orbit-cw" style={{ transformOrigin: `${cx}px ${cy}px` }} />
        <circle cx={cx} cy={cy} r={R * 0.35} stroke={GOLD} strokeWidth="1" strokeOpacity={active ? 0.3 : 0.1} fill="none" strokeDasharray="28 18" className="ro-orbit-ccw" style={{ transformOrigin: `${cx}px ${cy}px` }} />
      </g>
    </svg>
  );
}
