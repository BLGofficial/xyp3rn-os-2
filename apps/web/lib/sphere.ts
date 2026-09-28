import type { Domain } from '../../../core/contracts/taxonomy.ts';

/**
 * The sphere's geometry (Jarvis Prompt 01; AOS-04 design §13.2, §14). Pure and dependency-free, so the server and
 * the client compute the same picture: stable domain sectors, members placed by a hash of their id (never
 * Math.random, never input order), rotation, perspective projection, the hit target, and the keyboard's order.
 * Units: the sphere has radius 1; +x is east (right), +y north (up), +z towards the viewer.
 */

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };
export type Owner = Domain | 'shared';

/** A member's cap around its domain anchor, in radians: adjacent anchors are ~51° apart, so caps never overlap. */
export const SPREAD = 0.4;
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3;
// Camera distance in sphere radii: enough perspective to read depth, not enough to distort the rim.
const CAMERA = 3;

// An anchor 60° off the view axis at compass bearing φ (clockwise from north): every domain faces the viewer at rest.
const bearing = (deg: number): Vec3 => {
  const t = Math.PI / 3;
  const p = (deg * Math.PI) / 180;
  return { x: Math.sin(t) * Math.sin(p), y: Math.sin(t) * Math.cos(p), z: Math.cos(t) };
};

/** §13.2 sectors: Core north, Knowledge north-east, Governance south-east, Records south, Tech south-west, Research north-west; Shared on the far side. */
export const DOMAIN_DIRECTION: Readonly<Record<Owner, Vec3>> = {
  CORE: bearing(0), KNOWLEDGE: bearing(60), GOVERNANCE: bearing(120), RECORDS: bearing(180), TECH: bearing(240), RESEARCH_INTELLIGENCE: bearing(300),
  shared: { x: 0, y: 0, z: -1 },
};

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// FNV-1a over UTF-16 units, then murmur3's finaliser: two seeds give two independent 32-bit draws per id.
const hash = (s: string, seed: number): number => {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/**
 * @param ids - entity ids
 * @param anchor - the cap's centre (unit length)
 * @param spread - the cap's angular radius, radians
 * @returns each id's point: unit length, uniformly spread over the cap by area, a function of the id alone
 */
export const place = (ids: readonly string[], anchor: Vec3, spread: number): Map<string, Vec3> => {
  const a = norm(anchor);
  const b = norm(cross(Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }, a));
  const c = cross(a, b);
  const out = new Map<string, Vec3>();
  for (const id of ids) {
    const u = hash(id, 0x811c9dc5) / 2 ** 32;
    const v = hash(id, 0x9e3779b9) / 2 ** 32;
    const cosA = 1 - u * (1 - Math.cos(spread));
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const beta = 2 * Math.PI * v;
    out.set(id, norm({
      x: cosA * a.x + sinA * (Math.cos(beta) * b.x + Math.sin(beta) * c.x),
      y: cosA * a.y + sinA * (Math.cos(beta) * b.y + Math.sin(beta) * c.y),
      z: cosA * a.z + sinA * (Math.cos(beta) * b.z + Math.sin(beta) * c.z),
    }));
  }
  return out;
};

/**
 * @param items - what is drawn: a domain node (`anchor`) sits on its sector's anchor, everything else in its owner's cap
 * @param spread - the cap's angular radius
 * @returns positions by id, in id order (so equal inputs give equal maps, whatever their order)
 */
