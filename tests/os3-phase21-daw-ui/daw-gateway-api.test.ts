import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDawAdapter } from '../../core/daw-brain/fake-adapter.ts';
import { DawGatewayController, setDawGatewayController } from '../../core/gateway/daw-gateway.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const tempDirs: string[] = [];
const openDbs: SqliteRuntimeDb[] = [];
const openServers: Os3GatewayServerHandle[] = [];

const startTestGateway = async (options: { readonly withSimulatedDaw?: boolean } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-p21-gw-'));
  tempDirs.push(dir);
  const vaultRoot = join(dir, 'vault');
  await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
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

  const simAdapter = options.withSimulatedDaw ? new FakeDawAdapter() : null;
  const controller = new DawGatewayController(runtime, {
    adapters: simAdapter ? [simAdapter] : undefined,
    flHostProbe: offlineProbe,
    reaperHostProbe: offlineProbe,
  });
  setDawGatewayController(runtime, controller);

  const server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
  openServers.push(server);
  return { server, controller, simAdapter, runtime };
};

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => undefined);
  }
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Phase 21 — OS3 Gateway DAW Brain API (/api/daw/*)', () => {
  it('honestly reports disconnected host state without fabricating live sessions', async () => {
    const { server } = await startTestGateway({ withSimulatedDaw: false });

    const res = await fetch(`${server.url}/api/daw/overview`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.isDemoFixture).toBe(false);
    expect(data.dataSource).toBe('os3-gateway-live');

    const conn = data.connectionSummary as Record<string, unknown>;
    expect(conn.state).toBe('disconnected');
    expect(conn.connectedSessions).toBe(0);
    expect(conn.currentDaw).toBeNull();
    expect(conn.currentProject).toBeNull();

    const caps = data.capabilities as { available: unknown[]; unsupported: unknown[] };
    expect(caps.available.length).toBeGreaterThan(0);
    expect(caps.unsupported.length).toBeGreaterThan(0);

    // Refresh on disconnected session fails cleanly instead of fabricating state
    const refreshRes = await fetch(`${server.url}/api/daw/sessions/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'missing-session' }),
    });
    expect(refreshRes.status).toBe(404);
  });

  it('connects a session, enforces F35 D2 approvals, executes commands, supports rollback, and runs agents/evals', async () => {
    const { server, controller, simAdapter } = await startTestGateway({ withSimulatedDaw: true });
    expect(simAdapter).not.toBeNull();

    const connectRes = await fetch(`${server.url}/api/daw/connections/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: simAdapter!.manifest.adapterId, actor: 'operator-ui' }),
    });
    expect(connectRes.status).toBe(200);
    const connectJson = (await connectRes.json()) as { session: { sessionId: string } };
    const sessionId = connectJson.session.sessionId;

    // Agent Console dispatch in analyze mode + block direct execute
    const agRes = await fetch(`${server.url}/api/daw/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: 'daw-session-analyst',
        goal: 'Inspect live routing and session structure',
        mode: 'analyze',
        sessionId,
      }),
    });
    expect(agRes.status).toBe(200);

    const badModeRes = await fetch(`${server.url}/api/daw/agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: 'daw-operator',
        goal: 'Mutate directly',
        mode: 'execute_with_approval',
        sessionId,
      }),
    });
    expect(badModeRes.status).toBe(403);

    // Proposing without active prepare lease is denied with 403
    const unleasedRes = await fetch(`${server.url}/api/daw/commands/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        kind: 'mixer.volume_pan_mute',
        capabilityId: 'daw.mixer.fader_pan_mute',
        targetRef: 'mixer:insert:1',
        params: { deltaDb: -1.5 },
        proposer: 'daw-operator-draft',
      }),
    });
    expect(unleasedRes.status).toBe(403);

    // Operator grants scoped prepare lease -> propose mutable mixer trim (-1.5 dB) -> pending approval
    const leaseRes = await fetch(`${server.url}/api/daw/sessions/lease`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        grantedBy: 'blago-operator',
        allowedTargets: ['mixer:insert:1'],
      }),
    });
    expect(leaseRes.status).toBe(200);
    const leaseJson = (await leaseRes.json()) as { lease: { id: string } };

    const propRes = await fetch(`${server.url}/api/daw/commands/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        kind: 'mixer.volume_pan_mute',
        capabilityId: 'daw.mixer.fader_pan_mute',
        targetRef: 'mixer:insert:1',
        params: { deltaDb: -1.5 },
        proposer: 'daw-operator-draft',
        leaseId: leaseJson.lease.id,
      }),
    });
    expect(propRes.status).toBe(200);
    const propJson = (await propRes.json()) as { approvalId: string };

    // Agent/self approval blocked with 403
    const selfAppr = await fetch(`${server.url}/api/daw/commands/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approvalId: propJson.approvalId,
        decision: 'approved',
        approver: 'agent:auto-mixer',
        reason: 'Self approval attempt',
      }),
    });
    expect(selfAppr.status).toBe(403);

    // Human operator approves -> executes cleanly and records receipt
    const humanAppr = await fetch(`${server.url}/api/daw/commands/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approvalId: propJson.approvalId,
        decision: 'approved',
        approver: 'blago-operator',
        reason: 'Gain staging verified against headroom target',
        confirmDangerous: true,
      }),
    });
    expect(humanAppr.status).toBe(200);
    const execJson = (await humanAppr.json()) as {
      ok: boolean;
      executionResult: { ok: boolean; receiptId?: string; rollbackSupported: boolean };
    };
    expect(execJson.ok).toBe(true);
    expect(execJson.executionResult.ok).toBe(true);
    const receiptId = execJson.executionResult.receiptId!;
    expect(receiptId).toBeTruthy();

    // Rollback supported receipt succeeds
    const rbRes = await fetch(`${server.url}/api/daw/commands/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId, actor: 'blago-operator', reason: 'Revert A/B gain change' }),
    });
    expect(rbRes.status).toBe(200);

    // Trigger DAW Evaluation benchmark via gateway
    const evalRes = await fetch(`${server.url}/api/daw/evaluate`, { method: 'POST' });
    expect(evalRes.status).toBe(200);
    const evalJson = (await evalRes.json()) as { ok: boolean; evaluationScope: string; report: { totalCases: number } };
    expect(evalJson.ok).toBe(true);
    expect(evalJson.report.totalCases).toBeGreaterThanOrEqual(12);

    const overviewAfter = await controller.buildOverview();
    expect(overviewAfter.executionHistory.length).toBeGreaterThanOrEqual(1);
    expect(overviewAfter.evaluation).not.toBeNull();
  });
});
