import { compare } from './build-graph.js';

export function seededRandom(seed = 0x58595033) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Fixed-step simulation; no wall-clock, locale, input-order or browser randomness.
 * @param {import('./graph.types.ts').GraphData} data
 * @param {number} seed
 * @returns {import('./graph.types.ts').Position[]}
 */
export function layoutGraph(data, seed = 0x58595033) {
  const random = seededRandom(seed);
  const clusters = data.nodes.filter(n => n.kind === 'cluster').sort((a, b) => compare(a.id, b.id));
  const columns = Math.ceil(Math.sqrt(clusters.length));
  const centers = new Map(clusters.map((n, i) => [n.group, {
    x: (i % columns - (columns - 1) / 2) * 650 + random() * 90,
    y: (Math.floor(i / columns) - (columns - 1) / 2) * 650 + random() * 90,
    size: Math.sqrt(data.nodes.filter(m => m.group === n.group).length),
  }]));
  const nodes = [...data.nodes].sort((a, b) => compare(a.id, b.id)).map(n => {
    const center = centers.get(n.group);
    if (!center) throw Error('Layout node has no indexed group');
    return { ...n,
      x: center.x + (random() - .5) * (n.kind === 'cluster' ? 1 : center.size * 90),
      y: center.y + (random() - .5) * (n.kind === 'cluster' ? 1 : center.size * 90), vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = [...data.edges].sort((a, b) => compare(a.id, b.id)).map(e => {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b) throw Error('Layout edge has no endpoint');
    return { a, b, length: e.kind === 'contains' ? 55 + (centers.get(a.group)?.size || 1) * 22 : 300,
      strength: e.kind === 'contains' ? .055 : .00035 };
  });
  for (let tick = 0; tick < 520; tick++) {
    const alpha = Math.pow(.986, tick);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]; let dx = a.x - b.x, dy = a.y - b.y;
        if (!dx && !dy) dx = .01;
        const d = Math.max(1, Math.hypot(dx, dy));
        const collision = Math.max(0, 64 - d) * .3;
        const repulsion = a.kind === 'cluster' && b.kind === 'cluster' ? 250000 : 1400;
        const f = Math.min(35, repulsion * alpha / (d * d) + collision);
        a.vx += dx / d * f; a.vy += dy / d * f;
        b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
    }
    for (const { a, b, length, strength } of edges) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - length) * strength * alpha;
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
    for (const n of nodes) {
      n.vx = (n.vx - n.x * .0005 * alpha) * .68;
      n.vy = (n.vy - n.y * .0005 * alpha) * .68;
      n.x += Math.max(-16, Math.min(16, n.vx)); n.y += Math.max(-16, Math.min(16, n.vy));
    }
  }
  // Explicit frozen output; rounding masks insignificant floating-point differences.
  return nodes.map(({ id, x, y }) => ({ id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }));
}
