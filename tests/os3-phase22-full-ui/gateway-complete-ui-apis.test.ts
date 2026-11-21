import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDawAdapter } from '../../core/daw-brain/fake-adapter.ts';
import { DawGatewayController, setDawGatewayController } from '../../core/gateway/daw-gateway.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const tempDirs: string[] = [];
const openDbs: SqliteRuntimeDb[] = [];
const openServers: Os3GatewayServerHandle[] = [];

const startTestGateway = async (options: { readonly authToken?: string } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-p22-gw-'));
  tempDirs.push(dir);
  const vaultRoot = join(dir, 'vault');
  await bootstrapAndSyncVault({ vaultRoot, repoRoot: REPO_ROOT });
  const db = openRuntimeDb(join(dir, 'os3.sqlite'));
  openDbs.push(db);
  const vault = new VaultEngine({ vaultRoot, db });
  await vault.scanVault({ full: true });
  const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

  const offlineProbe = {
    probeHost: async () =>
      ({
        probedAt: new Date().toISOString(),
        installations: [],
        runningProcesses: [],
        midiInPorts: [],
        midiOutPorts: [],
        loopMidiInstalled: false,
        configuredInPortFound: false,
        configuredOutPortFound: false,
        controllerScriptPath: 'none',
        controllerScriptInstalled: false,
        userProjectsRoot: '',
        pluginDatabaseRoot: '',
        missingPrerequisites: ['host_not_running'],
        warnings: [],
      }) as never,
    discoverProjects: () => [],
    scanInstalledPlugins: () => [],
  };

  const controller = new DawGatewayController(runtime, {
    adapters: [new FakeDawAdapter()],
    flHostProbe: offlineProbe,
    reaperHostProbe: offlineProbe,
  });
  setDawGatewayController(runtime, controller);

  const server = await startOs3GatewayServer(runtime, {
    host: '127.0.0.1',
    port: 0,
    authToken: options.authToken,
  });
  openServers.push(server);
  return { server, runtime, vault, db };
};

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => undefined);
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Phase 22 — Complete OS3 Gateway UI Integration APIs', () => {
  it('exposes /api/modules, /api/governance, and /api/diagnostics with live runtime and DAW telemetry', async () => {
    const { server, db } = await startTestGateway();

    const locked = db.acquireLock('vault:01_CORE/test-lock.md', 'agent-lock-tester', 60_000);
    expect(locked).toBe(true);

    // Queue an approval through Jarvis promote flow
    await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'xyp3rn> promote Phase 22 Policy Verification' }),
    });

    const [modRes, govRes, diagRes] = await Promise.all([
      fetch(`${server.url}/api/modules`),
      fetch(`${server.url}/api/governance`),
      fetch(`${server.url}/api/diagnostics`),
    ]);

    expect(modRes.status).toBe(200);
    const mods = (await modRes.json()) as {
      ok: boolean;
      modules: Array<{ id: string; name: string; status: string }>;
    };
    expect(mods.ok).toBe(true);
    expect(mods.modules.some((m) => m.id === 'context-engine' && m.status === 'healthy')).toBe(true);
    expect(mods.modules.some((m) => m.id === 'daw-brain')).toBe(true);
    expect(mods.modules.some((m) => m.id === 'plugin-brain')).toBe(true);
    expect(mods.modules.some((m) => m.id === 'audio-brain')).toBe(true);

    expect(govRes.status).toBe(200);
    const gov = (await govRes.json()) as {
      ok: boolean;
      enforcedInvariants: Array<{ id: string; enforced: boolean }>;
      counts: { activeLocks: number; pendingApprovals: number };
      activeLocks: Array<{ resourceKey: string; ownerId: string }>;
    };
    expect(gov.ok).toBe(true);
    expect(gov.enforcedInvariants.some((i) => i.id === 'F35-D2' && i.enforced)).toBe(true);
    expect(gov.enforcedInvariants.some((i) => i.id === 'LOCALHOST-BINDING' && i.enforced)).toBe(true);
    expect(gov.counts.activeLocks).toBeGreaterThanOrEqual(1);
    expect(gov.activeLocks.some((l) => l.resourceKey === 'vault:01_CORE/test-lock.md' && l.ownerId === 'agent-lock-tester')).toBe(true);
    expect(gov.counts.pendingApprovals).toBe(1);

    expect(diagRes.status).toBe(200);
    const diag = (await diagRes.json()) as {
      ok: boolean;
      sqlite: { open: boolean; integrityOk: boolean };
      vault: { totalIndexedFiles: number };
      agents: { loadedCount: number };
      dawHealth: { adaptersRegistered: number; state: string } | null;
    };
    expect(diag.ok).toBe(true);
    expect(diag.sqlite.open).toBe(true);
    expect(diag.sqlite.integrityOk).toBe(true);
    expect(diag.vault.totalIndexedFiles).toBeGreaterThanOrEqual(60);
    expect(diag.agents.loadedCount).toBe(52);
    expect(diag.dawHealth?.adaptersRegistered).toBeGreaterThanOrEqual(1);
  });

  it('indexes all OS3 sectors in /api/vault/tree including 06_RECORDS and 09_X3LIUS_MUSIC', async () => {
    const { server, vault } = await startTestGateway();

    await vault.writeNote({
      vaultPath: '06_RECORDS/00_Songs/phase22-song.md',
      content: '---\ntitle: "Phase 22 Song Record"\ntype: song\ndomain: RECORDS\ntags: [music]\n---\n\n# Phase 22 Song Record\n\nBody.\n',
      actor: 'records-catalog',
    });
    await vault.writeNote({
      vaultPath: '09_X3LIUS_MUSIC/01_Releases/phase22-release.md',
      content: '---\ntitle: "Phase 22 Release"\ntype: release\ndomain: X3LIUS_MUSIC\ntags: [release]\n---\n\n# Phase 22 Release\n\nBody.\n',
      actor: 'records-catalog',
    });

    const treeRes = await fetch(`${server.url}/api/vault/tree`);
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as {
      ok: boolean;
      sectors: Array<{ sector: string; totalIndexed: number }>;
    };
    expect(tree.ok).toBe(true);
    const sectorNames = tree.sectors.map((s) => s.sector);
    expect(sectorNames).toContain('01_CORE');
    expect(sectorNames).toContain('03_RESEARCH_INTELLIGENCE');
    expect(sectorNames).toContain('06_RECORDS');
    expect(sectorNames).toContain('09_X3LIUS_MUSIC');
  });

  it('executes registered agents via POST /api/agents/run and enforces class permissions', async () => {
    const { server, runtime, db } = await startTestGateway();

    const researchAgent = runtime.agents.list().find((a) => a.class !== 'Execution');
    const executionAgent = runtime.agents.list().find((a) => a.class === 'Execution');
    expect(researchAgent).toBeDefined();
    expect(executionAgent).toBeDefined();

    // 1. Read-only analyze on non-Execution agent -> 200
    const analyzeRes = await fetch(`${server.url}/api/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: researchAgent!.name, goal: 'architecture verification', mode: 'analyze' }),
    });
    expect(analyzeRes.status).toBe(200);
    const analyzeBody = (await analyzeRes.json()) as {
      ok: boolean;
      run: { id: string; agentName: string; status: string };
      output: { summary: string };
    };
    expect(analyzeBody.ok).toBe(true);
    expect(analyzeBody.run.agentName).toBe(researchAgent!.name);
    expect(analyzeBody.run.status).toBe('success');

    // 2. Mutating execute mode on non-Execution agent -> 403 PERMISSION_DENIED
    const deniedRes = await fetch(`${server.url}/api/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: researchAgent!.name, goal: 'mutate state', mode: 'execute' }),
    });
    expect(deniedRes.status).toBe(403);
    const deniedBody = (await deniedRes.json()) as { ok: boolean; code: string; error: string };
    expect(deniedBody.ok).toBe(false);
    expect(deniedBody.code).toBe('PERMISSION_DENIED');

    // 3. Execute mode on Execution-class agent -> 200
    const execRes = await fetch(`${server.url}/api/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: executionAgent!.name, goal: 'run verified check', mode: 'execute' }),
    });
    expect(execRes.status).toBe(200);

    // 4. Unknown agent -> 404
    const missingRes = await fetch(`${server.url}/api/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'nonexistent-agent', goal: 'ping', mode: 'analyze' }),
    });
    expect(missingRes.status).toBe(404);

    // Verify SQLite events recorded
    const events = db.listEvents({ limit: 20 });
    expect(events.some((e) => e.eventType === 'agent.run.completed' && e.actor === researchAgent!.name)).toBe(true);
  });

  it('triggers workflow definitions via POST /api/workflows/run and validates required inputs', async () => {
    const { server } = await startTestGateway();

    const wfListRes = await fetch(`${server.url}/api/workflows`);
    const wfList = (await wfListRes.json()) as {
      workflows: Array<{ name: string; requiredInputs: string[]; stepCount: number }>;
    };
    const targetWf = wfList.workflows[0];
    expect(targetWf).toBeDefined();

    if (targetWf!.requiredInputs.length > 0) {
      const badRes = await fetch(`${server.url}/api/workflows/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowName: targetWf!.name, inputs: {} }),
      });
      expect(badRes.status).toBe(400);
    }

    const inputs = Object.fromEntries(targetWf!.requiredInputs.map((k) => [k, `phase22-${k}`]));
    const runRes = await fetch(`${server.url}/api/workflows/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowName: targetWf!.name, inputs }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      ok: boolean;
      job: { id: string; name: string; status: string };
      steps: Array<{ stepId: string; status: string }>;
    };
    expect(runBody.ok).toBe(true);
    expect(runBody.job.name).toBe(targetWf!.name);
    expect(runBody.job.status).toBe('success');
    expect(runBody.steps.length).toBe(targetWf!.stepCount);
  });

  it('enforces Bearer / X-XYP-Token authentication across /api/* routes when configured', async () => {
    const { server } = await startTestGateway({ authToken: 'p22-secret-token' });

    // Health stays open for readiness probes
    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);

    // Unauthenticated call returns 401
    const unauthRes = await fetch(`${server.url}/api/modules`);
    expect(unauthRes.status).toBe(401);

    // Authenticated call succeeds
    const authRes = await fetch(`${server.url}/api/modules`, {
      headers: { Authorization: 'Bearer p22-secret-token' },
    });
    expect(authRes.status).toBe(200);
  });
});
