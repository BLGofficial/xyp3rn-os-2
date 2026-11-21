import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpReaperBridgeTransport, MAX_REAPER_RPC_RESPONSE_BYTES } from '../../core/daw-adapters/reaper/reaper-transport.ts';
import { inspectRppProjectFile } from '../../core/daw-adapters/reaper/rpp-inspector.ts';
import { AudioBrain } from '../../core/daw-brain/audio-brain/audio-brain.ts';
import { acquireWavFileReadOnly, decodeWavBuffer } from '../../core/daw-brain/audio-brain/acquisition-decoder.ts';
import { createDawBrainRuntimeToolSpecs } from '../../core/daw-brain/agents/daw-agent-tools.ts';
import { DawCore, FakeDawAdapter } from '../../core/daw-brain/index.ts';
import { PluginCatalogRegistry } from '../../core/daw-brain/plugin-brain/catalog-ingestion.ts';
import { PluginBrain } from '../../core/daw-brain/plugin-brain/plugin-brain.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { redactSecrets, StructuredLogger } from '../../core/runtime/logger.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { inspectSqliteFile, restoreSqliteDatabase } from '../../core/sqlite/recovery.ts';
import { Os3ToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { archiveVaultNote } from '../../core/vault-engine/vault-archive.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';
import { validateVaultPath } from '../../core/vault-engine/path-guard.ts';
import { resolveVaultPathSync } from '../../core/vault-engine/path-resolver.ts';
import { validateEntityContent } from '../../core/vault-engine/schema-validator.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const buildValidWavBuffer = (sampleRateHz = 44100, channels = 1, frames = 2048): Buffer => {
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames * channels; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.1) * 12000), 44 + i * 2);
  }
  return buf;
};

