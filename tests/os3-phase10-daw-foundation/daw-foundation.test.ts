import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import {
  DawCore,
  FakeDawAdapter,
  validateAdapterContract,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3ToolRegistryWithDawContracts } from '../../core/tool-registry/daw-tool-contracts.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 10 — Universal DAW Brain Foundation (Vendor-Independent Core & Fake Adapter)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const cores: DawCore[] = [];

  afterEach(async () => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const makeDb = () => {
    const db = openRuntimeDb(':memory:');
    openDbs.push(db);
    return db;
  };

  it('1. guarantees zero vendor-specific FL Studio / REAPER dependencies inside core/daw-brain/', () => {
    const dir = join(REPO_ROOT, 'core', 'daw-brain');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(12);

    const forbiddenVendorPatterns = [
      /\bFL64\.exe\b/i,
      /\breaper\.exe\b/i,
      /\bdevice_Fire\b/,
      /\bloopMIDI\b/i,
      /\bReaScript\b/i,
      /\bchild_process\b/,
    ];

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf8');
      for (const pat of forbiddenVendorPatterns) {
        expect(pat.test(content), `Vendor coupling leak matching ${pat} found in core/daw-brain/${file}`).toBe(false);
      }
    }
  });

  it('2. validates FakeDawAdapter contract, explicit simulated identity, lifecycle, subscriptions & explicit unavailable state', async () => {
    const db = makeDb();
    const core = new DawCore({ db, staleThresholdMs: 500 });
    cores.push(core);

    const fake = new FakeDawAdapter({ simulatedLatencyMs: 5 });
    const contractCheck = validateAdapterContract(fake);
    expect(contractCheck.ok).toBe(true);
    expect(fake.manifest.isSimulated).toBe(true);
    expect(fake.manifest.hostKind).toBe('simulated');

    core.registerAdapter(fake);
    const discovered = await core.discoverInstances();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.isSimulated).toBe(true);

    const session = await core.connectSession(fake.manifest.adapterId, {
      projectPath: 'D:/SimProjects/Session1.sim',
      actor: 'blago-operator',
    });

    // Boots strictly read-only (`connected_read_only`), carries provenance & explicit unavailable info
    expect(session.connection.status).toBe('connected_read_only');
    expect(session.connection.activePermissionTier).toBe('observe');
    expect(session.stateFreshness).toBe('observed');
    expect(session.observed).not.toBeNull();
    expect(session.observed!.provenance.dawId).toBe(session.dawId);
    expect(session.observed!.provenance.adapterId).toBe(fake.manifest.adapterId);
    expect(session.observed!.automationLanes.status).toBe('unavailable');
    expect(session.unknownFields).toContain('automationLanes:unavailable');
    expect(session.unknownFields).toContain('audioClips:unknown');

    // Push subscription updates live observed snapshot cleanly
    core.observer.attachSubscription(session.sessionId);
    fake.mutateHostOutOfBand({ bpm: 146 });
    await fake.pushSnapshotToSubscribers(session.sessionId);

    const afterPush = core.sessions.getSession(session.sessionId)!;
    expect(afterPush.observed!.transport.tempo.bpm).toBe(146);

    // Disconnecting closes cleanly and emits durable disconnect event
    const closed = await core.disconnectSession(session.sessionId);
    expect(closed.connection.status).toBe('closed');
  });

  it('3. enforces explicit 7-tier state freshness (observed/cached/stale/saved/proposed/applied/unknown) & health degradation', async () => {
    const db = makeDb();
    const core = new DawCore({ db, staleThresholdMs: 600, maxConsecutiveHealthFailures: 2 });
    cores.push(core);

    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);

    const session = await core.connectSession(fake.manifest.adapterId);
    // Record baseline saved project SHA-256
    core.setSavedProject(session.sessionId, {
      ...session.project,
      savedSha256: 'sha256-saved-baseline',
      lastSavedAt: new Date().toISOString(),
    });
    expect(core.sessions.getSession(session.sessionId)!.hasUnsavedLiveChanges).toBe(false);

    // Out-of-band host edit sets hasUnsavedLiveChanges without mutating saved project record
    fake.mutateHostOutOfBand({ bpm: 150 });
    await core.refreshSession(session.sessionId);
    const drifted = core.sessions.getSession(session.sessionId)!;
    expect(drifted.hasUnsavedLiveChanges).toBe(true);
    expect(drifted.saved?.savedSha256).toBe('sha256-saved-baseline');

    // Host goes offline -> health monitor degrades session -> observed cleared, cached preserved as stale!
    fake.setOffline(true, 'Simulated host process exited');
    const health = await core.checkHealth(session.sessionId);
    expect(health.healthy).toBe(false);

    const degraded = core.sessions.getSession(session.sessionId)!;
    expect(degraded.connection.status).toBe('degraded_cached');
    expect(degraded.observed).toBeNull();
    expect(degraded.stale).toBe(true);
    expect(degraded.stateFreshness).toBe('stale');
    expect(degraded.cached?.freshness).toBe('stale');
  });

  it('4. enforces version compatibility checks: blocks incompatible versions & restricts untested newer versions to read-only', async () => {
    const db = makeDb();
    const core = new DawCore({ db });
    cores.push(core);

    const tooOld = new FakeDawAdapter({
      adapterId: 'fake-old',
      hostVersion: '0.9.0',
      minSupportedHostVersion: '1.0.0',
      maxTestedHostVersion: '2.0.0',
    });
    core.registerAdapter(tooOld);
    await expect(core.connectSession('fake-old')).rejects.toMatchObject({
      code: 'DAW_UNSUPPORTED_HOST_VERSION',
    });

    const untestedNew = new FakeDawAdapter({
      adapterId: 'fake-new',
      hostVersion: '2.5.0',
      minSupportedHostVersion: '1.0.0',
      maxTestedHostVersion: '2.0.0',
    });
    core.registerAdapter(untestedNew);
    const sess = await core.connectSession('fake-new');
    expect(sess.connection.versionCompatibility).toBe('degraded_read_only');

    // Even with a lease, mutations on an untested newer host are refused cleanly!
    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
    });
    const cmd: DawCommand = {
      commandId: 'cmd-ver-block',
      sessionId: sess.sessionId,
      kind: 'mixer.volume_pan_mute',
      capabilityId: 'daw.mixer.fader_pan_mute',
      targetRef: 'mixer:insert:1',
      params: { deltaDb: 1.0 },
      requestedBy: 'tech-audio-tools',
      requestedClass: 'Execution',
      correlationId: 'corr-v1',
      createdAt: new Date().toISOString(),
    };
    await expect(core.prepareCommand(cmd, { leaseId: lease.id })).rejects.toMatchObject({
      code: 'DAW_PERMISSION_DENIED',
    });
  });

  it('5. enforces capability boundaries, safety clamps, target drift, human approvals & exact beforeState rollback', async () => {
    const db = makeDb();
    const core = new DawCore({ db });
    cores.push(core);

    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId);

    const makeCmd = (overrides: Partial<DawCommand> = {}): DawCommand => ({
      commandId: `cmd-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sess.sessionId,
      kind: 'mixer.volume_pan_mute',
      capabilityId: 'daw.mixer.fader_pan_mute',
      targetRef: 'mixer:insert:1',
      params: { deltaDb: 1.5 },
      requestedBy: 'tech-audio-tools',
      requestedClass: 'Execution',
      correlationId: 'corr-gate-1',
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    // 1. Default read-only mode refuses mutation without lease
    await expect(core.prepareCommand(makeCmd())).rejects.toMatchObject({ code: 'DAW_LEASE_REQUIRED' });

    // 2. Grant execute lease
    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    // 3. UNSUPPORTED capability fails fast
    await expect(
      core.prepareCommand(
        makeCmd({ kind: 'plugin.load_remove', capabilityId: 'daw.plugin.load_remove', targetRef: 'mixer:insert:1' }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_CAPABILITY_UNSUPPORTED' });

    // 4. Safety clamps reject excessive +5 dB jump and >0 dBFS master boost
    await expect(
      core.prepareCommand(makeCmd({ params: { deltaDb: 5.0 } }), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

    await expect(
      core.prepareCommand(makeCmd({ targetRef: 'mixer:insert:0', params: { volumeDb: 2.0 } }), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

    // 5. Prepare valid command + verify drift detection
    const prep = await core.prepareCommand(makeCmd({ params: { deltaDb: 1.5 } }), {
      leaseId: lease.id,
      queueApproval: true,
    });
    expect(prep.beforeState).toMatchObject({ volumeDb: -2.0 });
    expect(prep.approvalId).toBeTruthy();

    // Missing human approval blocks execute cleanly
    const unapprovedExec = await core.executeCommand(prep.prepareId, {
      actor: 'tech-audio-tools',
      leaseId: lease.id,
    });
    expect(unapprovedExec.ok).toBe(false);
    expect(unapprovedExec.error?.code).toBe('DAW_APPROVAL_REQUIRED');

    // Approve by human operator
    db.decideApproval({
      approvalId: prep.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved Lead Vocal +1.5dB trim',
    });

    // Simulate out-of-band host drift before execute -> rejected cleanly with DAW_TARGET_DRIFT!
    fake.mutateHostOutOfBand({ bpm: 152 });
    await core.refreshSession(sess.sessionId);
    const driftedExec = await core.executeCommand(prep.prepareId, {
      actor: 'tech-audio-tools',
      approvalId: prep.approvalId!,
      leaseId: lease.id,
    });
    expect(driftedExec.ok).toBe(false);
    expect(driftedExec.error?.code).toBe('DAW_TARGET_DRIFT');

    // Fresh prepare -> approve -> execute -> readback -> rollback restoration
    const appr2 = db.queueApproval({
      itemType: 'artifact_version',
      itemId: 'daw_patch:fresh-trim',
      proposer: 'tech-audio-tools',
      request: { targetRef: 'mixer:insert:1' },
    });
    db.decideApproval({
      approvalId: appr2.id,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Fresh trim approval',
    });
    const prep2 = await core.prepareCommand(makeCmd({ params: { deltaDb: 1.5 } }), { leaseId: lease.id });
    const execOk = await core.executeCommand(prep2.prepareId, {
      actor: 'tech-audio-tools',
      approvalId: appr2.id,
      leaseId: lease.id,
    });
    expect(execOk.ok).toBe(true);
    expect(execOk.verifiedByReadback).toBe(true);
    expect(execOk.afterState?.volumeDb).toBe(-0.5);
    expect(execOk.receiptId).toBeTruthy();

    // Rollback restores original -2.0 dB accurately
    const rbRes = await core.rollbackCommand(execOk.receiptId!, {
      actor: 'blago-operator',
      leaseId: lease.id,
    });
    expect(rbRes.ok).toBe(true);
    expect(rbRes.status).toBe('rolled_back');
    const postRbSnap = core.sessions.getSession(sess.sessionId)!.observed!;
    const ch1AfterRb = postRbSnap.mixerChannels.status === 'available'
      ? postRbSnap.mixerChannels.value.find((c) => c.index === 1)
      : undefined;
    expect(ch1AfterRb?.volumeDb).toBe(-2.0);
  });

  it('6. integrates end-to-end with Phase 08 JARVIS Core via DawBrainDelegate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p10-jarvis-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const tools = createOs3ToolRegistryWithDawContracts({ vault, db });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(vaultRoot, '04_AGENTS'), toolRegistry: tools });
    const orchestrator = new Os3Orchestrator({ db, agents, tools });
    const workflows = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });
    const contextEngine = new Os3ContextEngine({ vault, db });

    const dawCore = new DawCore({ db });
    cores.push(dawCore);
    const fake = new FakeDawAdapter();
    dawCore.registerAdapter(fake);
    const dawSession = await dawCore.connectSession(fake.manifest.adapterId);

    const jarvis = new Os3JarvisCore({
      db,
      agents,
      tools,
      contextEngine,
      orchestrator,
      workflows,
      dawDelegate: dawCore,
    });

    const res = await jarvis.handleDirective('xyp3rn> daw inspect tracks', {
      sessionId: dawSession.sessionId,
    });
    expect(res.ok).toBe(true);
    expect(res.classification.intent).toBe('daw');
    expect(res.dawResult?.executionStatus).toBe('succeeded');
    expect(res.dawResult?.stateTier).toBe('liveObserved');
    expect(res.dawResult?.result).toHaveProperty('mixerChannels');
    expect(res.dawResult?.evidence.length).toBeGreaterThanOrEqual(2);
  });
});