export const layout = (items: readonly { readonly id: string; readonly domain: Owner; readonly anchor?: boolean }[], spread = SPREAD): Map<string, Vec3> => {
  const all = new Map<string, Vec3>();
  const byOwner = new Map<Owner, string[]>();
  for (const i of items) {
    if (i.anchor) all.set(i.id, DOMAIN_DIRECTION[i.domain]);
    else byOwner.set(i.domain, [...(byOwner.get(i.domain) ?? []), i.id]);
  }
  for (const [owner, ids] of byOwner) for (const [id, v] of place(ids, DOMAIN_DIRECTION[owner], spread)) all.set(id, v);
  return new Map([...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

/**
 * @param v - a point
 * @param yaw - turn about the vertical axis, radians (positive turns the east side away: +x → -z)
 * @param pitch - tilt about the horizontal axis, radians (applied after yaw)
 */
export const rotate = (v: Vec3, yaw: number, pitch: number): Vec3 => {
  const x1 = v.x * Math.cos(yaw) + v.z * Math.sin(yaw);
  const z1 = -v.x * Math.sin(yaw) + v.z * Math.cos(yaw);
  return { x: x1, y: v.y * Math.cos(pitch) - z1 * Math.sin(pitch), z: v.y * Math.sin(pitch) + z1 * Math.cos(pitch) };
};

/**
 * @param v - a rotated point
 * @param view - the drawing's size in px and the zoom (about the centre)
 * @returns screen x/y (y down), depth in [0, 1] (1 nearest), and the perspective scale (1 on the rim's plane)
 */
export const project = (v: Vec3, view: { readonly width: number; readonly height: number; readonly zoom: number }) => {
  const r = Math.min(view.width, view.height) * 0.4 * view.zoom;
  const scale = CAMERA / (CAMERA - v.z);
  return { x: view.width / 2 + r * v.x * scale, y: view.height / 2 - r * v.y * scale, depth: (v.z + 1) / 2, scale };
};

/** @returns the sphere's on-screen radius at this view (the rim) */
export const rimRadius = (view: { readonly width: number; readonly height: number; readonly zoom: number }) => Math.min(view.width, view.height) * 0.4 * view.zoom;

/** @param depth - from project (1 nearest) @returns a mark's opacity: the far side dims, never vanishes */
export const opacity = (depth: number) => 0.2 + 0.8 * depth;

/** @param markRadius - a mark's drawn radius, px @returns its hit radius: never under 22 px (a 44 px target) */
export const hitRadius = (markRadius: number) => Math.max(22, markRadius + 4);

/** @returns the zoom kept inside MIN_ZOOM..MAX_ZOOM */
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * A curved link's control point: lifted off the sphere over the midpoint, so links bow outward and never cut
 * through the centre (the hub is not connected to anything).
 * @param a - one end (unit length)
 * @param b - the other end
 */
export const arcControl = (a: Vec3, b: Vec3): Vec3 => {
  const m = { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  const l = Math.hypot(m.x, m.y, m.z);
  // Antipodal ends: any perpendicular works; this one is stable.
  const dir = l < 1e-9 ? norm(cross(a, Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 })) : { x: m.x / l, y: m.y / l, z: m.z / l };
  const lift = 1 + 0.25 * (1 - l / 2);
  return { x: dir.x * lift, y: dir.y * lift, z: dir.z * lift };
};

/**
 * The keyboard's order (§14): left/right move within the focused node's domain (wrapping); up/down move to the
 * next/previous domain's first node (its domain node, when drawn); Home/End go to the ends.
 * @param order - the drawn nodes in reading order, grouped by domain
 * @param current - the focused id (null or unknown: start at the first)
 * @param key - a KeyboardEvent key
 * @returns the id to focus, or null when nothing is drawn
 */
export const step = (order: readonly { readonly id: string; readonly domain: string }[], current: string | null, key: string): string | null => {
  if (order.length === 0) return null;
  if (key === 'Home') return order[0]!.id;
  if (key === 'End') return order[order.length - 1]!.id;
  const at = order.findIndex((o) => o.id === current);
  if (at < 0) return order[0]!.id;
  const here = order[at]!;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const same = order.filter((o) => o.domain === here.domain);
    const i = same.findIndex((o) => o.id === here.id);
    return same[(i + (key === 'ArrowRight' ? 1 : same.length - 1)) % same.length]!.id;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const domains = [...new Set(order.map((o) => o.domain))];
    const d = domains.indexOf(here.domain);
    const next = domains[(d + (key === 'ArrowDown' ? 1 : domains.length - 1)) % domains.length]!;
    return order.find((o) => o.domain === next)!.id;
  }
  return here.id;
};
