import { buildGraph } from './build-graph.js';
import { seededRandom } from './graph-layout.js';

// Demand-rendered canvas. Source notes and workflow controls remain owned by the host viewer.
export async function createGraphView(container, { source, colors, onNote, onClear, onGroup, onDomain }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-canvas'; canvas.tabIndex = 0;
  canvas.setAttribute('role', 'group');
  canvas.setAttribute('aria-label', 'Knowledge graph. Arrow keys navigate nodes; Enter opens; R lists relationships; plus and minus zoom; zero fits. Browse nodes for a searchable list.');
  container.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('Canvas is unavailable');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let data, nodes = [], edges = [], byId = new Map(), selected = null, hover = null, highlighted = new Set();
  let width = innerWidth, height = innerHeight, camera = { x: 0, y: 0, k: 1 }, frame = 0, tween = null, pulseUntil = 0;
  let paused = false, keyboardIndex = 0, gesture = null, layoutMs = 0;
  const worker = new Worker(new URL('./graph-worker.js', import.meta.url), { type: 'module' });
  let requestId = 0;
  const pending = new Map();
  worker.onmessage = ({ data: result }) => { const task = pending.get(result.id); if (!task) return; pending.delete(result.id); clearTimeout(task.timer); result.error ? task.reject(Error(result.error)) : task.resolve(result.positions); };
  worker.onerror = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error('Graph layout worker failed. Reload or switch to Galaxy.')); } pending.clear(); };
  function settle(graph) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Graph layout timed out. Switch to Galaxy.')); }, 15000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, graph: { nodes: graph.nodes.map(({ id, kind, group }) => ({ id, kind, group })), edges: graph.edges } });
    });
  }
  const random = seededRandom(31), stars = Array.from({ length: 110 }, () => [random(), random(), random()]);
  const logo = new Image(); logo.src = '/xyp3rn-logo.png'; logo.onload = invalidate;
  const tools = document.createElement('div'); tools.className = 'graph-tools'; tools.setAttribute('aria-label', 'Graph controls');
  const zoomOut = button('−', 'Zoom out', () => zoom(.8));
  const zoomIn = button('+', 'Zoom in', () => zoom(1.25));
  const output = document.createElement('output'); output.setAttribute('aria-label', 'Zoom level');
  const fit = button('Fit', 'Fit graph', () => { onClear(); api.zoomToFit(); });
  const browse = button('Nodes', 'Browse nodes', () => { picker.hidden = !picker.hidden; browse.setAttribute('aria-expanded', String(!picker.hidden)); if (!picker.hidden) search.focus(); });
  browse.setAttribute('aria-expanded', 'false'); browse.setAttribute('aria-controls', 'graph-picker');
  const fallback = document.createElement('a'); fallback.textContent = '3D'; fallback.title = 'Switch to Galaxy fallback';
  const fallbackUrl = new URL(location.href); fallbackUrl.searchParams.set('view', 'galaxy'); fallback.href = fallbackUrl;
  tools.append(zoomOut, output, zoomIn, fit, browse, fallback); document.body.append(tools);
  const picker = document.createElement('section'); picker.id = 'graph-picker'; picker.className = 'graph-picker'; picker.hidden = true;
  picker.setAttribute('aria-label', 'Browse graph nodes');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Find a note or group'; search.setAttribute('aria-label', 'Search graph nodes');
  const list = document.createElement('ul'); picker.append(search, list); document.body.append(picker);
  const details = document.createElement('section'); details.className = 'graph-details'; details.hidden = true; details.setAttribute('aria-label', 'Relationship details'); document.body.append(details);
  const live = document.createElement('div'); live.className = 'graph-sr'; live.setAttribute('role', 'status'); document.body.append(live);
  const key = document.createElement('div'); key.className = 'graph-key';
  key.textContent = '→ contains · — related (mention / shared reference)'; document.body.append(key);
  search.addEventListener('input', renderList);
  picker.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); picker.hidden = true; browse.setAttribute('aria-expanded', 'false'); browse.focus(); } });

  function button(text, label, click) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.onclick = click; return b; }
  function renderList() {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren(...nodes.filter(n => `${n.label} ${n.paths.join(' ')}`.toLowerCase().includes(q)).map(n => {
      const li = document.createElement('li'); li.append(button(`${n.kind === 'cluster' ? 'Group: ' : ''}${n.label}`, `${n.label}, ${n.kind}, ${n.paths[0]}`, () => activate(n))); return li;
    }));
  }
  function persist() {
    const url = new URL(location.href);
    url.searchParams.set('camera', [camera.x.toFixed(2), camera.y.toFixed(2), camera.k.toFixed(4)].join(','));
    history.replaceState(null, '', url);
  }
  function state(key, value) {
    const url = new URL(location.href);
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    history.replaceState(null, '', url);
  }
  function invalidate() { if (!frame && !paused) frame = requestAnimationFrame(draw); }
  function center() {
    const side = document.querySelector('.side'), panel = document.querySelector('#panel');
    if (width <= 1180) {
      const top = (side?.getBoundingClientRect().bottom || 310) + 32;
      const bottom = (document.querySelector('.dock')?.getBoundingClientRect().top || height - 100) - 45;
      return { x: width / 2, y: (top + bottom) / 2, w: width + 30, h: Math.max(120, bottom - top) };
    }
    const left = width > 1180 ? side?.getBoundingClientRect().right || 0 : 0;
    const right = document.body.classList.contains('panel-open') ? panel.offsetWidth + 14 : 0;
    return { x: (left + width - right) / 2, y: height * .49, w: Math.max(150, width - left - right), h: Math.max(180, height - 300) };
  }
  function screen(n) { const c = center(); return { x: c.x + (n.x - camera.x) * camera.k, y: c.y + (n.y - camera.y) * camera.k }; }
  function world(x, y) { const c = center(); return { x: camera.x + (x - c.x) / camera.k, y: camera.y + (y - c.y) / camera.k }; }
  function move(target, animate = true) {
    target.k = Math.max(.06, Math.min(4, target.k));
    if (animate && !motion.matches) tween = { from: { ...camera }, to: target, start: performance.now() };
    else { camera = target; tween = null; persist(); }
    invalidate();
  }
  function zoom(factor, x = center().x, y = center().y, animate = true) {
    const p = world(x, y), k = Math.max(.06, Math.min(4, camera.k * factor)), c = center();
    move({ x: p.x - (x - c.x) / k, y: p.y - (y - c.y) / k, k }, animate);
  }
  function fitNodes(items, animate = true) {
    if (!items.length) return;
    const xs = items.map(n => n.x), ys = items.map(n => n.y), c = center();
    const minX = Math.min(...xs) - 65, maxX = Math.max(...xs) + 65, minY = Math.min(...ys) - 65, maxY = Math.max(...ys) + 65;
    move({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, k: Math.min(1.7, (c.w - 90) / (maxX - minX), c.h / (maxY - minY)) }, animate);
  }
  function neighbors(id) { const found = new Set([id]); for (const e of edges) { if (e.source === id) found.add(e.target); if (e.target === id) found.add(e.source); } return found; }
  function activate(n) {
    selected = n.id; details.hidden = true;
    if (n.kind === 'cluster') onGroup(n.group); else onNote(n.note);
    live.textContent = `${n.label}. ${n.kind}. ${neighbors(n.id).size - 1} connected entities.`;
    pulseUntil = motion.matches ? 0 : performance.now() + 450; invalidate();
  }
  function radius(n) { return n.kind === 'core' ? 22 : n.kind === 'cluster' ? 16 : 7; }
  function pick(x, y) { return [...nodes].reverse().find(n => { const p = screen(n); return Math.hypot(p.x - x, p.y - y) <= Math.max(10, radius(n) * camera.k + 4); }); }
  function pickEdge(x, y) {
    let best = null, distance = 6;
    for (const e of edges) {
      const a = screen(byId.get(e.source)), b = screen(byId.get(e.target));
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
      if (d < distance) { best = e; distance = d; }
    }
    return best;
  }
  function showEdge(e) {
    const title = document.createElement('b'); title.textContent = e.kind === 'contains' ? 'Contains →' : 'Related — undirected';
    const endpoints = document.createElement('p'); endpoints.textContent = `${byId.get(e.source).label} / ${byId.get(e.target).label}`;
    const evidence = document.createElement('p'); evidence.textContent = e.provenance;
    details.replaceChildren(title, endpoints, evidence, button('Close', 'Close relationship', () => { details.hidden = true; canvas.focus(); }));
    details.hidden = false; details.querySelector('button').focus();
  }
  function showRelationships() {
    const id = hover || selected || nodes[keyboardIndex]?.id;
    if (!id) return;
    const heading = document.createElement('b'); heading.textContent = `Relationships: ${byId.get(id).label}`;
    const items = edges.filter(e => e.source === id || e.target === id).map(e => button(
      `${e.kind}: ${byId.get(e.source).label} ${e.directed ? '→' : '—'} ${byId.get(e.target).label}`,
      `${e.kind}: ${byId.get(e.source).label} and ${byId.get(e.target).label}`, () => showEdge(e)));
    details.replaceChildren(heading, ...items, button('Close', 'Close relationships', () => { details.hidden = true; canvas.focus(); }));
    details.hidden = false; details.querySelector('button').focus();
  }
  details.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); details.hidden = true; canvas.focus(); } });
  function draw(now) {
    frame = 0;
    if (tween) {
      const t = Math.min(1, (now - tween.start) / 280), k = 1 - (1 - t) ** 3;
      for (const axis of ['x', 'y', 'k']) camera[axis] = tween.from[axis] + (tween.to[axis] - tween.from[axis]) * k;
      if (t === 1) { tween = null; persist(); }
    }
    const dpr = Math.min(devicePixelRatio || 1, 1.75); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    for (const [x, y, alpha] of stars) { ctx.fillStyle = `rgba(170,170,210,${.1 + alpha * .3})`; ctx.fillRect(x * width, y * height, 1, 1); }
    const active = hover ? neighbors(hover) : highlighted;
    // Cluster regions derive only from indexed membership; rounded convex hulls follow dragged members.
    for (const cluster of nodes.filter(n => n.kind === 'cluster')) {
      const members = nodes.filter(n => n.group === cluster.group).map(screen), points = hull(members);
      if (points.length < 3) continue;
      ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = `${colors[cluster.group]}09`; ctx.strokeStyle = `${colors[cluster.group]}22`; ctx.lineWidth = 14 * camera.k; ctx.lineJoin = 'round'; ctx.stroke(); ctx.fill();
    }
    let pulsed = 0;
    for (const e of edges) {
      const a = screen(byId.get(e.source)), b = screen(byId.get(e.target));
      const focal = hover || (selected?.startsWith('note:') && active.has(selected) ? selected : null);
      const lit = active.size && active.has(e.source) && active.has(e.target) && (!focal || e.source === focal || e.target === focal);
      ctx.strokeStyle = lit ? '#d2a44ec9' : active.size ? '#9188df10' : e.directed ? '#7f9cad55' : '#9188df32';
      ctx.lineWidth = lit ? 1.4 : .65; ctx.setLineDash(e.directed ? [3, 5] : []);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      if (e.directed && (lit || !active.size)) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x), r = radius(byId.get(e.target)) * camera.k + 4;
        const x = b.x - Math.cos(angle) * r, y = b.y - Math.sin(angle) * r;
        ctx.beginPath(); ctx.moveTo(x - Math.cos(angle - .5) * 5, y - Math.sin(angle - .5) * 5); ctx.lineTo(x, y); ctx.lineTo(x - Math.cos(angle + .5) * 5, y - Math.sin(angle + .5) * 5); ctx.stroke();
        if (lit && now < pulseUntil && !motion.matches && pulsed++ < 3) {
          const t = 1 - (pulseUntil - now) / 450; ctx.fillStyle = '#ecd49e'; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    for (const n of nodes) {
      const p = screen(n), r = radius(n) * Math.max(.6, camera.k), lit = !active.size || active.has(n.id);
      if (p.x < -100 || p.y < -50 || p.x > width + 100 || p.y > height + 50) continue;
      const color = n.kind === 'core' ? '#d2a44e' : colors[n.group];
      ctx.globalAlpha = lit ? 1 : .24; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.fillStyle = `${color}16`; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = n.kind === 'cluster' ? '#151523' : '#202034'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = n.id === selected || n.id === hover ? 2 : 1; ctx.stroke();
      if (n.kind === 'core' && logo.complete && logo.naturalWidth) ctx.drawImage(logo, p.x - r * .7, p.y - r * .7, r * 1.4, r * 1.4);
      else if (n.kind === 'cluster') { ctx.fillStyle = color; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.fillText(String(n.paths.length), p.x, p.y + 4); }
      else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill(); }
      if (n.kind !== 'note' || camera.k > 1.5 || n.id === hover || n.id === selected || active.has(n.id) && camera.k > .8) {
        ctx.font = `${n.kind === 'cluster' ? 'bold ' : ''}11px monospace`; ctx.textAlign = 'center'; ctx.fillStyle = '#dbd7e9'; ctx.fillText(n.label.slice(0, 38), p.x, p.y + r + 17);
      }
    }
    ctx.globalAlpha = 1; output.value = `${Math.round(camera.k * 100)}%`;
    if (tween || now < pulseUntil && !motion.matches) invalidate();
  }
  canvas.addEventListener('pointerdown', e => { if (e.button !== 0) return; tween = null; canvas.focus(); canvas.setPointerCapture(e.pointerId); gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, node: pick(e.clientX, e.clientY), moved: false }; });
  canvas.addEventListener('pointermove', e => {
    if (gesture && gesture.id === e.pointerId) {
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      gesture.moved ||= Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 4;
      if (gesture.moved) {
        if (gesture.node) { gesture.node.x += dx / camera.k; gesture.node.y += dy / camera.k; }
        else { camera.x -= dx / camera.k; camera.y -= dy / camera.k; }
      }
      gesture.x = e.clientX; gesture.y = e.clientY; invalidate();
    } else {
      const n = pick(e.clientX, e.clientY), id = n?.id || null;
      if (id !== hover) { hover = id; canvas.title = n ? `${n.label} · ${n.paths[0]}` : ''; canvas.style.cursor = n ? 'pointer' : 'grab'; invalidate(); }
    }
  });
  canvas.addEventListener('pointerleave', () => { if (!gesture) { hover = null; invalidate(); } });
  canvas.addEventListener('pointerup', e => {
    if (!gesture || gesture.id !== e.pointerId) return;
    const g = gesture; gesture = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!g.moved) { if (g.node) activate(g.node); else { const edge = pickEdge(e.clientX, e.clientY); if (edge) showEdge(edge); else onClear(); } }
    persist();
  });
  canvas.addEventListener('pointercancel', () => { gesture = null; persist(); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(-e.deltaY * .0015), e.clientX, e.clientY, false); }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); keyboardIndex = e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : (keyboardIndex + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + nodes.length) % nodes.length;
      const n = nodes[keyboardIndex]; if (!n) return; hover = n.id; fitNodes([n]); live.textContent = `${n.label}, ${n.kind}, ${n.paths[0]}`; invalidate();
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (nodes[keyboardIndex]) activate(nodes[keyboardIndex]); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.25); }
    else if (e.key === '-') { e.preventDefault(); zoom(.8); }
    else if (e.key === '0') { e.preventDefault(); onClear(); api.zoomToFit(); }
    else if (e.key === 'Escape') { details.hidden = true; hover = null; onClear(); }
    else if (e.key.toLowerCase() === 'r') { e.preventDefault(); showRelationships(); }
    else if (e.key === '/') { e.preventDefault(); picker.hidden = false; browse.setAttribute('aria-expanded', 'true'); search.focus(); }
  });
  motion.addEventListener('change', () => { if (tween) { camera = tween.to; tween = null; } pulseUntil = 0; invalidate(); });
  const api = {
    async graphData(value) {
      if (!value) return data;
      source = value;
      const notesById = new Map(source.nodes.map(n => [n.id, n]));
      // The original viewer expects object endpoints for note highlighting.
      for (const e of source.links) { if (typeof e.source !== 'object') e.source = notesById.get(e.source); if (typeof e.target !== 'object') e.target = notesById.get(e.target); }
      const next = buildGraph(source), generation = requestId + 1;
      const t0 = performance.now(); const positions = await settle(next); layoutMs = performance.now() - t0;
      if (generation !== requestId) return api;
      data = next;
      const previous = byId; nodes = data.nodes.map((n, i) => ({ ...n, ...positions[i], ...(previous.has(n.id) ? { x: previous.get(n.id).x, y: previous.get(n.id).y } : {}) }));
      edges = data.edges; byId = new Map(nodes.map(n => [n.id, n])); renderList(); invalidate(); return api;
    },
    highlight(noteSet) { highlighted = new Set([...noteSet].map(n => `note:${n.path}`)); for (const n of nodes) if (n.kind === 'cluster' && nodes.some(m => m.group === n.group && highlighted.has(m.id))) highlighted.add(n.id); invalidate(); },
    focusNote(note) { selected = `note:${note.path}`; state('note', note.path); state('group', null); state('domain', null); const related = neighbors(selected); fitNodes(nodes.filter(n => related.has(n.id))); },
    filterGroup(group) { state('group', group); state('note', null); state('domain', null); selected = `group:${group}`; highlighted = neighbors(selected); fitNodes(nodes.filter(n => n.group === group)); invalidate(); },
    filterDomain(domain) { selected = null; state('domain', domain); state('note', null); state('group', null); },
    clearSelection() { selected = null; hover = null; highlighted.clear(); details.hidden = true; for (const k of ['note', 'group', 'domain']) state(k, null); invalidate(); },
    zoomToFit(_ms, _pad, predicate) { fitNodes(predicate ? nodes.filter(n => n.note && predicate(n.note)) : nodes); return api; },
    resize() { width = innerWidth; height = innerHeight; const dpr = Math.min(devicePixelRatio || 1, 1.75); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); invalidate(); },
    pauseAnimation() { paused = true; cancelAnimationFrame(frame); frame = 0; },
    resumeAnimation() { paused = false; invalidate(); },
    restore() {
      const params = new URLSearchParams(location.search), cameraValue = params.get('camera');
      const n = nodes.find(n => n.note?.path === params.get('note'));
      if (n) activate(n); else if (params.get('group') && byId.has(`group:${params.get('group')}`)) onGroup(params.get('group'));
      else if (params.get('domain') && nodes.some(n => n.note?.domain === params.get('domain'))) onDomain(params.get('domain'));
      else fitNodes(nodes, false);
      const values = cameraValue?.split(',').map(Number);
      if (values?.length === 3 && values.every(Number.isFinite) && Math.abs(values[0]) < 1e6 && Math.abs(values[1]) < 1e6 && values[2] >= .06 && values[2] <= 4) move({ x: values[0], y: values[1], k: values[2] }, false);
    },
    inspect() { return { nodes: nodes.map(n => ({ id: n.id, kind: n.kind, x: n.x, y: n.y, screen: screen(n) })), edges, camera: { ...camera }, viewport: center(), selected, hover, highlighted: [...(hover ? neighbors(hover) : highlighted)], layoutMs, animating: !!frame, reducedMotion: motion.matches }; },
  };
  await api.graphData(source); api.resize();
  return api;
}

function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 2) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = input => { const h = []; for (const v of input) { while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], v) <= 0) h.pop(); h.push(v); } return h; };
  const lo = half(p), hi = half(p.reverse()); lo.pop(); hi.pop(); return [...lo, ...hi];
}
