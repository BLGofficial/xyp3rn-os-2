import React, { useCallback, useEffect, useRef, useState } from 'react';
import './AudioDeck.css';

// The Track Library's player: one <audio> element for the life of the deck (Web Audio can wrap an element only once),
// a spectrum drawn from an AnalyserNode while it plays, and the bass level handed to the player art as --xos-level so
// its rings breathe with the music. The draw loop runs only while playing; reduced motion gets a still spectrum.

const fmt = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const BARS = 48;

export default function AudioDeck({ src, title }: { src: string; title: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const graph = useRef<{ ctx: AudioContext; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer> } | null>(null);
  const raf = useRef(0);
  const bassAvg = useRef(0);
  const peak = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  const art = () => rootRef.current?.closest('.xos-player-panel')?.querySelector<HTMLElement>('.xos-player-art') ?? null;
  const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const draw = useCallback((live: boolean) => {
    const canvas = canvasRef.current; const g = graph.current; if (!canvas) return;
    const c = canvas.getContext('2d'); if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (live && g) g.analyser.getByteFrequencyData(g.bins);
    const grad = c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#00d9f5'); grad.addColorStop(0.55, '#7c8cff'); grad.addColorStop(1, '#d4af37');
    c.fillStyle = grad;
    const gap = 3, bw = (w - gap * (BARS - 1)) / BARS;
    let bass = 0;
    for (let i = 0; i < BARS; i++) {
      // Log-ish spread: the low bins carry most of the music, so they get more bars.
      const v = live && g ? g.bins[Math.min(g.bins.length - 1, Math.floor((i / BARS) ** 1.6 * g.bins.length * 0.85))]! / 255 : 0.06 + 0.04 * Math.sin(i * 0.7);
      if (i < 6) bass += v / 6;
      const bh = Math.max(2, v * (h - 4));
      c.globalAlpha = 0.35 + v * 0.65;
      c.beginPath(); c.roundRect(i * (bw + gap), (h - bh) / 2, bw, bh, bw / 2); c.fill();
    }
    c.globalAlpha = 1;
    // Beats, not loudness: a mastered track keeps its low bins near full, so the rings follow how far the bass jumps
    // above its own running average (an onset), then fall back.
    const avg = (bassAvg.current = bassAvg.current * 0.93 + bass * 0.07);
    const hit = Math.min(1, Math.max(0, (bass - avg) * 10));
    const level = (peak.current = live ? Math.max(hit, peak.current * 0.9) : 0);
    art()?.style.setProperty('--xos-level', level.toFixed(3));
  }, []);

  const loop = useCallback(() => { draw(true); raf.current = requestAnimationFrame(loop); }, [draw]);

  // A new track: same element, new source; the visual state resets.
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    setTime(0); setDuration(0); setBuffered(0); setError(''); setPlaying(false);
    a.load();
    draw(false);
  }, [src, draw]);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const panel = rootRef.current?.closest('.xos-player-panel'); const layout = rootRef.current?.closest('.xos-records-layout');
    const on = {
      play: () => { setPlaying(true); panel?.classList.add('is-playing'); layout?.setAttribute('data-playing', ''); if (!reduced()) { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(loop); } },
      pause: () => { setPlaying(false); panel?.classList.remove('is-playing'); layout?.removeAttribute('data-playing'); cancelAnimationFrame(raf.current); draw(false); },
      timeupdate: () => setTime(a.currentTime),
      durationchange: () => setDuration(a.duration),
      progress: () => { if (a.buffered.length) setBuffered(a.buffered.end(a.buffered.length - 1)); },
      waiting: () => setLoading(true),
      canplay: () => setLoading(false),
      playing: () => setLoading(false),
      error: () => { setLoading(false); setError('This audio could not be loaded. The file may be missing from the Vault or in a format this browser cannot play.'); },
    } as const;
    (Object.keys(on) as (keyof typeof on)[]).forEach((k) => a.addEventListener(k, on[k]));
    a.addEventListener('ended', on.pause);
    return () => {
      (Object.keys(on) as (keyof typeof on)[]).forEach((k) => a.removeEventListener(k, on[k]));
      a.removeEventListener('ended', on.pause); cancelAnimationFrame(raf.current);
    };
  }, [draw, loop]);

  useEffect(() => () => { void graph.current?.ctx.close(); }, []);
  useEffect(() => { const a = audioRef.current; if (a) { a.volume = volume; a.muted = muted; } }, [volume, muted]);

  const toggle = async () => {
    const a = audioRef.current; if (!a) return;
    if (!a.paused) { a.pause(); return; }
    try {
      if (!graph.current) {
        const ctx = new AudioContext(); const analyser = ctx.createAnalyser();
        analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.82;
        ctx.createMediaElementSource(a).connect(analyser); analyser.connect(ctx.destination);
        graph.current = { ctx, analyser, bins: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)) };
      }
      await graph.current.ctx.resume();
      await a.play();
    } catch (e) { setError(`Playback failed: ${(e as Error).message}`); }
  };
  const seek = (t: number) => { const a = audioRef.current; if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(a.duration, t)); };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); void toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(time + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(time - 5); }
    else if (e.key === 'm') setMuted((m) => !m);
  };

  const pct = duration ? (time / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  return (
    <div ref={rootRef} className={`xos-deck${playing ? ' is-playing' : ''}${loading ? ' is-loading' : ''}`} onKeyDown={onKey} role="group" aria-label={`Player: ${title}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <canvas ref={canvasRef} className="xos-deck-spectrum" aria-hidden="true" />
      <div className="xos-deck-scrub" style={{ '--p': `${pct}%`, '--b': `${bufPct}%` } as React.CSSProperties}>
        <input type="range" min={0} max={duration || 0} step={0.1} value={time} onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek" aria-valuetext={`${fmt(time)} of ${fmt(duration)}`} disabled={!duration} />
      </div>
      <div className="xos-deck-row">
        <span className="xos-deck-time">{fmt(time)}</span>
        <div className="xos-deck-controls">
          <button type="button" className="xos-deck-skip" onClick={() => seek(time - 10)} aria-label="Back 10 seconds" disabled={!duration}>−10</button>
          <button type="button" className="xos-deck-play" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
            <span className="xos-deck-play-ring" aria-hidden="true" />
            {playing
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.4" /><rect x="14" y="5" width="4" height="14" rx="1.4" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>}
          </button>
          <button type="button" className="xos-deck-skip" onClick={() => seek(time + 10)} aria-label="Forward 10 seconds" disabled={!duration}>+10</button>
        </div>
        <span className="xos-deck-time is-total">{fmt(duration)}</span>
      </div>
      <div className="xos-deck-volume">
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>{muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}</button>
        <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }}
          aria-label="Volume" style={{ '--p': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} />
        <small className="xos-deck-hint">Space play · ← → 5 s · M mute</small>
      </div>
      {error && <div className="xos-deck-error" role="alert">{error}</div>}
    </div>
  );
}
