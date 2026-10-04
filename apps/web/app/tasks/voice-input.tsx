'use client';

import { useEffect, useRef, useState } from 'react';

/** Uses the same authenticated transcription endpoint as Studio. Recording never launches work. */
export function VoiceInput({ language, onTranscript, onBusy }: { language: string; onTranscript: (text: string) => void; onBusy: (busy: boolean) => void }) {
  const [configured, setConfigured] = useState(false), [state, setState] = useState('idle'), [message, setMessage] = useState('Checking microphone transcription…');
  const stream = useRef<MediaStream>(), recorder = useRef<MediaRecorder>(), request = useRef<AbortController>();
  const generation = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>();
  const release = () => { clearTimeout(timer.current); stream.current?.getTracks().forEach(t => t.stop()); stream.current = undefined; };
  const cancel = () => { generation.current++; request.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); release(); setState('idle'); onBusy(false); setMessage('Recording cancelled. Your brief is preserved.'); };
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/studio/status', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(s => {
      setConfigured(s.transcription.configured && s.transcription.languages.includes(language));
      setMessage(s.transcription.configured ? 'Record, finish, then review your transcript.' : 'Microphone transcription is not configured. Use Wispr Flow in the brief, or type.');
    }).catch(() => { if (!controller.signal.aborted) setMessage('Microphone status unavailable. Typing and Wispr Flow still work.'); });
    return () => { controller.abort(); generation.current++; request.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); release(); };
  }, [language]);
  const record = async () => {
    const version = ++generation.current;
    onBusy(true); setState('permission'); setMessage('Waiting for microphone permission…');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Recording is unavailable in this browser.');
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== generation.current) { input.getTracks().forEach(t => t.stop()); return; }
      stream.current = input;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error('No supported recording format.');
      const rec = new MediaRecorder(input, { mimeType }); recorder.current = rec;
      const chunks: Blob[] = []; let size = 0;
      rec.ondataavailable = e => { if (version !== generation.current) return; size += e.data.size; if (size > 10 * 1024 * 1024) { cancel(); setMessage('Recording exceeded 10 MiB. Try a shorter command.'); return; } if (e.data.size) chunks.push(e.data); };
      rec.onerror = () => { cancel(); setMessage('Recording failed. Type your brief or retry.'); };
      rec.onstop = async () => {
        if (version !== generation.current) return;
        release(); setState('transcribing'); setMessage('Transcribing your command…');
        const controller = new AbortController(); request.current = controller;
        try {
          const response = await fetch('/api/studio/transcribe', { method: 'POST', body: new Blob(chunks, { type: mimeType }), signal: controller.signal, headers: { 'Content-Type': mimeType, 'X-Source-Language': language } });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? 'Transcription failed.');
          if (version !== generation.current) return;
          onTranscript(result.text); setMessage('Transcript added. Review the brief, then choose Start workflow.');
        } catch (e) { if (version === generation.current) setMessage(e instanceof Error ? e.message : 'Transcription failed.'); }
        finally { if (version === generation.current) { setState('idle'); onBusy(false); } }
      };
      rec.start(1000); setState('recording'); setMessage('Listening. Finish recording when your command is ready.');
      timer.current = setTimeout(() => { cancel(); setMessage('Recording stopped after five minutes. Try a shorter command.'); }, 300_000);
    } catch (e) { if (version === generation.current) { release(); setState('idle'); onBusy(false); setMessage(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone permission denied. Type or use Wispr Flow.' : 'Microphone unavailable. Type or use Wispr Flow.'); } }
  };
  return <div className="task-voice">
    <div className="task-inline">
      {state === 'idle' ? <button type="button" onClick={record} disabled={!configured}>Record command</button> : <>
        {state === 'recording' && <button type="button" onClick={() => { setState('transcribing'); if (recorder.current?.state === 'recording') recorder.current.stop(); }}>Finish recording</button>}
        <button type="button" onClick={cancel}>Cancel recording</button>
      </>}
    </div>
    <p role="status">{message}</p>
  </div>;
}
