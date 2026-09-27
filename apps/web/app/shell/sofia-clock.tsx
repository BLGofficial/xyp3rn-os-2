'use client';

import { useEffect, useRef, useState } from 'react';
import { bestSample, offsetFromSample, sofiaParts, SYNC_EVERY_MS, SYNC_LABEL, syncState, type Sample, type SyncState } from '../../lib/clock.ts';

// The Sofia clock (AOS-04 design §19), top right. Server time is estimated from /api/time samples against
// performance.now() (the lowest round trip of each round wins), so a wrong device clock doesn't move it.
// Every tick is recomputed from that anchor, never incremented. It claims "Server-synced" only after a
// successful sample; without one it says the device time is not verified. Hidden tabs don't render.

const SAMPLES_PER_ROUND = 3;

export function SofiaClock({ initialEpochMs }: { initialEpochMs: number }) {
  const [epoch, setEpoch] = useState(initialEpochMs);
  const [sync, setSync] = useState<SyncState>('device-unverified');
  const offset = useRef<Sample | null>(null);
  const lastSampleAt = useRef<number | null>(null);

  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | undefined;
    let resync: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    // performance.now() + offset = server epoch; without a sample, the device clock stands in (and says so).
    const nowEpoch = () => (offset.current ? performance.now() + offset.current.offsetMs : Date.now());
    const render = () => {
      setEpoch(Math.floor(nowEpoch() / 1000) * 1000);
      setSync(syncState(lastSampleAt.current === null ? null : { at: lastSampleAt.current }, performance.now()));
    };
    const sampleOnce = async (): Promise<Sample | null> => {
      const sentAt = performance.now();
      try {
        const res = await fetch('/api/time', { cache: 'no-store' });
        const receivedAt = performance.now();
        if (!res.ok) return null;
        const { epochMs } = (await res.json()) as { epochMs: number };
        return offsetFromSample({ sentAt, receivedAt, serverEpochMs: epochMs });
      } catch {
        return null;
      }
    };
    const syncRound = async () => {
      const got: Sample[] = [];
      for (let i = 0; i < SAMPLES_PER_ROUND; i++) {
        const s = await sampleOnce();
        if (s) got.push(s);
      }
      const best = bestSample(got);
      if (!alive) return;
      if (best) {
        offset.current = best;
        lastSampleAt.current = performance.now();
      }
      render();
    };
    const start = () => {
      stop();
      render();
      tick = setInterval(render, 250);
      resync = setInterval(() => void syncRound(), SYNC_EVERY_MS);
      void syncRound();
    };
    const stop = () => {
      if (tick) clearInterval(tick);
      if (resync) clearInterval(resync);
      tick = resync = undefined;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onOnline = () => void syncRound();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    if (!document.hidden) start();
    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  const p = sofiaParts(epoch);
  const label = SYNC_LABEL[sync];
  return (
    <div className="flex flex-col items-end leading-tight" title={`${p.date} · ${p.offset} · ${label}`}>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Sofia, BG</span>
      <time dateTime={new Date(epoch).toISOString()} className="num w-[8ch] text-right font-mono text-[15px] text-ink-1" aria-label={`Sofia time ${p.time}, ${p.date}, ${p.offset}`}>
        <span className="md:hidden">{p.short}</span>
        <span className="hidden md:inline">{p.time}</span>
      </time>
      <span data-sync={sync} className={`text-[11px] ${sync === 'server-synced' ? 'text-ok' : 'text-warn'}`} aria-live="polite">{label}</span>
    </div>
  );
}
