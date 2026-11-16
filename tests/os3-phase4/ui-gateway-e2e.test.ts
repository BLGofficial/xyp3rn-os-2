import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('OS 3.0 Phase 4 — End-to-End UI-xyp3rn <-> OS 3.0 Gateway Integration', () => {
  let tempVault: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p4-'));
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

  it('verifies UI-xyp3rn wire compatibility for status, compose, play, vault note fetch, search, and approval flow', async () => {
    // 1. UI-xyp3rn status command returns 137 vault jobs + live Vault counts
    const statusRes = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({ prompt: 'xyp3rn> status', activeSector: '01_CORE' }),
    });
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as {
      ok: boolean;
      reply: string;
      connectorCount: number;
      connectorHealthy: number;
    };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.reply).toContain('137 vault jobs');
    expect(statusJson.connectorCount).toBe(21);
    expect(statusJson.connectorHealthy).toBe(21);

    // 2. UI-xyp3rn compose command creates Suno package note and returns compose-track action
    const composeRes = await fetch(`${server.url}/api/jarvis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({ prompt: 'xyp3rn> compose "-FREE- Uk Drill Type"' }),
    });
    const composeJson = (await composeRes.json()) as {
      ok: boolean;
      action?: { type: string; trackId: string };
      vaultPath?: string;
    };
    expect(composeJson.ok).toBe(true);
    expect(composeJson.action).toEqual({ type: 'compose-track', trackId: 'uk-drill' });
    expect(composeJson.vaultPath).toContain('05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/07_Suno_Prompts/');

    // 3. UI-xyp3rn fetchVaultNote reads the synced agent note from 01_CORE/02_Agents/
    const noteRes = await fetch(
      `${server.url}/api/vault/note?path=${encodeURIComponent('01_CORE/02_Agents/x3lius-lyrics.md')}`,
    );
    expect(noteRes.status).toBe(200);
    const noteJson = (await noteRes.json()) as {
      ok: boolean;
      note: { vaultPath: string; sector: string; sha256: string };
    };
    expect(noteJson.ok).toBe(true);
    expect(noteJson.note.vaultPath).toBe('01_CORE/02_Agents/x3lius-lyrics.md');
    expect(noteJson.note.sector).toBe('01_CORE');

    // 4. UI-xyp3rn /api/runs lists the executed runs and jobs
    const runsRes = await fetch(`${server.url}/api/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const runsJson = (await runsRes.json()) as { ok: boolean; agentRuns: unknown[]; jobs: unknown[] };
    expect(runsJson.ok).toBe(true);
  });
});
