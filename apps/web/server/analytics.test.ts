import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { analyticsOverview } from './analytics-loaders.ts';
import { link, registerTrack, unlink } from './catalog-ops.ts';
import { songCreate, uploadFiles } from './ops.ts';

// Jarvis Prompt 01 Task 6 (J1): Analytics, honest. No platform connector exists (Prompt 11), so the page shows the
// one real data point, the recorded platform links, and nothing shaped like a statistic.

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'jarvis01-analytics-vault-'));
const wav = (): Uint8Array => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.alloc(1600, 3)]));
};

beforeAll(async () => {
  db = await createTestDb('jarvis01_analytics', { migrated: true });
  deps = { sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
  const { songId } = await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' });
  const [bounce] = await uploadFiles(deps, [{ name: 'night-city-master.wav', bytes: wav() }], { songId });
  const { releaseId, trackId } = await registerTrack(deps, { sourceId: bounce!.file.sourceId, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1, songId });
  await link(deps, { releaseId, platform: 'spotify', url: 'https://open.spotify.com/album/1' });
  await link(deps, { trackId, platform: 'soundcloud', url: 'https://soundcloud.com/x3lius/night-city' });
  await link(deps, { releaseId, platform: 'soundcloud', url: 'https://soundcloud.com/x3lius/sets/new-era' });
  const { linkId } = await link(deps, { trackId, platform: 'youtube', url: 'https://www.youtube.com/watch?v=fixture0001' });
  await unlink(deps, linkId, '[FIXTURE] wrong video');
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

const keysOf = (v: unknown): string[] =>
  v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

describe('analyticsOverview', () => {
  it('counts the live platform links by platform (a retracted link is not one), release vs track', async () => {
    const o = await analyticsOverview(db.sql);
    expect(o.links).toEqual([
      { platform: 'soundcloud', total: 2, releases: 1, tracks: 1 },
      { platform: 'spotify', total: 1, releases: 1, tracks: 0 },
    ]);
    expect(o.totalLinks).toBe(3);
    expect(o.connectors).toEqual([]);
  });

  it('returns nothing shaped like a metric', async () => {
    const keys = keysOf(await analyticsOverview(db.sql)).map((k) => k.toLowerCase());
    for (const k of keys) expect(k).not.toMatch(/play|stream|listen|follow|view|revenue|earning|like|metric|stat|reach|engage|save/);
  });
});
