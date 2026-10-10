import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startJarvis } from './jarvis-launcher.ts';

// The Start Jarvis button's launcher. A throwaway "galaxy" folder holds a stand-in server script, run by node.

const dirs: string[] = [];
let fake: Server | undefined;
// On Windows a running script holds its working folder, and the stand-in exits within 1.5 s: delete until it lets go.
const remove = async (dir: string) => {
  for (let i = 0; i < 20; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(remove));
  const f = fake; fake = undefined;
  if (f) await new Promise<void>((done) => { f.closeAllConnections(); f.close(() => done()); });
});

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});
/** A repo root whose galaxy/<name> is the given script. */
const rootWith = (name: string, source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-launch-'));
  dirs.push(root);
  mkdirSync(join(root, 'galaxy'));
  writeFileSync(join(root, 'galaxy', name), source);
  return root;
};
const node = [[process.execPath, []]] as const;

describe('startJarvis', () => {
  it('leaves a Jarvis that already answers alone: nothing is spawned', async () => {
    fake = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => fake!.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const r = await startJarvis({ origin, pythons: [['definitely-not-a-command', []]] }); // would fail if it tried to spawn
    expect(r).toEqual({ reason: 'already-running' });
  });

  it('starts the script detached and reports started once Jarvis answers', async () => {
    const port = await freePort();
    const root = rootWith('listen.mjs', `import { createServer } from 'node:http';
      const s = createServer((_q, res) => res.end('{}')).listen(${port}, '127.0.0.1');
      setTimeout(() => { s.close(); process.exit(0); }, 1500);`);
    const r = await startJarvis({ origin: `http://127.0.0.1:${port}`, root, pythons: node, script: 'listen.mjs', waitMs: 3000 });
    expect(r.reason).toBe('started');
  });

  it('says Python is missing when no interpreter can be run', async () => {
    const port = await freePort();
    const r = await startJarvis({ origin: `http://127.0.0.1:${port}`, root: rootWith('x.py', ''), pythons: [['definitely-not-a-command', []], ['also-not-a-command', ['-3']]], waitMs: 400 });
    expect(r).toMatchObject({ reason: 'failed', detail: expect.stringContaining('Python was not found') });
  });

  it('reports a failure, with the log path, when the script runs but never answers', async () => {
    const port = await freePort();
    const root = rootWith('dies.mjs', 'process.exit(1);');
    const r = await startJarvis({ origin: `http://127.0.0.1:${port}`, root, pythons: node, script: 'dies.mjs', waitMs: 800 });
    expect(r).toMatchObject({ reason: 'failed', detail: expect.stringContaining('did not answer') });
    expect((r as { logFile: string }).logFile).toMatch(/xyp3rn-jarvis\.log$/);
  });

  it('shares one start between two calls made at once', async () => {
    const port = await freePort();
    const root = rootWith('dies.mjs', 'process.exit(1);');
    const opts = { origin: `http://127.0.0.1:${port}`, root, pythons: node, script: 'dies.mjs', waitMs: 500 } as const;
    const [a, b] = await Promise.all([startJarvis(opts), startJarvis(opts)]);
    expect(a).toBe(b);
  });
});
