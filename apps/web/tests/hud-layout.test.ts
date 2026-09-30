import { describe, expect, it } from 'vitest';
import { DOMAINS, type Domain } from '../../../core/contracts/taxonomy.ts';
import { bend, globeRadius, layout, ORBIT, satellites, toScreen, toWorld, zoomAt } from '../lib/hud-layout.ts';

const items = Object.fromEntries(DOMAINS.map((d) => [d, Array.from({ length: d === 'RECORDS' ? 14 : 6 }, (_, i) => ({ id: `${d}:c${i}`, group: d === 'RECORDS' ? (i < 10 ? 'x3lius' : 'ops') : null }))])) as Record<Domain, { id: string; group: 'x3lius' | 'ops' | null }[]>;

describe('HUD layout', () => {
  it('the globe is 38% of the canvas height, clamped to 260–420 px', () => {
    expect(globeRadius(900) * 2).toBeCloseTo(342, 0);
    expect(globeRadius(400) * 2).toBe(260);
    expect(globeRadius(2000) * 2).toBe(420);
  });

  it('medallions sit on their compass bearings at 1.45× the globe radius', () => {
    const l = layout(1320, 900, items);
    const c = l.centre;
    expect(l.medallion.CORE.x).toBeCloseTo(c.x); expect(l.medallion.CORE.y).toBeLessThan(c.y);
    expect(l.medallion.RECORDS.x).toBeCloseTo(c.x); expect(l.medallion.RECORDS.y).toBeGreaterThan(c.y);
    expect(l.medallion.KNOWLEDGE.x).toBeGreaterThan(c.x); expect(l.medallion.KNOWLEDGE.y).toBeLessThan(c.y);
    expect(l.medallion.GOVERNANCE.x).toBeGreaterThan(c.x); expect(l.medallion.GOVERNANCE.y).toBeGreaterThan(c.y);
    expect(l.medallion.TECH.x).toBeLessThan(c.x); expect(l.medallion.TECH.y).toBeGreaterThan(c.y);
    expect(l.medallion.RESEARCH_INTELLIGENCE.x).toBeLessThan(c.x); expect(l.medallion.RESEARCH_INTELLIGENCE.y).toBeLessThan(c.y);
    for (const d of DOMAINS) expect(Math.hypot(l.medallion[d].x - c.x, l.medallion[d].y - c.y)).toBeCloseTo(l.r * ORBIT);
  });

  it('every sub-component gets one anchor outside the globe, on the canvas, and no two overlap', () => {
    const l = layout(1320, 900, items);
    expect(l.anchors.size).toBe(DOMAINS.reduce((s, d) => s + items[d].length, 0));
    const dots = [...l.anchors.values()].map((a) => a.dot);
    for (const p of dots) {
      expect(Math.hypot(p.x - l.centre.x, p.y - l.centre.y)).toBeGreaterThan(l.r);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1320);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(900);
    }
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) expect(Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y)).toBeGreaterThan(10);
  });

  it('zooming toward a point keeps that point still; screen and world round-trip', () => {
    const c = { x: 600, y: 400 };
    const v = { z: 1, focus: { x: 600, y: 400 } };
    const at = { x: 800, y: 250 };
    const before = toWorld(at, v, c);
    const nv = zoomAt(v, c, at, 2);
    expect(nv.z).toBe(2);
    const after = toScreen(before, nv, c);
    expect(after.x).toBeCloseTo(at.x); expect(after.y).toBeCloseTo(at.y);
    expect(zoomAt(v, c, at, 99).z).toBe(4);
    expect(zoomAt(v, c, at, 0.1).z).toBe(0.5);
  });

  it('links bend toward the centre; satellites place every file', () => {
    const k = bend({ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 100 });
    expect(k.y).toBeGreaterThan(0);
    expect(satellites({ x: 0, y: 0 }, 200)).toHaveLength(200);
    expect(satellites({ x: 0, y: 0 }, 0)).toHaveLength(0);
  });
});
