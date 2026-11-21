import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import {
  createLocalDeterministicEmbedder,
  Os3SemanticIndex,
} from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import {
  FlStudio2025Adapter,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';
import {
  AudioBrain,
  buildClippedFixtureWav,
  DawAgentTeam,
  DawSessionIntelligence,
  PluginBrain,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { DawGatewayController, setDawGatewayController } from '../../core/gateway/daw-gateway.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { Os3KnowledgeEngine } from '../../core/knowledge-engine/index.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';
import {
  migrateOs2ResearchToOs3,
  Os3ResearchEngine,
  verifyResearchMigrationParity,
  type Os2ResearchExportPayload,
} from '../../research-intelligence/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const makeFlHostProbe = (overrides: Partial<FlHostEnvironment> = {}): FlStudioHostProbe => ({
  async probeHost(): Promise<FlHostEnvironment> {
    return {
      probedAt: new Date().toISOString(),
      installations: [
        {
          label: 'FL Studio 2025',
          versionDir: 'C:\\Program Files\\Image-Line\\FL Studio 2025',
          executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe',
          exists: true,
          fileVersion: '25.1.6.4997',
          productVersion: '25.1.6.4997',
          hasCompanionDataDirs: false,
          missingCompanionDirs: ['Data', 'Plugins', 'Shared', 'System'],
        },
      ],
      runningProcesses: [
        {
          pid: 5150,
          processName: 'FL64',
          executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe',
        },
      ],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath:
        'C:\\Users\\test\\Documents\\Image-Line\\FL Studio\\Settings\\Hardware\\XYP3RN_Brain\\device_XYP3RNBrain.py',
      controllerScriptInstalled: true,
      userProjectsRoot: 'C:\\Projects',
      pluginDatabaseRoot: 'C:\\PluginDb',
      missingPrerequisites: [],
      warnings: [],
      ...overrides,
    };
  },
  discoverProjects: () => ['C:\\Projects\\COLDINMYEYES.flp'],
  scanInstalledPlugins: () => [
    {
      name: 'FabFilter Pro-Q 3',
      format: 'VST3',
      path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 3.vst3',
      source: 'vst_filesystem',
      producerEditionStatus: 'third_party_compatible',
    },
  ],
});

const makeOfflineProbe = () =>
  makeFlHostProbe({
    runningProcesses: [],
    midiInPorts: [],
    midiOutPorts: [],
    loopMidiInstalled: false,
    configuredInPortFound: false,
    configuredOutPortFound: false,
    controllerScriptInstalled: false,
    missingPrerequisites: ['host_not_running', 'loopmidi_missing'],
  });

