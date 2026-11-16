import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Jarvis Direct Vault + Whole-OS Read/Search & Operator Change Acceptance', () => {
  let tempVault: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-jarvis-acc-'));
    db = openRuntimeDb(':memory:');
    vault = new VaultEngine({ vaultRoot: tempVault, db });
    await bootstrapAndSyncVault({ vaultRoot: tempVault, repoRoot: REPO_ROOT });

    // Seed a ROOT_KB note at Vault root to verify root-level full-text Vault search & read
    await writeFile(
      join(tempVault, 'Suno-Deep-Bass-Bible.md'),
      '# Suno Deep Bass Bible\n\nAlways layer sub-bass glides at 48 Hz cleanly below 140 BPM UK drill kicks.\n',
      'utf8',
    );
    await vault.scanVault({ full: true });
    runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    db.close();
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined);
  });

  it('searches and reads across Whole OS functions/files and full Obsidian Vault bodies without mutating anything', async () => {
    // 1. Natural question targeting OS code & functions
    const osAskRes = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        prompt: 'What functions exist in reverseEngineerAudioTelemetry?',
        readAccepted: true,
        askBeforeChange: true,
      }),
    });
    expect(osAskRes.status).toBe(200);
    const osAskJson = (await osAskRes.json()) as {
      ok: boolean;
      reply: string;
      citations?: Array<{ scope: string; path: string; symbols?: string[] }>;
    };
    expect(osAskJson.ok).toBe(true);
    expect(osAskJson.reply).toContain('core/gateway/audio-reverse-engineer.ts');
    expect(osAskJson.citations?.some((c) => c.scope === 'os' && c.path.includes('audio-reverse-engineer.ts'))).toBe(true);

    // 2. Full-text Vault search hits ROOT_KB note body text cleanly
    const searchRes = await fetch(`${server.url}/api/jarvis/search?q=${encodeURIComponent('48 Hz sub-bass glides')}`);
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as {
      ok: boolean;
      vaultHits: Array<{ vaultPath: string; matchedLines: Array<{ text: string }> }>;
    };
    expect(searchJson.ok).toBe(true);
    expect(searchJson.vaultHits.some((h) => h.vaultPath === 'Suno-Deep-Bass-Bible.md')).toBe(true);

    // 3. Direct OS inspection extracts symbols & blocks sensitive .env paths
    const inspectOs = await fetch(
      `${server.url}/api/jarvis/inspect?scope=os&path=${encodeURIComponent('core/gateway/audio-reverse-engineer.ts')}`,
    );
    expect(inspectOs.status).toBe(200);
    const inspected = (await inspectOs.json()) as {
      ok: boolean;
      symbols: Array<{ name: string }>;
      content: string;
    };
    expect(inspected.ok).toBe(true);
    expect(inspected.symbols.some((s) => s.name === 'reverseEngineerAudioTelemetry')).toBe(true);

    const inspectSecret = await fetch(`${server.url}/api/jarvis/inspect?scope=os&path=${encodeURIComponent('.env')}`);
    expect(inspectSecret.status).toBe(403);
  });

  it('pauses when readAccepted is false, and requires explicit operator Accept/Decline before applying changes', async () => {
    // 1. Read gated when readAccepted=false
    const lockedRes = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        prompt: 'What is in core/gateway/server.ts?',
        readAccepted: false,
      }),
    });
    const lockedJson = (await lockedRes.json()) as { ok: boolean; requiresReadAcceptance?: boolean; reply: string };
    expect(lockedJson.ok).toBe(true);
    expect(lockedJson.requiresReadAcceptance).toBe(true);
    expect(lockedJson.reply).toMatch(/acceptance/i);

    // 2. Propose a Vault write with askBeforeChange=true -> does NOT touch disk yet
    const targetRel = '05_XYP3RN_RECORDS/00_Daily_Notes/Accepted-Test.md';
    const propRes = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        prompt: `xyp3rn> write ${targetRel} "# Test Operator Gate"`,
        askBeforeChange: true,
        readAccepted: true,
      }),
    });
    const propJson = (await propRes.json()) as {
      ok: boolean;
      proposal?: { id: string; targetPath: string; status: string };
      reply: string;
    };
    expect(propJson.ok).toBe(true);
    expect(propJson.proposal?.id).toBeTruthy();
    expect(propJson.proposal?.status).toBe('pending');
    expect(propJson.reply).toMatch(/apply this change or make no changes/i);
    expect(existsSync(join(tempVault, ...targetRel.split('/')))).toBe(false);

    // 3. Reject / Decline proposal -> zero files created
    const declineRes = await fetch(`${server.url}/api/jarvis/proposal/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: propJson.proposal!.id,
        decision: 'rejected',
        approver: 'blago',
        reason: 'skip writing test note',
      }),
    });
    expect(declineRes.status).toBe(200);
    const declineJson = (await declineRes.json()) as { ok: boolean; applied: boolean; decision: string };
    expect(declineJson.ok).toBe(true);
    expect(declineJson.applied).toBe(false);
    expect(declineJson.decision).toBe('rejected');
    expect(existsSync(join(tempVault, ...targetRel.split('/')))).toBe(false);

    // 4. Propose via natural language & Accept -> applies change cleanly & blocks agent self-approval
    const prop2Res = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        prompt: `Create ${targetRel} # Accepted Note Content`,
        askBeforeChange: true,
        readAccepted: true,
      }),
    });
    const prop2Json = (await prop2Res.json()) as { proposal?: { id: string } };
    expect(prop2Json.proposal?.id).toBeTruthy();

    const agentBlocked = await fetch(`${server.url}/api/jarvis/proposal/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: prop2Json.proposal!.id,
        decision: 'approved',
        approver: 'jarvis',
        reason: 'self approve attempt',
      }),
    });
    expect(agentBlocked.status).toBe(403);

    const acceptRes = await fetch(`${server.url}/api/jarvis/proposal/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId: prop2Json.proposal!.id,
        decision: 'approved',
        approver: 'blago',
        reason: 'looks good',
      }),
    });
    expect(acceptRes.status).toBe(200);
    const acceptJson = (await acceptRes.json()) as { ok: boolean; applied: boolean; vaultPath: string };
    expect(acceptJson.ok).toBe(true);
    expect(acceptJson.applied).toBe(true);
    const writtenText = await readFile(join(tempVault, ...targetRel.split('/')), 'utf8');
    expect(writtenText).toContain('Accepted Note Content');
  });
});
