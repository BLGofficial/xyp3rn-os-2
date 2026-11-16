import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('OS 3.0 Phase 11 — UI-xyp3rn Gateway Data API Endpoints', () => {
  let tempVault: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-ui-gw-'));
    db = openRuntimeDb(':memory:');
    vault = new VaultEngine({ vaultRoot: tempVault, db });
    await bootstrapAndSyncVault({ vaultRoot: tempVault, repoRoot: REPO_ROOT });
    await vault.scanVault();
    runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    db.close();
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined);
  });

  it('serves /api/overview with system stats, agents, workflows, runtime counts, and pending approvals', async () => {
    await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'xyp3rn> flow daily-digest test-run' }),
    });
    await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'xyp3rn> promote Test Insight' }),
    });

    const res = await fetch(`${server.url}/api/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      integrityOk: boolean;
      agents: { total: number };
      workflows: { total: number; names: string[] };
      runtime: { pendingApprovals: number; recentJobsCount: number };
      indexStats: { totalFiles: number };
    };
    expect(body.ok).toBe(true);
    expect(body.integrityOk).toBe(true);
    expect(body.agents.total).toBe(52);
    expect(body.workflows.total).toBeGreaterThanOrEqual(4);
    expect(body.runtime.pendingApprovals).toBe(1);
    expect(body.runtime.recentJobsCount).toBeGreaterThanOrEqual(1);
    expect(body.indexStats.totalFiles).toBeGreaterThanOrEqual(68);
  });

  it('serves /api/vault/tree grouped by sectors and folders and /api/vault/graph with nodes and edges', async () => {
    const a = await vault.writeNote({
      vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/source-note.md',
      content: '---\ntitle: "Source Note"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [x]\n---\n\n# Source Note\n\nBody.\n',
      actor: 'research-orchestrator',
    });
    await vault.writeNote({
      vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/linking-note.md',
      content: `---\ntitle: "Linking Note"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [x]\n---\n\n# Linking Note\n\nSee [[${a.vaultPath}|Source Note]].\n`,
      actor: 'research-orchestrator',
    });

    const treeRes = await fetch(`${server.url}/api/vault/tree?sector=03_RESEARCH_INTELLIGENCE`);
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as {
      ok: boolean;
      sectors: Array<{ sector: string; folders: Array<{ folder: string; count: number }> }>;
    };
    expect(tree.ok).toBe(true);
    expect(tree.sectors).toHaveLength(1);
    expect(tree.sectors[0]!.sector).toBe('03_RESEARCH_INTELLIGENCE');
    expect(tree.sectors[0]!.folders.some((f) => f.folder === '00_Briefs' && f.count >= 2)).toBe(true);

    const graphRes = await fetch(`${server.url}/api/vault/graph?sector=03_RESEARCH_INTELLIGENCE`);
    expect(graphRes.status).toBe(200);
    const graph = (await graphRes.json()) as {
      ok: boolean;
      nodeCount: number;
      edgeCount: number;
      edges: Array<{ source: string; target: string }>;
    };
    expect(graph.ok).toBe(true);
    expect(graph.nodeCount).toBeGreaterThanOrEqual(2);
    expect(graph.edgeCount).toBeGreaterThanOrEqual(1);
    expect(
      graph.edges.some(
        (e) =>
          e.source === '03_RESEARCH_INTELLIGENCE/00_Briefs/linking-note.md' &&
          e.target === '03_RESEARCH_INTELLIGENCE/00_Briefs/source-note.md',
      ),
    ).toBe(true);
  });

  it('serves /api/agents, /api/workflows, /api/research, and /api/records', async () => {
    await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'xyp3rn> song new Night Pulse' }),
    });
    await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'xyp3rn> research Local Audio Models' }),
    });

    const [agentsRes, workflowsRes, researchRes, recordsRes] = await Promise.all([
      fetch(`${server.url}/api/agents`),
      fetch(`${server.url}/api/workflows`),
      fetch(`${server.url}/api/research`),
      fetch(`${server.url}/api/records`),
    ]);

    expect(agentsRes.status).toBe(200);
    expect(workflowsRes.status).toBe(200);
    expect(researchRes.status).toBe(200);
    expect(recordsRes.status).toBe(200);

    const agentsBody = (await agentsRes.json()) as { ok: boolean; total: number; agents: Array<{ name: string }> };
    expect(agentsBody.ok).toBe(true);
    expect(agentsBody.total).toBe(52);
    expect(agentsBody.agents.some((a) => a.name === 'research-orchestrator')).toBe(true);

    const wfBody = (await workflowsRes.json()) as { ok: boolean; total: number; workflows: Array<{ name: string }> };
    expect(wfBody.ok).toBe(true);
    expect(wfBody.total).toBeGreaterThanOrEqual(4);

    const researchBody = (await researchRes.json()) as { ok: boolean; counts: { briefs: number; specialists: number } };
    expect(researchBody.ok).toBe(true);
    expect(researchBody.counts.briefs).toBeGreaterThanOrEqual(1);
    expect(researchBody.counts.specialists).toBeGreaterThanOrEqual(10);

    const recordsBody = (await recordsRes.json()) as { ok: boolean; counts: { sunoPrompts: number } };
    expect(recordsBody.ok).toBe(true);
    expect(recordsBody.counts.sunoPrompts).toBeGreaterThanOrEqual(1);
  });
});
