import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FlStudio2025Adapter,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';
import {
  ALWAYS_PROHIBITED_COMMAND_KINDS,
  DawCore,
  FakeDawAdapter,
  INITIAL_PERMITTED_DAW_CAPABILITIES,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';

const createFlProbe = (): FlStudioHostProbe => ({
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
        { pid: 7740, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' },
      ],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath: 'C:\\Users\\test\\Documents\\Image-Line\\FL Studio\\Settings\\Hardware\\XYP3RN_Brain\\device_XYP3RNBrain.py',
      controllerScriptInstalled: true,
      userProjectsRoot: 'C:\\Projects',
      pluginDatabaseRoot: 'C:\\PluginDb',
      missingPrerequisites: [],
      warnings: [],
    };
  },
  discoverProjects: () => ['C:\\Projects\\COLDINMYEYES.flp'],
  scanInstalledPlugins: () => [],
});

describe('Phase 16 — DAW Command Gateway + Safe Execution', () => {
  const openDbs: SqliteRuntimeDb[] = [];
  const tempDirs: string[] = [];
  const cores: DawCore[] = [];

  afterEach(() => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  const makeRuntime = (options?: ConstructorParameters<typeof DawCore>[0]) => {
    const dir = mkdtempSync(join(tmpdir(), 'xyp3rn-os3-p16-gw-'));
    tempDirs.push(dir);
    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const core = new DawCore({ db, ...options });
    cores.push(core);
    return { dir, db, core };
  };

  const makeCommand = (
    sessionId: string,
    overrides: Partial<DawCommand> = {},
  ): DawCommand => ({
    commandId: `cmd-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    kind: 'mixer.volume_pan_mute',
    capabilityId: 'daw.mixer.fader_pan_mute',
    targetRef: 'mixer:insert:1',
    params: { deltaDb: -1.5 },
    requestedBy: 'daw-operator',
    requestedClass: 'Execution',
    correlationId: `corr-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('1. executes full 11-stage safe lifecycle: dry-run diff, approval, postcondition readback, receipt, immutable audit & rollback', async () => {
    const { db, core } = makeRuntime();
    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId, { projectPath: 'D:\\Projects\\SAFE.sim' });

    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['mixer:insert:1', 'plug-sim-eq-1'],
      ttlMs: 60_000,
    });

    const cmd = makeCommand(sess.sessionId, {
      commandId: 'cmd-p16-lifecycle-1',
      correlationId: 'corr-p16-001',
      expectedProjectId: sess.project.projectId,
      expectedProjectPath: 'd:/Projects/SAFE.sim', // case/slash normalized match
      params: { deltaDb: -1.5, panNormalized: 0.2 },
    });

    // Stage 6 dry-run: side-effect-free simulation + diff
    const dry = await core.dryRunCommand(cmd, { leaseId: lease.id });
    expect(dry.ok).toBe(true);
    expect(dry.wouldSucceed).toBe(true);
    expect(dry.commandClass).toBe('reversible');
    expect(dry.riskLevel).toBe('low');
    expect(dry.rollbackSupported).toBe(true);
    expect(dry.approvalRequirement).toBe('human_standard');
    expect(dry.diff).toEqual(
      expect.arrayContaining([
        { field: 'volumeDb', before: -2.0, after: -3.5, unit: 'dB' },
        { field: 'panNormalized', before: 0, after: 0.2, unit: 'pan' },
      ]),
    );

    // Dry-run MUST NOT modify live DAW host state
    const afterDrySnap = await fake.observe(sess.sessionId);
    expect(afterDrySnap.stateDigest).toBe(sess.observed!.stateDigest);

    // Stage 1..7 prepare + queue human approval
    const prep = await core.prepareCommand(cmd, { leaseId: lease.id, queueApproval: true });
    expect(prep.approvalId).toBeTruthy();
    expect(prep.dryRun.diff).toEqual(dry.diff);

    db.decideApproval({
      approvalId: prep.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved -1.5 dB vocal trim and +0.2 pan shift',
    });

    // Stage 8..10 single-shot execution + postcondition verification + receipt + immutable SQLite journal
    const res = await core.executeCommand(prep.prepareId, {
      actor: 'daw-operator',
      approvalId: prep.approvalId!,
      leaseId: lease.id,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('succeeded');
    expect(res.verifiedByReadback).toBe(true);
    expect(res.postconditionVerified).toBe(true);
    expect(res.rollbackSupported).toBe(true);
    expect(res.correlationId).toBe('corr-p16-001');
    expect(res.lifecycleStages).toEqual(
      expect.arrayContaining([
        'request',
        'capability_verification',
        'input_validation',
        'permission_check',
        'risk_classification',
        'dry_run',
        'approval',
        'execution',
        'postcondition_verification',
        'audit',
      ]),
    );
    expect(res.afterState).toMatchObject({ volumeDb: -3.5, panNormalized: 0.2 });

    const receipt = core.getCommandReceipt(res.receiptId!);
    expect(receipt).toBeTruthy();
    expect(receipt?.correlationId).toBe('corr-p16-001');
    expect(receipt?.dryRunDiff).toEqual(dry.diff);
    expect(core.gateway.getAuditTrail('corr-p16-001')).toHaveLength(1);

    // Journal immutability check + durable event audit check
    const journalRow = db.getDawCommand(res.receiptId!);
    expect(journalRow?.status).toBe('executed');
    expect(db.listEvents({ eventType: 'daw.command.executed' }).length).toBeGreaterThanOrEqual(1);

    // Stage 11 rollback restores exact beforeState + rejects duplicate rollback
    const rb = await core.rollbackCommand(res.receiptId!, {
      actor: 'blago-operator',
      leaseId: lease.id,
    });
    expect(rb.ok).toBe(true);
    expect(rb.status).toBe('rolled_back');
    expect(rb.afterState).toMatchObject({ volumeDb: -2.0, panNormalized: 0 });
    expect(core.getCommandReceipt(res.receiptId!)?.rollbackStatus).toBe('rolled_back');

    await expect(
      core.rollbackCommand(res.receiptId!, { actor: 'blago-operator', leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_DUPLICATE_COMMAND' });
  });

  it('2. classifies all 5 command classes, enforces initial low-risk allowlist (default deny), and gates no-rollback ops behind strong approval', async () => {
    const { db, core } = makeRuntime();
    const fake = new FakeDawAdapter({
      extraCapabilities: [
        {
          capabilityId: 'daw.render.master',
          category: 'daw_command_execution',
          requiredTier: 'execute',
          supportLevel: 'SUPPORTED',
          rollbackSupported: false,
        },
        {
          capabilityId: 'daw.automation.edit',
          category: 'daw_command_execution',
          requiredTier: 'execute',
          supportLevel: 'SUPPORTED',
          rollbackSupported: false,
        },
      ],
    });
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId);
    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    // Verify all 5 Command Classes
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'session.observe', capabilityId: 'daw.mixer.read' })).commandClass,
    ).toBe('read_only');
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'mixer.volume_pan_mute', capabilityId: 'daw.mixer.fader_pan_mute', targetRef: 'mixer:insert:1' })).commandClass,
    ).toBe('reversible');
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'mixer.volume_pan_mute', capabilityId: 'daw.mixer.fader_pan_mute', targetRef: 'mixer:insert:0' })).commandClass,
    ).toBe('potentially_destructive');
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'render.master', capabilityId: 'daw.render.master' })).commandClass,
    ).toBe('potentially_destructive');
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'automation.edit', capabilityId: 'daw.automation.edit' })).commandClass,
    ).toBe('irreversible');
    expect(
      core.classifyCommand(makeCommand(sess.sessionId, { kind: 'plugin.load_remove', capabilityId: 'daw.plugin.load_remove' })).commandClass,
    ).toBe('unsupported');

    // Initial allowlist permits ONLY low-risk set (`daw.transport.control`, `daw.mixer.fader_pan_mute`, `daw.plugin.bypass`)
    expect(INITIAL_PERMITTED_DAW_CAPABILITIES).toEqual([
      'daw.transport.control',
      'daw.mixer.fader_pan_mute',
      'daw.plugin.bypass',
    ]);
    expect(ALWAYS_PROHIBITED_COMMAND_KINDS.has('automation.edit')).toBe(true);

    // Non-allowlisted capabilities fail default-deny policy cleanly (`DAW_ACTION_NOT_ALLOWLISTED`)
    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'plugin.param_write',
          capabilityId: 'daw.plugin.param_write',
          targetRef: 'plug-sim-eq-1',
          params: { paramIndex: 0, valueNormalized: 0.4 },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_ACTION_NOT_ALLOWLISTED' });

    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'mixer.routing_write',
          capabilityId: 'daw.mixer.routing_write',
          targetRef: 'route-1-0',
          params: { enabled: false },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_ACTION_NOT_ALLOWLISTED' });

    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'automation.edit',
          capabilityId: 'daw.automation.edit',
          targetRef: 'lane:1',
          params: { points: [] },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_ACTION_NOT_ALLOWLISTED' });

    // Even inside allowed `transport.control`, unattended `recording: true` is denied by initial policy
    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'transport.control',
          capabilityId: 'daw.transport.control',
          targetRef: 'transport:main',
          params: { recording: true },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_ACTION_NOT_ALLOWLISTED' });

    // No-rollback operation explicitly permitted by custom policy MUST warn & require stronger approval + never advertise rollback
    const { db: db2, core: strongCore } = makeRuntime({
      executionPolicy: {
        permittedCapabilities: [...INITIAL_PERMITTED_DAW_CAPABILITIES, 'daw.render.master'],
      },
    });
    const fake2 = new FakeDawAdapter({
      extraCapabilities: [
        {
          capabilityId: 'daw.render.master',
          category: 'daw_command_execution',
          requiredTier: 'execute',
          supportLevel: 'SUPPORTED',
          rollbackSupported: false,
        },
      ],
    });
    strongCore.registerAdapter(fake2);
    const s2 = await strongCore.connectSession(fake2.manifest.adapterId);
    const lease2 = strongCore.grantSessionLease({
      sessionId: s2.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    const renderCmd = makeCommand(s2.sessionId, {
      kind: 'render.master',
      capabilityId: 'daw.render.master',
      targetRef: 'master:output',
      params: { format: 'wav' },
    });

    const prepRender = await strongCore.prepareCommand(renderCmd, { leaseId: lease2.id, queueApproval: true });
    expect(prepRender.assessment.rollbackSupported).toBe(false);
    expect(prepRender.assessment.approvalRequirement).toBe('human_strong');
    expect(prepRender.dryRun.warnings.some((w) => w.includes('NO_RELIABLE_ROLLBACK'))).toBe(true);

    // Weak approval without acknowledging no-rollback risk is refused!
    db2.decideApproval({
      approvalId: prepRender.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'ok',
    });
    const weakExec = await strongCore.executeCommand(prepRender.prepareId, {
      actor: 'daw-operator',
      approvalId: prepRender.approvalId!,
      leaseId: lease2.id,
    });
    expect(weakExec.ok).toBe(false);
    expect(weakExec.error?.code).toBe('DAW_APPROVAL_REQUIRED');

    // Stronger confirmation succeeds cleanly, marks rollbackSupported=false, and refuses rollback()
    const freshRenderCmd = makeCommand(s2.sessionId, {
      commandId: 'cmd-render-strong-ok',
      kind: 'render.master',
      capabilityId: 'daw.render.master',
      targetRef: 'master:output',
      params: { format: 'wav' },
      strongApprovalReason: 'Acknowledge no rollback for external render bounce',
    });
    const strongExec = await strongCore.executeCommand(freshRenderCmd, {
      actor: 'daw-operator',
      approvalId: prepRender.approvalId!,
      leaseId: lease2.id,
      strongApprovalConfirmed: true,
    });
    expect(strongExec.ok).toBe(true);
    expect(strongExec.rollbackSupported).toBe(false);
    await expect(
      strongCore.rollbackCommand(strongExec.receiptId!, { actor: 'blago-operator', leaseId: lease2.id }),
    ).rejects.toMatchObject({ code: 'DAW_ROLLBACK_UNSUPPORTED' });
  });

  it('3. enforces invalid command rejection, stale state detection, project identity mismatch, permission denial & duplicate protection', async () => {
    const { db, core } = makeRuntime();
    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId, { projectPath: 'C:\\Projects\\SongA.flp' });
    core.setSavedProject(sess.sessionId, {
      ...sess.project,
      savedSha256: 'abc123def456',
    });

    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['mixer:insert:1'],
      ttlMs: 60_000,
    });

    // Invalid commands & safety ranges
    await expect(
      core.prepareCommand(makeCommand(sess.sessionId, { commandId: '   ' }), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_INVALID_COMMAND' });

    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, { kind: 'mixer.volume_pan_mute', capabilityId: 'daw.transport.control' }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_INVALID_COMMAND' });

    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'transport.control',
          capabilityId: 'daw.transport.control',
          targetRef: 'transport:main',
          params: { bpm: 999 },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

    // Project identity verification mismatches
    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, { expectedProjectPath: 'C:\\Projects\\WRONG_SONG.flp' }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_PROJECT_MISMATCH' });

    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, { expectedProjectSha256: 'deadbeef' }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_PROJECT_MISMATCH' });

    // Stale state verification (expired observation window + explicit stale session)
    await new Promise((r) => setTimeout(r, 45));
    await expect(
      core.prepareCommand(makeCommand(sess.sessionId, { maxStateAgeMs: 10 }), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_STALE_STATE' });

    core.sessions.markStale(sess.sessionId, 'Simulated observation expiry');
    await expect(
      core.prepareCommand(makeCommand(sess.sessionId), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_STALE_STATE' });

    // Refresh observation & verify permission/target-scope/self-approval denials
    await core.refreshSession(sess.sessionId);

    // Non-Execution actor class denied
    await expect(
      core.prepareCommand(makeCommand(sess.sessionId, { requestedClass: 'Creative' }), { leaseId: lease.id }),
    ).rejects.toMatchObject({ code: 'DAW_PERMISSION_DENIED' });

    // Out-of-lease target denied
    await expect(
      core.prepareCommand(
        makeCommand(sess.sessionId, {
          kind: 'plugin.bypass',
          capabilityId: 'daw.plugin.bypass',
          targetRef: 'plug-sim-eq-1',
          params: { bypassed: true },
        }),
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_PERMISSION_DENIED' });

    // Self-approval denied on execute
    const selfPrep = await core.prepareCommand(makeCommand(sess.sessionId, { commandId: 'cmd-self-appr' }), {
      leaseId: lease.id,
      queueApproval: true,
    });
    db.decideApproval({
      approvalId: selfPrep.approvalId!,
      decision: 'approved',
      approver: 'daw-operator', // forbidden agent/proposer self-approval
      reason: 'Self',
    });
    const selfExec = await core.executeCommand(selfPrep.prepareId, {
      actor: 'daw-operator',
      approvalId: selfPrep.approvalId!,
      leaseId: lease.id,
    });
    expect(selfExec.ok).toBe(false);
    expect(selfExec.error?.code).toBe('DAW_PERMISSION_DENIED');

    // Duplicate command & idempotency protection
    const idemCmd = makeCommand(sess.sessionId, {
      commandId: 'cmd-idem-1',
      idempotencyKey: 'idem-key-vocal-trim',
      params: { deltaDb: -1.0 },
    });
    const prepIdem = await core.prepareCommand(idemCmd, { leaseId: lease.id, queueApproval: true });
    db.decideApproval({
      approvalId: prepIdem.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approve unique idempotency execution',
    });
    const firstExec = await core.executeCommand(prepIdem.prepareId, {
      actor: 'daw-operator',
      approvalId: prepIdem.approvalId!,
      leaseId: lease.id,
    });
    expect(firstExec.ok).toBe(true);

    // Duplicate same commandId on prepare rejected
    await expect(core.prepareCommand(idemCmd, { leaseId: lease.id })).rejects.toMatchObject({
      code: 'DAW_DUPLICATE_COMMAND',
    });

    // Different commandId sharing same idempotencyKey rejected cleanly with DAW_DUPLICATE_COMMAND
    const dupIdemExec = await core.executeCommand(
      makeCommand(sess.sessionId, {
        commandId: 'cmd-idem-2-replay',
        idempotencyKey: 'idem-key-vocal-trim',
      }),
      { actor: 'daw-operator', approvalId: prepIdem.approvalId!, leaseId: lease.id },
    );
    expect(dupIdemExec.ok).toBe(false);
    expect(dupIdemExec.error?.code).toBe('DAW_DUPLICATE_COMMAND');
  });

  it('4. handles pre/mid-flight cancellation, execution timeout, postcondition mismatch & automatic recovery rollback', async () => {
    const { db, core } = makeRuntime();
    const fake = new FakeDawAdapter();
    core.registerAdapter(fake);
    const sess = await core.connectSession(fake.manifest.adapterId);
    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    const appr = db.queueApproval({
      itemType: 'artifact_version',
      itemId: 'daw_patch:recovery-suite',
      proposer: 'daw-operator',
      request: { targetRef: 'mixer:insert:1' },
    });
    db.decideApproval({
      approvalId: appr.id,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved for interruption recovery test suite',
    });

    // A. Explicit prepare cancellation blocks later dispatch
    const prepCancel = await core.prepareCommand(makeCommand(sess.sessionId, { commandId: 'cmd-cancel-prep' }), {
      leaseId: lease.id,
    });
    expect(core.cancelCommand(prepCancel.prepareId, 'blago-operator', 'Operator changed mind')).toBe(true);
    await expect(
      core.executeCommand(prepCancel.prepareId, {
        actor: 'daw-operator',
        approvalId: appr.id,
        leaseId: lease.id,
      }),
    ).rejects.toMatchObject({ code: 'DAW_CANCELLED' });

    // B. Pre-aborted AbortSignal blocks execution cleanly without touching adapter
    const acPre = new AbortController();
    acPre.abort();
    const abortedPre = await core.executeCommand(
      makeCommand(sess.sessionId, { commandId: 'cmd-abort-pre' }),
      { actor: 'daw-operator', approvalId: appr.id, leaseId: lease.id, signal: acPre.signal },
    );
    expect(abortedPre.ok).toBe(false);
    expect(abortedPre.status).toBe('cancelled');
    expect(abortedPre.cancelled).toBe(true);
    expect(abortedPre.error?.code).toBe('DAW_CANCELLED');

    // C. Mid-flight timeout after partial host mutation triggers automatic compensating rollback recovery!
    fake.setExecuteDelayMs(120);
    fake.setMutateBeforeTimeoutOrHang(true);
    const timedOutRes = await core.executeCommand(
      makeCommand(sess.sessionId, {
        commandId: 'cmd-timeout-recover',
        correlationId: 'corr-timeout-1',
        params: { deltaDb: 1.5 },
        timeoutMs: 25,
      }),
      { actor: 'daw-operator', approvalId: appr.id, leaseId: lease.id },
    );
    expect(timedOutRes.ok).toBe(false);
    expect(timedOutRes.status).toBe('timed_out');
    expect(timedOutRes.timedOut).toBe(true);
    expect(timedOutRes.error?.code).toBe('DAW_TIMEOUT');
    expect(timedOutRes.recovery?.attempted).toBe(true);
    expect(timedOutRes.recovery?.succeeded).toBe(true);
    expect(timedOutRes.recovery?.strategy).toBe('rollback_restored');

    // Wait for delayed fake promise to settle, then verify host value restored cleanly to original -2.0 dB
    await new Promise((r) => setTimeout(r, 140));
    fake.setExecuteDelayMs(0);
    fake.setMutateBeforeTimeoutOrHang(false);
    const postRecoverySnap = await core.refreshSession(sess.sessionId);
    const ch1 =
      postRecoverySnap?.mixerChannels.status === 'available'
        ? postRecoverySnap.mixerChannels.value.find((m) => m.index === 1)
        : undefined;
    expect(ch1?.volumeDb).toBe(-2.0);
    expect(db.listEvents({ eventType: 'daw.command.timed_out' }).length).toBeGreaterThanOrEqual(1);
    expect(db.listEvents({ eventType: 'daw.command.recovered' }).length).toBeGreaterThanOrEqual(1);

    // D. Postcondition verification catches host ignoring a write & fails cleanly (`DAW_POSTCONDITION_FAILED`)
    fake.setSimulatePostconditionMismatch(true);
    const postFailRes = await core.executeCommand(
      makeCommand(sess.sessionId, {
        commandId: 'cmd-postcond-fail',
        params: { deltaDb: -2.0 },
      }),
      { actor: 'daw-operator', approvalId: appr.id, leaseId: lease.id },
    );
    fake.setSimulatePostconditionMismatch(false);
    expect(postFailRes.ok).toBe(false);
    expect(postFailRes.postconditionVerified).toBe(false);
    expect(postFailRes.error?.code).toBe('DAW_POSTCONDITION_FAILED');
  });

  it('5. enables controlled low-risk FL Studio 2025 SysEx execution (opt-in only) while keeping default FL adapter read-only', async () => {
    const { db, core } = makeRuntime();

    // Verify default FL Studio adapter stays locked read-only
    const roFl = new FlStudio2025Adapter({
      adapterId: 'fl-ro-check',
      midiTransport: new MockFlMidiTransport({ allowControlledWrites: false }),
      hostProbe: createFlProbe(),
    });
    expect(roFl.getCapabilities().filter((c) => c.supportLevel === 'SUPPORTED')).toHaveLength(0);

    // Opt-in Phase 16 `controlled_safe_v1` profile enables ONLY transport, mixer fader/pan/mute, and plugin bypass
    const safeFl = new FlStudio2025Adapter({
      adapterId: 'fl-studio-safe-v1',
      executionProfile: 'controlled_safe_v1',
      midiTransport: new MockFlMidiTransport({ allowControlledWrites: true, latencyMs: 1 }),
      hostProbe: createFlProbe(),
    });
    core.registerAdapter(safeFl);
    const sess = await core.connectSession('fl-studio-safe-v1', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' });

    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    // High-risk/absent FL APIs stay strictly UNSUPPORTED even in controlled_safe_v1!
    for (const lockedCap of [
      { kind: 'plugin.load_remove' as const, capabilityId: 'daw.plugin.load_remove' },
      { kind: 'track.create_delete' as const, capabilityId: 'daw.track.create_delete' },
      { kind: 'project.save' as const, capabilityId: 'daw.project.save' },
      { kind: 'plugin.param_write' as const, capabilityId: 'daw.plugin.param_write' },
    ]) {
      await expect(
        core.prepareCommand(
          makeCommand(sess.sessionId, {
            kind: lockedCap.kind,
            capabilityId: lockedCap.capabilityId,
            params: { valueNormalized: 0.5 },
          }),
          { leaseId: lease.id },
        ),
      ).rejects.toMatchObject({ code: 'DAW_CAPABILITY_UNSUPPORTED' });
    }

    // Verified low-risk SysEx execution: plugin.bypass toggle + postcondition readback + rollback!
    const bypassCmd = makeCommand(sess.sessionId, {
      commandId: 'cmd-fl-bypass-1',
      kind: 'plugin.bypass',
      capabilityId: 'daw.plugin.bypass',
      targetRef: 'plugin:mixer:2:0', // FabFilter Pro-Q 3 on LEAD VOX
      params: { bypassed: true },
    });
    const prepFl = await core.prepareCommand(bypassCmd, { leaseId: lease.id, queueApproval: true });
    expect(prepFl.dryRun.diff).toEqual([{ field: 'bypassed', before: false, after: true, unit: undefined }]);
    db.decideApproval({
      approvalId: prepFl.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved bypass A/B check on Pro-Q 3',
    });

    const execFl = await core.executeCommand(prepFl.prepareId, {
      actor: 'daw-operator',
      approvalId: prepFl.approvalId!,
      leaseId: lease.id,
    });
    expect(execFl.ok).toBe(true);
    expect(execFl.postconditionVerified).toBe(true);
    expect(execFl.afterState).toMatchObject({ bypassed: true });

    const rbFl = await core.rollbackCommand(execFl.receiptId!, {
      actor: 'blago-operator',
      leaseId: lease.id,
    });
    expect(rbFl.ok).toBe(true);
    expect(rbFl.status).toBe('rolled_back');
    const postSnap = core.sessions.getSession(sess.sessionId)!.observed!;
    const proQ =
      postSnap.plugins.status === 'available'
        ? postSnap.plugins.value.find((p) => p.id === 'plugin:mixer:2:0')
        : undefined;
    expect(proQ?.bypassed).toBe(false);
  });
});
