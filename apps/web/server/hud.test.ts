import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { scanRoots } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, type TestDb } from '../../../tests/helpers/db.ts';
import { hudComponents, hudStatus } from './hud-loaders.ts';

// Mercury HUD (F52): what /api/graph/components and /api/system/status answer, against a scanned fixture root.
// Pinned: sub-component file counts add up to the indexed total; the aggregated links, the internal edges and the
// edges with a record end add up to graph_edges; no secret value reaches the status.

let db: TestDb;
const root = mkdtempSync(join(tmpdir(), 'hud-root-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'hud-vault-'));
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const agent = (name: string, domain: string, model = 'none') =>
  `---\nname: ${name}\nclass: Execution\ndomain: ${domain}\ntools: []\nmodel: ${model}\n---\n\n## Role\n\n[FIXTURE]\n\n## Contract\n\nx\n\n## Refuses\n\nx\n`;

beforeAll(async () => {
  db = await createTestDb('hud_components', { migrated: true });
  put('core/orchestrator/a.ts', "import { v } from '../../records/x3lius/vocal-dna/v.ts';\nexport const a = v;\n");
  put('core/orchestrator/b.ts', "import { a } from './a.ts';\nexport const b = a;\n");
  put('records/x3lius/vocal-dna/v.ts', 'export const v = 1;\n');
  put('records/x3lius/music-system.ts', "import { a } from '../../core/orchestrator/a.ts';\nexport const m = a;\n");
  put('docs/notes.md', '# [FIXTURE] notes\n');
  put('agents/x3lius-vocal-dna.agent.md', agent('x3lius-vocal-dna', 'RECORDS', 'claude-sonnet-5'));
  put('agents/records-catalog.agent.md', agent('records-catalog', 'RECORDS'));
  put('records/workflows/hud.workflow.yaml', 'name: hud\ndescription: x\nsteps:\n  - id: one\n    agent: x3lius-vocal-dna\n  - id: two\n    agent: records-catalog\n    dependsOn: [one]\n');
  expect((await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir) })).status).toBe('success');
}, 180_000);
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('hudComponents', () => {
  it('matches every indexed file to exactly one sub-component', async () => {
    const c = await hudComponents(db.sql);
    const n = (await db.sql<{ n: number }[]>`select count(*)::int as n from graph_nodes where kind = 'file'`)[0]!.n;
    expect(c.totals.files).toBe(n);
    expect(c.components.reduce((s, r) => s + r.fileCount, 0)).toBe(n);
    const all = c.components.flatMap((r) => r.fileIds);
    expect(new Set(all).size).toBe(all.length);
    const byId = new Map(c.components.map((r) => [r.id, r]));
    expect(byId.get('CORE:orchestrator')).toMatchObject({ status: 'built', fileCount: 2 });
    expect(byId.get('RECORDS:vocal-dna')?.fileIds).toEqual(['file:repo/agents/x3lius-vocal-dna.agent.md', 'file:repo/records/x3lius/vocal-dna/v.ts']);
    expect(byId.get('RECORDS:other')?.fileIds).toContain('file:repo/records/x3lius/music-system.ts');
    expect(byId.get('shared')?.fileIds).toContain('file:repo/docs/notes.md');
    expect(byId.get('GOVERNANCE:legal')).toMatchObject({ status: 'reserved', fileCount: 0, fileIds: [] });
  });

  it('discloses its links as aggregates of graph_edges: aggregated + internal + unmapped = every edge', async () => {
    const c = await hudComponents(db.sql);
    const n = (await db.sql<{ n: number }[]>`select count(*)::int as n from graph_edges`)[0]!.n;
    expect(c.totals.edges).toBe(n);
    expect(c.totals.aggregated + c.totals.internal + c.totals.unmapped).toBe(n);
    expect(c.links.reduce((s, l) => s + l.count, 0)).toBe(c.totals.aggregated);
    // a.ts imports vocal-dna/v.ts; music-system.ts imports a.ts; b.ts → a.ts stays inside Orchestrator.
    expect(c.links).toContainEqual({ from: 'CORE:orchestrator', to: 'RECORDS:vocal-dna', relation: 'imports', count: 1 });
    expect(c.links).toContainEqual({ from: 'RECORDS:other', to: 'CORE:orchestrator', relation: 'imports', count: 1 });
    expect(c.totals.internal).toBeGreaterThanOrEqual(1);
    expect(c.components.find((r) => r.id === 'CORE:orchestrator')?.topFiles[0]).toMatchObject({ path: 'core/orchestrator/a.ts' });
  });
});

describe('hudStatus', () => {
  it('counts agents from the registry and never returns a key value', async () => {
    const registry = createAgentRegistry({ dir: join(root, 'agents') });
    const s = await hudStatus(db.sql, { ANTHROPIC_API_KEY: 'sk-SECRET-FIXTURE' }, registry);
    expect(s.agents).toMatchObject({ registered: 2, llm: 1, deterministic: 1 });
    expect(s.counts.workflowsDefined).toBe(1);
    expect(s.runsPerHour).toHaveLength(24);
    expect(s.lastScan?.status).toBe('success');
    expect(JSON.stringify(s)).not.toContain('sk-SECRET-FIXTURE');
  });
});
