'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { askAction } from '../app/ask-actions';
import { parseVoiceStatus, type VoiceStatus } from '../lib/voice-status';

// One Jarvis state for the whole shell. The header pill and the footer bar are separate client islands in a server
// layout, so they share this module-level store instead of props or a provider.
type Shared = { readonly recording: boolean; readonly busy: boolean; readonly remote: VoiceStatus };
let shared: Shared = { recording: false, busy: false, remote: 'idle' };
const listeners = new Set<() => void>();
const patch = (p: Partial<Shared>) => { shared = { ...shared, ...p }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: Shared = shared;

export type JarvisState = 'IDLE' | 'LISTENING' | 'EXECUTING';
const stateOf = (s: Shared): JarvisState =>
  s.busy || s.remote === 'thinking' || s.remote === 'speaking' ? 'EXECUTING' : s.recording || s.remote === 'listening' ? 'LISTENING' : 'IDLE';
const useJarvisState = (): JarvisState => stateOf(useSyncExternalStore(subscribe, () => shared, () => SERVER));

const PILL: Record<JarvisState, string> = {
  IDLE: 'border-line text-ink-3',
  LISTENING: 'border-[#72d6f7] text-[#72d6f7]',
  EXECUTING: 'border-[#f5a623] text-[#f5a623]',
};

/** Header pill: Jarvis's live state, from the typed/spoken command in flight and Jarvis's own voice stream. */
export function JarvisStatusPill() {
  const state = useJarvisState();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let last = -1;
    const es = new EventSource('/api/voice/stream');
    es.addEventListener('voice', (e) => {
      let raw: unknown;
      try { raw = JSON.parse((e as MessageEvent<string>).data); } catch { return; }
      const ev = parseVoiceStatus(raw);
      if (!ev || ev.seq <= last) return;
      last = ev.seq;
      patch({ remote: ev.status });
    });
    return () => es.close();
  }, []);
  return (
    <span role="status" aria-label={`Jarvis ${state.toLowerCase()}`} title="Jarvis state"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.1em] ${PILL[state]}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full bg-current ${state === 'IDLE' ? 'opacity-50' : 'animate-pulse'}`} />
      {state}
    </span>
  );
}

const MAX_AUDIO = 10 * 1024 * 1024;

/**
 * Footer bar: one place to ask your notes, run a playbook, or say "remember that ...". Enter sends to Jarvis through
 * /api/jarvis/command; when Jarvis is not running the same text goes to Ask (the in-app `pnpm ask` path). The mic
 * records, transcribes through the Studio endpoint (server-side Whisper or Wispr Flow) and fills the box: speech
 * never sends by itself.
 */
export function JarvisCommandBar() {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [mic, setMic] = useState<{ ok: boolean; language: string }>({ ok: false, language: 'en' });
  const input = useRef<HTMLInputElement>(null);
  const fallback = useRef<HTMLFormElement>(null);
  const fallbackQ = useRef<HTMLInputElement>(null);
  const rec = useRef<MediaRecorder>(undefined);
  const stream = useRef<MediaStream>(undefined);
  const { recording, busy } = useSyncExternalStore(subscribe, () => shared, () => SERVER);

  // Cmd/Ctrl+K focuses the bar from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    const c = new AbortController();
    fetch('/api/studio/status', { signal: c.signal }).then((r) => (r.ok ? r.json() : Promise.reject())).then((s: { transcription?: { configured?: boolean; languages?: string[] } }) => {
      const langs = s.transcription?.languages ?? [];
      setMic({ ok: !!s.transcription?.configured && langs.length > 0, language: langs.includes('en') ? 'en' : (langs[0] ?? 'en') });
    }).catch(() => {});
    return () => { c.abort(); stop(); };
  }, []);

  const release = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = undefined; };
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop(); release(); patch({ recording: false }); };

  const toggleMic = async () => {
    if (recording) return stop();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Recording is unavailable in this browser.');
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error('No supported recording format.');
      const r = new MediaRecorder(media, { mimeType });
      const chunks: Blob[] = [];
      let size = 0;
      let cancelled = false;
      r.ondataavailable = (e) => { size += e.data.size; if (size > MAX_AUDIO) { cancelled = true; setNote('Recording passed 10 MiB; try a shorter command.'); stop(); return; } if (e.data.size) chunks.push(e.data); };
      r.onstop = async () => {
        release();
        patch({ recording: false });
        if (cancelled || chunks.length === 0) return;
        patch({ busy: true });
        setNote('Transcribing…');
        try {
          const res = await fetch('/api/studio/transcribe', { method: 'POST', body: new Blob(chunks, { type: mimeType }), headers: { 'Content-Type': mimeType, 'X-Source-Language': mic.language } });
          const out = (await res.json()) as { text?: string; error?: string };
          if (!res.ok || !out.text) throw new Error(out.error ?? 'Transcription failed.');
          setText((v) => `${v}${v ? ' ' : ''}${out.text}`.slice(0, 2000));
          setNote('Transcript added. Press Enter to send.');
          input.current?.focus();
        } catch (e) { setNote(e instanceof Error ? e.message : 'Transcription failed.'); }
        finally { patch({ busy: false }); }
      };
      rec.current = r;
      r.start(1000);
      patch({ recording: true });
      setNote('Listening. Press the mic again to finish.');
    } catch (e) {
      release();
      setNote(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone permission denied. Type instead.' : e instanceof Error ? e.message : 'Microphone unavailable.');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    patch({ busy: true });
    setNote('');
    try {
      const res = await fetch('/api/jarvis/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q }) });
      if (res.status === 503) {
        // Jarvis is not running: hand the same text to Ask (what `pnpm ask` runs), which opens its run page.
        if (fallbackQ.current && fallback.current) { fallbackQ.current.value = q; fallback.current.requestSubmit(); return; }
      }
      const out = (await res.json()) as { answer?: string; message?: string; error?: string };
      if (!res.ok) throw new Error(out.message ?? out.error ?? `Jarvis answered ${res.status}`);
      setNote(out.answer || 'Done.');
      setText('');
    } catch (err) { setNote(err instanceof Error ? err.message : 'The command failed.'); }
    finally { patch({ busy: false }); }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-30 px-4">
      <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-1.5 rounded-control border border-line bg-canvas/90 p-2 shadow-lg backdrop-blur-md">
        {note && <p role="status" aria-live="polite" className="max-h-28 overflow-y-auto whitespace-pre-wrap px-2 text-[13px] text-ink-2">{note}</p>}
        <form onSubmit={submit} role="search" aria-label="Jarvis command bar" className="flex items-center gap-2">
          <button type="button" onClick={toggleMic} disabled={!mic.ok || (busy && !recording)} aria-pressed={recording}
            aria-label={recording ? 'Stop recording' : 'Record a spoken command'}
            title={mic.ok ? (recording ? 'Stop and transcribe' : 'Speak a command') : 'Microphone transcription is not configured (see Studio)'}
            className={`btn-quiet shrink-0 ${recording ? 'text-[#72d6f7]' : ''}`}>{recording ? '■' : '🎤'}</button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Jarvis command</span>
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} disabled={busy && !recording}
              onKeyDown={(e) => { if (e.key === 'Escape') input.current?.blur(); }}
              placeholder="Ask your notes, run a playbook, or say 'remember that...'" className="w-full" />
          </label>
          <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-3 md:block" aria-hidden="true">Ctrl/⌘ K</kbd>
          <button type="submit" disabled={busy || !text.trim()} className="btn-quiet shrink-0">{busy ? '…' : 'Send'}</button>
        </form>
      </div>
      <form ref={fallback} action={askAction} hidden><input ref={fallbackQ} type="hidden" name="q" /></form>
    </div>
  );
}
