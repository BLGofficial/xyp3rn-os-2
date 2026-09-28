import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAINS } from '../../../core/contracts/taxonomy.ts';
import { scanRoots } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { listNodes, overview } from './graph-loaders.ts';

// Jarvis Prompt 01 Task 1: the bounded overview the sphere draws. Every drawn node is a graph_nodes row (or the
// configured hub), every drawn edge a graph_edges row (or a group's `contains`), and every group names its query
// and its real members. A scanned fixture root: 400 files, 12 agents across three domains, one three-step workflow.

let db: TestDb;
let empty: TestDb;
const root = mkdtempSync(join(tmpdir(), 'jarvis01-overview-root-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'jarvis01-overview-vault-'));
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const agent = (name: string, domain: string) =>
  `---\nname: ${name}\nclass: Execution\ndomain: ${domain}\ntools: []\nmodel: none\n---\n\n## Role\n\n[FIXTURE]\n\n## Contract\n\nx\n\n## Refuses\n\nx\n`;
const AGENT_DOMAINS = ['RECORDS', 'CORE', 'KNOWLEDGE'] as const;

beforeAll(async () => {
  [db, empty] = await Promise.all([createTestDb('jarvis01_overview', { migrated: true }), createTestDb('jarvis01_overview_empty', { migrated: true })]);
  // 400 files: 250 under core/ (one group past the 200-member list), 100 under records/, 50 shared (docs/).
  for (let i = 0; i < 250; i++) put(`core/f${String(i).padStart(3, '0')}.ts`, `export const f${i} = ${i};\n`);
  for (let i = 0; i < 100; i++) put(`records/r${String(i).padStart(3, '0')}.ts`, i === 0 ? "import { f0 } from '../core/f000.ts';\n" : `export const r${i} = ${i};\n`);
  for (let i = 0; i < 48; i++) put(`docs/d${String(i).padStart(2, '0')}.md`, `# [FIXTURE] note ${i}\n`);
  for (let i = 0; i < 12; i++) put(`agents/fixture-${String(i).padStart(2, '0')}.agent.md`, agent(`fixture-${String(i).padStart(2, '0')}`, AGENT_DOMAINS[i % 3]!));
  put('records/workflows/fixture-overview.workflow.yaml',
    'name: fixture-overview\ndescription: x\nsteps:\n  - id: one\n    agent: fixture-00\n  - id: two\n    agent: fixture-03\n    dependsOn: [one]\n  - id: three\n    agent: fixture-06\n    dependsOn: [two]\n');
  put('docs/ARCHITECTURE.md', '# Architecture\n\n**F1. [FIXTURE] One decision.** DECIDED.\n');
  expect((await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir) })).status).toBe('success');
}, 180_000);
afterAll(async () => {
  await Promise.all([db?.drop(), empty?.drop()]);
  rmSync(root, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

const withoutAsOf = <T extends { asOf: string }>(o: T) => ({ ...o, asOf: 'x' });

describe('overview', () => {
  it('draws only graph_nodes rows and the configured hub, and only graph_edges rows and group contains links', async () => {
    const o = await overview(db.sql);
    const ids = new Set((await db.sql<{ id: string }[]>`select id from graph_nodes`).map((r) => r.id));
    for (const n of o.nodes) expect(ids.has(n.id), n.id).toBe(true);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
    expect(o.hub).toEqual({ id: `app:${pkg.name}`, title: pkg.name, version: pkg.version, sourceRef: 'package.json', backing: 'configuration' });
    expect(ids.has(o.hub.id)).toBe(false);

    const edges = new Map((await db.sql<{ id: string; provenance: string; from_id: string; to_id: string }[]>`select id, provenance, from_id, to_id from graph_edges`).map((e) => [e.id, e]));
    const drawn = new Set([...o.nodes.map((n) => n.id), ...o.groups.map((g) => g.id)]);
    expect(o.edges.length).toBeGreaterThan(0);
    for (const e of o.edges) {
      expect(drawn.has(e.fromId) && drawn.has(e.toId), e.id).toBe(true);
      if (e.relation === 'contains') {
        const g = o.groups.find((x) => x.id === e.fromId)!;
        expect(g.domain).not.toBe('shared');
        expect(e.toId).toBe(`domain:${g.domain}`);
        expect(e.grouping).toBe(true);
        continue;
      }
      expect(edges.get(e.id), e.id).toMatchObject({ provenance: e.provenance, from_id: e.fromId, to_id: e.toId });
      expect(e.grouping).toBe(false);
    }
    // The workflow's steps, drawn with their proven edges (fixture: under the default budget nothing is demoted).
    expect(o.demoted).toEqual([]);
    expect(o.nodes.filter((n) => n.kind === 'workflow_step').map((n) => n.id).sort()).toEqual(
      ['one', 'three', 'two'].map((s) => `workflow_step:fixture-overview#${s}`));
    expect(o.edges.some((e) => e.relation === 'step_uses_agent' && e.fromId === 'workflow_step:fixture-overview#one' && e.toId === 'agent:fixture-00')).toBe(true);
  });

  it('groups count their real members, and their query reads the same members back', async () => {
    const o = await overview(db.sql);
    expect(o.groups.length).toBeGreaterThan(0);
    for (const g of o.groups) {
      expect(g.count).toBeGreaterThan(0);
      const back = await listNodes(db.sql, { kind: g.kind, domain: g.domain, perPage: 500 });
      expect(back.total, g.id).toBe(g.count);
      expect(g.memberIds).toEqual(back.nodes.slice(0, 200).map((n) => n.id));
      expect(g.membersTruncated).toBe(g.count > 200);
      expect(g.id).toBe(`group:${g.domain}:${g.kind}`);
      expect(g.query).toBe(`kind = ${g.kind} and owner ${g.domain === 'shared' ? 'is Shared/Unassigned' : `= ${g.domain}`}`);
      expect(g.href).toBe(`/?kind=${g.kind}&domain=${g.domain}`);
    }
    const coreFiles = o.groups.find((g) => g.id === 'group:CORE:file')!;
    expect(coreFiles).toMatchObject({ count: 250, membersTruncated: true, label: 'Core · Files' });
    expect(coreFiles.memberIds).toHaveLength(200);
    expect(o.groups.find((g) => g.id === 'group:shared:file')).toMatchObject({ label: 'Shared/Unassigned · Files' });

    const [c] = await db.sql<{ n: number }[]>`select count(*)::int as n from graph_nodes`;
    expect(o.counts).toEqual({ indexed: c!.n, drawn: o.nodes.length, grouped: o.groups.reduce((s, g) => s + g.count, 0) });
    expect(o.counts.indexed).toBe(o.counts.drawn + o.counts.grouped);
  });

  it('holds the budget: 400 files stay grouped, and a smaller budget groups steps, then agents, then modules, then workflows', async () => {
    const full = await overview(db.sql);
    expect(full.nodes.length + full.groups.length).toBeLessThanOrEqual(250);
    expect(full.edges.length).toBeLessThanOrEqual(500);
    expect(full.nodes.some((n) => n.kind === 'file')).toBe(false);

    // One slot short: the three steps become one group (they share the workflow file's owner).
    const tight = await overview(db.sql, { maxNodes: full.nodes.length + full.groups.length - 1, maxEdges: 3 });
    expect(tight.demoted).toEqual(['workflow_step']);
    expect(tight.nodes.some((n) => n.kind === 'workflow_step')).toBe(false);
    expect(tight.nodes.filter((n) => n.kind === 'agent')).toHaveLength(12);
    expect(tight.groups.find((g) => g.kind === 'workflow_step')).toMatchObject({ domain: 'RECORDS', count: 3 });
    expect(tight.edges).toHaveLength(3);
    expect(tight.edgesTruncated).toBe(true);
    expect(tight.counts.indexed).toBe(tight.counts.drawn + tight.counts.grouped);

    // Nothing fits: only the domains stay drawn; everything else is a group, and the counts still add up.
    const floor = await overview(db.sql, { maxNodes: 1, maxEdges: 500 });
    expect(floor.demoted).toEqual(['workflow_step', 'agent', 'module', 'workflow']);
    expect(floor.nodes.map((n) => n.id).sort()).toEqual(DOMAINS.map((d) => `domain:${d}`).sort());
    expect(floor.groups.filter((g) => g.kind === 'agent').map((g) => [g.domain, g.count]).sort()).toEqual([['CORE', 4], ['KNOWLEDGE', 4], ['RECORDS', 4]]);
    expect(floor.counts.indexed).toBe(full.counts.indexed);
  });

  it('gives identical output on two calls', async () => {
    expect(withoutAsOf(await overview(db.sql))).toEqual(withoutAsOf(await overview(db.sql)));
  });

  it('an empty workspace: the six domains and the hub, no group with zero members', async () => {
    const o = await overview(empty.sql);
    expect(o.nodes.map((n) => n.id).sort()).toEqual(DOMAINS.map((d) => `domain:${d}`).sort());
    expect(o.groups).toEqual([]);
    expect(o.edges).toEqual([]);
    expect(o.counts).toEqual({ indexed: 6, drawn: 6, grouped: 0 });
    expect(o.hub.id).toMatch(/^app:/);
  });
});
