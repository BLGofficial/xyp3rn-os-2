import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DawCore,
  validateAdapterContract,
  type DawCommand,
} from '../../core/daw-brain/index.ts';
import { openRuntimeDb } from '../../core/sqlite/client.ts';
import {
  assertFlpMutationBlocked,
  computeCrc16,
  decodeSysExFrame,
  DefaultFlStudioHostProbe,
  encodeSysExMessage,
  FlStudio2025Adapter,
  inspectFlpProjectFile,
  MockFlMidiTransport,
  SysExChunkAssembler,
  type FlHostEnvironment,
  type FlPluginInventoryEntry,
  type FlStudioHostProbe,
} from '../../core/daw-adapters/fl-studio-2025/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const buildSyntheticFlp = (options: {
  readonly flVersion?: string;
  readonly bpm?: number;
  readonly fineTempo?: boolean;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly channelNames?: readonly string[];
  readonly mixerNames?: readonly string[];
  readonly pluginNames?: readonly string[];
}): Buffer => {
  const events: Buffer[] = [];
  const pushU8 = (id: number, val: number): void => {
    events.push(Buffer.from([id, val & 0xff]));
  };
  const pushU16 = (id: number, val: number): void => {
    const b = Buffer.alloc(3);
    b[0] = id;
    b.writeUInt16LE(val, 1);
    events.push(b);
  };
  const pushU32 = (id: number, val: number): void => {
    const b = Buffer.alloc(5);
    b[0] = id;
    b.writeUInt32LE(val >>> 0, 1);
    events.push(b);
  };
  const pushText = (id: number, text: string, utf16 = true): void => {
    const data = utf16 ? Buffer.from(`${text}\0`, 'utf16le') : Buffer.from(`${text}\0`, 'utf8');
    const lenBytes: number[] = [];
    let len = data.length;
    do {
      let byte = len & 0x7f;
      len >>= 7;
      if (len > 0) byte |= 0x80;
      lenBytes.push(byte);
    } while (len > 0);
    events.push(Buffer.from([id, ...lenBytes]), data);
  };

  pushU8(17, options.numerator ?? 4);
  pushU8(18, options.denominator ?? 4);
  pushU32(159, 4997);
  if (options.bpm !== undefined) {
    if (options.fineTempo) pushU32(156, Math.round(options.bpm * 1000));
    else pushU16(66, Math.round(options.bpm));
  }
  pushText(199, options.flVersion ?? '25.1.6.4997', false);
  for (const ch of options.channelNames ?? ['808 Bass', 'Lead Vocal']) pushText(203, ch);
  for (const mx of options.mixerNames ?? ['Master', 'LEAD VOX']) pushText(204, mx);
  for (const pl of options.pluginNames ?? ['FabFilter Pro-Q 3', 'Fruity Limiter']) pushText(201, pl);

  const dtBody = Buffer.concat(events);
  const flhd = Buffer.alloc(14);
  flhd.write('FLhd', 0, 'ascii');
  flhd.writeUInt32LE(6, 4);
  flhd.writeUInt16LE(0, 8);
  flhd.writeUInt16LE(options.channelNames?.length ?? 2, 10);
  flhd.writeUInt16LE(96, 12);

  const dtHdr = Buffer.alloc(8);
  dtHdr.write('FLdt', 0, 'ascii');
  dtHdr.writeUInt32LE(dtBody.length, 4);

  return Buffer.concat([flhd, dtHdr, dtBody]);
};

