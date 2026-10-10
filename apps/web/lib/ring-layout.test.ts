import { describe, expect, it } from 'vitest';
import { firstSentence, layoutRing, MIN_R, shortLabel, VIEW, type RingNode } from './ring-layout.ts';

const make = (n: number): RingNode[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `n${i}`, color: '#fff', live: true }));
const gap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('layoutRing', () => {
  it('places nothing for no nodes', () => expect(layoutRing([])).toEqual([]));

  it('keeps every node inside the canvas and outside the core, for every size up to the largest domain', () => {
    for (let n = 1; n <= 30; n += 1) {
      for (const p of layoutRing(make(n))) {
        expect(p.x, `n=${n} x`).toBeGreaterThan(0);
        expect(p.x, `n=${n} x`).toBeLessThan(VIEW.w);
        expect(p.y, `n=${n} y`).toBeGreaterThan(0);
        expect(p.y, `n=${n} y`).toBeLessThan(VIEW.h);
        expect(Math.hypot(p.x - VIEW.cx, p.y - VIEW.cy), `n=${n} core`).toBeGreaterThanOrEqual(MIN_R);
      }
    }
  });

  it('keeps nodes apart so labels do not stack: 22 agents (the biggest domain) stay 40 px from one another', () => {
    const placed = layoutRing(make(22));
    for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) expect(gap(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(40);
  });

  it('puts the first node at the top and keeps the input order and fields', () => {
    const placed = layoutRing(make(6));
    expect(placed.map((p) => p.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
    expect(placed[0]!.x).toBeCloseTo(VIEW.cx);
    expect(placed[0]!.y).toBeLessThan(VIEW.cy);
  });
});

describe('shortLabel', () => {
  it('drops the role suffix and cuts long names', () => {
    expect(shortLabel('suno-researcher')).toBe('suno');
    expect(shortLabel('records-catalog')).toBe('records-catalog');
    expect(shortLabel('benchmark-scoring-methodology-researcher')).toBe('benchmark-scori…');
    expect(shortLabel('benchmark-scoring-methodology-researcher')).toHaveLength(16);
  });
});

describe('firstSentence', () => {
  it('stops at the first full stop and caps the length', () => {
    expect(firstSentence('Decides which specialists a question needs.  It never dispatches.')).toBe('Decides which specialists a question needs.');
    expect(firstSentence('no full stop here')).toBe('no full stop here');
    expect(firstSentence('x'.repeat(300))).toHaveLength(220);
  });
});