describe('Phase 24 — Complete OS3 + DAW Brain End-to-End Acceptance & All 10 Failure Modes', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const openServers: Os3GatewayServerHandle[] = [];
  const openControllers: DawGatewayController[] = [];

  afterEach(async () => {
    while (openControllers.length > 0) {
      openControllers.pop()?.core.dispose();
    }
    while (openServers.length > 0) {
      await openServers.pop()!.close().catch(() => undefined);
    }
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const createAcceptanceEnv = async (opts: {
    readonly withFlControlledSafe?: boolean;
    readonly flOffline?: boolean;
  } = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p24-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    const sqlitePath = join(dir, 'runtime.sqlite');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(sqlitePath);
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });

    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({ vault, db, provider: createLocalDeterministicEmbedder(64) });
    const knowledge = new Os3KnowledgeEngine({ vault, db, structural, semantic });
    const contextEngine = new Os3ContextEngine({ vault, db, structural, semantic });
    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const agents = new Os3VaultAgentRegistry({
      agentsDir: join(vaultRoot, '04_AGENTS'),
      toolRegistry: tools,
    });
    const orchestrator = new Os3Orchestrator({
      agents,
      tools,
      db,
      handlers: {
        'context-retriever': async (_ctx, inp) => ({
          output: {
            items: [{ id: 'doc-p24-1', query: String(inp.query ?? ''), title: 'OS3 Local Vault Spec' }],
          },
        }),
        'extractive-summarizer': async (_ctx, inp) => ({
          output: {
            summary: `Grounded synthesis for ${(inp.items as unknown[])?.length ?? 1} item(s)`,
          },
        }),
      },
    });
    const workflows = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });

    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    const flTransport = new MockFlMidiTransport({
      allowControlledWrites: opts.withFlControlledSafe ?? false,
      portsPresent: !(opts.flOffline ?? false),
      latencyMs: 1,
    });
    const flProbe = opts.flOffline ? makeOfflineProbe() : makeFlHostProbe();
    const flAdapter = new FlStudio2025Adapter({
      adapterId: 'fl-studio-2025',
      executionProfile: opts.withFlControlledSafe ? 'controlled_safe_v1' : 'read_only',
      midiTransport: flTransport,
      hostProbe: flProbe,
    });
    const controller = new DawGatewayController(runtime, {
      adapters: [flAdapter],
      flHostProbe: flProbe,
    });
    openControllers.push(controller);
    setDawGatewayController(runtime, controller);

    const server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
    openServers.push(server);

    const jarvisCore = new Os3JarvisCore({
      db,
      agents,
      tools,
      contextEngine,
      orchestrator,
      workflows,
    });

    return {
      dir,
      vaultRoot,
      sqlitePath,
      db,
      vault,
      structural,
      semantic,
      knowledge,
      contextEngine,
      tools,
      agents,
      orchestrator,
      workflows,
      runtime,
      controller,
      flAdapter,
      flTransport,
      server,
      jarvisCore,
    };
  };

  it('1. OS3 E2E Scenario: User request -> JARVIS -> Context -> Agent -> Tool checks -> Workflow -> Promotion Gate -> Audit -> UI API', async () => {
    const prevPg = process.env.XYP_DATABASE_URL;
    const prevSupa = process.env.SUPABASE_URL;
    delete process.env.XYP_DATABASE_URL;
    delete process.env.SUPABASE_URL;

    try {
      const env = await createAcceptanceEnv();

      // 1-4. User request -> JARVIS -> Agent selection -> Workflow execution + Tool permissions
      const jarvisRes = await env.jarvisCore.handleDirective('xyp3rn> workflow retrieve-and-summarize', {
        query: 'os3 canonical provenance architecture',
      });
      expect(jarvisRes.ok).toBe(true);

      // Tool permission boundary refuses undeclared write tool on read/analysis agent
      await expect(
        env.tools.execute(
          { agentName: 'evaluation-researcher', agentClass: 'Research', runId: 'p24-perm-1', log: () => undefined },
          'write_obsidian_note',
          { vaultPath: '02_KNOWLEDGE/CANONICAL/Unauthorized.md', content: '# Forbidden\n' },
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED_TOOL' });

      // 5. Context assembly from local Vault + Promotion Gate workflow (human approval required, zero auto-approve)
      const forgedAppr = env.db.queueApproval({
        itemType: 'vault_promotion',
        itemId: 'know-p24-forged',
        proposer: 'knowledge-curator',
        request: { targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Phase24-Forged.md' },
      });
      env.db.decideApproval({
        approvalId: forgedAppr.id,
        decision: 'approved',
        approver: 'knowledge-curator',
        reason: 'Self approval attempt',
      });
      await expect(
        env.knowledge.promoteCandidate({
          approvalId: forgedAppr.id,
          targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Phase24-Forged.md',
          title: 'Forged Self Promotion',
          domain: 'CORE',
          entityId: 'know-p24-forged',
          schema: 'xyp3rn.knowledge/v3',
          sourceRefs: ['doc-p24-1'],
          metadata: {
            type: 'knowledge',
            version: 1,
            created_at: '2026-11-21T08:00:00Z',
            updated_at: '2026-11-21T08:00:00Z',
          },
          provenance: 'test://phase24/forged',
          body: 'Should never promote.',
        }),
      ).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });

      const appr = env.db.queueApproval({
        itemType: 'vault_promotion',
        itemId: 'know-p24-e2e',
        proposer: 'knowledge-curator',
        request: { targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Phase24-E2E.md' },
      });
      // HTTP Gateway blocks self-approval with 403
      const selfDecideRes = await fetch(`${env.server.url}/api/approvals/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId: appr.id,
          decision: 'approved',
          approver: 'knowledge-curator',
          reason: 'Self approval HTTP attempt',
        }),
      });
      expect(selfDecideRes.status).toBe(403);

      const humanDecideRes = await fetch(`${env.server.url}/api/approvals/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalId: appr.id,
          decision: 'approved',
          approver: 'blago-operator',
          reason: 'Phase 24 acceptance promotion verified',
        }),
      });
      expect(humanDecideRes.status).toBe(200);

      const promoted = await env.knowledge.promoteCandidate({
        approvalId: appr.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Phase24-E2E.md',
        title: 'OS3 Promotion Gate Invariant',
        domain: 'CORE',
        entityId: 'know-p24-e2e',
        schema: 'xyp3rn.knowledge/v3',
        sourceRefs: ['doc-p24-1'],
        metadata: {
          type: 'knowledge',
          version: 1,
          created_at: '2026-11-21T08:00:00Z',
          updated_at: '2026-11-21T08:00:00Z',
        },
        provenance: 'test://phase24/os3-e2e',
        body: 'Canonical OS3 writes pass through Promotion Gate and emit SQLite audit events without Postgres.',
      });
      expect((await env.vault.read(promoted.vaultPath)).frontmatter.status).toBe('canonical');

      // Assemble context retrieving newly promoted canonical note
      const ctx = await env.contextEngine.retrieveContext('Promotion Gate canonical OS3 writes');
      expect(ctx.items.some((item) => item.filePath === promoted.vaultPath)).toBe(true);

      // 6. Audit events recorded in SQLite runtime
      expect(env.db.listEvents({ eventType: 'vault.promoted' }).length).toBeGreaterThanOrEqual(1);
      expect(env.db.listEvents({ eventType: 'orchestrator.task.completed' }).length).toBeGreaterThanOrEqual(1);

      // 7. UI Gateway APIs reflect exact live state
      const [ovRes, govRes, noteRes] = await Promise.all([
        fetch(`${env.server.url}/api/overview`),
        fetch(`${env.server.url}/api/governance`),
        fetch(`${env.server.url}/api/vault/note?path=${encodeURIComponent(promoted.vaultPath)}`),
      ]);
      expect(ovRes.status).toBe(200);
      expect(govRes.status).toBe(200);
      expect(noteRes.status).toBe(200);
      const ovJson = (await ovRes.json()) as { ok: boolean; agentCount?: number; runtime?: { completedRuns?: number } };
      expect(ovJson.ok).toBe(true);
      const noteJson = (await noteRes.json()) as { ok: boolean; note: { frontmatter: { status: string } } };
      expect(noteJson.note.frontmatter.status).toBe('canonical');
    } finally {
      if (prevPg !== undefined) process.env.XYP_DATABASE_URL = prevPg;
      if (prevSupa !== undefined) process.env.SUPABASE_URL = prevSupa;
    }
  });

  it('2. DAW Brain E2E Scenario: FL Studio detect -> connect -> observe -> Context + Session + Plugin + Audio Brain -> Agent -> Command Gateway -> Postcondition + Audit + UI API', async () => {
    const env = await createAcceptanceEnv({ withFlControlledSafe: true });

    // Seed approved DAW production knowledge in Vault
    const mixAppr = env.db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'know-fl-vox-headroom',
      proposer: 'x3lius-curator',
      request: { targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-FL-Vocal-Chain.md' },
    });
    env.db.decideApproval({
      approvalId: mixAppr.id,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Seed vocal mix production standard',
    });
    await env.knowledge.promoteCandidate({
      approvalId: mixAppr.id,
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-FL-Vocal-Chain.md',
      title: 'Vocal Chain Headroom Standard',
      domain: 'RECORDS',
      entityId: 'know-fl-vox-headroom',
      schema: 'xyp3rn.knowledge/v3',
      sourceRefs: ['ref-fl-mix'],
      metadata: {
        type: 'knowledge',
        version: 1,
        created_at: '2026-11-21T08:00:00Z',
        updated_at: '2026-11-21T08:00:00Z',
      },
      provenance: 'test://phase24/daw-e2e',
      body: 'Keep master true peak below -1.0 dBTP before Fruity Limiter ceiling stage.',
    });

    // 1-4. FL Studio detected -> connected -> live state observed & normalized
    const instances = await env.controller.core.discoverInstances();
    expect(instances.some((inst) => inst.hostKind === 'fl_studio' && inst.reachable)).toBe(true);

    const connRes = await fetch(`${env.server.url}/api/daw/connections/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adapterId: 'fl-studio-2025',
        projectPath: 'C:\\Projects\\COLDINMYEYES.flp',
        actor: 'blago-operator',
      }),
    });
    expect(connRes.status).toBe(200);
    const { session } = (await connRes.json()) as {
      session: { sessionId: string; hostVersion: string; observed: { stateDigest: string } };
    };
    expect(session.hostVersion).toBe('25.1.6.4997');

    // 5-8. Context + DAW Session Intelligence + Plugin Brain + Audio Brain + Specialist Agent recommendation with evidence
    const clipPath = join(env.dir, 'cold-master-bounce.wav');
    await writeFile(clipPath, buildClippedFixtureWav());
    const audioBrain = new AudioBrain();
    const audioReport = audioBrain.analyzeAudioFile(clipPath, { stage: 'master' });
    expect(audioReport.acquisition.readOnlyVerified).toBe(true);
    expect(audioReport.diagnostics.overallVerdict).toBe('CRITICAL');

    const pluginBrain = new PluginBrain();
    const liveSess = env.controller.core.sessions.getSession(session.sessionId)!;
    pluginBrain.ingestDawSnapshot(liveSess.observed!, 'fl_studio', liveSess.dawId);
    expect(pluginBrain.getProfile('FabFilter Pro-Q 3')?.installation.installedOnHost).toBe('verified_installed');

    const sessionIntel = new DawSessionIntelligence({ contextEngine: env.contextEngine });
    const team = new DawAgentTeam({
      vault: env.vault,
      db: env.db,
      core: env.controller.core,
      sessionIntelligence: sessionIntel,
      pluginBrain,
      audioBrain,
      contextEngine: env.contextEngine,
    });

    const agentRec = await team.runTask({
      agentName: 'daw-audio-quality-analyst',
      goal: 'Evaluate vocal headroom and clipped bounce evidence for COLDINMYEYES',
      mode: 'recommend',
      sessionId: session.sessionId,
      audioFilePath: clipPath,
    });
    expect(agentRec.ok).toBe(true);
    expect(agentRec.toolsInvoked).toContain('daw_audio_brain_analyze');
    expect(agentRec.recommendations.length).toBeGreaterThan(0);

    // 9-12. Proposed command passes capability & permission checks -> human approval -> verified execution -> postcondition & audit -> UI API
    const lease = env.controller.core.grantSessionLease({
      sessionId: session.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['plugin:mixer:2:0'],
      ttlMs: 60_000,
    });

    // Unsupported FL action (`plugin.load_remove`) remains blocked
    await expect(
      env.controller.core.prepareCommand(
        {
          commandId: 'cmd-p24-fl-unsupported',
          sessionId: session.sessionId,
          kind: 'plugin.load_remove',
          capabilityId: 'daw.plugin.load_remove',
          targetRef: 'plugin:mixer:2:0',
          params: {},
          requestedBy: 'daw-operator',
          requestedClass: 'Execution',
          correlationId: 'corr-p24-fl-1',
          createdAt: new Date().toISOString(),
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_CAPABILITY_UNSUPPORTED' });

    const bypassCmd: DawCommand = {
      commandId: 'cmd-p24-fl-bypass',
      sessionId: session.sessionId,
      kind: 'plugin.bypass',
      capabilityId: 'daw.plugin.bypass',
      targetRef: 'plugin:mixer:2:0',
      params: { bypassed: true },
      requestedBy: 'daw-operator',
      requestedClass: 'Execution',
      correlationId: 'corr-p24-fl-2',
      createdAt: new Date().toISOString(),
    };
    const prep = await env.controller.core.prepareCommand(bypassCmd, { leaseId: lease.id, queueApproval: true });
    expect(prep.approvalId).toBeTruthy();

    env.db.decideApproval({
      approvalId: prep.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved bypass A/B check after clipped audio report',
    });

    const exec = await env.controller.core.executeCommand(prep.prepareId, {
      actor: 'daw-operator',
      approvalId: prep.approvalId!,
      leaseId: lease.id,
    });
    expect(exec.ok).toBe(true);
    expect(exec.postconditionVerified).toBe(true);
    expect(exec.verifiedByReadback).toBe(true);
    expect(exec.afterState).toMatchObject({ bypassed: true });

    // Audit & Gateway overview reflect live connected state and receipt
    expect(env.db.listEvents({ eventType: 'daw.command.executed' }).length).toBeGreaterThanOrEqual(1);
    const dawOvRes = await fetch(`${env.server.url}/api/daw/overview`);
    expect(dawOvRes.status).toBe(200);
    const dawOv = (await dawOvRes.json()) as {
      ok: boolean;
      connectionSummary: { state: string; currentDaw: string };
      executionHistory: ReadonlyArray<{ receiptId: string }>;
    };
    expect(dawOv.ok).toBe(true);
    expect(dawOv.connectionSummary.currentDaw).toMatch(/^fl-studio-25\./);
    expect(dawOv.executionHistory.some((r) => r.receiptId === exec.receiptId)).toBe(true);
  });

  it('3. Failure Scenarios 1–9: DAW offline, mid-op disconnect, stale state, unsupported cmd, invalid param, duplicate cmd, agent timeout, Vault missing, DB closed', async () => {
    // Failure 1: DAW unavailable
    const offlineEnv = await createAcceptanceEnv({ flOffline: true });
    await expect(
      offlineEnv.controller.core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' }),
    ).rejects.toMatchObject({ code: 'DAW_HOST_OFFLINE' });

    // Scenarios 2–6 on connected FL Studio controlled session
    const env = await createAcceptanceEnv({ withFlControlledSafe: true });
    const sess = await env.controller.core.connectSession('fl-studio-2025', {
      projectPath: 'C:\\Projects\\COLDINMYEYES.flp',
    });
    const lease = env.controller.core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    // Failure 4: Unsupported command
    await expect(
      env.controller.core.prepareCommand(
        {
          commandId: 'cmd-f4-unsup',
          sessionId: sess.sessionId,
          kind: 'track.create_delete',
          capabilityId: 'daw.track.create_delete',
          targetRef: 'mixer:insert:3',
          params: {},
          requestedBy: 'daw-operator',
          requestedClass: 'Execution',
          correlationId: 'corr-f4',
          createdAt: new Date().toISOString(),
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_CAPABILITY_UNSUPPORTED' });

    // Failure 5: Invalid parameter (+12 dB excessive gain jump violates safety clamp)
    await expect(
      env.controller.core.prepareCommand(
        {
          commandId: 'cmd-f5-param',
          sessionId: sess.sessionId,
          kind: 'mixer.volume_pan_mute',
          capabilityId: 'daw.mixer.fader_pan_mute',
          targetRef: 'mixer:insert:1',
          params: { deltaDb: 12 },
          requestedBy: 'daw-operator',
          requestedClass: 'Execution',
          correlationId: 'corr-f5',
          createdAt: new Date().toISOString(),
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

    // Failure 6: Duplicate command blocked cleanly
    const dupCmd: DawCommand = {
      commandId: 'cmd-f6-dup-1',
      sessionId: sess.sessionId,
      kind: 'plugin.bypass',
      capabilityId: 'daw.plugin.bypass',
      targetRef: 'plugin:mixer:2:0',
      params: { bypassed: true },
      requestedBy: 'daw-operator',
      requestedClass: 'Execution',
      correlationId: 'corr-f6-a',
      createdAt: new Date().toISOString(),
    };
    const prepDup = await env.controller.core.prepareCommand(dupCmd, { leaseId: lease.id, queueApproval: true });
    env.db.decideApproval({
      approvalId: prepDup.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'First approved execution',
    });
    const firstExec = await env.controller.core.executeCommand(prepDup.prepareId, {
      actor: 'daw-operator',
      approvalId: prepDup.approvalId!,
      leaseId: lease.id,
    });
    expect(firstExec.ok).toBe(true);

    // Replaying exact commandId must be rejected cleanly
    await expect(
      env.controller.core.prepareCommand(
        { ...dupCmd, correlationId: 'corr-f6-replay' },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_DUPLICATE_COMMAND' });

    // Failure 3: Stale session state detected cleanly before disconnect
    env.controller.core.sessions.markStale(sess.sessionId, 'Simulated stale snapshot age');
    await expect(
      env.controller.core.prepareCommand(
        {
          ...dupCmd,
          commandId: 'cmd-f3-stale-check',
          correlationId: 'corr-f3-stale',
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_STALE_STATE' });
    await env.controller.core.refreshSession(sess.sessionId);

    // Failure 2: DAW disconnects mid-operation -> marks session stale & blocks mutations cleanly
    env.flTransport.setOffline(true, 'FL64 terminated mid-session');
    const downHealth = await env.controller.core.checkHealth(sess.sessionId);
    expect(downHealth.reachable).toBe(false);
    expect(env.controller.core.sessions.getSession(sess.sessionId)?.stale).toBe(true);
    await expect(
      env.controller.core.prepareCommand(
        {
          ...dupCmd,
          commandId: 'cmd-f2-after-disconnect',
          correlationId: 'corr-f2',
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_HOST_OFFLINE' });

    // Failure 7: Agent timeout handled deterministically without hanging
    const timeoutOrch = new Os3Orchestrator({
      agents: env.agents,
      tools: env.tools,
      db: env.db,
      handlers: {
        'context-retriever': async (ctx) => {
          await new Promise<void>((resolveWait) => {
            const t = setTimeout(resolveWait, 250);
            ctx.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolveWait();
              },
              { once: true },
            );
          });
          return { output: { items: [] } };
        },
      },
    });
    const timeoutRes = await timeoutOrch.executeSingleAgent(
      'context-retriever',
      { query: 'timeout test' },
      { timeoutMs: 35, maxRetries: 0 },
    );
    expect(timeoutRes.status).toBe('error');
    expect(timeoutRes.error).toMatch(/timeout after 35ms/i);

    // Failure 8: Vault unavailable throws cleanly without corrupting SQLite runtime
    await rm(env.vaultRoot, { recursive: true, force: true });
    await expect(env.vault.read('02_KNOWLEDGE/CANONICAL/MissingAfterDelete.md')).rejects.toThrow();

    // Failure 9: Runtime database unavailable throws cleanly instead of silently succeeding
    env.db.close();
    expect(() => env.db.listEvents({ limit: 5 })).toThrow();
  });

  it('4. Failure Scenario 10: Interrupted OS2 migration preserves prior files/legacy sources safely and resumes idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p24-mig-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const research = new Os3ResearchEngine({ vault, db });

    // Legacy read-only markdown directory must stay untouched across crash + resume
    const legacyDir = join(dir, 'legacy-research');
    await mkdir(legacyDir, { recursive: true });
    const legacyBrief = join(legacyDir, 'legacy-brief.md');
    const legacyRaw = '---\ntitle: Legacy Note\n---\n\nUnmigrated legacy note\n';
    await writeFile(legacyBrief, legacyRaw, 'utf8');

    const payload: Os2ResearchExportPayload = {
      exportedAt: '2026-11-21T08:00:00.000Z',
      sourceSystem: 'supabase-os2-export',
      projects: [
        { id: 'aaaaaaaa-0000-0000-0000-000000000001', slug: 'p24-proj-one', title: 'P24 Project One', status: 'open' },
        { id: 'aaaaaaaa-0000-0000-0000-000000000002', slug: 'p24-proj-two', title: 'P24 Project Two', status: 'open' },
      ],
      questions: [
        {
          id: 'bbbbbbbb-0000-0000-0000-000000000001',
          project_id: 'aaaaaaaa-0000-0000-0000-000000000001',
          question: 'Does interrupted batch resume cleanly?',
          intended_use: 'Phase 24 interrupted migration recovery check',
          status: 'answered',
        },
      ],
      runs: [
        {
          id: 'cccccccc-0000-0000-0000-000000000001',
          question_id: 'bbbbbbbb-0000-0000-0000-000000000001',
          status: 'success',
          selected_specialists: ['evaluation-researcher'],
          completed_at: '2026-11-21T08:05:00.000Z',
        },
      ],
      sources: [
        {
          id: 'dddddddd-0000-0000-0000-000000000001',
          kind: 'doc',
          uri: 'https://xyp3rn.local/spec/resumable-migration',
          title: 'Resumable Migration Spec',
          text: 'Checkpointed migration resumes cleanly after crash without overwriting committed files.',
          reliability: 0.95,
        },
      ],
      evidence: [
        {
          id: 'eeeeeeee-0000-0000-0000-000000000001',
          research_run_id: 'cccccccc-0000-0000-0000-000000000001',
          research_source_id: 'dddddddd-0000-0000-0000-000000000001',
          specialist: 'evaluation-researcher',
          claim: 'Resumable migration avoids duplicates after mid-batch interruption.',
          quote: 'Checkpointed migration resumes cleanly after crash',
          uncertainty_note: 'Tested with fault injection on write #3.',
          claim_topic: 'migration.resumability',
          claim_value: { idempotent: true },
          model_tag: 'model-agnostic',
          confidence: 0.9,
          confidence_inputs: { n: 1 },
        },
      ],
      findings: [
        {
          id: 'ffffffff-0000-0000-0000-000000000001',
          research_run_id: 'cccccccc-0000-0000-0000-000000000001',
          claim: 'OS2 Research migrator recovers cleanly after mid-run failure.',
          claim_topic: 'migration.resumability',
          claim_value: { idempotent: true },
          model_tag: 'model-agnostic',
          confidence: 0.65,
          uncertainty_note: 'Verified with simulated crash on third Vault write.',
          evidence_ids: ['eeeeeeee-0000-0000-0000-000000000001'],
        },
      ],
      contradictions: [],
      experiments: [],
      experimentRuns: [],
      researchLinks: [],
      findingDecisions: [],
    };

    // Inject mid-batch I/O interruption on Vault write #3
    const origWrite = vault.write.bind(vault);
    let writeCalls = 0;
    (vault as { write: typeof vault.write }).write = (async (...args: Parameters<typeof vault.write>) => {
      writeCalls += 1;
      if (writeCalls === 3) {
        throw new Error('Simulated power/disk interruption mid-migration');
      }
      return origWrite(...args);
    }) as typeof vault.write;

    try {
      await expect(
        migrateOs2ResearchToOs3({
          payload,
          vault,
          db,
          research,
          legacyMarkdownRootDirs: [legacyDir],
        }),
      ).rejects.toThrow(/Simulated power\/disk interruption/i);
    } finally {
      (vault as { write: typeof vault.write }).write = origWrite;
    }

    // Prior 2 committed files remain intact and valid; legacy markdown untouched
    const proj1 = await vault.read('03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-p24-proj-one.md');
    expect(proj1.frontmatter.title).toBe('P24 Project One');
    expect(await readFile(legacyBrief, 'utf8')).toBe(legacyRaw);

    // Resume migration cleanly -> skips already-committed entities idempotently and migrates remainder
    const resumedReport = await migrateOs2ResearchToOs3({
      payload,
      vault,
      db,
      research,
      legacyMarkdownRootDirs: [legacyDir],
    });
    expect(resumedReport.legacyDataUntouched).toBe(true);
    expect(resumedReport.totals.skippedIdempotentCount).toBeGreaterThanOrEqual(2);
    expect(resumedReport.totals.migratedCount).toBeGreaterThanOrEqual(4);
    expect(resumedReport.conflicting).toEqual([]);

    const parity = await verifyResearchMigrationParity({ payload, report: resumedReport, vault, db });
    expect(parity.ok).toBe(true);
    expect(parity.discrepancies).toEqual([]);
  });
});
