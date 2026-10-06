import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './KnowledgeGraphExplorer.css';

export type KnowledgeGroup = 'AGENTS' | 'HANDOFFS' | 'ARTIST-OS' | 'DOCS' | 'SKILLS' | 'SPECS' | 'SONGS' | 'RESEARCH';
export type KnowledgeNode = {
  id: string;
  label: string;
  group: KnowledgeGroup;
  markdown?: string;
  frontmatter?: string | Record<string, unknown>;
  dbPrimaryKey?: string;
  path?: string;
  metadata?: Record<string, unknown>;
};
export type KnowledgeLink = { source: string; target: string; type?: string; relation?: string; label?: string };
export type KnowledgeGraphData = { nodes: KnowledgeNode[]; links: KnowledgeLink[] };

type Props = { graphEndpoint?: string; streamEndpoint?: string; className?: string; modelTier?: string };
type RuntimeNode = KnowledgeNode & { x: number; y: number; vx: number; vy: number; tx: number; ty: number; radius: number; bornAt?: number };
type RuntimeLink = { source: number; target: number; semantic: boolean };
type DragState = { kind: 'node' | 'pan'; pointerId: number; startX: number; startY: number; lastX: number; lastY: number; node?: RuntimeNode; moved: boolean };

const GROUPS: KnowledgeGroup[] = ['AGENTS', 'HANDOFFS', 'ARTIST-OS', 'DOCS', 'SKILLS', 'SPECS', 'SONGS', 'RESEARCH'];
const COLORS: Record<KnowledgeGroup, string> = {
  AGENTS: '#D4AF37', HANDOFFS: '#00D9F5', 'ARTIST-OS': '#E752C2', DOCS: '#E8EDF4',
  SKILLS: '#A855F7', SPECS: '#F04F5E', SONGS: '#458CFF', RESEARCH: '#F28C38',
};
const GROUP_CENTERS: Record<KnowledgeGroup, [number, number]> = {
  AGENTS: [-330, -250], HANDOFFS: [0, -410], 'ARTIST-OS': [340, -230], DOCS: [420, 120],
  SKILLS: [185, 390], SPECS: [-205, 390], SONGS: [-430, 90], RESEARCH: [-40, 40],
};
const GROUP_SYNONYMS: Record<string, KnowledgeGroup> = {
  AGENT: 'AGENTS', AGENTS: 'AGENTS', HANDOFF: 'HANDOFFS', HANDOFFS: 'HANDOFFS',
  ARTIST_OS: 'ARTIST-OS', 'ARTIST OS': 'ARTIST-OS', 'ARTIST-OS': 'ARTIST-OS',
  DOCUMENT: 'DOCS', DOCUMENTS: 'DOCS', DOC: 'DOCS', DOCS: 'DOCS',
  SKILL: 'SKILLS', SKILLS: 'SKILLS', SPEC: 'SPECS', SPECS: 'SPECS',
  SONG: 'SONGS', SONGS: 'SONGS', RESEARCH: 'RESEARCH',
};

