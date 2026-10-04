import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildGraph } from './viewer/build-graph.js';
import { layoutGraph } from './viewer/graph-layout.js';
import type { GraphData, SourceGraph, Position } from './viewer/graph.types.ts';

const context = { data: {} as SourceGraph };
runInNewContext(readFileSync('galaxy/viewer/graph-data.js', 'utf8') + ';this.data=GRAPH;', context);
const source = context.data;
const graph: GraphData = buildGraph(source);
const sample: SourceGraph = { nodes: [
  { id: 0, path: 'README.md', label: 'Core', group: 'root' },
  { id: 1, path: 'knowledge/README.md', label: 'Knowledge', group: 'knowledge' },
  { id: 2, path: 'knowledge/note.md', label: 'Note', group: 'knowledge' },
], links: [{ source: 0, target: 1 }] };

describe('source-backed graph migration', () => {
  it('preserves every real note and creates only source-backed group membership', () => {
    expect(graph.nodes.filter(n => n.note).length).toBe(source.nodes.length);
    expect(graph.nodes.filter(n => n.kind === 'cluster').length).toBe(new Set(source.nodes.map(n => n.group)).size);
    expect(graph.nodes.every(n => n.paths.length && n.paths.every(p => existsSync(p)))).toBe(true);
    const ids = new Set(graph.nodes.map(n => n.id));
    expect(graph.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(graph.edges.filter(e => e.kind === 'contains')).toHaveLength(source.nodes.length);
    expect(graph.edges.filter(e => e.kind === 'related')).toHaveLength(source.links.length);
    expect(graph.edges.filter(e => e.kind === 'related').every(e => !e.directed)).toBe(true);
    expect(graph.nodes.every(n => graph.edges.some(e => e.source === n.id || e.target === n.id))).toBe(true);
  });
  it('reports isolated notes without inventing note relationships', () => {
    expect(buildGraph(sample).isolated).toEqual(['note:knowledge/note.md']);
  });
  it('rejects corrupt identities, dangling edges and self-links', () => {
    expect(() => buildGraph({ ...sample, nodes: [...sample.nodes, sample.nodes[0]!] })).toThrow();
    expect(() => buildGraph({ ...sample, links: [{ source: 0, target: 99 }] })).toThrow();
    expect(() => buildGraph({ ...sample, links: [{ source: 0, target: 0 }] })).toThrow();
  });
  it('accepts force-library object endpoints and deduplicates undirected pairs', () => {
    const g = buildGraph({ ...sample, links: [...sample.links, { source: sample.nodes[1]!, target: sample.nodes[0]! }] });
    expect(g.edges.filter((e: { kind: string }) => e.kind === 'related')).toHaveLength(1);
  });
  it('matches the frozen layout fixture and is independent of input ordering', () => {
    const fixture = JSON.parse(readFileSync('galaxy/fixtures/layout.json', 'utf8'));
    expect(layoutGraph(buildGraph(sample))).toEqual(fixture);
    expect(layoutGraph(buildGraph({ nodes: [...sample.nodes].reverse(), links: sample.links }))).toEqual(fixture);
  });
  it('settles the real graph to finite, separated positions without mutating source data', () => {
    const before = JSON.stringify(source), positions: Position[] = layoutGraph(graph);
    expect(positions).toHaveLength(graph.nodes.length);
    expect(positions.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!, b = positions[j]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(40);
    }
    expect(JSON.stringify(source)).toBe(before);
    expect(layoutGraph(graph)).toEqual(positions);
  });
});