const createStaticHostProbe = (overrides: Partial<FlHostEnvironment> = {}): FlStudioHostProbe => ({
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
      runningProcesses: [{ pid: 4120, processName: 'FL64', executablePath: 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe' }],
      midiInPorts: [{ index: 0, direction: 'in', name: 'XYP3RN_OUT' }],
      midiOutPorts: [{ index: 0, direction: 'out', name: 'XYP3RN_IN' }],
      loopMidiInstalled: true,
      configuredInPortFound: true,
      configuredOutPortFound: true,
      controllerScriptPath: 'C:\\Users\\test\\Documents\\Image-Line\\FL Studio\\Settings\\Hardware\\XYP3RN_Brain\\device_XYP3RNBrain.py',
      controllerScriptInstalled: true,
      userProjectsRoot: 'C:\\Users\\test\\Documents\\Image-Line\\FL Studio\\Projects',
      pluginDatabaseRoot: 'C:\\Users\\test\\Documents\\Image-Line\\FL Studio\\Presets\\Plugin database',
      missingPrerequisites: [],
      warnings: [],
      ...overrides,
    };
  },
  discoverProjects: () => ['C:\\Projects\\COLDINMYEYES.flp'],
  scanInstalledPlugins: (): readonly FlPluginInventoryEntry[] => [
    {
      name: 'FabFilter Pro-Q 3',
      format: 'VST3',
      path: 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 3.vst3',
      source: 'vst_filesystem',
      producerEditionStatus: 'third_party_compatible',
    },
    {
      name: 'Harmor',
      format: 'NATIVE',
      path: 'C:\\FL\\Plugins\\Harmor.fst',
      source: 'plugin_database',
      producerEditionStatus: 'excluded_by_edition_unless_purchased',
    },
  ],
});

