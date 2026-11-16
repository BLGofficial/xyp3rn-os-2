import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIO_EXTRACTED_PROMPTS_DIR } from '../../core/gateway/audio-reverse-engineer.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { bootstrapAndSyncVault } from '../../core/vault-engine/bootstrap.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';
import { provisionOs3Vault, validateOs3Vault } from '../../core/vault-engine/vault-foundation.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Audio Reverse-Engineer & Dedicated Obsidian Extracted Prompts Folder', () => {
  let tempVault: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-audio-'));
    db = openRuntimeDb(':memory:');
    vault = new VaultEngine({ vaultRoot: tempVault, db });
    await provisionOs3Vault({ vaultRoot: tempVault, repoRoot: REPO_ROOT });
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

  it('reverse-engineers acoustic telemetry without saving files until operator confirms unified or per-facet save', async () => {
    const telemetry = {
      fileName: 'Midnight-London-Drill-Demo.wav',
      mimeType: 'audio/wav',
      fileSizeBytes: 18_420_000,
      durationSec: 148,
      sampleRate: 44100,
      channels: 2,
      bpm: 142,
      bpmConfidence: 0.91,
      musicalKey: 'F#',
      scale: 'minor',
      keyConfidence: 0.84,
      rmsDb: -10.2,
      peakDb: -0.4,
      crestDb: 9.8,
      estimatedLufs: -9.4,
      spectralCentroidHz: 1840,
      subBassRatio: 0.39,
      lowMidRatio: 0.31,
      vocalMidRatio: 0.28,
      airHighRatio: 0.17,
      stereoWidth: 0.62,
      transientDensity: 5.2,
      swingFactor: 0.34,
      vocalActivityScore: 0.44,
      sections: [
        { label: 'Intro', startSec: 0, endSec: 20, energy: 0.28 },
        { label: 'Drop / Hook', startSec: 20, endSec: 65, energy: 0.88 },
      ],
    };

    // 1. Reverse-engineer must NOT create any Markdown or audio file on disk
    const revRes = await fetch(`${server.url}/api/audio/reverse-engineer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({ telemetry, useLlm: false }),
    });
    expect(revRes.status).toBe(200);
    const revJson = (await revRes.json()) as {
      ok: boolean;
      folder: string;
      spec: {
        id: string;
        stylePrompt: string;
        genres: string[];
        vocalSpec: { hasVocals: boolean; register: string };
        flowSpec: { pocket: string };
        instrumentsSpec: { bassAndSub: string[]; drumsAndPercussion: string[] };
      };
    };
    expect(revJson.ok).toBe(true);
    expect(revJson.folder).toBe(AUDIO_EXTRACTED_PROMPTS_DIR);
    expect(revJson.spec.stylePrompt).toContain('142 BPM');
    expect(revJson.spec.stylePrompt).toContain('F# minor');
    expect(revJson.spec.genres.some((g) => /drill/i.test(g))).toBe(true);
    expect(revJson.spec.vocalSpec.hasVocals).toBe(true);
    expect(revJson.spec.flowSpec.pocket).toContain('142 BPM');

    const filesBeforeSave = await readdir(join(tempVault, ...AUDIO_EXTRACTED_PROMPTS_DIR.split('/')));
    expect(filesBeforeSave).toEqual([]);

    // 2. Operator confirms per-facet Markdown save into the dedicated Obsidian folder
    const saveRes = await fetch(`${server.url}/api/audio/save-prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        spec: revJson.spec,
        saveMode: 'per-facet',
        selectedFacets: ['style', 'vocal', 'flow'],
        customTitle: 'Midnight London Drill',
      }),
    });
    expect(saveRes.status).toBe(200);
    const saveJson = (await saveRes.json()) as {
      ok: boolean;
      folder: string;
      savedFiles: Array<{ facet: string; vaultPath: string; sha256: string }>;
    };
    expect(saveJson.ok).toBe(true);
    expect(saveJson.folder).toBe(AUDIO_EXTRACTED_PROMPTS_DIR);
    expect(saveJson.savedFiles).toHaveLength(3);
    for (const file of saveJson.savedFiles) {
      expect(file.vaultPath.startsWith(`${AUDIO_EXTRACTED_PROMPTS_DIR}/`)).toBe(true);
      expect(file.vaultPath.endsWith('.md')).toBe(true);
      const md = await readFile(join(tempVault, ...file.vaultPath.split('/')), 'utf8');
      expect(md).toContain('schema: xyp3rn.knowledge/v3');
      expect(md).toContain('category: audio-extracted-prompt');
    }

    // 3. List endpoint returns strictly the extracted prompt notes from that folder
    const listRes = await fetch(`${server.url}/api/audio/prompts`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      folder: string;
      count: number;
      prompts: Array<{ vaultPath: string }>;
    };
    expect(listJson.ok).toBe(true);
    expect(listJson.folder).toBe(AUDIO_EXTRACTED_PROMPTS_DIR);
    expect(listJson.count).toBe(3);

    // 4. Whole Vault validation passes cleanly with saved prompt notes
    const vaultReport = await validateOs3Vault(tempVault);
    expect(vaultReport.ok).toBe(true);

    // 5. Dashboard /api/records overview merges 09_X3LIUS_MUSIC extracted prompts
    const recordsRes = await fetch(`${server.url}/api/records`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    expect(recordsRes.status).toBe(200);
    const recordsJson = (await recordsRes.json()) as {
      ok: boolean;
      sunoPrompts: Array<{ vaultPath: string }>;
    };
    expect(recordsJson.ok).toBe(true);
    expect(
      recordsJson.sunoPrompts.filter((item) => item.vaultPath.startsWith(`${AUDIO_EXTRACTED_PROMPTS_DIR}/`)).length,
    ).toBe(3);
  });
});
