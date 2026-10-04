'use client';

import { useEffect, useRef, useState } from 'react';
import { CAPTURE_KINDS, validateCapture, type CaptureKind } from '../../lib/studio-capture';

type State = 'stopped' | 'listening' | 'paused' | 'transcribing' | 'thinking' | 'speaking' | 'error';
type Availability = { configured: boolean; languages: string[] };
type Receipt = { sourceId: string; sha256: string; runIds: string[]; href: string; status: string };

export function VoiceCapture() {
  const [state, setState] = useState<State>('stopped');
  const [text, setText] = useState(''), [language, setLanguage] = useState('en');
  const [intent, setIntent] = useState<CaptureKind>('general-note');
  const [inputMethod, setInputMethod] = useState<'typed' | 'wispr-flow'>('typed');
  const [message, setMessage] = useState(''), [proof, setProof] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [muted, setMuted] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState<Receipt>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ transcription: Availability; speech: Availability }>();
  const recorder = useRef<MediaRecorder>(), stream = useRef<MediaStream>();
  const request = useRef<AbortController>(), audio = useRef<HTMLAudioElement>();
  const objectUrl = useRef(''), recording = useRef<{ blob: Blob; language: string }>();
  const generation = useRef(0), captureId = useRef(''), timer = useRef<ReturnType<typeof setTimeout>>();
  const editor = useRef<HTMLTextAreaElement>(null);
  const resetReview = () => { setConfirmed(false); setSaved(undefined); };
  const releaseAudio = () => { audio.current?.pause(); audio.current = undefined; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; };
  const stopTracks = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined; clearTimeout(timer.current); };
  const cancel = () => {
    generation.current++; request.current?.abort(); releaseAudio();
    recording.current = undefined;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    stopTracks(); setState('stopped'); setMessage('Stopped. Reviewed text is preserved.');
  };
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/studio/status', { cache: 'no-store', signal: controller.signal }).then(r => {
      if (!r.ok) throw new Error(); return r.json();
    }).then(setStatus).catch(() => { if (!controller.signal.aborted) setMessage('Speech configuration unavailable. Text capture remains available.'); });
    return () => { controller.abort(); generation.current++; request.current?.abort(); stopTracks(); releaseAudio(); if (recorder.current?.state !== 'inactive') recorder.current?.stop(); };
  }, []);
  const fail = (error: unknown) => { setState('error'); setMessage(error instanceof Error ? error.message : 'Studio request failed. Your text is preserved.'); };
  const beginRequest = () => { request.current?.abort(); const controller = new AbortController(); request.current = controller; return controller; };
  const responseJson = async (response: Response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Studio request failed.'); return result; };
  const transcribe = async (blob: Blob, version: number, sourceLanguage: string) => {
    const controller = beginRequest(); setState('transcribing'); setMessage('Transcribing. Nothing is saved until you review and confirm.');
    try {
      const result = await responseJson(await fetch('/api/studio/transcribe', { method: 'POST', body: blob, signal: controller.signal,
        headers: { 'Content-Type': blob.type, 'X-Source-Language': sourceLanguage } }));
      if (generation.current !== version) return;
      setText(result.text); setLanguage(sourceLanguage); setProof(result.receipt); setDetected(result.detectedLanguage); captureId.current = crypto.randomUUID(); resetReview();
      setState('stopped'); setMessage('Transcript ready. Review the text, language and capture kind before saving.');
    } catch (error) { if (!controller.signal.aborted && generation.current === version) fail(error); }
  };
  const listen = async () => {
    cancel(); const version = generation.current;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { fail(new Error('Microphone recording is unavailable. Use text input.')); return; }
    setState('thinking'); setMessage('Waiting for microphone permission.');
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== generation.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser cannot record a supported audio format. Use text input.');
      const capture = new MediaRecorder(input, { mimeType }); recorder.current = capture;
      const chunks: Blob[] = []; let size = 0;
      capture.ondataavailable = event => {
        if (version !== generation.current) return;
        size += event.data.size;
        if (size > 10 * 1024 * 1024) { cancel(); fail(new Error('Recording reached 10 MiB. Record a shorter fragment.')); return; }
        if (event.data.size) chunks.push(event.data);
      };
      capture.onerror = () => { if (version === generation.current) { cancel(); fail(new Error('Microphone recording failed. Retry or use text.')); } };
      capture.onstop = () => { if (version !== generation.current) return; stopTracks();
        const blob = new Blob(chunks, { type: mimeType }); recording.current = { blob, language };
        if (!blob.size) { fail(new Error('No audio was captured. Retry or use text.')); return; }
        void transcribe(blob, version, language);
      };
      capture.start(1000); setState('listening'); setMessage('Listening. Pauses never submit automatically. Press Finish to transcribe.');
      timer.current = setTimeout(() => { cancel(); fail(new Error('Recording stopped at five minutes. Record a shorter fragment.')); }, 5 * 60_000);
    } catch (error) { if (version === generation.current) { stopTracks(); fail(new Error(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone permission denied. Use text or allow the microphone and retry.' : 'Microphone unavailable. Use text input.')); } }
  };
  const save = async () => {
    if (!confirmed) return;
    const version = ++generation.current, controller = beginRequest(); releaseAudio();
    try {
      captureId.current ||= crypto.randomUUID();
      const capture = validateCapture({ captureId: captureId.current, text, language, intent, ...(proof ? { receipt: proof } : { inputMethod }) });
      setSaving(true); setState('thinking'); setMessage('Saving a new draft to Creative Vault…');
      const result = await responseJson(await fetch('/api/studio/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capture), signal: controller.signal }));
      if (version !== generation.current) return;
      setSaved(result); setState('stopped'); setMessage('Draft saved. No approved record was changed.');
    } catch (error) { if (!controller.signal.aborted && version === generation.current) fail(error); }
    finally { setSaving(false); }
  };
  const readBack = async () => {
    const selected = editor.current ? text.slice(editor.current.selectionStart, editor.current.selectionEnd) : '';
    const spoken = selected || text;
    if (!spoken.trim() || spoken.length > 600) { fail(new Error('Select up to 600 characters in the transcript for read-back.')); return; }
    const version = ++generation.current, controller = beginRequest(); releaseAudio(); setState('thinking'); setMessage('Preparing read-back.');
    try {
      const response = await fetch('/api/studio/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spoken, language }), signal: controller.signal });
      if (!response.ok) { await responseJson(response); return; }
      const blob = await response.blob(); if (version !== generation.current) return;
      objectUrl.current = URL.createObjectURL(blob); const player = new Audio(objectUrl.current); audio.current = player;
      player.onended = () => { if (version === generation.current) { releaseAudio(); setState('stopped'); setMessage('Read-back finished.'); } };
      player.onerror = () => { if (version === generation.current) { releaseAudio(); fail(new Error('Audio playback failed. Retry or use text.')); } };
      await player.play(); if (version === generation.current) { setState('speaking'); setMessage('Reading selected draft text.'); }
    } catch (error) { if (!controller.signal.aborted && version === generation.current) { releaseAudio(); fail(error); } }
  };
  const busy = ['listening', 'paused', 'transcribing', 'thinking', 'speaking'].includes(state);
  return <section className="voice-capture mercury-panel" aria-labelledby="capture-title">
    <h2 id="capture-title">Studio capture</h2><p>Type a draft or focus the field and use your Wispr Flow shortcut. After dictating, select Wispr Flow as the text input source and review before saving.</p>
    <p className="meta">Wispr Flow handles dictation in its desktop app. Studio receives text; it cannot observe Flow's recording state or verify its original audio.</p>
    <p className="meta">Kokoro read-back: {status ? status.speech.configured ? 'configured' : 'unconfigured' : 'checking configuration'}</p>
    <p role="status" aria-live="polite"><strong>{state}</strong> · {message}</p>
    <div className="capture-fields"><label>Source language<select value={language} disabled={busy || Boolean(proof)} onChange={e => { setLanguage(e.target.value); resetReview(); }}><option value="en">English</option><option value="bg">Bulgarian</option>{[...new Set([...(status?.transcription.languages ?? []), ...(status?.speech.languages ?? [])])].filter(l => !['en', 'bg'].includes(l)).map(l => <option key={l} value={l}>{l}</option>)}</select></label>
      <label>Capture kind<select value={intent} disabled={busy} onChange={e => { setIntent(e.target.value as CaptureKind); resetReview(); }}>{CAPTURE_KINDS.map(kind => <option key={kind} value={kind}>{kind.replaceAll('-', ' ')}</option>)}</select></label></div>
    {!proof && <label>Text input source<select value={inputMethod} disabled={busy} onChange={e => { setInputMethod(e.target.value as 'typed' | 'wispr-flow'); resetReview(); }}><option value="wispr-flow">Wispr Flow (owner-declared)</option><option value="typed">Typed or pasted text</option></select></label>}
    <div className="capture-controls"><button type="button" disabled={busy} onClick={() => editor.current?.focus()}>Focus draft for Wispr Flow</button></div>
    {status?.transcription.configured && <div className="capture-controls"><button type="button" disabled={busy || !status.transcription.languages.includes(language)} onClick={() => void listen()}>Start listening</button>
      <button type="button" disabled={!['listening', 'paused'].includes(state)} onClick={() => { if (state === 'listening') { recorder.current?.pause(); setState('paused'); } else { recorder.current?.resume(); setState('listening'); } }}>{state === 'paused' ? 'Resume recording' : 'Pause recording'}</button>
      <button type="button" disabled={!['listening', 'paused'].includes(state)} onClick={() => recorder.current?.stop()}>Finish recording</button>
      <button type="button" disabled={saving} onClick={cancel}>Cancel / stop</button>
      <button type="button" disabled={busy || !recording.current} onClick={() => { const version = ++generation.current; const captured = recording.current!; void transcribe(captured.blob, version, captured.language); }}>Retry transcription</button></div>}
    <div className="capture-controls"><button type="button" disabled={saving} onClick={() => { cancel(); setProof(''); setDetected(null); recording.current = undefined; setInputMethod('typed'); resetReview(); setMessage('Text-only capture. Existing text is preserved.'); editor.current?.focus(); }}>Text only</button>
      <button type="button" disabled={saving} onClick={cancel}>Stop Studio playback / request</button></div>
    <label className="capture-transcript">Transcript / typed draft<textarea ref={editor} rows={7} value={text} disabled={busy} maxLength={20_000} onChange={e => { setText(e.target.value); resetReview(); }}/></label>
    {proof && <p className="meta">Voice source language: {language} · service-reported language: {detected ?? 'not reported'}. Original transcript and audio checksum are retained with the saved draft.</p>}
    <div className="capture-controls"><label><input type="checkbox" checked={muted} disabled={saving} onChange={e => { setMuted(e.target.checked); if (e.target.checked) cancel(); }}/>Mute read-back</label><button type="button" disabled={muted || busy || !text.trim() || !status?.speech.languages.includes(language)} onClick={() => void readBack()}>Read selection / short draft</button></div>
    {status && !status.speech.languages.includes(language) && <p className="meta">Read-back is unavailable for the selected language. You can still edit and save the draft.</p>}
    <label className="capture-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)}/>I reviewed this text and want to save it as a new draft.</label>
    <button type="button" disabled={busy || !confirmed || !text.trim() || Boolean(saved)} onClick={() => void save()}>Save new draft</button>
    {saved && <p><a href={saved.href}>Open saved draft</a> · source {saved.sourceId} · {saved.runIds.length} recorded run(s)</p>}
    <p className="meta">Tasks, style requests and tag requests are captured as drafts; capture never executes them or overwrites approved work.</p>
  </section>;
}
