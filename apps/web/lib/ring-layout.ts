/**
 * The agent ring's geometry (pure; ring-layout.test.ts). Nodes sit on one ellipse around the core, or on two when
 * there are many, in the 680 x 480 canvas the ring is drawn in. The drawing component only places what this returns.
 */

export const VIEW = { w: 680, h: 480, cx: 340, cy: 240 } as const;
/** No node nearer the core than this: the core's glow and rings live inside it. */
export const MIN_R = 128;

export type RingNode = { readonly id: string; readonly label: string; readonly color: string; readonly live: boolean; readonly r?: number };
export type Placed = RingNode & { readonly x: number; readonly y: number; readonly bend: number; readonly r: number };

const ONE = { rx: 250, ry: 178 };
const INNER = { rx: 160, ry: 132 };
const OUTER = { rx: 225, ry: 190 };
/** Up to this many nodes share one ring; more go onto two. */
const SINGLE_MAX = 10;

const onEllipse = (count: number, e: { rx: number; ry: number }, startDeg: number) =>
  Array.from({ length: count }, (_, i) => {
    const a = ((startDeg + (360 / count) * i) * Math.PI) / 180;
    return { x: VIEW.cx + e.rx * Math.cos(a), y: VIEW.cy + e.ry * Math.sin(a) };
  });

/** Places every node. Order is kept: the first node sits at the top of the outer ring, the rest follow clockwise. */
export const layoutRing = (nodes: readonly RingNode[]): Placed[] => {
  const n = nodes.length;
  if (n === 0) return [];
  const inner = n <= SINGLE_MAX ? 0 : Math.round(n * 0.38);
  const outer = n - inner;
  const outerPts = onEllipse(outer, inner === 0 ? ONE : OUTER, -90);
  // The inner ring starts half a step round, so inner nodes fall between outer ones and labels do not collide.
  const innerPts = onEllipse(inner, INNER, -90 + 180 / Math.max(inner, 1));
  // Nodes 0..outer-1 take the outer ring, the rest the inner one.
  const pts = [...outerPts, ...innerPts];
  return nodes.map((node, i) => ({ ...node, ...pts[i]!, bend: i % 2 === 0 ? 18 : -18, r: node.r ?? 6.5 }));
};

/** A label that fits beside a node: the redundant role suffix dropped, long names cut with an ellipsis. */
export const shortLabel = (name: string, max = 16): string => {
  const base = name.replace(/-(researcher|agent)$/, '');
  return base.length <= max ? base : `${base.slice(0, max - 1)}…`;
};

/** The text of a role up to its first full stop, cut to `max` characters. */
export const firstSentence = (text: string, max = 220): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const one = end === -1 ? flat : flat.slice(0, end + 1);
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};
