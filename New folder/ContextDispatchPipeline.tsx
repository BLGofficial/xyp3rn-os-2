import React, { useEffect, useMemo, useRef, useState } from 'react';
import './ContextDispatchPipeline.css';

type Corpus = 'knowledge' | 'vault';
type VectorMatch = { id: string; x?: number; y?: number; nx?: number; ny?: number; corpus?: Corpus; score?: number; label?: string };
type PipelineStep = { label: string; state: 'pending' | 'active' | 'complete' };
type Pipeline = { id: string; label: string; steps: PipelineStep[] };
type Particle = { x: number; y: number; fromX: number; fromY: number; toX: number; toY: number; progress: number; speed: number; phase: 'in' | 'out'; corpus: Corpus; lane: number; step: number; size: number };
type FlowEvent = { type?: string; [key: string]: unknown };

const COLORS = { knowledge: '#00D9F5', vault: '#D4AF37' };
const START_PIPELINES: Pipeline[] = [
  { id: 'songwriting', label: 'MUSIC CREATION', steps: ['Songwriting', 'Lyrics', 'Genre-Style', 'Suno Package'].map((label) => ({ label, state: 'pending' })) },
  { id: 'research', label: 'RESEARCH RUN', steps: ['Question', 'Evidence', 'Synthesis', 'Knowledge File'].map((label) => ({ label, state: 'pending' })) },
  { id: 'artist-os', label: 'ARTIST OS', steps: ['Intent', 'Context', 'Agent Run', 'Review'].map((label) => ({ label, state: 'pending' })) },
  { id: 'knowledge-ingest', label: 'KNOWLEDGE INGEST', steps: ['Source', 'Chunking', 'Embedding', 'pgvector'].map((label) => ({ label, state: 'pending' })) },
  { id: 'release-ops', label: 'RELEASE OPS', steps: ['Asset Check', 'Metadata', 'Approval', 'Distribution'].map((label) => ({ label, state: 'pending' })) },
];

