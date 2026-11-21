import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOs3AgentsFromDir,
  Os3VaultAgentRegistry,
} from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { createLocalDeterministicEmbedder, Os3SemanticIndex } from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import {
  AudioBrain,
  buildClippedFixtureWav,
  DAW_AGENT_CATALOG,
  DawAgentTeam,
  DawCore,
  DawSessionIntelligence,
  FakeDawAdapter,
  PluginBrain,
  writeDawAgentDefinitionsToDir,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { Os3KnowledgeEngine } from '../../core/knowledge-engine/index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  FlStudio2025Adapter,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';

const flProbe: FlStudioHostProbe = {
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
      runningProcesses: [{ pid: 8888, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' }],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath: 'C:\\Users\\test\\device_XYP3RNBrain.py',
      controllerScriptInstalled: true,
      userProjectsRoot: 'C:\\Users\\test\\Projects',
      pluginDatabaseRoot: 'C:\\Users\\test\\PluginDb',
      missingPrerequisites: [],
      warnings: [],
    };
  },
  discoverProjects: () => [],
  scanInstalledPlugins: () => [],
};

describe('Phase 15 — XYP3RN DAW Agent Team', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const cores: DawCore[] = [];

  afterEach(async () => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const setupFullEnv = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p15-agents-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await mkdir(vaultRoot, { recursive: true });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({ vault, db, provider: createLocalDeterministicEmbedder(64) });
    const knowledge = new Os3KnowledgeEngine({ vault, db, structural, semantic });
    const contextEngine = new Os3ContextEngine({ vault, db, structural, semantic });

    const core = new DawCore({ db });
    cores.push(core);
    const sessionIntelligence = new DawSessionIntelligence({ contextEngine });
    const pluginBrain = new PluginBrain();
    const audioBrain = new AudioBrain();

    // Provision a canonical X3LIUS song record & approved mix preference
    const appr1 = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'song-coldinmyeyes',
      request: { targetVaultPath: '09_X3LIUS_MUSIC/SONGS/COLDINMYEYES.md' },
      proposer: 'x3lius-curator',
    });
    db.decideApproval({ approvalId: appr1.id, decision: 'approved', approver: 'blago-operator', reason: 'Approve song' });
    await knowledge.promoteCandidate({
      approvalId: appr1.id,
      targetVaultPath: '09_X3LIUS_MUSIC/SONGS/COLDINMYEYES.md',
      title: 'COLDINMYEYES',
      domain: 'RECORDS',
      entityId: 'song-coldinmyeyes',
      schema: 'xyp3rn.song/v3',
      sourceRefs: ['src-p15'],
      metadata: {
        type: 'song',
        artist: 'X3LIUS',
        language: 'en',
        version: 1,
        created_at: '2026-11-20T12:00:00Z',
        updated_at: '2026-11-20T12:00:00Z',
      },
      provenance: 'test://p15/song',
      body: 'Baritone vocal trap track COLDINMYEYES at 138 BPM.',
    });

    const team = new DawAgentTeam({
      vault,
      db,
      core,
      sessionIntelligence,
      pluginBrain,
      audioBrain,
      contextEngine,
    });

    return { dir, vaultRoot, db, vault, core, team, audioBrain, pluginBrain };
  };

  it('1. validates all 12 consolidated Markdown agent definitions cleanly against xyp3rn.agent/v3 & single-class permissions', async () => {
    const { vaultRoot, vault, team } = await setupFullEnv();

    expect(DAW_AGENT_CATALOG).toHaveLength(12);
    expect(team.listAgents()).toHaveLength(12);

    const dawAgentsDir = join(vaultRoot, '04_AGENTS');
    const files = writeDawAgentDefinitionsToDir(dawAgentsDir);
    expect(files).toHaveLength(12);

    const loaded = loadOs3AgentsFromDir(dawAgentsDir, {
      toolRegistry: team.toolRegistry,
      requireV3Schema: true,
    });
    expect(loaded.failures).toEqual([]);
    expect(loaded.agents).toHaveLength(12);

    const vaultReg = new Os3VaultAgentRegistry({
      agentsDir: dawAgentsDir,
      toolRegistry: team.toolRegistry,
    });
    expect(vaultReg.list()).toHaveLength(12);

    for (const ag of loaded.agents) {
      expect(ag.schema).toBe('xyp3rn.agent/v3');
      expect(ag.responsibilities.length).toBeGreaterThan(0);
      expect(ag.procedure.length).toBeGreaterThan(0);
      expect(ag.refusals.length).toBeGreaterThan(0);
      expect(ag.escalation.length).toBeGreaterThan(0);
      expect(ag.sections['Context Requirements']).toBeTruthy();
      expect(ag.sections['Evaluation Criteria']).toBeTruthy();

      const vRes = await vault.validate(`04_AGENTS/${ag.name}.md`, { requireSchema: true });
      expect(vRes.ok).toBe(true);
    }
  });

  it('2. selects appropriate specialists deterministically and enforces analyze-by-default & single-class refusals', async () => {
    const { core, team } = await setupFullEnv();
    core.registerAdapter(new FlStudio2025Adapter({ midiTransport: new MockFlMidiTransport(), hostProbe: flProbe }));
    const sess = await core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' });

    // Agent selection routing checks
    expect(team.selectAgentForTask('Check session arrangement and snapshot drift').name).toBe('daw-session-analyst');
    expect(team.selectAgentForTask('Inspect vocal chain and baritone pitch plugin compatibility').name).toBe('daw-vocal-engineer');
    expect(team.selectAgentForTask('Check master loudness LUFS and limiter placement').name).toBe('daw-mastering-engineer');
    expect(team.selectAgentForTask('Trace disconnected routing buses and sidechain send').name).toBe('daw-routing-specialist');
    expect(team.selectAgentForTask('Audit Producer Edition version compatibility and unsupported APIs').name).toBe('daw-compatibility-analyst');
    expect(team.selectAgentForTask('Execute prepared gain trim patch', 'execute_with_approval').name).toBe('daw-operator');

    // Default execution mode strictly `analyze` (zero recommendations unless `recommend`, zero mutations)
    const defaultRun = await team.runTask({
      agentName: 'daw-session-analyst',
      goal: 'Inspect COLDINMYEYES session structure',
      sessionId: sess.sessionId,
      projectVaultPath: '09_X3LIUS_MUSIC/SONGS/COLDINMYEYES.md',
    });
    expect(defaultRun.ok).toBe(true);
    expect(defaultRun.mode).toBe('analyze');
    expect(defaultRun.recommendations).toEqual([]);
    expect(defaultRun.evidence.length).toBeGreaterThan(0);
    expect(defaultRun.limitations.some((l) => l.includes('automationLanes'))).toBe(true);

    // Non-Execution agents MUST refuse `prepare` and `execute_with_approval` and escalate to daw-operator!
    for (const nonExecName of ['daw-mixing-engineer', 'daw-mastering-engineer', 'daw-audio-quality-analyst', 'daw-workflow-planner']) {
      const blockedPrep = await team.runTask({
        agentName: nonExecName,
        goal: 'Mutate fader directly',
        mode: 'prepare',
        sessionId: sess.sessionId,
      });
      expect(blockedPrep.ok).toBe(false);
      expect(blockedPrep.error?.code).toBe('DAW_PERMISSION_DENIED');
      expect(blockedPrep.escalatedTo).toBe('daw-operator');
    }

    // ToolRegistry direct authorization defense: Creative/Critic cannot call `daw_gateway_execute`
    await expect(
      team.toolRegistry.execute(
        { agentName: 'daw-mixing-engineer', agentClass: 'Creative', runId: 'adv-1', log: () => {} },
        'daw_gateway_execute',
        { prepareId: 'x', approvalId: 'y', leaseId: 'z' },
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_TOOL' });
  });

  it('3. grounds Critique, Mixing, Music Theory & Execution modes in real Audio Brain, Plugin Brain & Command Gateway evidence', async () => {
    const { dir, db, core, team } = await setupFullEnv();

    // 1. Ground daw-audio-quality-analyst (`Critic`) on clipped WAV fixture
    const clipWav = join(dir, 'clip-master.wav');
    fs.writeFileSync(clipWav, buildClippedFixtureWav());
    const criticRes = await team.runTask({
      agentName: 'daw-audio-quality-analyst',
      goal: 'Evaluate master bounce clipping and quality rubric verdict',
      mode: 'recommend',
      audioFilePath: clipWav,
    });
    expect(criticRes.ok).toBe(true);
    expect(criticRes.toolsInvoked).toContain('daw_audio_brain_analyze');
    expect(criticRes.evidence.some((e) => e.includes('verdict=CRITICAL'))).toBe(true);
    expect(criticRes.findings.some((f) => f.includes('clipping') || f.includes('True peak'))).toBe(true);
    expect(criticRes.recommendations.some((r) => r.includes('Trim master ceiling'))).toBe(true);

    // 2. Test daw-operator Command Gateway lifecycle with FakeDawAdapter (SUPPORTED) AND approval enforcement
    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const fakeSess = await core.connectSession(fake.manifest.adapterId, { projectPath: 'D:/Sim/Mix.sim' });

    // Missing approval/lease blocks execute_with_approval even for `daw-operator`!
    const unapprovedExec = await team.runTask({
      agentName: 'daw-operator',
      goal: 'Run execute without approval',
      mode: 'execute_with_approval',
      sessionId: fakeSess.sessionId,
      prepareId: 'none',
    });
    expect(unapprovedExec.ok).toBe(false);
    expect(unapprovedExec.error?.code).toBe('DAW_APPROVAL_REQUIRED');

    const lease = core.grantSessionLease({
      sessionId: fakeSess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['mixer:insert:1'],
      ttlMs: 60_000,
    });

    const cmd: DawCommand = {
      commandId: 'cmd-team-op-1',
      sessionId: fakeSess.sessionId,
      kind: 'mixer.volume_pan_mute',
      capabilityId: 'daw.mixer.fader_pan_mute',
      targetRef: 'mixer:insert:1',
      params: { deltaDb: -1.5 },
      requestedBy: 'daw-operator',
      requestedClass: 'Execution',
      correlationId: 'corr-team-1',
      createdAt: new Date().toISOString(),
    };

    const prepRes = await team.runTask({
      agentName: 'daw-operator',
      goal: 'Prepare bounded -1.5 dB vocal trim',
      mode: 'prepare',
      sessionId: fakeSess.sessionId,
      command: cmd,
      leaseId: lease.id,
    });
    expect(prepRes.ok).toBe(true);
    const prepared = prepRes.data.prepared as { prepareId: string; approvalId: string };
    expect(prepared.approvalId).toBeTruthy();

    db.decideApproval({
      approvalId: prepared.approvalId,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Operator approved daw-operator trim',
    });

    const execRes = await team.runTask({
      agentName: 'daw-operator',
      goal: 'Execute approved bounded trim',
      mode: 'execute_with_approval',
      sessionId: fakeSess.sessionId,
      prepareId: prepared.prepareId,
      approvalId: prepared.approvalId,
      leaseId: lease.id,
    });
    expect(execRes.ok).toBe(true);
    expect(execRes.toolsInvoked).toContain('daw_gateway_execute');
    expect((execRes.data.executionResult as { verifiedByReadback: boolean }).verifiedByReadback).toBe(true);

    // 3. Read-only FL Studio 2025 adapter rejects `prepare` cleanly via Command Gateway too
    core.registerAdapter(new FlStudio2025Adapter({ midiTransport: new MockFlMidiTransport(), hostProbe: flProbe }));
    const flSess = await core.connectSession('fl-studio-2025');
    const flLease = core.grantSessionLease({
      sessionId: flSess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });
    const flPrep = await team.runTask({
      agentName: 'daw-operator',
      goal: 'Attempt unsupported write on Phase 11 read-only FL adapter',
      mode: 'prepare',
      sessionId: flSess.sessionId,
      leaseId: flLease.id,
      command: { ...cmd, sessionId: flSess.sessionId, commandId: 'cmd-fl-ro-deny' },
    });
    expect(flPrep.ok).toBe(false);
    expect(flPrep.error?.message).toContain('DAW_CAPABILITY_UNSUPPORTED');
  });
});
