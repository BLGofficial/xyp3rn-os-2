import { execFileSync } from 'node:child_process';

// Usage: node scripts/voice-services.ts <start|status|stop>
// Local services for Mercury voice: Postgres (existing container xyp3rn-pg) and Kokoro-FastAPI
// (container xyp3rn-kokoro on 127.0.0.1:8880). Containers are reused by name, never duplicated.
// Mercury itself runs in the foreground (`pnpm dev` or `pnpm build && pnpm start`); stop it with
// Ctrl+C in its terminal. Nothing here registers OS-login startup.

const PG = 'xyp3rn-pg';
const KOKORO = 'xyp3rn-kokoro';
// Pinned to the digest validated on 2026-09-28 (Kokoro-FastAPI 0.9.0, CPU). Override with KOKORO_IMAGE.
const KOKORO_IMAGE = process.env.KOKORO_IMAGE || 'ghcr.io/remsky/kokoro-fastapi-cpu@sha256:ee3111d6a2c903ed62f3b4fa19543c6901205ed39fce3c177e895b34a8386b9c';
const KOKORO_HEALTH = 'http://127.0.0.1:8880/health';
const MERCURY = 'http://127.0.0.1:3000/';

const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args: string[]): string | null => { try { return docker(...args); } catch { return null; } };
const state = (name: string): 'running' | 'stopped' | 'missing' => {
  const s = tryDocker('inspect', '-f', '{{.State.Running}}', name);
  return s === null ? 'missing' : s === 'true' ? 'running' : 'stopped';
};
const probe = async (url: string, ms = 2000): Promise<number | null> => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(ms) })).status; } catch { return null; }
};
const waitFor = async (what: string, check: () => Promise<boolean>, seconds: number): Promise<boolean> => {
  for (let i = 0; i < seconds; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 1000)); }
  console.error(`${what}: not ready after ${seconds}s`);
  return false;
};
const pgReady = async () => tryDocker('exec', PG, 'pg_isready', '-q', '-h', '127.0.0.1') !== null;
const kokoroReady = async () => (await probe(KOKORO_HEALTH)) === 200;

const prerequisites = (): boolean => {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 22;
  console.log(`node ${process.versions.node}${ok ? '' : ' (need >= 22)'}`);
  const server = tryDocker('version', '--format', '{{.Server.Version}}');
  console.log(server ? `docker engine ${server}` : 'docker: engine not reachable (start Docker Desktop)');
  return ok && server !== null;
};

const status = async (): Promise<void> => {
  prerequisites();
  console.log(`postgres ${PG}: ${state(PG)}${state(PG) === 'running' ? (await pgReady() ? ', accepting connections' : ', not ready') : ''}`);
  console.log(`kokoro ${KOKORO}: ${state(KOKORO)}${state(KOKORO) === 'running' ? (await kokoroReady() ? ', healthy' : ', not healthy yet') : ''}`);
  const m = await probe(MERCURY);
  console.log(`mercury ${MERCURY}: ${m === null ? 'not running' : `HTTP ${m}`}`);
  if (process.platform === 'win32') {
    const wispr = (() => { try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq Wispr Flow.exe', '/NH'], { encoding: 'utf8' }); } catch { return ''; } })();
    console.log(`wispr flow: ${/Wispr Flow\.exe/i.test(wispr) ? 'running' : 'not detected'} (external app; Mercury never talks to it)`);
  }
  for (const name of ['XYP_DATABASE_URL', 'KOKORO_URL', 'KOKORO_API_KEY', 'KOKORO_TIMEOUT_MS', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']) {
    console.log(`env ${name}: ${process.env[name] ? 'set' : 'not set'}`);
  }
};

const start = async (): Promise<void> => {
  if (!prerequisites()) { process.exitCode = 1; return; }
  const pg = state(PG);
  if (pg === 'missing') {
    console.error(`postgres: no container named ${PG}. Create it once (see docs/voice/README.md), then rerun.`);
    process.exitCode = 1; return;
  }
  if (pg === 'stopped') docker('start', PG);
  if (!(await waitFor('postgres', pgReady, 30))) { process.exitCode = 1; return; }
  console.log('postgres: ready');

  const k = state(KOKORO);
  if (k === 'missing') {
    if ((await probe(KOKORO_HEALTH)) !== null) { console.error('kokoro: port 8880 is already served by something else; not starting a second service'); process.exitCode = 1; return; }
    docker('run', '-d', '--name', KOKORO, '-p', '127.0.0.1:8880:8880', KOKORO_IMAGE);
  } else if (k === 'stopped') docker('start', KOKORO);
  if (!(await waitFor('kokoro', kokoroReady, 180))) { process.exitCode = 1; return; }
  console.log('kokoro: healthy on 127.0.0.1:8880');
  console.log('next: pnpm dev   (or: pnpm build && pnpm start)   then open http://127.0.0.1:3000');
};

const stop = async (): Promise<void> => {
  // Postgres is shared with the rest of the OS, so only Kokoro is stopped here.
  if (state(KOKORO) === 'running') { docker('stop', KOKORO); console.log('kokoro: stopped (container kept; `pnpm voice:start` resumes it)'); }
  else console.log(`kokoro: ${state(KOKORO)}`);
  if ((await probe(MERCURY)) !== null) console.log('mercury: still running; stop it with Ctrl+C in its terminal');
};

const cmd = process.argv[2];
if (cmd === 'start') await start();
else if (cmd === 'status') await status();
else if (cmd === 'stop') await stop();
else { console.error('usage: voice-services.ts <start|status|stop>'); process.exitCode = 2; }
