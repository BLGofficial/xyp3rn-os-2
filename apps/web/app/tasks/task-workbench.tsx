'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnimate } from 'motion/react-mini';
import { TASK_CATALOG, MAX_KNOWLEDGE, type KnowledgeChoice, type RecentTask, type TaskId } from '../../lib/task-catalog';
import { VoiceInput } from './voice-input';

export function TaskWorkbench({ initialBrief = '' }: { initialBrief?: string }) {
  const [task, setTask] = useState<TaskId>('lyrics'), [brief, setBrief] = useState(initialBrief);
  const [knowledge, setKnowledge] = useState<KnowledgeChoice[]>([]), [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
  const [inputMethod, setInputMethod] = useState('typed'), [language, setLanguage] = useState('en');
  const [voiceBusy, setVoiceBusy] = useState(false), [starting, setStarting] = useState(false), [run, setRun] = useState<{ href: string; requestId: string }>();
  const editor = useRef<HTMLTextAreaElement>(null), submitted = useRef(false);
  const [scope, animate] = useAnimate();
  const chosen = TASK_CATALOG.find(t => t.id === task)!;
  const visible = knowledge.filter(k => `${k.title} ${k.kind} ${k.detail}`.toLowerCase().includes(query.toLowerCase()));
  const load = async (signal?: AbortSignal) => {
    setLoading(true); setLoadError('');
    try {
      const r = await fetch('/api/tasks', { signal, cache: 'no-store' }); const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Task options could not load.');
      setKnowledge(data.knowledge); setRecent(data.recent);
    } catch (e) { if (!signal?.aborted) setLoadError(e instanceof Error ? e.message : 'Task options could not load.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    const refresh = async () => {
      if (document.hidden) return;
      try { const r = await fetch('/api/tasks?recent=1', { cache: 'no-store', signal: controller.signal }); if (r.ok) setRecent((await r.json()).recent); } catch { /* keep last known state */ }
    };
    const interval = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = animate(scope.current, { opacity: [0.65, 1], transform: ['translateY(8px)', 'translateY(0px)'] }, { duration: 0.22, ease: 'easeOut' });
    return () => animation.stop();
  }, [task, animate, scope]);
  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitted.current || voiceBusy) return;
    submitted.current = true; setStarting(true); setError(''); setRun(undefined);
    try {
      const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, text: brief, knowledge: selected, inputMethod, language }), signal: AbortSignal.timeout(30_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Task could not start.');
      setRun(data); void load();
    } catch (e) { setError(e instanceof DOMException || e instanceof TypeError ? 'Connection interrupted. Check recent requests before retrying; your brief is preserved.' : e instanceof Error ? e.message : 'Task could not start. Your brief is preserved.'); }
    finally { submitted.current = false; setStarting(false); }
  };
  return <div className="task-workbench">
    <header className="task-hero">
      <div><p className="task-eyebrow">XYP3RN / Creative operations</p><h1>From idea to action.</h1><p>Choose a task. Combine your knowledge. Give the agents a clear brief.</p></div>
      <a className="task-secondary-link" href="/workflows">View workflow runs <span aria-hidden="true">↗</span></a>
    </header>
    <nav className="task-surface-links" aria-label="Workspace views"><a href="/hud">Web HUD · control the engine</a><a href="http://127.0.0.1:4700/" target="_blank" rel="noreferrer">Galaxy · explore knowledge ↗</a><a href="#catalog-tasks">Saved task list ↓</a></nav>
    <div className="task-layout">
      <section className="task-palette" aria-labelledby="task-list-title">
        <p className="task-eyebrow">01 / Choose your task</p><h2 id="task-list-title">Task list</h2>
        <div className="task-options" role="group" aria-label="Executable tasks">{TASK_CATALOG.map((t, index) => <button type="button" key={t.id} className={`task-option ${task === t.id ? 'is-selected' : ''}`} aria-pressed={task === t.id} disabled={starting || voiceBusy} onClick={() => { setTask(t.id); setRun(undefined); setError(''); }}>
          <span className="task-option-number">0{index + 1}</span><span><strong>{t.label}</strong><small>{t.category}</small></span><span aria-hidden="true">↗</span>
        </button>)}</div>
        <div className="task-explainer"><strong>One workspace, two views.</strong><p>HUD follows live engine activity. Galaxy explores indexed notes and their relationships. Tasks here use the engine’s existing workflows and approvals.</p></div>
      </section>
      <form className="task-composer" onSubmit={start} ref={scope} aria-label="Start agentic task">
        <div className="task-composer-heading"><div><p className="task-eyebrow">02 / Shape the brief</p><h2>{chosen.label}</h2></div><span className="task-category">{chosen.category}</span></div>
        <p className="task-description">{chosen.description}</p>
        <fieldset disabled={starting || voiceBusy} className="task-input-options"><legend className="sr-only">Input preferences</legend>
          <label>Input<select value={inputMethod} onChange={e => { setInputMethod(e.target.value); editor.current?.focus(); }}><option value="typed">Type a brief</option><option value="wispr-flow">Wispr Flow dictation</option><option value="microphone">Microphone transcript</option></select></label>
          <label>Language<select value={language} onChange={e => setLanguage(e.target.value)}><option value="en">English</option><option value="bg">Bulgarian</option></select></label>
        </fieldset>
        <label className="task-brief-label" htmlFor="task-brief">Your brief</label>
        <textarea ref={editor} id="task-brief" required maxLength={8000} rows={7} value={brief} disabled={starting || voiceBusy} onChange={e => { setBrief(e.target.value); setRun(undefined); }} placeholder={task === 'lyrics' ? 'Write a Bulgarian chorus about starting over. Intimate verses, a memorable hook, and room to breathe…' : 'Describe the outcome, constraints, and what a good result should include…'} />
        <div className="task-brief-meta"><span>{inputMethod === 'wispr-flow' ? 'Focus the brief, dictate with Wispr Flow, then review and start.' : 'Typing or voice creates an editable brief. Start is always explicit.'}</span><span>{brief.length.toLocaleString()} / 8,000</span></div>
        {inputMethod === 'microphone' && !starting && <VoiceInput language={language} onBusy={setVoiceBusy} onTranscript={text => { setBrief(value => `${value}${value ? '\n' : ''}${text}`.slice(0, 8000)); setRun(undefined); editor.current?.focus(); }} />}
        <section className="task-knowledge" aria-labelledby="knowledge-title"><div className="task-section-heading"><div><p className="task-eyebrow">03 / Add music knowledge</p><h3 id="knowledge-title">Build your combination</h3></div><span>{selected.length} / {MAX_KNOWLEDGE}</span></div>
          <p>Combine canonical prompts, music modules, approved recipes, and indexed notes. Source IDs travel with your brief.</p>
          <label className="sr-only" htmlFor="knowledge-search">Search music knowledge</label><input id="knowledge-search" type="search" placeholder="Search your music knowledge…" value={query} onChange={e => setQuery(e.target.value)} />
          {loading ? <p role="status">Loading music knowledge…</p> : loadError ? <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void load()}>Retry knowledge</button></div> : <>
            <div className="task-knowledge-list">{visible.map(k => <label key={k.id} className={`task-knowledge-row ${selected.includes(k.id) ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={selected.includes(k.id)} disabled={starting || voiceBusy || (!selected.includes(k.id) && selected.length >= MAX_KNOWLEDGE)} onChange={e => setSelected(s => e.target.checked ? [...s, k.id] : s.filter(id => id !== k.id))} />
              <span><strong>{k.title}</strong><small>{k.kind} · {k.detail}</small></span>
            </label>)}</div>
            {!visible.length && <p>{knowledge.length ? 'No sources match this search.' : 'No music sources are available yet. Add knowledge in Ingest or approve a Studio recipe.'}</p>}
          </>}
          {!!selected.length && <div className="task-selected" aria-label="Selected knowledge">{selected.map(id => <button key={id} type="button" disabled={starting || voiceBusy} onClick={() => setSelected(s => s.filter(x => x !== id))} aria-label={`Remove ${knowledge.find(k => k.id === id)?.title ?? 'source'}`}>{knowledge.find(k => k.id === id)?.title ?? 'Source'} ×</button>)}</div>}
        </section>
        {error && <p role="alert" className="task-error">{error}</p>}
        {run && <div role="status" className="task-receipt"><strong>Request started.</strong><a href={run.href}>Open result and run status →</a><small>{run.requestId}</small></div>}
        <div className="task-submit-row"><p>Results keep their run records.<br />Approval gates remain in place.</p><button className="task-start" type="submit" disabled={starting || voiceBusy || !brief.trim()}>{starting ? 'Starting…' : 'Start workflow'} <span aria-hidden="true">↗</span></button></div>
      </form>
    </div>
    <section className="task-recent" aria-labelledby="recent-task-title"><div className="task-section-heading"><h2 id="recent-task-title">Recent requests</h2><a href="/workflows">All workflow records →</a></div><p>Requests from this server session. Workflow and research records remain available after a restart.</p>
      {recent.length ? <ul>{recent.map(r => <li key={r.requestId}><a href={`/ask/${r.requestId}`}><span>{r.title}</span><span className={`status-${r.status}`}>{r.status}</span></a></li>)}</ul> : <p>No requests in this session yet.</p>}
    </section>
  </div>;
}
