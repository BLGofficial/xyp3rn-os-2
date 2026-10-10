'use client';

import { useEffect, useRef, useState } from 'react';
import { TASK_CATALOG, type TaskId } from '../../lib/task-catalog';

/** Jarvis, the voice agent's desk (galaxy/server.py). The HUD links to the same address. */
export const JARVIS_URL = 'http://127.0.0.1:4700';

const BTN = 'inline-flex min-h-0 items-center justify-center gap-1.5 rounded-control border px-3 py-2 text-[12.5px] font-medium no-underline';
export const BTN_GHOST = `${BTN} border-[#1b5f78] bg-[#0c1d30] text-[#dfeaf3] hover:bg-[#122c43]`;
export const BTN_GOLD = `${BTN} border-[#f5a623] bg-[#f5a623] text-[#1a1204] hover:bg-[#ffd080] disabled:cursor-not-allowed disabled:opacity-50`;
const FIELD = 'w-full rounded-control border border-[#1b5f78] bg-[#0b1726] px-2.5 py-2 text-[13px] text-[#dfeaf3] placeholder:text-[#546a7d]';

/**
 * A glass window floating over the stage, as APEX-UI's agent overview does. Escape closes it; focus moves in when it
 * opens and goes back to what opened it when it closes, so the keyboard is never left behind the graph.
 */
export function Panel({ title, subtitle, color, onClose, children }: { title: string; subtitle: string; color: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, a, select, textarea')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (opener && document.contains(opener)) opener.focus(); };
  }, [onClose]);
  return (
    <div ref={ref} role="dialog" aria-label={title} className="absolute bottom-2 right-2 top-2 z-20 flex w-[min(350px,94%)] flex-col overflow-hidden rounded-[16px] text-[#dfeaf3]"
      style={{ background: 'rgba(4,3,12,0.92)', backdropFilter: 'blur(24px)', border: `1px solid ${color}55`, boxShadow: `0 0 40px ${color}22, 0 8px 32px rgba(0,0,0,0.6)` }}>
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: `${color}33`, background: `linear-gradient(135deg, ${color}12 0%, transparent 100%)` }}>
        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
        <div className="min-w-0">
          <div className="break-words text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color }}>{title}</div>
          <div className="text-[10.5px] uppercase tracking-[0.06em] text-white/45">{subtitle}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto min-h-0 border-0 bg-transparent px-2 py-1 text-[20px] leading-none text-white/50 hover:text-white">×</button>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-[13px]">{children}</div>
    </div>
  );
}

export const Label = ({ children, color }: { children: React.ReactNode; color: string }) => (
  <div className="mb-1.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: `${color}cc` }}>{children}</div>
);

type Start = { kind: 'idle' } | { kind: 'starting' } | { kind: 'error'; message: string } | { kind: 'started'; href: string; id: string };

/**
 * Starts a task through the same endpoint as the Tasks page (POST /api/tasks): the server maps the task to its
 * workflow or domain, so the ring never names a tool or an agent to run. The brief is kept on any failure.
 */
