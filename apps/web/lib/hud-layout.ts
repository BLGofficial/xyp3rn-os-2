import type { Domain } from '../../../core/contracts/taxonomy.ts';
import { HUD_BEARING, ZOOM } from './hud-theme.ts';

/**
 * The Mercury HUD's geometry (pure; hud-layout.test.ts). World coordinates are canvas pixels at zoom 1, centred on
 * the globe. The canvas (light) and the HTML overlay (labels, buttons) both place things from this one layout and
 * share one view transform, so they never drift apart.
 */

export type Pt = { readonly x: number; readonly y: number };
export type Item = { readonly id: string; readonly group?: 'x3lius' | 'ops' | null };
export type Anchor = { readonly id: string; readonly dot: Pt; readonly align: 'left' | 'right'; readonly domain: Domain };
/** Where a domain's title goes: a side domain's title heads its list (outer side); Core and Records face the globe. */
export type TitleAt = { readonly at: Pt; readonly align: 'left' | 'right' | 'center'; readonly place: 'above' | 'below' };

export const GLOBE_SHARE = 0.38; // the globe's diameter as a share of the canvas height, at FIT
export const ORBIT = 1.45; // medallion ring radius / globe radius
const ROW = 20; // label row pitch (px, world)
const COL = 190; // label column width for the north and south lists
/** A domain title's box on screen (px): shared by FIT, collision avoidance and the tests. */
export const TITLE_W = 270;
export const TITLE_H = 44;

/** The globe's radius: 38% of the canvas height as a diameter, clamped to 260–420 px. */
export const globeRadius = (height: number) => Math.min(420, Math.max(260, height * GLOBE_SHARE)) / 2;

/** A unit vector at a compass bearing (clockwise from north; screen y points down). */
export const dir = (bearingDeg: number): Pt => {
  const r = (bearingDeg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
};

export type Layout = {
  readonly width: number; readonly height: number; readonly centre: Pt; readonly r: number; readonly orbit: number;
  readonly medallion: Readonly<Record<Domain, Pt>>;
  readonly anchors: ReadonlyMap<string, Anchor>;
  readonly titles: Readonly<Record<Domain, TitleAt>>;
};

/**
 * Lays the orbit out: six medallions on their bearings; each domain's sub-components beside its medallion. North
 * and south lists run in columns above and below (Records: two X3LIUS columns, then Ops); the four side lists run
 * outward in one column, dots on the medallion's side.
 * @param items - per domain, its sub-components in display order
 */
export const layout = (width: number, height: number, items: Readonly<Record<Domain, readonly Item[]>>): Layout => {
  const centre = { x: width / 2, y: height / 2 };
  const r = globeRadius(height);
  const orbit = r * ORBIT;
  const medallion = {} as Record<Domain, Pt>;
  const anchors = new Map<string, Anchor>();
  const titles = {} as Record<Domain, TitleAt>;
  for (const d of Object.keys(HUD_BEARING) as Domain[]) {
    const u = dir(HUD_BEARING[d]);
    const m = { x: centre.x + u.x * orbit, y: centre.y + u.y * orbit };
    medallion[d] = m;
    const list = items[d] ?? [];
    if (Math.abs(u.x) < 0.01) {
      // North (Core) or south (Records): columns centred on the medallion, stacked away from the globe.
      const x3 = list.filter((i) => i.group !== 'ops'), ops = list.filter((i) => i.group === 'ops');
      const cols = [x3.slice(0, Math.ceil(x3.length / 2)), x3.slice(Math.ceil(x3.length / 2)), ...(ops.length ? [ops] : [])].filter((c) => c.length);
      const left = m.x - (cols.length * COL) / 2 + 8;
      titles[d] = u.y < 0 ? { at: { x: m.x, y: m.y + 36 }, align: 'center', place: 'below' } : { at: { x: m.x, y: m.y - 36 }, align: 'center', place: 'above' };
      cols.forEach((col, ci) => col.forEach((it, ri) => {
        const y = u.y < 0 ? m.y - 52 - (col.length - 1 - ri) * ROW : m.y + 52 + ri * ROW;
        anchors.set(it.id, { id: it.id, dot: { x: left + ci * COL, y }, align: 'left', domain: d });
      }));
    } else {
      // A side domain: one column outward from the medallion, running away from the horizon (upper domains end
      // level with the medallion and grow upward, lower ones start level with it and grow down), so the title,
      // on the horizon side, never shares a row with the list.
      const align = u.x > 0 ? 'left' : 'right';
      const x = m.x + Math.sign(u.x) * 48;
      list.forEach((it, i) => anchors.set(it.id, { id: it.id, dot: { x, y: u.y < 0 ? m.y - (list.length - 1 - i) * ROW : m.y + i * ROW }, align, domain: d }));
      const top = u.y < 0 ? m.y - Math.max(0, list.length - 1) * ROW : m.y;
      titles[d] = { at: { x: x + (align === 'left' ? -4 : 4), y: top - 14 }, align, place: 'above' };
    }
  }
  return { width, height, centre, r, orbit, medallion, anchors, titles };
};

/** The view: zoom `z` about the world point `focus`, which sits at the canvas centre. */
export type View = { readonly z: number; readonly focus: Pt };
export const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));
export const toScreen = (p: Pt, v: View, c: Pt): Pt => ({ x: (p.x - v.focus.x) * v.z + c.x, y: (p.y - v.focus.y) * v.z + c.y });
export const toWorld = (p: Pt, v: View, c: Pt): Pt => ({ x: (p.x - c.x) / v.z + v.focus.x, y: (p.y - c.y) / v.z + v.focus.y });

/** Zoom toward a screen point (the cursor): the world point under it stays under it. */
export const zoomAt = (v: View, c: Pt, at: Pt, z: number): View => {
  const nz = clampZoom(z);
  const w = toWorld(at, v, c);
  return { z: nz, focus: { x: w.x - (at.x - c.x) / nz, y: w.y - (at.y - c.y) / nz } };
};

/** The control point that bends a link through the inner ring (pulled 65% of the way to the centre). */
export const bend = (a: Pt, b: Pt, centre: Pt): Pt => {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: mid.x + (centre.x - mid.x) * 0.65, y: mid.y + (centre.y - mid.y) * 0.65 };
};

/** Satellite positions for an expanded component: rings of files around its dot (first ring 28 px, then +14). */
export const satellites = (at: Pt, n: number): Pt[] => {
  const out: Pt[] = [];
  for (let ring = 0, placed = 0; placed < n; ring++) {
    const radius = 28 + ring * 14;
    const cap = Math.floor((2 * Math.PI * radius) / 11);
    const k = Math.min(cap, n - placed);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * 2 * Math.PI - Math.PI / 2 + ring * 0.3;
      out.push({ x: at.x + Math.cos(a) * radius, y: at.y + Math.sin(a) * radius });
    }
    placed += k;
  }
  return out;
};
