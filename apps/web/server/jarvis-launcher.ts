import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/repo.ts';
import { JARVIS_ORIGIN } from './voice-relay.ts';

/**
 * Starts Jarvis (galaxy/server.py, the voice agent's desk) for the agent ring's Start button. The command is fixed:
 * nothing from the request reaches it. It is started detached, so it outlives this server, with its output in a log
 * file in the OS temp folder, and it is never started twice: a Jarvis that already answers is left alone.
 */

export type LaunchResult =
  | { readonly reason: 'already-running' }
  | { readonly reason: 'started'; readonly logFile: string }
  | { readonly reason: 'failed'; readonly detail: string; readonly logFile: string };

type Options = {
  readonly origin?: string;
  readonly root?: string;
  /** Interpreters to try in order, each with the arguments that go before the script. */
  readonly pythons?: readonly (readonly [string, readonly string[]])[];
  readonly script?: string;
  readonly waitMs?: number;
};

const DEFAULT_PYTHONS = [['python', []], ['py', ['-3']]] as const;
const WAIT_MS = 8000;
const POLL_MS = 400;
export const JARVIS_LOG = join(tmpdir(), 'xyp3rn-jarvis.log');

const answers = async (origin: string) => {
  try { await fetch(`${origin}/state`, { cache: 'no-store', signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let inflight: Promise<LaunchResult> | undefined;

const launch = async (o: Required<Options>): Promise<LaunchResult> => {
  if (await answers(o.origin)) return { reason: 'already-running' };
  for (const [cmd, pre] of o.pythons) {
    const log = openSync(JARVIS_LOG, 'a');
    const spawned = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, [...pre, o.script], { cwd: join(o.root, 'galaxy'), detached: true, stdio: ['ignore', log, log], windowsHide: true });
      child.once('error', () => resolve(false)); // not found: try the next interpreter
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
    closeSync(log);
    if (!spawned) continue;
    for (let waited = 0; waited < o.waitMs; waited += POLL_MS) {
      await sleep(POLL_MS);
      if (await answers(o.origin)) return { reason: 'started', logFile: JARVIS_LOG };
    }
    return { reason: 'failed', detail: `Jarvis was started but did not answer on ${o.origin} within ${Math.round(o.waitMs / 1000)} s.`, logFile: JARVIS_LOG };
  }
  return { reason: 'failed', detail: 'Python was not found on this server (tried python and py -3).', logFile: JARVIS_LOG };
};

/** A second call while one is starting waits for the same start instead of spawning another. */
export const startJarvis = (options: Options = {}): Promise<LaunchResult> => {
  inflight ??= launch({ origin: JARVIS_ORIGIN, root: REPO_ROOT, pythons: DEFAULT_PYTHONS, script: 'server.py', waitMs: WAIT_MS, ...options })
    .finally(() => { inflight = undefined; });
  return inflight;
};
