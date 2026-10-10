'use client';

import './ring-orb.css';
import type { RingState } from './ring-web';

/**
 * The equalizer, STANDBY label and dots along the bottom of the stage: the centre cluster of APEX-UI's OrbStatusBar
 * (MIT, R. Mouradian). Its label is the web's state; the hint line says what a click does.
 */

const GOLD = '#f5a623';
const GOLD_BRIGHT = '#ffd080';
const LABEL: Readonly<Record<RingState, string>> = { standby: 'STANDBY', listening: 'LISTENING', processing: 'PROCESSING', speaking: 'SPEAKING' };
const W = 420, H = 130, CX = W / 2, CY = 48, BARS = 28, BAR_W = 3, SPAN = 170;

export function RingStatus({ state, hint }: { readonly state: RingState; readonly hint: string }) {
  const active = state !== 'standby';
  const gap = (SPAN - BARS * BAR_W) / (BARS - 1);
  return (
    <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 6, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" style={{ maxWidth: '60%', height: 'auto' }}>
        <defs>
          <filter id="ro-sbBlur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <line x1={CX - 150} y1={CY} x2={CX - 28} y2={CY} stroke={GOLD} strokeWidth="1" opacity={active ? 0.5 : 0.18} strokeDasharray="4 3" />
        <line x1={CX + 28} y1={CY} x2={CX + 150} y2={CY} stroke={GOLD} strokeWidth="1" opacity={active ? 0.5 : 0.18} strokeDasharray="4 3" />
        {Array.from({ length: BARS }, (_, i) => {
          const x = CX - SPAN / 2 + i * (BAR_W + gap);
          const base = 3 + Math.abs(Math.sin(i * 0.6)) * 5, high = 8 + Math.abs(Math.sin(i * 0.8)) * 26, hgt = active ? high : base;
          return (
            <rect key={i} x={x} y={CY - hgt / 2} width={BAR_W} height={hgt} rx={1.5} fill={GOLD} opacity={active ? 0.85 : 0.3}
              style={{ transformOrigin: `${x + BAR_W / 2}px ${CY}px`, animation: active ? `roBar ${0.55 + (i % 5) * 0.16}s ease-in-out ${(i % 7) * 0.07}s infinite alternate` : 'none' }} />
          );
        })}
        <circle cx={CX} cy={CY} r={20} stroke={GOLD} strokeWidth="1.5" strokeOpacity="0.7" fill="#030200" filter="url(#ro-sbBlur)" className="ro-center-ring" />
        <circle cx={CX} cy={CY} r={6} fill={GOLD_BRIGHT} opacity="0.95" className="ro-center" style={{ filter: `drop-shadow(0 0 10px ${GOLD})` }} />
        <text x={CX} y={CY + 44} textAnchor="middle" fill={GOLD} fontSize="13" fontFamily="'IBM Plex Mono', monospace" letterSpacing="0.4em" opacity="0.8">{LABEL[state]}</text>
        {[0, 1, 2].map((i) => <circle key={i} cx={CX + (i - 1) * 12} cy={CY + 62} r={2.5} fill={GOLD} className={`ro-dot-blink ro-blink-${i}`} />)}
        {!active && <text x={CX} y={CY + 80} textAnchor="middle" fill={GOLD} fontSize="9" fontFamily="'IBM Plex Mono', monospace" letterSpacing="0.14em" opacity="0.5">{hint}</text>}
      </svg>
    </div>
  );
}