describe('Phase 23 — OS3 + DAW Brain Security Hardening & Failure-Injection Suite', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];
  const openCores: DawCore[] = [];
  const openServers: Os3GatewayServerHandle[] = [];
  const httpServers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    while (httpServers.length > 0) {
      const s = httpServers.pop()!;
      await new Promise<void>((r) => s.close(() => r()));
    }
    while (openServers.length > 0) {
      await openServers.pop()!.close().catch(() => undefined);
    }
    while (openCores.length > 0) {
      openCores.pop()!.dispose();
    }
    while (openDbs.length > 0) {
      openDbs.pop()!.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeTempDir = (prefix = 'xyp3rn-p23-') => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  it('1. Blocks OS3/legacy governance bypasses, NTFS ADS colons, control chars, and Windows reserved filenames', async () => {
    const dir = makeTempDir();
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(join(dir, 'os3.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });

    const forbiddenPaths = [
      '08_GOVERNANCE/00_Policies/Injected.md',
      '08_GOVERNANCE/policies/lower.md',
      '08_GOVERNANCE/CustomOverride.md',
      '06_GOVERNANCE/CustomOverride.md',
      '00_SYSTEM/MaliciousManifest.md',
    ];
    for (const p of forbiddenPaths) {
      await expect(
        vault.writeNote({ vaultPath: p, content: '# Bypass Attempt\n', actor: 'rogue-agent' }),
      ).rejects.toThrow(/canonical|restricted/i);
    }
    await expect(
      vault.writeNote({ vaultPath: '08_governance/policies/lower.md', content: '# Bypass\n', actor: 'rogue-agent' }),
    ).rejects.toThrow(/approved Vault directory/i);

    const unsafeLexical = [
      '03_RESEARCH_INTELLIGENCE/00_Briefs/note.md::$DATA',
      '03_RESEARCH_INTELLIGENCE/00_Briefs/CON.md',
      '03_RESEARCH_INTELLIGENCE/00_Briefs/NUL.md',
      '03_RESEARCH_INTELLIGENCE/00_Briefs/bad\u0007bell.md',
    ];
    for (const bad of unsafeLexical) {
      expect(validateVaultPath(vaultRoot, bad).ok).toBe(false);
      expect(() => resolveVaultPathSync(vaultRoot, bad)).toThrow();
    }

    // Archive sector immutability & targetSubdir restriction
    const workingPath = '03_RESEARCH_INTELLIGENCE/00_Briefs/arch-source.md';
    await vault.writeNote({
      vaultPath: workingPath,
      content: '---\nschema: xyp3rn.entity/v3\nid: p23-arch-src-1\ntitle: "Archive Source"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\nstatus: draft\n---\n\nBody.\n',
      actor: 'operator',
    });
    const archived = await archiveVaultNote(vault, {
      sourceVaultPath: workingPath,
      reason: 'Superseded by Phase 23 test',
      actor: 'operator',
      targetSubdir: 'RETIRED',
    });
    await expect(
      archiveVaultNote(vault, {
        sourceVaultPath: archived.archivedPath,
        reason: 'Double archive attempt',
        actor: 'operator',
      }),
    ).rejects.toThrow(/immutable archive sector/i);
  });

  it('2. Enforces DAW instance identity, single-use consumed-approval lock, and failure/timeout recovery', async () => {
    const dir = makeTempDir();
    const db = openRuntimeDb(join(dir, 'daw.sqlite'));
    openDbs.push(db);

    let delayExecute = false;
    class SlowableFakeAdapter extends FakeDawAdapter {
      override async execute(
        command: Parameters<FakeDawAdapter['execute']>[0],
        snapshot: Parameters<FakeDawAdapter['execute']>[1],
      ) {
        if (delayExecute) {
          await new Promise((r) => setTimeout(r, 200));
        }
        return super.execute(command, snapshot);
      }
    }
    const fakeAdapter = new SlowableFakeAdapter();

    const core = new DawCore({
      db,
      executionPolicy: { defaultTimeoutMs: 60 },
    });
    openCores.push(core);
    core.registerAdapter(fakeAdapter);
    const sess = await core.connectSession(fakeAdapter.manifest.adapterId, { projectPath: 'D:\\Projects\\SecTest.sim' });

    const lease = core.grantSessionLease({
      sessionId: sess.sessionId,
      maxPermission: 'rollback',
      grantedBy: 'human-operator',
      allowedTargets: ['mixer:insert:1'],
      ttlMs: 60_000,
    });

    // Wrong DAW instance ID fails cleanly in prepare() and logs deny event
    await expect(
      core.prepareCommand(
        {
          commandId: 'cmd-wrong-inst',
          sessionId: sess.sessionId,
          kind: 'mixer.volume_pan_mute',
          capabilityId: 'daw.mixer.fader_pan_mute',
          targetRef: 'mixer:insert:1',
          params: { deltaDb: -1.0 },
          expectedDawId: 'wrong-daw-instance-999',
          expectedProjectId: sess.project.projectId,
          requestedBy: 'daw-operator',
          requestedClass: 'Execution',
          correlationId: 'corr-wrong-inst',
          createdAt: new Date().toISOString(),
        },
        { leaseId: lease.id },
      ),
    ).rejects.toMatchObject({ code: 'DAW_PERMISSION_DENIED' });

    // Prepare + approve + execute ONCE
    const cmd1 = {
      commandId: 'cmd-once-1',
      sessionId: sess.sessionId,
      kind: 'mixer.volume_pan_mute' as const,
      capabilityId: 'daw.mixer.fader_pan_mute',
      targetRef: 'mixer:insert:1',
      params: { deltaDb: -1.0 },
      expectedDawId: sess.dawId,
      expectedAdapterId: sess.adapterId,
      expectedProjectId: sess.project.projectId,
      requestedBy: 'daw-operator',
      requestedClass: 'Execution' as const,
      correlationId: 'corr-once-1',
      createdAt: new Date().toISOString(),
    };
    const prep1 = await core.prepareCommand(cmd1, { leaseId: lease.id, queueApproval: true });
    db.decideApproval({
      approvalId: prep1.approvalId!,
      decision: 'approved',
      approver: 'human-operator',
      reason: 'Single-use trim approved',
    });
    const res1 = await core.executeCommand(prep1.prepareId, {
      actor: 'daw-operator',
      approvalId: prep1.approvalId!,
      leaseId: lease.id,
    });
    expect(res1.ok).toBe(true);

    // Replaying the consumed approvalId with a brand new command MUST be denied
    const replayCmd = {
      ...cmd1,
      commandId: 'cmd-replay-attack-2',
      correlationId: 'corr-replay-2',
    };
    const replayRes = await core.executeCommand(replayCmd, {
      actor: 'daw-operator',
      approvalId: prep1.approvalId!,
      leaseId: lease.id,
    });
    expect(replayRes.ok).toBe(false);
    expect(replayRes.error?.code).toBe('DAW_APPROVAL_REQUIRED');
    expect(replayRes.error?.message).toMatch(/already consumed/i);

    // Timeout failure injection triggers recovery outcome & logs timed_out event
    const slowCmd = {
      ...cmd1,
      commandId: 'cmd-slow-timeout',
      correlationId: 'corr-slow',
      params: { deltaDb: -0.5 },
      timeoutMs: 25,
    };
    const prepSlow = await core.prepareCommand(slowCmd, { leaseId: lease.id, queueApproval: true });
    db.decideApproval({
      approvalId: prepSlow.approvalId!,
      decision: 'approved',
      approver: 'human-operator',
      reason: 'Timeout recovery check',
    });
    delayExecute = true;
    const timedOutRes = await core.executeCommand(prepSlow.prepareId, {
      actor: 'daw-operator',
      approvalId: prepSlow.approvalId!,
      leaseId: lease.id,
      timeoutMs: 25,
    });
    delayExecute = false;
    expect(timedOutRes.ok).toBe(false);
    expect(timedOutRes.status).toBe('timed_out');
    expect(timedOutRes.timedOut).toBe(true);
    expect(timedOutRes.lifecycleStages).toContain('recovery_or_rollback');
    expect(db.listEvents({ eventType: 'daw.command.timed_out' }).length).toBeGreaterThanOrEqual(1);
  });

  it('3. Hardens REAPER HTTP bridge loopback transport against SSRF, tokenless requests, and oversized RPC responses', async () => {
    expect(() => new HttpReaperBridgeTransport('http://192.168.1.50:8088/rpc')).toThrow(/loopback/i);
    expect(() => new HttpReaperBridgeTransport('ftp://127.0.0.1:8088/rpc')).toThrow(/protocol/i);

    const seenHeaders: Array<string | undefined> = [];
    let sendOversized = false;
    const srv = createServer((req, res) => {
      seenHeaders.push(req.headers['x-xyp-bridge-token'] as string | undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (sendOversized) {
        res.end('x'.repeat(MAX_REAPER_RPC_RESPONSE_BYTES + 1024));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { reaperVersion: '7.0', apiVersion: 1, projectPath: null } }));
      }
    });
    httpServers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;

    const transport = new HttpReaperBridgeTransport(`http://127.0.0.1:${port}/rpc`, {
      bridgeToken: 'bridge-sec-token',
    });
    await transport.open();
    expect(seenHeaders[0]).toBe('bridge-sec-token');

    sendOversized = true;
    await expect(transport.call('getSnapshot')).rejects.toThrow(/exceeded max/i);
  });

  it('4. Hardens audio decoding/acquisition, tool path traversal, plugin metadata ingestion, and .rpp size/symlink checks', async () => {
    const dir = makeTempDir();
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(join(dir, 'audio-sec.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });

    const validWav = join(dir, 'clean.wav');
    writeFileSync(validWav, buildValidWavBuffer(44100, 1, 4410));

    // Size limit enforcement BEFORE reading large WAV into RAM
    expect(() => acquireWavFileReadOnly(validWav, 'user_file', { maxBytes: 1024 })).toThrow(/AUDIO_FILE_TOO_LARGE/i);

    // Malicious sample rate & max frames cap in WAV decoder
    const badRateWav = buildValidWavBuffer(100, 1, 200);
    expect(() => decodeWavBuffer(badRateWav)).toThrow(/sample rate/i);
    expect(() => decodeWavBuffer(buildValidWavBuffer(44100, 1, 5000), { maxFrames: 1000 })).toThrow(/AUDIO_FRAME_LIMIT_EXCEEDED/i);

    // Symlink audio rejection
    const symWav = join(dir, 'sym.wav');
    let symOk = false;
    try {
      symlinkSync(validWav, symWav, 'file');
      symOk = true;
    } catch {
      symOk = false;
    }
    if (symOk) {
      expect(() => acquireWavFileReadOnly(symWav)).toThrow(/symlink/i);
    }

    // AudioBrain + PluginBrain observability events (no raw PCM/credentials logged)
    const audioBrain = new AudioBrain();
    const audioRep = audioBrain.analyzeAudioFile(validWav, { db, sessionId: null });
    expect(audioRep.reportId).toMatch(/^audiorep-/);
    const audioEvents = db.listEvents({ eventType: 'daw.audio.analyzed' });
    expect(audioEvents).toHaveLength(1);
    expect(JSON.stringify(audioEvents[0]!.payload)).not.toContain('channelData');

    // Tool Registry rejects traversal in daw_audio_brain_analyze & emits daw.plugin.analyzed on plugin query
    const toolSpecs = createDawBrainRuntimeToolSpecs({
      vault,
      audioBrain,
      pluginBrain: new PluginBrain(),
      db,
    });
    const dummyTools = new Os3ToolRegistry(toolSpecs, db);
    await expect(
      dummyTools.execute(
        { runId: 'run-p23-1', agentName: 'audio-quality-analyst', agentClass: 'Research', log: () => undefined },
        'daw_audio_brain_analyze',
        { filePath: '..\\..\\Windows\\secret.wav' },
      ),
    ).rejects.toThrow(/traversal/i);

    await dummyTools.execute(
      { runId: 'run-p23-2', agentName: 'plugin-specialist', agentClass: 'Research', log: () => undefined },
      'daw_plugin_brain_query',
      { operation: 'recommend_role', role: 'subtractive_eq' },
    );
    expect(db.listEvents({ eventType: 'daw.plugin.analyzed' }).length).toBeGreaterThanOrEqual(1);

    // Plugin metadata ingestion sanitization & batch cap
    const catalog = new PluginCatalogRegistry();
    expect(() => catalog.ingestUserCatalog([{ productName: '__proto__' }])).toThrow(/prototype key/i);
    expect(() => catalog.ingestUserCatalog([{ productName: '\x00' }])).toThrow(/non-empty/i);
    expect(() =>
      catalog.ingestUserCatalog(
        Array.from({ length: 2001 }, (_, i) => ({ productName: `Plugin-${i}` })),
      ),
    ).toThrow(/BATCH_EXCEEDED/i);

    // .rpp non-rpp extension rejection
    const fakeRpp = join(dir, 'bad.txt');
    writeFileSync(fakeRpp, '<REAPER_PROJECT 0.1 "7.0"\n>');
    expect(() => inspectRppProjectFile(fakeRpp)).toThrow(/expected \.rpp extension/i);
  });

  it('5. Enforces fail-closed auth, prototype-safe JSON bodies, expanded secret/audio redaction, runtime errors & SQLite recovery', async () => {
    const dir = makeTempDir();
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const dbPath = join(dir, 'os3.sqlite');
    const db = openRuntimeDb(dbPath);
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });

    // XYP_REQUIRE_AUTH=1 refuses empty token
    const prevRequire = process.env.XYP_REQUIRE_AUTH;
    const prevToken = process.env.XYP_GATEWAY_TOKEN;
    process.env.XYP_REQUIRE_AUTH = '1';
    delete process.env.XYP_GATEWAY_TOKEN;
    try {
      await expect(startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 })).rejects.toThrow(
        /XYP_REQUIRE_AUTH=1/,
      );
    } finally {
      if (prevRequire === undefined) delete process.env.XYP_REQUIRE_AUTH;
      else process.env.XYP_REQUIRE_AUTH = prevRequire;
      if (prevToken === undefined) delete process.env.XYP_GATEWAY_TOKEN;
      else process.env.XYP_GATEWAY_TOKEN = prevToken;
    }

    // Secret & raw-audio redaction checks
    const sampleRedacted = redactSecrets(
      'err sk-proj-abcdefghijklmnopqrstuvwxyz ghp_1234567890abcdef123456 postgres://admin:supersecret@db.local:5432/x?api_key=leakkey123',
    );
    expect(sampleRedacted).not.toContain('sk-proj-abc');
    expect(sampleRedacted).not.toContain('ghp_12345');
    expect(sampleRedacted).not.toContain('supersecret');
    expect(sampleRedacted).toContain('@db.local:5432');
    expect(sampleRedacted).not.toContain('leakkey123');

    const logger = new StructuredLogger();
    const logged = logger.info('test.audio', 'Audio telemetry', {
      token: 'secret-token',
      channelData: [0.1, 0.2, 0.3],
      verdict: 'pass',
    });
    expect(logged?.context?.token).toBe('[REDACTED_SECRET]');
    expect(logged?.context?.channelData).toBe('[AUDIO_CONTENT_REDACTED]');
    expect(logged?.context?.verdict).toBe('pass');

    // Vault secret detector catches GitHub / OpenAI keys / credentialed URIs
    const secCheck = validateEntityContent(
      '03_RESEARCH_INTELLIGENCE/00_Briefs/leak.md',
      '---\ntitle: "Leak"\n---\n\nhttps://user:pass@secret.host/db and sk-proj-0123456789abcdefghijkl\n',
      { requireSchema: false },
    );
    expect(secCheck.issues.some((i) => i.code === 'SECRET_DETECTED')).toBe(true);

    // Gateway prototype pollution stripping on JSON input
    const gw = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      authToken: 'p23-token',
    });
    openServers.push(gw);
    const protoRes = await fetch(`${gw.url}/api/workflows/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer p23-token',
      },
      body: '{"workflowName":"retrieve-and-summarize","inputs":{"query":"safe","__proto__":{"polluted":true}}}',
    });
    expect(protoRes.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // SQLite backup -> corrupt injection -> quarantine & restore recovery proof
    const backupPath = join(dir, 'os3-backup.sqlite');
    db.close();
    copyFileSync(dbPath, backupPath);
    writeFileSync(dbPath, 'CORRUPTED_BYTES_0000000000000000', 'utf8');

    const corruptedCheck = inspectSqliteFile(dbPath);
    expect(corruptedCheck.corrupt).toBe(true);

    const restored = restoreSqliteDatabase({ backupPath, targetPath: dbPath });
    expect(restored.ok).toBe(true);
    expect(restored.integrityOk).toBe(true);
    expect(restored.quarantinePath).toBeTruthy();
    expect(inspectSqliteFile(dbPath).ok).toBe(true);
  });
});