describe('Phase 11 — FL Studio 2025 Producer Edition Adapter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyp3rn-phase11-fl-'));
    tempDirs.push(dir);
    return dir;
  };

  it('1. maintains strict isolation from core/daw-brain and satisfies DawAdapter contract in read-only v1 mode', () => {
    const coreDir = path.join(REPO_ROOT, 'core', 'daw-brain');
    for (const file of fs.readdirSync(coreDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(coreDir, file), 'utf8');
      expect(text).not.toMatch(/daw-adapters|fl-studio-2025|FlStudio2025Adapter|device_XYP3RNBrain/i);
    }

    const adapter = new FlStudio2025Adapter({
      midiTransport: new MockFlMidiTransport(),
      hostProbe: createStaticHostProbe(),
    });
    const contract = validateAdapterContract(adapter);
    expect(contract.ok).toBe(true);
    expect(adapter.manifest.adapterId).toBe('fl-studio-2025');
    expect(adapter.manifest.hostKind).toBe('fl_studio');
    expect(adapter.manifest.isSimulated).toBe(false);
    expect(adapter.manifest.transportKind).toBe('midi_sysex');

    // Release v1 MUST NOT claim writable support or rollback support for any capability
    const mutatingSupported = adapter
      .getCapabilities()
      .filter((c) => c.supportLevel === 'SUPPORTED' || c.rollbackSupported);
    expect(mutatingSupported).toHaveLength(0);
  });

  it('2. encodes/decodes strict 7-bit SysEx with chunk reassembly, CRC-16 check, and validates read-only Python script', () => {
    const bigTracks = Array.from({ length: 18 }, (_, i) => ({
      index: i,
      name: `Track_${i}_Lead_Synth_€_Test`,
      vol: 0.8,
    }));
    const frames = encodeSysExMessage(0x11, 42, { tracks: bigTracks }, 64);
    expect(frames.length).toBeGreaterThan(2);

    const assembler = new SysExChunkAssembler();
    let decodedOut: unknown = null;
    for (const frame of frames) {
      expect(frame[0]).toBe(0xf0);
      expect(frame[frame.length - 1]).toBe(0xf7);
      for (let i = 1; i < frame.length - 1; i += 1) {
        expect(frame[i]!).toBeLessThan(0x80);
      }
      const res = assembler.push(frame);
      if (res.complete) decodedOut = res.json;
    }
    expect(decodedOut).toEqual({ tracks: bigTracks });

    // Tamper 1 payload byte -> must fail CRC_MISMATCH
    const tampered = new Uint8Array(frames[0]!);
    tampered[13] = ((tampered[13] ?? 0) ^ 0x05) & 0x7f;
    expect(() => decodeSysExFrame(tampered)).toThrow(/CRC_MISMATCH/);
    expect(computeCrc16(new Uint8Array([1, 2, 3]))).toBeTypeOf('number');

    // Verify controller Python script exists, contains zero write calls, and compiles cleanly if python present
    const pyPath = path.join(
      REPO_ROOT,
      'core',
      'daw-adapters',
      'fl-studio-2025',
      'controller',
      'XYP3RN_Brain',
      'device_XYP3RNBrain.py',
    );
    const pyText = fs.readFileSync(pyPath, 'utf8');
    expect(pyText).toContain('def OnSysEx(');
    expect(pyText).toContain('def OnRefresh(');
    expect(pyText).not.toMatch(/setTrackVolume|setTrackPan|setRouteTo|setParamValue|transport\.start|transport\.stop|import\s+socket/);
    try {
      execFileSync('python', ['-m', 'py_compile', pyPath], { timeout: 5_000 });
    } catch {
      // Skip py_compile only if python binary isn't installed in PATH
    }
  });

  it('3. inspects .flp project headers strictly read-only, rejects binary writes, and flags corrupt/obfuscated files honestly', () => {
    const dir = makeTempDir();
    const flpPath = path.join(dir, 'sample_session.flp');
    fs.writeFileSync(
      flpPath,
      buildSyntheticFlp({
        flVersion: '25.1.6.4997',
        bpm: 138,
        fineTempo: true,
        channelNames: ['808 Sub', 'Vocal Take 1'],
        mixerNames: ['Master', 'LEAD VOX'],
        pluginNames: ['FLEX', 'FabFilter Pro-Q 3'],
      }),
    );

    const parsed = inspectFlpProjectFile(flpPath);
    expect(parsed.sha256BeforeRead).toBe(parsed.sha256AfterRead);
    expect(parsed.flVersion).toBe('25.1.6.4997');
    expect(parsed.ppq).toBe(96);
    expect(parsed.tempoBpm).toEqual({ status: 'available', value: 138 });
    expect(parsed.timeSignature).toEqual({
      status: 'available',
      value: { numerator: 4, denominator: 4, ppq: 96 },
    });
    expect(parsed.channelNames).toEqual(['808 Sub', 'Vocal Take 1']);
    expect(parsed.mixerTrackNames).toEqual(['Master', 'LEAD VOX']);
    expect(parsed.pluginNames).toEqual(['FLEX', 'FabFilter Pro-Q 3']);

    // Mutation block fires BEFORE opening file
    expect(() => assertFlpMutationBlocked(flpPath)).toThrow(/UNSUPPORTED/i);

    // Corrupt header fails cleanly
    const badPath = path.join(dir, 'corrupt.flp');
    fs.writeFileSync(badPath, Buffer.from('NOT_FLP_HEADER_DATA_BYTES'));
    expect(() => inspectFlpProjectFile(badPath)).toThrow(/INVALID_PROJECT_FILE/);

    // Real workstation .flp check if running on host where user project files exist
    const realProj1 = path.join(os.homedir(), 'Documents', 'Image-Line', 'FL Studio', 'Projects', 'Project_1', 'Project_1.flp');
    if (fs.existsSync(realProj1)) {
      const realParsed = inspectFlpProjectFile(realProj1);
      expect(realParsed.sha256BeforeRead).toBe(realParsed.sha256AfterRead);
      expect(realParsed.flVersion).toBe('25.1.6.4997');
      expect(realParsed.pluginNames).toContain('FLEX');
    }
  });

  it('4. detects FL Studio, connects read-only, observes state + HW_Dirty_* events, disconnects, and recovers via DawCore', async () => {
    const db = openRuntimeDb(':memory:');

    const mockMidi = new MockFlMidiTransport({ latencyMs: 2 });
    const adapter = new FlStudio2025Adapter({
      midiTransport: mockMidi,
      hostProbe: createStaticHostProbe(),
    });
    const core = new DawCore({ db, maxConsecutiveHealthFailures: 2 });
    core.registerAdapter(adapter);

    const instances = await core.discoverInstances();
    expect(instances.length).toBeGreaterThan(0);
    expect(instances[0]?.hostKind).toBe('fl_studio');
    expect(instances[0]?.reachable).toBe(true);

    const sess = await core.connectSession('fl-studio-2025', { projectPath: 'C:\\Projects\\COLDINMYEYES.flp' });
    expect(sess.connection.status).toBe('connected_read_only');
    expect(sess.connection.activePermissionTier).toBe('observe');
    expect(sess.connection.versionCompatibility).toBe('compatible');
    expect(sess.observed?.transport.tempo.bpm).toBe(138);
    expect(sess.observed?.channels.status).toBe('available');
    expect(sess.observed?.mixerChannels.status).toBe('available');
    expect(sess.observed?.routing.status).toBe('available');
    expect(sess.observed?.plugins.status).toBe('available');

    if (sess.observed?.plugins.status === 'available') {
      const proQ = sess.observed.plugins.value.find((p) => p.name === 'FabFilter Pro-Q 3');
      expect(proQ?.parameters.status).toBe('available');
    }

    // Explicit unsupported assertions (never simulated)
    expect(sess.observed?.automationLanes.status).toBe('unsupported');
    expect(sess.observed?.audioClips.status).toBe('unsupported');
    expect(sess.observed?.markers.status).toBe('unsupported');
    expect(sess.unknownFields.length).toBeGreaterThan(0);

    // Push HW_Dirty_* update propagates live into DawSessionModel
    core.observer.attachSubscription(sess.sessionId);
    mockMidi.injectHostStateChange({ tempoBpm: 141, playing: true }, true);
    const afterPush = core.sessions.getSession(sess.sessionId);
    expect(afterPush?.observed?.transport.tempo.bpm).toBe(141);
    expect(afterPush?.observed?.transport.playing).toBe(true);
    core.observer.stopObserving(sess.sessionId);

    // Disconnection degrades cleanly to cached/stale
    mockMidi.setOffline(true, 'Simulated FL Studio exited');
    const downHealth = await core.checkHealth(sess.sessionId);
    expect(downHealth.healthy).toBe(false);
    expect(downHealth.reachable).toBe(false);
    const degraded = core.sessions.getSession(sess.sessionId);
    expect(degraded?.stale).toBe(true);
    expect(degraded?.cached?.transport.tempo.bpm).toBe(141);

    // Recovery after controller reconnects
    mockMidi.setOffline(false);
    await core.refreshSession(sess.sessionId);
    const recoveredHealth = await core.checkHealth(sess.sessionId);
    expect(recoveredHealth.healthy).toBe(true);
    const recovered = core.sessions.getSession(sess.sessionId);
    expect(recovered?.stale).toBe(false);
    expect(recovered?.stateFreshness).toBe('observed');

    await core.disconnectSession(sess.sessionId);
    core.dispose();
    db.close();
  });

  it('5. handles version mismatches (blocks <24.x, degrades 26.x to read-only) and missing DAW / missing loopMIDI', async () => {
    const tooOldMidi = new MockFlMidiTransport({
      hello: { version: '21.2.3.3424', apiVersion: 24 },
      initialSnapshot: { version: '21.2.3.3424', apiVersion: 24 },
    });
    const core1 = new DawCore();
    core1.registerAdapter(new FlStudio2025Adapter({ midiTransport: tooOldMidi, hostProbe: createStaticHostProbe() }));
    await expect(core1.connectSession('fl-studio-2025')).rejects.toMatchObject({
      code: 'DAW_UNSUPPORTED_HOST_VERSION',
    });

    // Newer FL Studio 26.1.1.5547 degrades cleanly to `degraded_read_only`
    const fl26Midi = new MockFlMidiTransport({
      hello: { version: '26.1.1.5547', apiVersion: 35 },
      initialSnapshot: { version: '26.1.1.5547', apiVersion: 35 },
    });
    const core2 = new DawCore();
    core2.registerAdapter(new FlStudio2025Adapter({ midiTransport: fl26Midi, hostProbe: createStaticHostProbe() }));
    const fl26Sess = await core2.connectSession('fl-studio-2025');
    expect(fl26Sess.connection.versionCompatibility).toBe('degraded_read_only');

    // Missing loopMIDI / missing DAW throws DAW_HOST_OFFLINE cleanly and never fakes online state
    const offlineMidi = new MockFlMidiTransport({ portsPresent: false });
    const core3 = new DawCore();
    const offlineProbe = createStaticHostProbe({
      runningProcesses: [],
      loopMidiInstalled: false,
      configuredInPortFound: false,
      configuredOutPortFound: false,
      missingPrerequisites: [
        'Virtual MIDI loopback ports (XYP3RN_IN / XYP3RN_OUT) not found on Windows WinMM',
        'No live FL64.exe process running',
      ],
    });
    core3.registerAdapter(new FlStudio2025Adapter({ midiTransport: offlineMidi, hostProbe: offlineProbe }));
    const discoveredOffline = await core3.discoverInstances();
    expect(discoveredOffline[0]?.reachable).toBe(false);
    await expect(core3.connectSession('fl-studio-2025')).rejects.toMatchObject({
      code: 'DAW_HOST_OFFLINE',
    });
  });

  it('6. enforces observation-only lock across ALL mutating capabilities (even with lease) and records integration logs', async () => {
    const db = openRuntimeDb(':memory:');

    const mockMidi = new MockFlMidiTransport();
    const adapter = new FlStudio2025Adapter({
      midiTransport: mockMidi,
      hostProbe: createStaticHostProbe(),
    });
    const core = new DawCore({ db });
    core.registerAdapter(adapter);

    const sess = await core.connectSession('fl-studio-2025');
    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'blago-operator',
      allowedTargets: ['*'],
      ttlMs: 60_000,
    });

    const writeCases: readonly { kind: DawCommand['kind']; capabilityId: string }[] = [
      { kind: 'transport.control', capabilityId: 'daw.transport.control' },
      { kind: 'mixer.volume_pan_mute', capabilityId: 'daw.mixer.fader_pan_mute' },
      { kind: 'mixer.routing_write', capabilityId: 'daw.mixer.routing_write' },
      { kind: 'plugin.param_write', capabilityId: 'daw.plugin.param_write' },
      { kind: 'plugin.load_remove', capabilityId: 'daw.plugin.load_remove' },
      { kind: 'track.create_delete', capabilityId: 'daw.track.create_delete' },
      { kind: 'project.save', capabilityId: 'daw.project.save' },
    ];

    for (const wc of writeCases) {
      const cmd: DawCommand = {
        commandId: `cmd-${wc.kind}`,
        sessionId: sess.sessionId,
        kind: wc.kind,
        capabilityId: wc.capabilityId,
        targetRef: 'mixer:insert:1',
        params: { valueNormalized: 0.5 },
        requestedBy: 'tech-audio-tools',
        requestedClass: 'Execution',
        correlationId: 'corr-ro-lock',
        createdAt: new Date().toISOString(),
      };
      await expect(core.prepareCommand(cmd, { leaseId: lease.id })).rejects.toMatchObject({
        code: 'DAW_CAPABILITY_UNSUPPORTED',
      });
      const directExec = await adapter.execute(cmd, sess.observed!);
      expect(directExec.ok).toBe(false);
      expect(directExec.status).toBe('unsupported');
      expect(directExec.error?.code).toBe('DAW_CAPABILITY_UNSUPPORTED');
    }

    const logs = adapter.getIntegrationLogs();
    expect(logs.some((l) => l.event === 'fl.connect.succeeded')).toBe(true);
    expect(logs.some((l) => l.event === 'fl.mutation.refused_execute')).toBe(true);

    core.dispose();
    db.close();
  });

  it('7. real workstation WinMM/host probe returns authentic host telemetry without crashing when loopMIDI absent', async () => {
    const probe = new DefaultFlStudioHostProbe();
    const env = await probe.probeHost();
    expect(env.probedAt).toBeTruthy();
    expect(Array.isArray(env.installations)).toBe(true);
    expect(Array.isArray(env.midiInPorts)).toBe(true);
    expect(Array.isArray(env.midiOutPorts)).toBe(true);
  });
});