function groupOf(value: unknown): KnowledgeGroup {
  const key = String(value || 'DOCS').trim().toUpperCase().replace(/[\s_]+/g, (m) => m.includes('_') ? '_' : ' ');
  return GROUP_SYNONYMS[key] || 'DOCS';
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function normalizeNode(raw: unknown): KnowledgeNode | null {
  const n = record(raw); const id = String(n.id ?? n.node_id ?? n.key ?? '');
  if (!id) return null;
  const meta = record(n.metadata ?? n.data);
  return {
    ...n, id, label: String(n.label ?? n.title ?? n.name ?? id),
    group: groupOf(n.group ?? n.category ?? n.domain ?? n.type ?? meta.group),
    markdown: typeof (n.markdown ?? n.content ?? n.body) === 'string' ? String(n.markdown ?? n.content ?? n.body) : undefined,
    frontmatter: (n.frontmatter ?? meta.frontmatter) as KnowledgeNode['frontmatter'],
    dbPrimaryKey: String(n.dbPrimaryKey ?? n.db_primary_key ?? n.primaryKey ?? n.primary_key ?? meta.dbPrimaryKey ?? meta.primary_key ?? ''),
    path: String(n.path ?? n.file_path ?? meta.path ?? ''), metadata: meta,
  };
}
function normalizeLink(raw: unknown): KnowledgeLink | null {
  const l = record(raw); const source = typeof l.source === 'object' ? record(l.source).id : l.source;
  const target = typeof l.target === 'object' ? record(l.target).id : l.target;
  if (source == null || target == null) return null;
  return { source: String(source), target: String(target), type: String(l.type ?? l.kind ?? l.relation ?? 'contains'), relation: String(l.relation ?? l.type ?? l.kind ?? 'contains'), label: String(l.label ?? '') };
}
function normalizeGraph(raw: unknown): KnowledgeGraphData {
  const body = record(raw); const nodes = Array.isArray(body.nodes) ? body.nodes.map(normalizeNode).filter((n): n is KnowledgeNode => !!n) : [];
  const links = Array.isArray(body.links) ? body.links.map(normalizeLink).filter((l): l is KnowledgeLink => !!l) : [];
  return { nodes, links };
}
function isSemantic(link: KnowledgeLink) {
  const relation = `${link.type || ''} ${link.relation || ''} ${link.label || ''}`.toLowerCase();
  return /related|semantic|shared[_ -]?reference|reference|cross/.test(relation) && !/contains/.test(relation);
}
function hash(value: string) { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return h >>> 0; }
function initialPosition(node: KnowledgeNode, ordinal: number): [number, number] {
  const [cx, cy] = GROUP_CENTERS[node.group]; const h = hash(node.id); const angle = (ordinal * 2.399963229728653 + (h % 1000) / 1000 * Math.PI * 2);
  const radius = 28 + Math.sqrt(ordinal + 1) * 11 + (h % 27);
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
}
function parseSse(data: string) { try { return JSON.parse(data); } catch { return null; } }
function fuzzyMatch(query: string, text: string) {
  const q = query.toLowerCase().trim(); if (!q) return true;
  const t = text.toLowerCase(); if (t.includes(q)) return true;
  let qi = 0; for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++;
  return qi === q.length;
}
function yamlText(frontmatter: KnowledgeNode['frontmatter']) {
  if (typeof frontmatter === 'string') return frontmatter;
  if (!frontmatter) return '---\n# No frontmatter provided\n---';
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`).join('\n')}\n---`;
}

export default function KnowledgeGraphExplorer({ graphEndpoint = '/api/v1/knowledge/graph', streamEndpoint = '/api/v1/hud/stream', className = '', modelTier = 'BRAIN OPUS 5.5' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<RuntimeNode[]>([]);
  const linksRef = useRef<RuntimeLink[]>([]);
  const topologyRef = useRef<KnowledgeGraphData>({ nodes: [], links: [] });
  const viewRef = useRef({ width: 1, height: 1, dpr: 1, zoom: 0.72, panX: 0, panY: 0 });
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number>(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [topology, setTopology] = useState<KnowledgeGraphData>({ nodes: [], links: [] });
  const [visibleGroups, setVisibleGroups] = useState<Record<KnowledgeGroup, boolean>>(() => Object.fromEntries(GROUPS.map((g) => [g, true])) as Record<KnowledgeGroup, boolean>);
  const [queries, setQueries] = useState<Record<KnowledgeGroup, string>>(() => Object.fromEntries(GROUPS.map((g) => [g, ''])) as Record<KnowledgeGroup, string>);
  const [globalQuery, setGlobalQuery] = useState('');
  const [expandedGroup, setExpandedGroup] = useState<KnowledgeGroup | null>(null);
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
  const [hovered, setHovered] = useState<KnowledgeNode | null>(null);
  const [status, setStatus] = useState<'IDLE' | 'RUNNING'>('IDLE');
  const [graphReady, setGraphReady] = useState(false);
  const [consoleText, setConsoleText] = useState('');
  const [streamState, setStreamState] = useState<'CONNECTING' | 'LIVE' | 'OFFLINE'>('CONNECTING');
  const [micActive, setMicActive] = useState(false);
  const globalSearchRef = useRef<HTMLInputElement>(null);
  const hoveredRef = useRef<KnowledgeNode | null>(null);
  const selectedNodeRef = useRef<KnowledgeNode | null>(null);
  const speechRef = useRef<{ stop?: () => void; start?: () => void } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(graphEndpoint, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then((response) => { if (!response.ok) throw new Error(`Graph request failed: ${response.status}`); return response.json(); })
      .then((json) => { const normalized = normalizeGraph(json); topologyRef.current = normalized; setTopology(normalized); setGraphReady(true); })
      .catch((error: unknown) => { if ((error as { name?: string })?.name !== 'AbortError') { setGraphReady(true); } });
    return () => controller.abort();
  }, [graphEndpoint]);

  useEffect(() => {
    if (!graphReady || typeof EventSource === 'undefined') return;
    const source = new EventSource(streamEndpoint);
    source.onopen = () => setStreamState('LIVE'); source.onerror = () => setStreamState('OFFLINE');
    const addNode = (payload: unknown) => {
      const body = record(payload); const node = normalizeNode(body.node ?? body.payload ?? body.data ?? body);
      if (!node) return;
      topologyRef.current = { ...topologyRef.current, nodes: [...topologyRef.current.nodes.filter((n) => n.id !== node.id), node] };
      setTopology(topologyRef.current);
    };
    const addLink = (payload: unknown) => {
      const body = record(payload); const link = normalizeLink(body.link ?? body.payload ?? body.data ?? body);
      if (!link) return;
      topologyRef.current = { ...topologyRef.current, links: [...topologyRef.current.links, link] };
      setTopology(topologyRef.current);
    };
    const runUpdate = (payload: unknown) => {
      const outer = record(payload); const body = record(outer.payload ?? outer.data ?? outer); const run = String(body.status ?? body.state ?? body.event ?? outer.status ?? outer.state ?? '').toLowerCase();
      setStatus(/running|started|active/.test(run) ? 'RUNNING' : 'IDLE');
      if (body.node) addNode(body.node);
    };
    const listeners: Array<[string, (e: Event) => void]> = [
      ['NODE_CREATED', (e) => addNode(parseSse((e as MessageEvent).data))],
      ['LINK_ADDED', (e) => addLink(parseSse((e as MessageEvent).data))],
      ['AGENT_RUN_UPDATE', (e) => runUpdate(parseSse((e as MessageEvent).data))],
    ];
    listeners.forEach(([name, listener]) => source.addEventListener(name, listener));
    source.onmessage = (event) => {
      const payload = parseSse(event.data); const body = record(payload); const name = String(body.type ?? body.event ?? '').toUpperCase();
      if (name === 'NODE_CREATED') addNode(body.node ?? body); else if (name === 'LINK_ADDED') addLink(body.link ?? body); else if (name === 'AGENT_RUN_UPDATE') runUpdate(body);
    };
    return () => { listeners.forEach(([name, listener]) => source.removeEventListener(name, listener)); source.close(); };
  }, [graphReady, streamEndpoint]);

  useEffect(() => {
    const previous = new Map(runtimeRef.current.map((n) => [n.id, n]));
    const counts: Record<KnowledgeGroup, number> = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<KnowledgeGroup, number>;
    const runtime = topology.nodes.map((node) => {
      const old = previous.get(node.id); const ordinal = counts[node.group]++;
      if (old) { Object.assign(old, node); return old; }
      const [x, y] = initialPosition(node, ordinal);
      return { ...node, x, y, vx: 0, vy: 0, ...(() => { const [tx, ty] = GROUP_CENTERS[node.group]; return { tx, ty }; })(), radius: node.group === 'AGENTS' ? 5.4 : 4.1, bornAt: performance.now() };
    });
    const index = new Map(runtime.map((node, i) => [node.id, i]));
    runtimeRef.current = runtime;
    linksRef.current = topology.links.map((link) => ({ source: index.get(link.source) ?? -1, target: index.get(link.target) ?? -1, semantic: isSemantic(link) })).filter((link) => link.source >= 0 && link.target >= 0);
    topologyRef.current = topology;
  }, [topology]);

  const visibility = useMemo(() => {
    const visible = new Set<string>(); const groupCounts = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<KnowledgeGroup, number>;
    topology.nodes.forEach((node) => { const text = `${node.label} ${node.id} ${node.path || ''}`; if (visibleGroups[node.group] && fuzzyMatch(globalQuery, text) && fuzzyMatch(queries[node.group], text)) { visible.add(node.id); groupCounts[node.group]++; } });
    return { visible, groupCounts };
  }, [topology.nodes, visibleGroups, queries, globalQuery]);
  const visibleRef = useRef(visibility.visible); useEffect(() => { visibleRef.current = visibility.visible; }, [visibility]);
  useEffect(() => { hoveredRef.current = hovered; }, [hovered]);
  useEffect(() => { selectedNodeRef.current = selectedNode; }, [selectedNode]);

  const findNodeAt = useCallback((screenX: number, screenY: number) => {
    const view = viewRef.current; const worldX = (screenX - view.width / 2 - view.panX) / view.zoom; const worldY = (screenY - view.height / 2 - view.panY) / view.zoom;
    let nearest: RuntimeNode | null = null, best = 15 / view.zoom;
    for (const node of runtimeRef.current) {
      if (!visibleRef.current.has(node.id)) continue;
      const d = Math.hypot(node.x - worldX, node.y - worldY);
      if (d < Math.max(best, node.radius + 4)) { best = d; nearest = node; }
    }
    return nearest;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; const shell = shellRef.current; if (!canvas || !shell) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }); if (!ctx) return;
    let lastPhysics = 0;
    const resize = () => {
      const rect = shell.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
      viewRef.current.width = rect.width; viewRef.current.height = rect.height; viewRef.current.dpr = dpr;
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    };
    const observer = new ResizeObserver(resize); observer.observe(shell); resize();
    const tickPhysics = (dt: number) => {
      const nodes = runtimeRef.current; const links = linksRef.current; if (!nodes.length) return;
      const gridSize = 92; const cells = new Map<string, number[]>();
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; const key = `${Math.floor(n.x / gridSize)}:${Math.floor(n.y / gridSize)}`; const cell = cells.get(key); if (cell) cell.push(i); else cells.set(key, [i]); }
      const fx = new Float32Array(nodes.length), fy = new Float32Array(nodes.length);
      for (const link of links) {
        const a = nodes[link.source], b = nodes[link.target], dx = b.x - a.x, dy = b.y - a.y; const dist = Math.max(1, Math.hypot(dx, dy));
        const rest = link.semantic ? 142 : 94; const strength = link.semantic ? 0.0028 : 0.006;
        const f = (dist - rest) * strength; fx[link.source] += dx / dist * f; fy[link.source] += dy / dist * f; fx[link.target] -= dx / dist * f; fy[link.target] -= dy / dist * f;
      }
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]; const cx = Math.floor(a.x / gridSize), cy = Math.floor(a.y / gridSize);
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = cells.get(`${gx}:${gy}`); if (!bucket) continue;
          for (const j of bucket) { if (j <= i) continue; const b = nodes[j]; const dx = b.x - a.x, dy = b.y - a.y; const d2 = dx * dx + dy * dy; if (d2 < 1 || d2 > 88 * 88) continue; const d = Math.sqrt(d2); const f = (88 - d) / d * 0.055; fx[i] -= dx * f; fy[i] -= dy * f; fx[j] += dx * f; fy[j] += dy * f; }
        }
      }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]; const drag = dragRef.current?.node === n;
        const homeX = n.tx - n.x, homeY = n.ty - n.y; fx[i] += homeX * 0.0014; fy[i] += homeY * 0.0014;
        if (!drag) { n.vx = (n.vx + fx[i]) * 0.88; n.vy = (n.vy + fy[i]) * 0.88; n.x += n.vx * dt * 60; n.y += n.vy * dt * 60; }
      }
    };
    const draw = (time: number) => {
      const view = viewRef.current, dpr = view.dpr, w = view.width, h = view.height;
      const elapsed = Math.min(0.05, Math.max(0.001, (time - (lastPhysics || time - 16)) / 1000));
      if (time - lastPhysics > 16) { tickPhysics(elapsed); lastPhysics = time; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#070B12'; ctx.fillRect(0, 0, w, h);
      const gradient = ctx.createRadialGradient(w * .53, h * .48, 12, w * .53, h * .48, Math.max(w, h) * .72); gradient.addColorStop(0, '#111827'); gradient.addColorStop(.56, '#0A101A'); gradient.addColorStop(1, '#070B12'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.translate(w / 2 + view.panX, h / 2 + view.panY); ctx.scale(view.zoom, view.zoom);
      // Quiet coordinate speckle, transformed with the graph.
      ctx.fillStyle = 'rgba(148,163,184,.16)'; for (let x = -1400; x < 1400; x += 120) for (let y = -1400; y < 1400; y += 120) { const s = (hash(`${x}/${y}`) % 10) / 10; if (s > .7) { ctx.beginPath(); ctx.arc(x, y, .8, 0, Math.PI * 2); ctx.fill(); } }
      const visible = visibleRef.current; const nodes = runtimeRef.current;
      for (const link of linksRef.current) {
        const a = nodes[link.source], b = nodes[link.target]; if (!visible.has(a.id) || !visible.has(b.id)) continue;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        if (link.semantic) { ctx.setLineDash([4 / view.zoom, 7 / view.zoom]); ctx.strokeStyle = 'rgba(0,217,245,.35)'; ctx.lineWidth = .9 / view.zoom; ctx.shadowColor = '#00D9F5'; ctx.shadowBlur = 5 / view.zoom; }
        else { ctx.setLineDash([]); ctx.strokeStyle = 'rgba(143,161,182,.19)'; ctx.lineWidth = .72 / view.zoom; ctx.shadowBlur = 0; }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.shadowBlur = 0;
      const showLabels = view.zoom > .68;
      for (const node of nodes) {
        if (!visible.has(node.id)) continue;
        const color = COLORS[node.group]; const age = node.bornAt ? Math.min(1, (time - node.bornAt) / 650) : 1;
        ctx.globalAlpha = age; ctx.beginPath(); ctx.arc(node.x, node.y, node.radius * (node.bornAt ? .7 + .3 * age : 1), 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = node === hovered ? 16 : 8; ctx.fill(); ctx.shadowBlur = 0;
        const isHovered = node === hoveredRef.current, isSelected = node === selectedNodeRef.current;
        if (isHovered || isSelected) { ctx.beginPath(); ctx.arc(node.x, node.y, node.radius + 4 / view.zoom, 0, Math.PI * 2); ctx.strokeStyle = `${color}99`; ctx.lineWidth = 1 / view.zoom; ctx.stroke(); }
        if (showLabels || isHovered || isSelected) { ctx.font = `${(isHovered ? 11 : 9) / view.zoom}px Inter, system-ui, sans-serif`; ctx.textBaseline = 'middle'; ctx.fillStyle = isHovered ? '#F8FAFC' : 'rgba(214,224,236,.73)'; ctx.fillText(node.label.slice(0, 56), node.x + node.radius + 5 / view.zoom, node.y); }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); observer.disconnect(); };
  }, []);

  const canvasCoords = (event: React.MouseEvent<HTMLCanvasElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top] as const; };
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = canvasCoords(event); const node = findNodeAt(x, y); event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: node ? 'node' : 'pan', pointerId: event.pointerId, startX: x, startY: y, lastX: x, lastY: y, node: node || undefined, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = canvasCoords(event); pointerRef.current = { x, y }; const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = x - drag.lastX, dy = y - drag.lastY; if (Math.abs(x - drag.startX) + Math.abs(y - drag.startY) > 3) drag.moved = true;
      if (drag.kind === 'pan') { const v = viewRef.current; v.panX += dx; v.panY += dy; const limit = Math.max(v.width, v.height) * 3; v.panX = Math.max(-limit, Math.min(limit, v.panX)); v.panY = Math.max(-limit, Math.min(limit, v.panY)); }
      else if (drag.node) {
        const v = viewRef.current; const worldX = (x - v.width / 2 - v.panX) / v.zoom, worldY = (y - v.height / 2 - v.panY) / v.zoom;
        const dxWorld = worldX - drag.node.x, dyWorld = worldY - drag.node.y;
        for (const member of runtimeRef.current) if (member.group === drag.node.group && member !== drag.node) { member.x += dxWorld; member.y += dyWorld; member.tx += dxWorld; member.ty += dyWorld; }
        drag.node.x = worldX; drag.node.y = worldY; drag.node.tx += dxWorld; drag.node.ty += dyWorld; drag.node.vx = 0; drag.node.vy = 0;
      }
      drag.lastX = x; drag.lastY = y;
    } else {
      const node = findNodeAt(x, y); setHovered(node);
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; if (drag && drag.pointerId === event.pointerId) {
      if (drag.kind === 'node' && drag.node && !drag.moved) { setSelectedNode(drag.node); setHovered(null); }
      dragRef.current = null;
    }
  };
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault(); const [x, y] = canvasCoords(event); const view = viewRef.current; const old = view.zoom;
    const next = Math.max(.12, Math.min(3.8, old * Math.exp(-event.deltaY * .0012)));
    const wx = (x - view.width / 2 - view.panX) / old, wy = (y - view.height / 2 - view.panY) / old;
    view.zoom = next; view.panX = x - view.width / 2 - wx * next; view.panY = y - view.height / 2 - wy * next;
  };

  const executeCommand = () => {
    const query = consoleText.trim(); if (!query) return;
    const node = topology.nodes.find((n) => fuzzyMatch(query, `${n.label} ${n.id} ${n.path || ''}`));
    if (node) { setSelectedNode(node); setVisibleGroups((prev) => ({ ...prev, [node.group]: true })); setQueries((prev) => ({ ...prev, [node.group]: '' })); }
    else window.dispatchEvent(new CustomEvent('xyp3rn:knowledge-command', { detail: { prompt: query } }));
  };
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); globalSearchRef.current?.focus(); } };
    window.addEventListener('keydown', onShortcut); return () => window.removeEventListener('keydown', onShortcut);
  }, []);
  const toggleMic = () => {
    const SpeechRecognitionCtor = (window as unknown as { SpeechRecognition?: new () => { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null } }).SpeechRecognition;
    if (micActive) { speechRef.current?.stop?.(); setMicActive(false); return; }
    if (!SpeechRecognitionCtor) { window.dispatchEvent(new CustomEvent('xyp3rn:dictation-request', { detail: { target: 'knowledge-command' } })); return; }
    const recognition = new SpeechRecognitionCtor(); recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true;
    recognition.onresult = (e) => { const text = e.results[e.results.length - 1]?.[0]?.transcript; if (text) setConsoleText(text); };
    recognition.onend = () => setMicActive(false); speechRef.current = recognition; setMicActive(true); recognition.start();
  };

  const activeGroupCount = GROUPS.filter((group) => visibility.groupCounts[group] > 0).length;
  const visibleLinks = topology.links.filter((link) => visibility.visible.has(link.source) && visibility.visible.has(link.target)).length;
  const selectedFrontmatter = selectedNode ? yamlText(selectedNode.frontmatter) : '';
  const selectedMarkdown = selectedNode?.markdown ?? String(selectedNode?.metadata?.rawMarkdown ?? selectedNode?.metadata?.content ?? '# No raw markdown available for this note.');

  return <div ref={shellRef} className={`kg-explorer ${className}`}>
    <div className="kg-topbar">
      <div className="kg-brand"><span className="kg-brand-mark">X</span><div><b>KNOWLEDGE GRAPH</b><small>XYP3RN OS <i>/</i> CONTEXT ENGINE</small></div></div>
      <div className="kg-metrics"><div><small>TOTAL NOTES</small><b>{topology.nodes.length.toLocaleString()}</b></div><div><small>TOTAL LINKS</small><b>{topology.links.length.toLocaleString()}</b></div><div><small>ACTIVE GROUPS</small><b>{activeGroupCount}<em> / 08</em></b></div><div className="kg-model"><small>MODEL TIER</small><b>{modelTier}</b></div><div className={`kg-system kg-system--${status.toLowerCase()}`}><i />{status}</div></div>
    </div>
    <aside className="kg-workbench">
      <div className="kg-workbench-head"><div><small>FILTER WORKBENCH</small><b>Note Groups <span>{topology.nodes.length.toLocaleString()}</span></b></div><button onClick={() => { setVisibleGroups(Object.fromEntries(GROUPS.map((g) => [g, true])) as Record<KnowledgeGroup, boolean>); setQueries(Object.fromEntries(GROUPS.map((g) => [g, ''])) as Record<KnowledgeGroup, string>); setGlobalQuery(''); }} title="Reset filters">↺</button></div>
      <label className="kg-global-search"><span>⌕</span><input ref={globalSearchRef} aria-label="Search all notes" placeholder="Find a note or ID" value={globalQuery} onChange={(e) => setGlobalQuery(e.target.value)} /><kbd>⌘ K</kbd></label>
      <div className="kg-groups">
        {GROUPS.map((group) => {
          const count = topology.nodes.filter((node) => node.group === group).length;
          const filteredCount = visibility.groupCounts[group]; const isExpanded = expandedGroup === group;
          return <div className={`kg-group ${!visibleGroups[group] ? 'is-muted' : ''} ${isExpanded ? 'is-expanded' : ''}`} key={group}>
            <div className="kg-group-row">
              <button className="kg-group-check" aria-label={`${visibleGroups[group] ? 'Hide' : 'Show'} ${group}`} aria-pressed={visibleGroups[group]} onClick={() => setVisibleGroups((prev) => ({ ...prev, [group]: !prev[group] }))}><span style={{ '--group-color': COLORS[group] } as React.CSSProperties} /></button>
              <button className="kg-group-title" onClick={() => setExpandedGroup(isExpanded ? null : group)}><i style={{ background: COLORS[group], boxShadow: `0 0 10px ${COLORS[group]}55` }} />{group}<b>{String(count).padStart(2, '0')}</b></button>
              <button className="kg-group-expand" aria-label={`Filter ${group}`} onClick={() => setExpandedGroup(isExpanded ? null : group)}>{isExpanded ? '−' : '+'}</button>
            </div>
            {isExpanded && <div className="kg-group-detail"><input value={queries[group]} placeholder={`Filter ${group.toLowerCase()}…`} onChange={(e) => setQueries((prev) => ({ ...prev, [group]: e.target.value }))} /><small>{filteredCount} MATCHES</small></div>}
          </div>;
        })}
      </div>
      <div className="kg-workbench-foot"><i className={`kg-stream-dot kg-stream-dot--${streamState.toLowerCase()}`} />HUD STREAM <b>{streamState}</b></div>
    </aside>
    <main className="kg-graph-stage" aria-label="Interactive knowledge graph">
      <canvas ref={canvasRef} className="kg-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={() => { if (!dragRef.current) setHovered(null); }} onWheel={onWheel} />
      <div className="kg-map-hud"><span><i className="kg-dot-parent" />CONTAINS</span><span><i className="kg-dot-related" />RELATED / SHARED REFERENCE</span><span className="kg-map-hint">SCROLL TO ZOOM <b>·</b> DRAG TO PAN</span></div>
      {hovered && <div className="kg-hover-card"><i style={{ background: COLORS[hovered.group] }} />{hovered.group}<b>{hovered.label}</b><small>{hovered.id}</small></div>}
    </main>
    {selectedNode && <div className="kg-preview-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedNode(null); }}>
      <section className="kg-preview" aria-label={`Preview ${selectedNode.label}`}>
        <header><div><small>NOTE PREVIEW <i>/</i> {selectedNode.group}</small><h2>{selectedNode.label}</h2><span>{selectedNode.path || selectedNode.id}</span></div><button onClick={() => setSelectedNode(null)} aria-label="Close note preview">×</button></header>
        <div className="kg-primary-key"><small>DATABASE PRIMARY KEY</small><code>{selectedNode.dbPrimaryKey || selectedNode.id}</code></div>
        <div className="kg-preview-section"><div><small>FRONTMATTER · YAML</small><button onClick={() => navigator.clipboard?.writeText(selectedFrontmatter)}>COPY</button></div><pre>{selectedFrontmatter}</pre></div>
        <div className="kg-preview-section kg-preview-markdown"><div><small>RAW MARKDOWN</small><button onClick={() => navigator.clipboard?.writeText(selectedMarkdown)}>COPY</button></div><pre>{selectedMarkdown}</pre></div>
      </section>
    </div>}
    <div className="kg-console-wrap"><div className="kg-console">
      <button className={`kg-mic ${micActive ? 'is-active' : ''}`} onClick={toggleMic} aria-label={micActive ? 'Stop voice input' : 'Start Wispr dictation'} title="Wispr dictation"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8"/></svg></button>
      <input value={consoleText} onChange={(e) => setConsoleText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') executeCommand(); }} placeholder="Ask your notes, start a run, or say ‘remember that…’" aria-label="Ask your knowledge graph" />
      <span className="kg-console-shortcut">↵</span><button className="kg-execute" onClick={executeCommand} aria-label="Execute command"><svg viewBox="0 0 24 24"><path d="M4 12h15m-6-6 6 6-6 6"/></svg></button>
    </div><div className="kg-console-caption"><span><i className="kg-caption-dot"/> KNOWLEDGE ENGINE READY</span><span>DICTATE WITH WISPR <b>·</b> ENTER TO RUN</span></div></div>
  </div>;
}
