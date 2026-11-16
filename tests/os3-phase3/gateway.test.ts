import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import {
  isAllowedGatewayOrigin,
  startOs3GatewayServer,
  type Os3GatewayServerHandle,
} from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('OS 3.0 Phase 3 — JARVIS Core & Local HTTP Gateway (core/gateway)', () => {
  let tempVault: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-gw-'));
    db = openRuntimeDb(':memory:');
    vault = new VaultEngine({ vaultRoot: tempVault, db });
    await bootstrapAndSyncVault({ vaultRoot: tempVault, repoRoot: REPO_ROOT });
    await vault.scanVault();
    runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    server = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    db.close();
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined);
  });

  it('enforces localhost binding and Same-Origin & Host Allowlist', async () => {
    expect(isAllowedGatewayOrigin('127.0.0.1:8077', 'http://localhost:3000')).toBe(true);
    expect(isAllowedGatewayOrigin('localhost:8077', 'http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedGatewayOrigin('evil.example.com', 'http://127.0.0.1:3000')).toBe(false);
    expect(isAllowedGatewayOrigin('127.0.0.1:8077', 'https://evil.example.com')).toBe(false);

    await expect(
      startOs3GatewayServer(runtime, { host: '0.0.0.0', port: 0 }),
    ).rejects.toThrow(/must bind to 127\.0\.0\.1/i);

    const forbiddenRes = await fetch(`${server.url}/api/health`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(forbiddenRes.status).toBe(403);
  });

  it('serves /api/health and /api/music/pulse with 24-band spectrum', async () => {
    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      agentsCount: number;
      indexStats: { totalFiles: number };
    };
    expect(health.ok).toBe(true);
    expect(health.agentsCount).toBe(52);
    expect(health.indexStats.totalFiles).toBeGreaterThanOrEqual(68);

    const pulseRes = await fetch(`${server.url}/api/music/pulse?track=neon-static&t=2.4`);
    expect(pulseRes.status).toBe(200);
    const pulse = (await pulseRes.json()) as { ok: boolean; spectrum: number[] };
    expect(pulse.ok).toBe(true);
    expect(pulse.spectrum).toHaveLength(24);
    expect(pulse.spectrum.every((v) => v >= 0.1 && v <= 1)).toBe(true);
  });

  it('executes status, write (with No-Overwrite Guard & canonical guard), read, search, flow, and promote over POST /api/jarvis', async () => {
    const postJarvis = async (prompt: string) => {
      const res = await fetch(`${server.url}/api/jarvis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        ok: boolean;
        reply: string;
        commandKind: string;
        engine: string;
        vaultPath?: string;
        sha256?: string;
        approvalId?: string;
        jobId?: string;
      };
    };

    // 1. status
    const statusOut = await postJarvis('xyp3rn> status');
    expect(statusOut.ok).toBe(true);
    expect(statusOut.commandKind).toBe('status');
    expect(statusOut.reply).toContain('52 registered agents');

    // 2. write + No-Overwrite Guard
    const write1 = await postJarvis(
      'xyp3rn> write 05_XYP3RN_RECORDS/00_Daily_Notes/Session.md "First take notes"',
    );
    expect(write1.ok).toBe(true);
    expect(write1.vaultPath).toBe('05_XYP3RN_RECORDS/00_Daily_Notes/Session.md');

    const write2 = await postJarvis(
      'xyp3rn> write 05_XYP3RN_RECORDS/00_Daily_Notes/Session.md "Second take notes"',
    );
    expect(write2.ok).toBe(true);
    expect(write2.vaultPath).toBe('05_XYP3RN_RECORDS/00_Daily_Notes/Session (2).md');
    expect(write2.reply).toContain('No-Overwrite Guard preserved');

    // 3. canonical write blocked
    const blockedWrite = await postJarvis(
      'xyp3rn> write 02_KNOWLEDGE_LAYER/04_Atomic_Notes/Canon.md "Bypass attempt"',
    );
    expect(blockedWrite.ok).toBe(false);
    expect(blockedWrite.reply).toContain('403 FORBIDDEN');

    // 4. read
    const readOut = await postJarvis('xyp3rn> read 05_XYP3RN_RECORDS/00_Daily_Notes/Session.md');
    expect(readOut.ok).toBe(true);
    expect(readOut.reply).toContain('First take notes');

    // 5. search
    const searchOut = await postJarvis('xyp3rn> search Session');
    expect(searchOut.ok).toBe(true);
    expect(searchOut.reply).toContain('Session.md');

    // 6. flow research-brief
    const flowOut = await postJarvis('xyp3rn> flow research-brief Session');
    expect(flowOut.ok).toBe(true);
    expect(flowOut.jobId).toBeTruthy();
    expect(flowOut.vaultPath).toMatch(/^03_RESEARCH_INTELLIGENCE\/00_Briefs\//);

    // 7. promote -> human approval queue -> decide -> canonical promotion
    const promoteOut = await postJarvis('xyp3rn> promote suno-v6-sub-glide');
    expect(promoteOut.ok).toBe(true);
    expect(promoteOut.approvalId).toBeTruthy();

    const decideRes = await fetch(`${server.url}/api/approvals/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approvalId: promoteOut.approvalId,
        decision: 'approved',
        approver: 'blago',
        reason: 'verified in studio',
      }),
    });
    expect(decideRes.status).toBe(200);
    const decideJson = (await decideRes.json()) as {
      ok: boolean;
      approval: { status: string; approver: string };
    };
    expect(decideJson.ok).toBe(true);
    expect(decideJson.approval.status).toBe('approved');
  });
});
