import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FlStudio2025Adapter,
  MockFlMidiTransport,
  type FlHostEnvironment,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';
import {
  assertRppMutationBlocked,
  buildSnapshotFromRpp,
  DefaultReaperHostProbe,
  HttpReaperBridgeTransport,
  inspectRppProjectFile,
  MockReaperBridgeTransport,
  ReaperAdapter,
  type ReaperHostEnvironment,
  type ReaperHostProbe,
} from '../../core/daw-adapters/reaper/index.ts';
import { buildMultiDawCompatibilityReport } from '../../core/daw-adapters/multi-daw-comparison.ts';
import {
  DawCore,
  DawSessionIntelligence,
  FakeDawAdapter,
  validateAdapterContract,
  type DawAdapter,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { createOs3ToolRegistryWithDawContracts } from '../../core/tool-registry/daw-tool-contracts.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const SAMPLE_RPP = `<REAPER_PROJECT 0.1 "7.18/win64" 1732160000
  SAMPLERATE 48000 0 0
  TEMPO 138 4 4
  MASTER_VOLUME 1.0 0
  MARKER 1 0 "Intro" 0
  MARKER 2 16 "Hook" 1
  MARKER 2 32 "" 1
  RENDER_FILE "D:\\REAPER\\Renders\\COLDINMYEYES_master.wav"
  <TRACK {11111111-2222-3333-4444-555555555555}
    NAME "Lead Vocal"
    VOLPAN 0.794328 0.0 -1 -1 1
    MUTESOLO 0 0 0
    REC 0 0 1 0 0 0 0
    MAINSEND 1 0
    <FXCHAIN
      SHOW 0
      LASTSEL 0
      BYPASS 0 0 0
      <VST "VST3: FabFilter Pro-Q 3 (FabFilter)" "FabFilter Pro-Q 3.vst3" 0 "" 12345678
        Q2h1bmtEYXRhRmFrZUJhc2U2NFZTVFN0YXRlPT0=
      >
    >
    <VOLENV2
      ACT 1
      PT 0 0.794328 0
      PT 16 0.891251 0
    >
    <ITEM
      POSITION 16
      LENGTH 16
      VOLPAN 1.0 0 1 -1
      MUTE 0
      NAME "Lead_Take_3.wav"
      <SOURCE WAVE
        FILE "D:\\REAPER\\Media\\Lead_Take_3.wav"
      >
    >
  >
  <TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
    NAME "VOXVERB"
    VOLPAN 0.707946 0.0 -1 -1 1
    MUTESOLO 0 0 0
    MAINSEND 1 0
    AUXRECV 0 0 0.5 0.0 0 0 0 0 2 0
  >
>`;

const createMockFlProbe = (): FlStudioHostProbe => ({
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
        { pid: 4001, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' },
      ],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath: 'C:\\FL\\device_XYP3RNBrain.py',
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

const createMockReaperProbe = (): ReaperHostProbe => ({
  async probeHost(): Promise<ReaperHostEnvironment> {
    return {
      probedAt: new Date().toISOString(),
      installations: [
        {
          label: 'REAPER (x64)',
          installDir: 'C:\\Program Files\\REAPER (x64)',
          executablePath: 'C:\\Program Files\\REAPER (x64)\\reaper.exe',
          exists: true,
          fileVersion: '7.18.0.0',
          productVersion: '7.18',
          leftoverAssetFilesCount: 0,
        },
      ],
      runningProcesses: [
        { pid: 9012, processName: 'reaper', executablePath: 'C:\\Program Files\\REAPER (x64)\\reaper.exe' },
      ],
      appDataDir: 'C:\\Users\\test\\AppData\\Roaming\\REAPER',
      appDataExists: true,
      reaperIniPath: 'C:\\Users\\test\\AppData\\Roaming\\REAPER\\reaper.ini',
      reaperIniExists: true,
      luaBridgeScriptPath: 'C:\\Users\\test\\AppData\\Roaming\\REAPER\\Scripts\\xyp3rn_reaper_bridge.lua',
      luaBridgeInstalled: true,
      webRemoteConfiguredPort: 8088,
      oscConfiguredPort: 8000,
      discoveredProjects: ['D:\\REAPER\\COLDINMYEYES.rpp'],
      missingPrerequisites: [],
      warnings: [],
    };
  },
  discoverProjects: () => ['D:\\REAPER\\COLDINMYEYES.rpp'],
  scanInstalledPlugins: () => [],
});

type AdapterHarnessTarget = {
  readonly label: string;
  readonly createAdapter: () => {
    readonly adapter: DawAdapter;
    readonly insertTargetRef: string;
    readonly masterTargetRef: string;
    readonly expectedInitialInsertDb: number;
    readonly injectDrift: () => void;
    readonly setOffline: (offline: boolean) => void;
  };
  readonly createVersionVariant: (tooOld: boolean) => DawAdapter;
};

const HARNESS_TARGETS: readonly AdapterHarnessTarget[] = [
  {
    label: 'FakeDawAdapter',
    createAdapter: () => {
      const fake = new FakeDawAdapter();
      return {
        adapter: fake,
        insertTargetRef: 'mixer:insert:1',
        masterTargetRef: 'mixer:insert:0',
        expectedInitialInsertDb: -2.0,
        injectDrift: () => fake.mutateHostOutOfBand({ bpm: 155 }),
        setOffline: (off) => fake.setOffline(off),
      };
    },
    createVersionVariant: (tooOld) =>
      new FakeDawAdapter({
        adapterId: tooOld ? 'fake-too-old' : 'fake-too-new',
        hostVersion: tooOld ? '0.2.0' : '99.0.0',
      }),
  },
  {
    label: 'FlStudio2025Adapter (controlled_safe_v1)',
    createAdapter: () => {
      const midi = new MockFlMidiTransport({ allowControlledWrites: true, latencyMs: 1 });
      const fl = new FlStudio2025Adapter({
        adapterId: 'fl-studio-2025',
        executionProfile: 'controlled_safe_v1',
        midiTransport: midi,
        hostProbe: createMockFlProbe(),
      });
      return {
        adapter: fl,
        insertTargetRef: 'mixer:insert:1',
        masterTargetRef: 'mixer:insert:0',
        // FL Track 1 initial volumeNormalized=0.78 -> 20*log10(0.78/0.8) = -0.22 dB
        expectedInitialInsertDb: -0.22,
        injectDrift: () => midi.injectHostStateChange({ tempoBpm: 155 }, false),
        setOffline: (off) => midi.setOffline(off),
      };
    },
    createVersionVariant: (tooOld) =>
      new FlStudio2025Adapter({
        adapterId: tooOld ? 'fl-old' : 'fl-new',
        midiTransport: new MockFlMidiTransport({
          hello: { version: tooOld ? '20.0.0.1' : '26.1.1.5547', apiVersion: tooOld ? 15 : 35 },
          initialSnapshot: { version: tooOld ? '20.0.0.1' : '26.1.1.5547', apiVersion: tooOld ? 15 : 35 },
        }),
        hostProbe: createMockFlProbe(),
      }),
  },
  {
    label: 'ReaperAdapter (controlled_safe_v1)',
    createAdapter: () => {
      const rprTransport = new MockReaperBridgeTransport({ latencyMs: 1 });
      const reaper = new ReaperAdapter({
        adapterId: 'reaper',
        executionProfile: 'controlled_safe_v1',
        transport: rprTransport,
        hostProbe: createMockReaperProbe(),
      });
      return {
        adapter: reaper,
        insertTargetRef: 'reaper:mixer:0',
        masterTargetRef: 'reaper:mixer:master',
        expectedInitialInsertDb: -2.0,
        injectDrift: () => rprTransport.injectHostStateChange({ tempoBpm: 155 }, false),
        setOffline: (off) => rprTransport.setOffline(off),
      };
    },
    createVersionVariant: (tooOld) =>
      new ReaperAdapter({
        adapterId: tooOld ? 'reaper-old' : 'reaper-new',
        transport: new MockReaperBridgeTransport({
          version: tooOld ? '4.78' : '9.50',
          apiVersion: tooOld ? 478 : 950,
        }),
        hostProbe: createMockReaperProbe(),
      }),
  },
];

describe('Phase 17 — REAPER Adapter + Multi-DAW Validation', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const cores: DawCore[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    while (cores.length > 0) cores.pop()?.dispose();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) await new Promise<void>((res) => s.close(() => res()));
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'xyp3rn-os3-p17-reaper-'));
    tempDirs.push(dir);
    return dir;
  };

  it('1. maintains strict vendor isolation in core/daw-brain and probes real workstation REAPER status honestly', async () => {
    const dawBrainDir = join(REPO_ROOT, 'core', 'daw-brain');
    for (const file of fs.readdirSync(dawBrainDir)) {
      if (!file.endsWith('.ts')) continue;
      const src = fs.readFileSync(join(dawBrainDir, file), 'utf8');
      expect(src).not.toMatch(/daw-adapters|ReaperAdapter|HttpReaperBridgeTransport|FlStudio2025Adapter|xyp3rn_reaper_bridge/i);
    }

    // Real workstation REAPER check: verifies honestly whether reaper.exe exists (absent on this host despite PNG assets!)
    const realProbe = new DefaultReaperHostProbe();
    const env = await realProbe.probeHost();
    expect(env.probedAt).toBeTruthy();
    const reX64 = env.installations.find((i) => i.label === 'REAPER (x64)');
    expect(reX64).toBeDefined();
    if (!reX64!.exists) {
      expect(env.missingPrerequisites.some((m) => m.includes('reaper.exe is not installed'))).toBe(true);
      const offlineReaper = new ReaperAdapter({
        hostProbe: realProbe,
        hostUrl: 'http://127.0.0.1:59999/rpc',
      });
      const insts = await offlineReaper.discover();
      expect(insts[0]?.reachable).toBe(false);

      const core = new DawCore();
      cores.push(core);
      core.registerAdapter(offlineReaper);
      await expect(core.connectSession('reaper')).rejects.toMatchObject({ code: 'DAW_HOST_OFFLINE' });
    }
  });

  it('2. parses .rpp plain-text trees read-only with SHA-256 preservation, connects over real 127.0.0.1 HTTP RPC, and models authentic REAPER semantics', async () => {
    const dir = makeTempDir();
    const rppPath = join(dir, 'sample_mix.rpp');
    fs.writeFileSync(rppPath, SAMPLE_RPP, 'utf8');

    const parsed = inspectRppProjectFile(rppPath);
    expect(parsed.sha256BeforeRead).toBe(parsed.sha256AfterRead);
    expect(parsed.reaperVersion).toContain('7.18');
    expect(parsed.sampleRate).toBe(48_000);
    expect(parsed.tempoBpm).toEqual({ status: 'available', value: 138 });
    expect(parsed.masterVolumeLinear).toBe(1.0);
    expect(parsed.masterVolumeDb).toBe(0);
    expect(parsed.tracks).toHaveLength(2);
    expect(parsed.tracks[0]?.name).toBe('Lead Vocal');
    expect(parsed.tracks[0]?.fxChain[0]?.name).toContain('FabFilter Pro-Q 3');
    expect(parsed.tracks[0]?.fxChain[0]?.hasOpaqueBinaryChunk).toBe(true);
    expect(parsed.warnings.some((w) => w.includes('Base64-opaque'))).toBe(true);
    expect(parsed.tracks[1]?.receives[0]?.sourceTrackIndex).toBe(0);
    expect(parsed.tracks[1]?.receives[0]?.sidechainChannel).toBe(2);
    expect(parsed.markers.some((m) => m.isRegion && m.name === 'Hook')).toBe(true);

    // .rpp unsafe blind overwrite blocked cleanly with DAW_CAPABILITY_UNSUPPORTED
    expect(() => assertRppMutationBlocked(rppPath)).toThrow(/UNSUPPORTED/i);
    try {
      assertRppMutationBlocked(rppPath);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('DAW_CAPABILITY_UNSUPPORTED');
    }

    // Offline snapshot mapping preserves timeline entities (`available`)
    const rppSnap = buildSnapshotFromRpp(parsed, 'rpp-sess-1');
    expect(rppSnap.freshness).toBe('saved');
    expect(rppSnap.audioClips.status).toBe('available');
    expect(rppSnap.automationLanes.status).toBe('available');
    expect(rppSnap.regions.status).toBe('available');
    expect(rppSnap.markers.status).toBe('available');

    // Non-loopback endpoint rejected for security
    expect(() => new HttpReaperBridgeTransport('http://192.168.1.55:8088/rpc')).toThrow(/127\.0\.0\.1 loopback/);

    // Real 127.0.0.1 HTTP JSON-RPC server loopback verification!
    const mockReaperBackend = new MockReaperBridgeTransport();
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly id: number;
        readonly method: string;
        readonly params?: Record<string, unknown>;
      };
      if (rpc.method === 'hello') {
        const result = await mockReaperBackend.open();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        return;
      }
      const result = await mockReaperBackend.call(rpc.method, rpc.params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const addr = server.address() as { readonly port: number };

    const httpReaper = new ReaperAdapter({
      transport: new HttpReaperBridgeTransport(`http://127.0.0.1:${addr.port}/rpc`),
      hostProbe: createMockReaperProbe(),
    });
    const httpDb = openRuntimeDb(join(dir, 'http.sqlite'));
    openDbs.push(httpDb);
    const core = new DawCore({ db: httpDb });
    cores.push(core);
    core.registerAdapter(httpReaper);
    const liveSess = await core.connectSession('reaper', { projectPath: rppPath });
    expect(liveSess.observed?.transport.tempo.bpm).toBe(138);
    expect(liveSess.observed?.regions.status).toBe('available');
    expect(liveSess.observed?.automationLanes.status).toBe('available');
    const hc = await core.checkHealth(liveSess.sessionId);
    expect(hc.healthy).toBe(true);
    expect(hc.reachable).toBe(true);
  });

  describe.each(HARNESS_TARGETS)('3. Shared Cross-DAW Contract Conformance Suite -> $label', (target) => {
    it('passes lifecycle, read-only boot, version bounds, offline recovery, safety clamps, drift, approval & rollback identically', async () => {
      const dir = makeTempDir();
      const db = openRuntimeDb(join(dir, 'conformance.sqlite'));
      openDbs.push(db);
      const core = new DawCore({ db, maxConsecutiveHealthFailures: 2 });
      cores.push(core);

      const h = target.createAdapter();
      const contract = validateAdapterContract(h.adapter);
      expect(contract.ok).toBe(true);

      core.registerAdapter(h.adapter);
      const sess = await core.connectSession(h.adapter.manifest.adapterId);
      expect(sess.connection.status).toBe('connected_read_only');
      expect(sess.connection.activePermissionTier).toBe('observe');
      expect(sess.connection.versionCompatibility).toBe('compatible');

      // Version checks: too old throws DAW_UNSUPPORTED_HOST_VERSION; untested new degrades to degraded_read_only
      const oldCore = new DawCore({ db });
      cores.push(oldCore);
      oldCore.registerAdapter(target.createVersionVariant(true));
      await expect(oldCore.connectSession(target.createVersionVariant(true).manifest.adapterId)).rejects.toMatchObject({
        code: 'DAW_UNSUPPORTED_HOST_VERSION',
      });

      const newAdapter = target.createVersionVariant(false);
      const newCore = new DawCore({ db });
      cores.push(newCore);
      newCore.registerAdapter(newAdapter);
      const degradedSess = await newCore.connectSession(newAdapter.manifest.adapterId);
      expect(degradedSess.connection.versionCompatibility).toBe('degraded_read_only');

      // Default read-only boot refuses mutation without active lease
      const mkCmd = (over: Partial<DawCommand> = {}): DawCommand => ({
        commandId: `cmd-${Math.random().toString(36).slice(2, 9)}`,
        sessionId: sess.sessionId,
        kind: 'mixer.volume_pan_mute',
        capabilityId: 'daw.mixer.fader_pan_mute',
        targetRef: h.insertTargetRef,
        params: { deltaDb: -1.5 },
        requestedBy: 'daw-operator',
        requestedClass: 'Execution',
        correlationId: 'corr-conformance-1',
        createdAt: new Date().toISOString(),
        ...over,
      });

      await expect(core.prepareCommand(mkCmd())).rejects.toMatchObject({ code: 'DAW_LEASE_REQUIRED' });

      const lease = core.grantSessionLease({
        sessionId: sess.sessionId,
        maxPermission: 'rollback',
        grantedBy: 'blago-operator',
        allowedTargets: ['*'],
        ttlMs: 60_000,
      });

      // Universal safety clamps work across FL (0.8 unity), REAPER (1.0 unity), & FakeDawAdapter!
      await expect(
        core.prepareCommand(mkCmd({ params: { deltaDb: 5.0 } }), { leaseId: lease.id }),
      ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

      await expect(
        core.prepareCommand(mkCmd({ targetRef: h.masterTargetRef, params: { volumeDb: 2.0 } }), { leaseId: lease.id }),
      ).rejects.toMatchObject({ code: 'DAW_SAFETY_VIOLATION' });

      // Drift guard across all 3 adapters
      const driftPrep = await core.prepareCommand(mkCmd({ params: { deltaDb: -1.5 } }), {
        leaseId: lease.id,
        queueApproval: true,
      });
      db.decideApproval({
        approvalId: driftPrep.approvalId!,
        decision: 'approved',
        approver: 'blago-operator',
        reason: 'Conformance trim',
      });
      h.injectDrift();
      await core.refreshSession(sess.sessionId);
      const drifted = await core.executeCommand(driftPrep.prepareId, {
        actor: 'daw-operator',
        approvalId: driftPrep.approvalId!,
        leaseId: lease.id,
      });
      expect(drifted.ok).toBe(false);
      expect(drifted.error?.code).toBe('DAW_TARGET_DRIFT');

      // Full dry-run -> prepare -> human approval -> postcondition readback -> exact rollback
      const cleanPrep = await core.prepareCommand(mkCmd({ params: { deltaDb: -1.5 } }), {
        leaseId: lease.id,
        queueApproval: true,
      });
      expect(cleanPrep.dryRun.ok).toBe(true);
      db.decideApproval({
        approvalId: cleanPrep.approvalId!,
        decision: 'approved',
        approver: 'blago-operator',
        reason: 'Conformance clean execution',
      });

      const execOk = await core.executeCommand(cleanPrep.prepareId, {
        actor: 'daw-operator',
        approvalId: cleanPrep.approvalId!,
        leaseId: lease.id,
      });
      expect(execOk.ok).toBe(true);
      expect(execOk.verifiedByReadback).toBe(true);
      expect(execOk.postconditionVerified).toBe(true);

      const rb = await core.rollbackCommand(execOk.receiptId!, {
        actor: 'blago-operator',
        leaseId: lease.id,
      });
      expect(rb.ok).toBe(true);
      expect(rb.status).toBe('rolled_back');

      const postRbSnap = core.sessions.getSession(sess.sessionId)!.observed!;
      const restCh =
        postRbSnap.mixerChannels.status === 'available'
          ? postRbSnap.mixerChannels.value.find((m) => m.id === h.insertTargetRef)
          : undefined;
      expect(restCh?.volumeDb).toBeCloseTo(h.expectedInitialInsertDb, 1);

      // Disconnect -> stale cache degradation -> reconnect recovery
      h.setOffline(true);
      const downHealth = await core.checkHealth(sess.sessionId);
      expect(downHealth.healthy).toBe(false);
      expect(core.sessions.getSession(sess.sessionId)?.stale).toBe(true);

      h.setOffline(false);
      await core.refreshSession(sess.sessionId);
      const upHealth = await core.checkHealth(sess.sessionId);
      expect(upHealth.healthy).toBe(true);
      expect(core.sessions.getSession(sess.sessionId)?.stale).toBe(false);
    });
  });

  it('4. contrasts FL Studio vs REAPER capabilities honestly without forcing fake parity and integrates with JARVIS & Session Intelligence', async () => {
    const dir = makeTempDir();
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(join(dir, 'multi-daw.sqlite'));
    openDbs.push(db);

    const fake = new FakeDawAdapter();
    const fl = new FlStudio2025Adapter({
      executionProfile: 'controlled_safe_v1',
      midiTransport: new MockFlMidiTransport({ allowControlledWrites: true }),
      hostProbe: createMockFlProbe(),
    });
    const reaper = new ReaperAdapter({
      executionProfile: 'controlled_safe_v1',
      transport: new MockReaperBridgeTransport(),
      hostProbe: createMockReaperProbe(),
    });

    // Multi-DAW compatibility report captures shared caps, DAW-specific caps, gaps & semantic contrasts
    const report = buildMultiDawCompatibilityReport([fake, fl, reaper]);
    expect(report.adapterIds).toEqual(['fake-simulated-daw', 'fl-studio-2025', 'reaper']);
    expect(report.sharedCapabilities).toEqual(
      expect.arrayContaining([
        'daw.health.probe',
        'daw.transport.read',
        'daw.transport.control',
        'daw.mixer.read',
        'daw.mixer.fader_pan_mute',
        'daw.plugin.bypass',
      ]),
    );
    expect(report.capabilityGaps.some((g) => g.capabilityId === 'daw.plugin.load_remove')).toBe(true);
    expect(report.capabilityGaps.some((g) => g.capabilityId === 'daw.track.create_delete')).toBe(true);
    expect(report.dawSpecificCapabilities['reaper']).toEqual(
      expect.arrayContaining(['daw.track.create_delete', 'daw.plugin.load_remove', 'daw.project.save']),
    );
    expect(report.semanticDifferences.some((d) => d.aspect.includes('Unity Fader Calibration'))).toBe(true);

    // Core enabling extended REAPER structural operations demonstrates honest FL=UNSUPPORTED vs REAPER=SUPPORTED divergence!
    const extCore = new DawCore({
      db,
      executionPolicy: {
        allowStructuralOps: true,
        permittedCapabilities: [
          'daw.transport.control',
          'daw.mixer.fader_pan_mute',
          'daw.plugin.bypass',
          'daw.track.create_delete',
          'daw.plugin.load_remove',
          'daw.project.save',
        ],
      },
    });
    cores.push(extCore);
    extCore.registerAdapter(fl);
    extCore.registerAdapter(reaper);

    const flSess = await extCore.connectSession('fl-studio-2025');
    const rprSess = await extCore.connectSession('reaper');

    const flLease = extCore.grantSessionLease({
      sessionId: flSess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });
    const rprLease = extCore.grantSessionLease({
      sessionId: rprSess.sessionId,
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    // FL Studio refuses plugin.load_remove & track.create_delete cleanly (`DAW_CAPABILITY_UNSUPPORTED`)
    await expect(
      extCore.prepareCommand(
        {
          commandId: 'cmd-fl-addfx',
          sessionId: flSess.sessionId,
          kind: 'plugin.load_remove',
          capabilityId: 'daw.plugin.load_remove',
          targetRef: 'mixer:insert:1',
          params: { fxName: 'VST3: ReaComp' },
          requestedBy: 'daw-operator',
          requestedClass: 'Execution',
          correlationId: 'corr-div-fl',
          createdAt: new Date().toISOString(),
        },
        { leaseId: flLease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_CAPABILITY_UNSUPPORTED' });

    // REAPER supports plugin.load_remove (`TrackFX_AddByName`) with strong non-rollback approval & readback!
    const rprAddFxPrep = await extCore.prepareCommand(
      {
        commandId: 'cmd-rpr-addfx',
        sessionId: rprSess.sessionId,
        kind: 'plugin.load_remove',
        capabilityId: 'daw.plugin.load_remove',
        targetRef: 'reaper:mixer:0',
        params: { fxName: 'VST3: ReaComp (Cockos)' },
        strongApprovalReason: 'Acknowledge plugin load lacks scalar rollback',
        requestedBy: 'daw-operator',
        requestedClass: 'Execution',
        correlationId: 'corr-div-rpr',
        createdAt: new Date().toISOString(),
      },
      { leaseId: rprLease.id, queueApproval: true },
    );
    expect(rprAddFxPrep.assessment.rollbackSupported).toBe(false);
    expect(rprAddFxPrep.assessment.approvalRequirement).toBe('human_strong');

    db.decideApproval({
      approvalId: rprAddFxPrep.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved REAPER ReaComp load with strong awareness',
    });

    const rprAddFxExec = await extCore.executeCommand(rprAddFxPrep.prepareId, {
      actor: 'daw-operator',
      approvalId: rprAddFxPrep.approvalId!,
      leaseId: rprLease.id,
      strongApprovalConfirmed: true,
    });
    expect(rprAddFxExec.ok).toBe(true);
    expect(rprAddFxExec.rollbackSupported).toBe(false);
    const rprAfterPlugins =
      extCore.sessions.getSession(rprSess.sessionId)?.observed?.plugins.status === 'available'
        ? extCore.sessions.getSession(rprSess.sessionId)!.observed!.plugins
        : null;
    expect(
      rprAfterPlugins?.status === 'available' && rprAfterPlugins.value.some((p) => p.name.includes('ReaComp')),
    ).toBe(true);

    // End-to-end Session Intelligence & JARVIS Core delegation works on REAPER without core changes
    const si = new DawSessionIntelligence();
    const flIntel = await si.analyzeSession(extCore.sessions.getSession(flSess.sessionId)!);
    const rprIntel = await si.analyzeSession(extCore.sessions.getSession(rprSess.sessionId)!);
    expect(rprIntel.routingGraph.observabilityStatus).toBe('complete');
    expect(rprIntel.inventory.counts.plugins).toBeGreaterThanOrEqual(5);
    expect(rprIntel.inventory.inaccessibleDomains).toHaveLength(0);
    expect(flIntel.inventory.inaccessibleDomains.some((d) => d.domain === 'automationLanes')).toBe(true);

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
    const jarvis = new Os3JarvisCore({
      db,
      agents,
      tools,
      contextEngine: new Os3ContextEngine({ vault, db }),
      orchestrator,
      workflows,
      dawDelegate: extCore,
    });

    const jarvisRpr = await jarvis.handleDirective('xyp3rn> daw inspect tracks', {
      sessionId: rprSess.sessionId,
    });
    expect(jarvisRpr.ok).toBe(true);
    expect(jarvisRpr.dawResult?.capabilityInfo.hostAdapterId).toBe('reaper');
    expect(jarvisRpr.dawResult?.stateTier).toBe('liveObserved');
  });
});