function seeded(i: number) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function rec(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function parsePayload(data: string): FlowEvent | null { try { return JSON.parse(data) as FlowEvent; } catch { return null; } }
function corpusOf(v: unknown): Corpus { return String(v || '').toLowerCase().includes('vault') ? 'vault' : 'knowledge'; }
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function vectorPoint(match: VectorMatch, index: number, width: number, height: number) {
  if (match.nx != null && match.ny != null) return { x: width * (.045 + clamp01(match.nx) * .3), y: height * (.08 + clamp01(match.ny) * .84) };
  if (match.x == null || match.y == null) return { x: width * (.055 + seeded(index + 4) * .28), y: height * (.12 + seeded(index + 31) * .75) };
  const signed = match.x < 0 || match.y < 0;
  const x = Math.abs(match.x) <= 1 ? width * (signed ? .195 + match.x * .15 : .045 + clamp01(match.x) * .3) : match.x;
  const y = Math.abs(match.y) <= 1 ? height * (signed ? .5 + match.y * .42 : .08 + clamp01(match.y) * .84) : match.y;
  return { x: Math.max(18, Math.min(width * .39, x)), y: Math.max(22, Math.min(height - 24, y)) };
}

export default function ContextDispatchPipeline({ streamEndpoint = '/api/v1/workflows/active/stream', className = '' }: { streamEndpoint?: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const matchesRef = useRef<VectorMatch[]>([]);
  const modeRef = useRef<'IDLE' | 'QUERYING' | 'EXECUTING'>('IDLE');
  const pipelinesRef = useRef(START_PIPELINES);
  const [pipelines, setPipelines] = useState<Pipeline[]>(START_PIPELINES);
  const [matches, setMatches] = useState<VectorMatch[]>([]);
  const [mode, setMode] = useState<'IDLE' | 'QUERYING' | 'EXECUTING'>('IDLE');
  const [connection, setConnection] = useState<'CONNECTING' | 'LIVE' | 'OFFLINE'>('CONNECTING');
  const [lastEvent, setLastEvent] = useState('Waiting for dispatch');
  const [dispatchCount, setDispatchCount] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);

  useEffect(() => { pipelinesRef.current = pipelines; }, [pipelines]);
  useEffect(() => { matchesRef.current = matches; }, [matches]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const laneFor = (event: FlowEvent) => {
    const raw = event.pipelineIndex ?? event.workflowIndex ?? event.trackIndex;
    if (Number.isFinite(Number(raw))) return Math.max(0, Math.min(START_PIPELINES.length - 1, Number(raw)));
    const name = String(event.pipelineId ?? event.workflowId ?? event.pipeline ?? event.workflow ?? '').toLowerCase();
    const byId = START_PIPELINES.findIndex((p) => p.id === name || p.label.toLowerCase() === name);
    if (byId >= 0) return byId;
    if (/song|lyric|suno|music/.test(name)) return 0;
    if (/research|evidence/.test(name)) return 1;
    if (/artist|agent/.test(name)) return 2;
    if (/ingest|knowledge|vector/.test(name)) return 3;
    if (/release|distribution/.test(name)) return 4;
    return 0;
  };
  const stepFor = (event: FlowEvent, pipeline: Pipeline) => {
    const raw = event.stepIndex ?? event.stageIndex ?? event.index;
    if (Number.isFinite(Number(raw))) return Math.max(0, Math.min(pipeline.steps.length - 1, Number(raw)));
    const label = String(event.stepId ?? event.step ?? event.stage ?? event.stepName ?? '').toLowerCase();
    const match = pipeline.steps.findIndex((s) => s.label.toLowerCase() === label || s.label.toLowerCase().includes(label));
    return match >= 0 ? match : 0;
  };

  useEffect(() => {
    if (typeof EventSource === 'undefined') { setConnection('OFFLINE'); return; }
    const source = new EventSource(streamEndpoint);
    source.onopen = () => setConnection('LIVE'); source.onerror = () => setConnection('OFFLINE');
    const handle = (raw: unknown, type?: string) => {
      const outer = rec(raw); const body = rec(outer.payload ?? outer.data ?? outer); const eventType = String(type ?? body.type ?? body.event ?? '').toUpperCase();
      if (eventType === 'VECTOR_QUERY_MATCH') {
        const rawMatches = Array.isArray(body.matches) ? body.matches : Array.isArray(body.nodes) ? body.nodes : Array.isArray(body.results) ? body.results : [body];
        let normalized = rawMatches.map((item, i) => {
          const node = rec(item); const coords = rec(node.coordinates ?? node.position);
          const xValue = Number(node.x ?? coords.x), yValue = Number(node.y ?? coords.y);
          return { id: String(node.id ?? node.nodeId ?? `match-${Date.now()}-${i}`), x: Number.isFinite(xValue) ? xValue : undefined, y: Number.isFinite(yValue) ? yValue : undefined, corpus: corpusOf(node.corpus ?? node.source ?? node.collection) as Corpus, score: Number(node.score ?? node.similarity) || undefined, label: String(node.label ?? node.title ?? '') } as VectorMatch;
        });
        const positioned = normalized.filter((match) => match.x != null && match.y != null);
        if (positioned.some((match) => Math.abs(match.x!) > 1 || Math.abs(match.y!) > 1)) {
          const xs = positioned.map((match) => match.x!), ys = positioned.map((match) => match.y!);
          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
          normalized = normalized.map((match) => match.x == null || match.y == null ? match : ({ ...match, nx: maxX === minX ? .5 : (match.x - minX) / (maxX - minX), ny: maxY === minY ? .5 : (match.y - minY) / (maxY - minY) }));
        }
        setMatches(normalized); setMode('QUERYING'); setDispatchCount((n) => n + 1);
        setLastEvent(`${normalized.length} VECTOR MATCH${normalized.length === 1 ? '' : 'ES'} RETRIEVED`);
      } else if (eventType === 'WORKFLOW_STEP_START') {
        const lane = laneFor(body); const current = pipelinesRef.current; const step = stepFor(body, current[lane]);
        const updated = current.map((pipeline, i) => i !== lane ? pipeline : { ...pipeline, steps: pipeline.steps.map((s, j) => ({ ...s, state: j < step ? 'complete' as const : j === step ? 'active' as const : 'pending' as const })) });
        pipelinesRef.current = updated; setPipelines(updated); setMode('EXECUTING');
        setLastEvent(`${current[lane].label} · ${current[lane].steps[step].label} STARTED`);
      } else if (eventType === 'WORKFLOW_STEP_COMPLETE') {
        const lane = laneFor(body); const current = pipelinesRef.current; const step = stepFor(body, current[lane]);
        const updated = current.map((pipeline, i) => i !== lane ? pipeline : { ...pipeline, steps: pipeline.steps.map((s, j) => ({ ...s, state: j <= step ? 'complete' as const : 'pending' as const })) });
        pipelinesRef.current = updated; setPipelines(updated); setCompletedCount((n) => n + 1);
        setLastEvent(`${current[lane].label} · ${current[lane].steps[step].label} COMPLETE`);
        const stillActive = updated.some((pipeline) => pipeline.steps.some((s) => s.state === 'active'));
        if (!stillActive) setMode('IDLE');
      }
    };
    const types = ['VECTOR_QUERY_MATCH', 'WORKFLOW_STEP_START', 'WORKFLOW_STEP_COMPLETE'];
    const listeners = types.map((type) => {
      const listener = (event: Event) => handle(parsePayload((event as MessageEvent).data), type);
      source.addEventListener(type, listener); return [type, listener] as const;
    });
    source.onmessage = (event) => { const body = parsePayload(event.data); if (body) handle(body); };
    return () => { listeners.forEach(([type, listener]) => source.removeEventListener(type, listener)); source.close(); };
  }, [streamEndpoint]);

  useEffect(() => {
    const canvas = canvasRef.current, stage = stageRef.current; if (!canvas || !stage) return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true }); if (!ctx) return;
    let width = 0, height = 0, dpr = 1, frame = 0, previous = 0, ambientTime = 0;
    const resize = () => { const box = stage.getBoundingClientRect(); width = box.width; height = box.height; dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; };
    const observer = new ResizeObserver(resize); observer.observe(stage); resize();
    const targetPoint = (lane: number, step: number) => ({ x: width * (.66 + step * .071), y: height * (.19 + lane * .155) });
    const addIncoming = (match: VectorMatch, index: number) => {
      const { x, y } = vectorPoint(match, index, width, height);
      const lane = 0;
      particlesRef.current.push({ x, y, fromX: x, fromY: y, toX: width * .475, toY: height * .5, progress: 0, speed: .48 + seeded(index + Date.now() % 997) * .58, phase: 'in', corpus: match.corpus || 'knowledge', lane, step: 0, size: 1.6 + seeded(index + 88) * 1.5 });
    };
    const addOutgoing = (lane: number, step: number, count = 14) => {
      const sourceX = width * .51, sourceY = height * (.19 + lane * .155); const target = targetPoint(lane, Math.min(step, 3));
      for (let i = 0; i < count; i++) particlesRef.current.push({ x: sourceX, y: sourceY, fromX: sourceX, fromY: sourceY, toX: target.x, toY: target.y, progress: -seeded(i + performance.now() % 1000) * .8, speed: 1.2 + seeded(i + lane * 19) * 1.15, phase: 'out', corpus: i % 3 ? 'knowledge' : 'vault', lane, step, size: 1.3 + seeded(i + 70) * 1.2 });
    };
    let lastMatchSet: VectorMatch[] | null = null; let lastPipeStamp = '';
    const animate = (time: number) => {
      const dt = Math.min(.04, Math.max(.001, (time - (previous || time - 16)) / 1000)); previous = time; ambientTime += dt;
      ctx.clearRect(0, 0, width, height);
      // Low-opacity center routing lanes remain legible below the DOM checkpoints.
      ctx.save(); ctx.lineWidth = 1; ctx.setLineDash([3, 7]);
      for (let lane = 0; lane < 5; lane++) { const y = height * (.19 + lane * .155); ctx.beginPath(); ctx.moveTo(width * .51, y); ctx.lineTo(width * .985, y); ctx.strokeStyle = 'rgba(125,147,169,.12)'; ctx.stroke(); }
      ctx.restore();
      // Idle corpus cloud and ambient float drift.
      const count = Math.max(30, Math.min(90, matchesRef.current.length || 58));
      for (let i = 0; i < count; i++) {
        const match = matchesRef.current[i]; const point = match ? vectorPoint(match, i, width, height) : vectorPoint({ id: `ambient-${i}` }, i, width, height); const baseX = point.x, baseY = point.y;
        const corpus = match?.corpus || (i % 4 === 0 ? 'vault' : 'knowledge'); const drift = modeRef.current === 'IDLE' ? 2.4 : 1.1;
        const x = baseX + Math.sin(ambientTime * .55 + i * 2.1) * drift, y = baseY + Math.cos(ambientTime * .42 + i * 1.7) * drift;
        const alpha = .24 + (Math.sin(ambientTime * 1.2 + i) + 1) * .18;
        ctx.beginPath(); ctx.arc(x, y, 1.2 + seeded(i + 91) * 1.6, 0, Math.PI * 2); ctx.fillStyle = corpus === 'vault' ? `rgba(212,175,55,${alpha})` : `rgba(0,217,245,${alpha})`; ctx.shadowColor = corpus === 'vault' ? COLORS.vault : COLORS.knowledge; ctx.shadowBlur = 7; ctx.fill();
      }
      ctx.shadowBlur = 0;
      // React state is mirrored into refs; spawn once per update.
      if (matchesRef.current !== lastMatchSet) { matchesRef.current.forEach(addIncoming); lastMatchSet = matchesRef.current; }
      const stamp = pipelinesRef.current.map((p) => p.steps.map((s) => s.state[0]).join('')).join('|');
      if (stamp !== lastPipeStamp) {
        pipelinesRef.current.forEach((pipeline, lane) => {
          const active = pipeline.steps.findIndex((step) => step.state === 'active');
          if (active >= 0) addOutgoing(lane, active, 18);
          else if (pipeline.steps.some((step) => step.state === 'complete')) { const completed = pipeline.steps.filter((step) => step.state === 'complete').length - 1; if (completed >= 0) addOutgoing(lane, completed, 8); }
        }); lastPipeStamp = stamp;
      }
      const packets = particlesRef.current;
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i]; p.progress += dt * p.speed;
        if (p.progress >= 1) { if (p.phase === 'in' && modeRef.current === 'EXECUTING') { p.phase = 'out'; const activeLane = pipelinesRef.current.findIndex((pipeline) => pipeline.steps.some((s) => s.state === 'active')); p.lane = activeLane >= 0 ? activeLane : p.lane; p.fromX = width * .5; p.fromY = height * (.19 + p.lane * .155); const active = pipelinesRef.current[p.lane]?.steps.findIndex((s) => s.state === 'active') ?? 0; p.step = Math.max(0, active); const target = targetPoint(p.lane, p.step); p.toX = target.x; p.toY = target.y; p.progress = 0; } else { packets.splice(i, 1); continue; } }
        const t = p.progress < 0 ? 0 : p.progress; const ease = p.phase === 'in' ? 1 - Math.pow(1 - t, 2.4) : t;
        p.x = p.fromX + (p.toX - p.fromX) * ease; p.y = p.fromY + (p.toY - p.fromY) * ease;
        const color = p.corpus === 'vault' ? COLORS.vault : COLORS.knowledge;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = p.phase === 'out' ? 12 : 9; ctx.globalAlpha = p.phase === 'out' ? .85 : .95; ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;
      // Lens rings, sweep and aperture glow.
      const cx = width * .49, cy = height * .5, pulse = .5 + .5 * Math.sin(time * .002);
      const glow = ctx.createRadialGradient(cx, cy, 3, cx, cy, 68); glow.addColorStop(0, 'rgba(0,217,245,.1)'); glow.addColorStop(.55, 'rgba(0,217,245,.035)'); glow.addColorStop(1, 'rgba(0,217,245,0)');
      ctx.beginPath(); ctx.arc(cx, cy, 68, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill();
      [28, 37, 48, 58].forEach((radius, i) => { ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.strokeStyle = i === 1 ? `rgba(212,175,55,${.2 + pulse * .12})` : `rgba(0,217,245,${.15 + pulse * .13})`; ctx.lineWidth = i === 2 ? 1.2 : .7; ctx.stroke(); });
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(time * .0008); ctx.beginPath(); ctx.arc(0, 0, 53, -Math.PI * .42, Math.PI * .06); ctx.strokeStyle = 'rgba(0,217,245,.7)'; ctx.lineWidth = 2; ctx.shadowColor = COLORS.knowledge; ctx.shadowBlur = 13; ctx.stroke(); ctx.restore(); ctx.shadowBlur = 0;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  const retrievalText = useMemo(() => matches.length ? `${matches.length} MATCHES · GTE-SMALL` : 'GTE-SMALL · PGVECTOR', [matches.length]);
  return <section className={`context-pipeline ${className}`}>
    <header className="cp-header"><div className="cp-title"><span className="cp-mark">X</span><div><small>XYP3RN OS <i>/</i> CONTEXT ENGINE</small><h1>Context Dispatch <b>Pipeline</b></h1></div></div><div className="cp-header-right"><div className="cp-embedding"><i />{retrievalText}</div><div className={`cp-connection cp-connection--${connection.toLowerCase()}`}><i />HUD STREAM {connection}</div></div></header>
    <div className="cp-board" ref={stageRef}>
      <canvas ref={canvasRef} className="cp-canvas" aria-hidden="true" />
      <section className="cp-vector-panel"><div className="cp-panel-kicker"><span className="cp-panel-index">01</span> UNSTRUCTURED VECTOR CLOUD</div><div className="cp-panel-sub">SEMANTIC MATCHES <b>·</b> 1536D <b>·</b> COSINE</div><div className="cp-corpus-legend"><span><i className="cp-knowledge-dot" /> KNOWLEDGE</span><span><i className="cp-vault-dot" /> VAULT</span></div><div className="cp-vector-footer"><span>{matches.length ? String(matches.length).padStart(2, '0') : '58'} CANDIDATE VECTORS</span><b>pgvector / gte-small</b></div></section>
      <section className="cp-gateway"><div className={`cp-lens cp-lens--${mode.toLowerCase()}`}><div className="cp-lens-core"><span /><span /><span /></div><div className="cp-lens-sweep" /></div><div className="cp-gateway-caption"><b>CONTEXT ENGINE</b><span>HYBRID ROUTER</span></div><div className="cp-gateway-status"><i className={`cp-state-dot cp-state-dot--${mode.toLowerCase()}`} />{mode}</div></section>
      <section className="cp-pipeline-panel"><div className="cp-pipeline-heading"><div className="cp-panel-kicker"><span className="cp-panel-index">03</span> STRUCTURED WORKFLOW</div><div className="cp-pipeline-summary"><span><i className="cp-active-swatch" />ACTIVE</span><span><i className="cp-complete-swatch">✓</i>COMPLETE</span></div></div>
        <div className="cp-tracks">{pipelines.map((pipeline, lane) => <div className="cp-track" key={pipeline.id}>
          <div className="cp-track-label"><span>{String(lane + 1).padStart(2, '0')}</span><b>{pipeline.label}</b></div>
          <div className="cp-steps">{pipeline.steps.map((step, stepIndex) => <div className={`cp-step cp-step--${step.state}`} key={`${pipeline.id}-${step.label}`}>
            <div className="cp-step-rail"><span className="cp-step-tick">{step.state === 'complete' ? '✓' : ''}</span>{stepIndex < pipeline.steps.length - 1 && <i className="cp-step-arrow" />}</div><small>{step.label}</small>
          </div>)}</div>
        </div>)}</div>
      </section>
      <div className="cp-board-footer"><span><i className="cp-live-orb" />{lastEvent}</span><span>DISPATCHES <b>{String(dispatchCount).padStart(3, '0')}</b><i className="cp-footer-sep" />STEPS COMPLETE <b>{String(completedCount).padStart(3, '0')}</b></span></div>
    </div>
    <footer className="cp-footer"><span>RETRIEVAL → CONTEXT NORMALIZATION → AGENT EXECUTION</span><span>STREAM STATE <b>{connection}</b> <i>·</i> WORKFLOW <b>{mode}</b></span></footer>
  </section>;
}
