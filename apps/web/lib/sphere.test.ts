import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../../../core/contracts/taxonomy.ts';
import { DOMAIN_DIRECTION, hitRadius, layout, opacity, place, project, rotate, SPREAD, step, type Vec3 } from './sphere.ts';

// Jarvis Prompt 01 Task 2 (AOS-04 design §13.2, §14): the sphere's geometry. Stable domain sectors, members placed by
// a hash of their id (the same graph gives the same picture on the server and the client), perspective projection,
// 44 px targets, and the keyboard's order: within a domain, then across.

const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const VIEW = { width: 800, height: 600, zoom: 1 };
const ids = (n: number, prefix = 'file:repo/core/f') => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);

describe('DOMAIN_DIRECTION', () => {
  it('puts each domain in its compass sector, facing the viewer, and Shared on the far side', () => {
    for (const d of DOMAINS) {
      expect(len(DOMAIN_DIRECTION[d])).toBeCloseTo(1, 12);
      expect(DOMAIN_DIRECTION[d].z).toBeGreaterThan(0);
    }
    const p = (d: keyof typeof DOMAIN_DIRECTION) => project(rotate(DOMAIN_DIRECTION[d], 0, 0), VIEW);
    // Core north, Knowledge north-east, Governance south-east, Records south, Tech south-west, Research north-west.
    expect(p('CORE').y).toBeLessThan(p('RECORDS').y);
    expect(p('KNOWLEDGE').x).toBeGreaterThan(p('CORE').x);
    expect(p('KNOWLEDGE').y).toBeLessThan(VIEW.height / 2);
    expect(p('GOVERNANCE').x).toBeGreaterThan(VIEW.width / 2);
    expect(p('GOVERNANCE').y).toBeGreaterThan(VIEW.height / 2);
    expect(p('TECH').x).toBeLessThan(VIEW.width / 2);
    expect(p('TECH').y).toBeGreaterThan(VIEW.height / 2);
    expect(p('RESEARCH_INTELLIGENCE').x).toBeLessThan(VIEW.width / 2);
    expect(p('RESEARCH_INTELLIGENCE').y).toBeLessThan(VIEW.height / 2);
    expect(DOMAIN_DIRECTION.shared).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe('place', () => {
  it('places every id at unit length inside its cap', () => {
    const anchor = DOMAIN_DIRECTION.RECORDS;
    for (const [, v] of place(ids(500), anchor, SPREAD)) {
      expect(len(v)).toBeCloseTo(1, 12);
      expect(Math.acos(Math.min(1, dot(v, anchor)))).toBeLessThanOrEqual(SPREAD + 1e-12);
    }
  });

  it('gives the same positions on every call, whatever the input order', () => {
    const a = place(ids(300), DOMAIN_DIRECTION.CORE, SPREAD);
    const b = place([...ids(300)].reverse(), DOMAIN_DIRECTION.CORE, SPREAD);
    for (const [id, v] of a) expect(b.get(id)).toEqual(v);
    expect(place(['agent:x'], DOMAIN_DIRECTION.CORE, SPREAD).get('agent:x')).toEqual(place(['agent:x'], DOMAIN_DIRECTION.CORE, SPREAD).get('agent:x'));
  });

  it('never puts two distinct ids on the same point', () => {
    const seen = new Set<string>();
    for (const [, v] of place(ids(5000), DOMAIN_DIRECTION.KNOWLEDGE, SPREAD)) {
      const key = `${v.x},${v.y},${v.z}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('layout', () => {
  it('puts a domain node on its anchor, the others in their domain cap, and is order-independent', () => {
    const items = [
      { id: 'domain:CORE', domain: 'CORE' as const, anchor: true },
      { id: 'agent:context-retriever', domain: 'CORE' as const },
      { id: 'group:shared:file', domain: 'shared' as const },
    ];
    const a = layout(items);
    expect(a.get('domain:CORE')).toEqual(DOMAIN_DIRECTION.CORE);
    expect(Math.acos(dot(a.get('agent:context-retriever')!, DOMAIN_DIRECTION.CORE))).toBeLessThanOrEqual(SPREAD + 1e-12);
    expect(a.get('group:shared:file')!.z).toBeLessThan(0);
    expect(layout([...items].reverse())).toEqual(a);
  });
});

describe('rotate and project', () => {
  it('keeps length, and a full turn comes back', () => {
    const v = DOMAIN_DIRECTION.TECH;
    expect(len(rotate(v, 1.2, -0.4))).toBeCloseTo(1, 12);
    const back = rotate(v, 2 * Math.PI, 0);
    expect(back.x).toBeCloseTo(v.x, 12);
    expect(back.z).toBeCloseTo(v.z, 12);
  });

  it('gives the far side less depth, a smaller scale and less opacity', () => {
    const near = project({ x: 0, y: 0, z: 1 }, VIEW);
    const rim = project({ x: 1, y: 0, z: 0 }, VIEW);
    const far = project({ x: 0, y: 0, z: -1 }, VIEW);
    expect(near.depth).toBeGreaterThan(rim.depth);
    expect(rim.depth).toBeGreaterThan(far.depth);
    expect(far.scale).toBeLessThan(near.scale);
    expect(opacity(far.depth)).toBeLessThan(opacity(near.depth));
    expect(opacity(far.depth)).toBeGreaterThan(0);
    // Yawing half a turn brings the far side to the front.
    expect(project(rotate({ x: 0, y: 0, z: -1 }, Math.PI, 0), VIEW).depth).toBeCloseTo(near.depth, 12);
  });

  it('zooms about the centre', () => {
    const a = project(DOMAIN_DIRECTION.KNOWLEDGE, VIEW);
    const b = project(DOMAIN_DIRECTION.KNOWLEDGE, { ...VIEW, zoom: 2 });
    expect(b.x - VIEW.width / 2).toBeCloseTo(2 * (a.x - VIEW.width / 2), 9);
    expect(b.y - VIEW.height / 2).toBeCloseTo(2 * (a.y - VIEW.height / 2), 9);
  });
});

describe('hitRadius', () => {
  it('is never under 22 px (a 44 px target), and grows with a large mark', () => {
    for (const r of [0, 1, 3.5, 10, 21.9]) expect(hitRadius(r)).toBeGreaterThanOrEqual(22);
    expect(hitRadius(30)).toBeGreaterThanOrEqual(30);
  });
});

describe('step (the keyboard)', () => {
  const order = [
    { id: 'domain:CORE', domain: 'CORE' }, { id: 'agent:a', domain: 'CORE' }, { id: 'agent:b', domain: 'CORE' },
    { id: 'domain:KNOWLEDGE', domain: 'KNOWLEDGE' },
    { id: 'domain:RECORDS', domain: 'RECORDS' }, { id: 'module:m', domain: 'RECORDS' },
  ];
  it('moves within a domain with left/right (wrapping) and across domains with up/down (to the domain first)', () => {
    expect(step(order, null, 'ArrowRight')).toBe('domain:CORE');
    expect(step(order, 'domain:CORE', 'ArrowRight')).toBe('agent:a');
    expect(step(order, 'agent:b', 'ArrowRight')).toBe('domain:CORE');
    expect(step(order, 'domain:CORE', 'ArrowLeft')).toBe('agent:b');
    expect(step(order, 'agent:a', 'ArrowDown')).toBe('domain:KNOWLEDGE');
    expect(step(order, 'domain:KNOWLEDGE', 'ArrowDown')).toBe('domain:RECORDS');
    expect(step(order, 'domain:RECORDS', 'ArrowDown')).toBe('domain:CORE');
    expect(step(order, 'domain:CORE', 'ArrowUp')).toBe('domain:RECORDS');
    expect(step(order, 'module:m', 'Home')).toBe('domain:CORE');
    expect(step(order, 'agent:a', 'End')).toBe('module:m');
    expect(step(order, 'gone', 'ArrowRight')).toBe('domain:CORE');
    expect(step([], null, 'ArrowRight')).toBeNull();
  });
});