export function TaskStarter({ defaultTask, scope, color }: { defaultTask: TaskId; scope: string; color: string }) {
  const [task, setTask] = useState<TaskId>(defaultTask);
  const [brief, setBrief] = useState('');
  const [start, setStart] = useState<Start>({ kind: 'idle' });
  const busy = useRef(false);
  const chosen = TASK_CATALOG.find((t) => t.id === task)!;
  const workflows = TASK_CATALOG.filter((t) => 'workflow' in t.target);
  const domains = TASK_CATALOG.filter((t) => !('workflow' in t.target));

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current || !brief.trim()) return;
    busy.current = true;
    setStart({ kind: 'starting' });
    try {
      const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, text: brief, knowledge: [], inputMethod: 'typed', language: 'en' }), signal: AbortSignal.timeout(30_000) });
      const data = (await r.json()) as { error?: string; href?: string; requestId?: string };
      if (!r.ok || !data.href) throw new Error(data.error ?? 'Task could not start.');
      setStart({ kind: 'started', href: data.href, id: data.requestId ?? '' });
    } catch (err) {
      setStart({ kind: 'error', message: err instanceof DOMException || err instanceof TypeError ? 'Connection interrupted. Check recent requests before retrying; your brief is kept.' : err instanceof Error ? err.message : 'Task could not start. Your brief is kept.' });
    } finally { busy.current = false; }
  };

  return (
    <form onSubmit={go} aria-label="Start a task" className="flex flex-col gap-2.5">
      <Label color={color}>Start a task</Label>
      <label className="sr-only" htmlFor="ring-task">Task or workflow</label>
      <select id="ring-task" value={task} onChange={(e) => { setTask(e.target.value as TaskId); setStart({ kind: 'idle' }); }} className={FIELD}>
        <optgroup label="Workflows">{workflows.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>
        <optgroup label="Domain tasks">{domains.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>
      </select>
      <p className="m-0 text-[11.5px] leading-snug text-white/50">{chosen.description} {'workflow' in chosen.target ? `Runs the ${chosen.target.workflow} workflow.` : `Runs through the ${chosen.target.domain.replace('_', ' ').toLowerCase()} agents.`} {scope}</p>
      <label className="sr-only" htmlFor="ring-brief">Brief</label>
      <textarea id="ring-brief" value={brief} onChange={(e) => { setBrief(e.target.value.slice(0, 8000)); if (start.kind !== 'starting') setStart({ kind: 'idle' }); }} rows={4} placeholder="Describe the outcome, constraints, and what a good result includes…" className={`${FIELD} resize-y`} />
      {start.kind === 'error' && <p role="alert" className="m-0 text-[12px] text-[#ff8b7a]">{start.message}</p>}
      {start.kind === 'started' && <p role="status" className="m-0 text-[12px] text-[#7df1ae]">Started. <a href={start.href} className="text-[#7df1ae] underline">Open the result and run status →</a></p>}
      <button type="submit" disabled={start.kind === 'starting' || !brief.trim()} className={BTN_GOLD}>{start.kind === 'starting' ? 'Starting…' : 'Start'} <span aria-hidden="true">↗</span></button>
      <p className="m-0 text-[11px] text-white/40">Same as the Tasks page: runs keep their records and approval gates.</p>
    </form>
  );
}

/** Jarvis's panel: whether the desk answers, where to open it, and how to start it when it does not. */
export type Launch = { readonly kind: 'idle' } | { readonly kind: 'starting' } | { readonly kind: 'error'; readonly message: string };

export function JarvisPanel({ status, voice, launch, onStart }: { status: 'checking' | 'online' | 'offline'; voice: string | null; launch: Launch; onStart: () => void }) {
  const dot = status === 'online' ? '#34d399' : status === 'offline' ? '#ff5a4a' : '#c9a84c';
  return (
    <>
      <p className="m-0 flex items-center gap-2"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />
        <span className="text-[11px] uppercase tracking-[0.1em] text-white/60">{status === 'online' ? 'Online · the desk answers on port 4700' : status === 'offline' ? 'Offline · nothing answers on port 4700' : 'Checking…'}</span></p>
      {status === 'online' && <p className="m-0 text-[11px] uppercase tracking-[0.1em] text-white/60">Voice · {voice ?? 'waiting for status'}</p>}
      <div className="flex flex-col gap-2">
        {status === 'offline'
          ? <button type="button" onClick={onStart} disabled={launch.kind === 'starting'} className={BTN_GOLD}>{launch.kind === 'starting' ? 'Starting Jarvis…' : 'Start Jarvis'}</button>
          : <a href={JARVIS_URL} target="_blank" rel="noopener noreferrer" className={BTN_GOLD}>Open Jarvis ↗</a>}
        <a href={`${JARVIS_URL}/?view=graph`} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>Jarvis knowledge graph ↗</a>
        <a href="/tasks" className={BTN_GHOST}>Tasks workbench</a>
      </div>
      {launch.kind === 'error' && <p role="alert" className="m-0 text-[12px] leading-snug text-[#ff8b7a]">{launch.message}</p>}
      {status === 'offline' && (
        <div>
          <Label color="#f5a623">Or start it yourself</Label>
          <p className="m-0 mb-1.5 text-[11.5px] text-white/50">In a terminal, from the project folder:</p>
          <code className="block rounded-control border border-[#1b5f78] bg-[#0b1726] px-2.5 py-2 text-[12px] text-[#dfeaf3]">python galaxy/server.py</code>
        </div>
      )}
      <p className="m-0 text-[11.5px] leading-snug text-white/45">Jarvis keeps its voice, runs, approvals and phone line. This ring only shows state and opens it.</p>
    </>
  );
}
