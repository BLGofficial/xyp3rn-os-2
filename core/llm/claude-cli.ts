import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * Drives the real `claude` CLI (Claude Code) as a child process, for the claude-code LLM engine and
 * Mercury's headless skill/deep runs. Personal use of the owner's logged-in CLI: this module never
 * reads credentials. Arguments are an array with no shell; text goes through stdin.
 */

export type ClaudeRun = { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly stoppedBy?: 'abort' | 'timeout' };
export type ClaudeRunner = (
  args: readonly string[],
  stdin: string,
  opts: { readonly cwd: string; readonly signal?: AbortSignal; readonly timeoutMs?: number },
) => Promise<ClaudeRun>;

/**
 * Strips the vars that would steer the child `claude` off the owner's subscription: Claude Code
 * prefers API-key/token auth over the logged-in session when they're set, and a pinned base URL
 * (e.g. a hosted dev container's ANTHROPIC_BASE_URL) would send it somewhere else entirely. Pure:
 * returns a new object, never touches its input.
 */
export const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  delete copy.ANTHROPIC_API_KEY;
  delete copy.ANTHROPIC_AUTH_TOKEN;
  delete copy.ANTHROPIC_BASE_URL;
  return copy;
};

/**
 * Windows: Node's own abort/timeout wiring (passing `signal`/`timeout` to `spawn`) only terminates the
 * `claude` process itself, not a grandchild like `pnpm ask` it spawned — proven by manual repro: with
 * Node's `timeout` removed, `taskkill /T /F` killed the whole tree, but `child.kill()` alone left the
 * grandchild running. So on win32 we never pass `signal`/`timeout` to `spawn`; we watch for both
 * ourselves and run `taskkill /pid <pid> /T /F` first. `child.kill()` runs afterwards, in taskkill's
 * callback, only as a fallback (e.g. taskkill itself isn't on PATH) — its own errors are ignored.
 */
const killTreeOnWindows = (child: ChildProcess) => {
  if (child.pid === undefined) { child.kill(); return; }
  execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { child.kill(); });
};

/** `CLAUDE_BIN` overrides the binary (tests, non-PATH installs). */
export const runClaudeCli: ClaudeRunner = (args, stdin, opts) =>
  new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', [...args], {
      cwd: opts.cwd, shell: false, windowsHide: true, env: childEnv(process.env),
      ...(!win && opts.signal ? { signal: opts.signal } : {}),
      ...(!win && opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    let stdout = '';
    let stderr = '';
    let stoppedBy: 'abort' | 'timeout' | undefined;

    // On win32 only: we own abort/timeout entirely (nothing was handed to spawn above), including the
    // case where the signal is already aborted before this call ever gets to add a listener for it.
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (win) {
      const stopFor = (reason: 'abort' | 'timeout') => { stoppedBy = reason; killTreeOnWindows(child); };
      if (opts.signal) {
        if (opts.signal.aborted) stopFor('abort');
        else { onAbort = () => stopFor('abort'); opts.signal.addEventListener('abort', onAbort, { once: true }); }
      }
      if (opts.timeoutMs) timer = setTimeout(() => stopFor('timeout'), opts.timeoutMs);
    }
    const cleanup = () => { if (timer) clearTimeout(timer); if (onAbort) opts.signal?.removeEventListener('abort', onAbort); };

    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (e: NodeJS.ErrnoException) => {
      cleanup();
      reject(e.code === 'ENOENT' ? Object.assign(new Error('claude CLI not found on PATH (install Claude Code or set CLAUDE_BIN)'), { code: 'ENOENT' }) : e);
    });
    child.on('close', (code, signal) => {
      // Off win32, spawn's own signal/timeout options did the killing; infer why from what's left:
      // an aborted signal, or (absent that) the SIGTERM that spawn's `timeout` option sends.
      if (!win && !stoppedBy) {
        if (opts.signal?.aborted) stoppedBy = 'abort';
        else if (signal === 'SIGTERM' && opts.timeoutMs !== undefined) stoppedBy = 'timeout';
      }
      cleanup();
      resolve({ code, stdout, stderr, ...(stoppedBy ? { stoppedBy } : {}) });
    });
    // A child that exits before reading all of stdin (e.g. a fast failure) can make this write hit a
    // closed pipe: unhandled, that EPIPE is an uncaught 'error' event and crashes the process. The
    // outcome is still reported normally through 'close'/the parsed result, so the write error itself
    // is simply swallowed.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });

export type ClaudeResult = {
  readonly text: string;
  readonly isError: boolean;
  readonly subtype: string;
  readonly apiErrorStatus: number | null;
  readonly sessionId: string;
  readonly model: string | null;
  readonly stopReason: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
};

type RawResult = {
  type?: string; subtype?: string; is_error?: boolean; api_error_status?: number | null; result?: string;
  session_id?: string; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
};

/** Parses `--output-format json` stdout; null when it is not a result object. */
export const parseClaudeResult = (stdout: string): ClaudeResult | null => {
  let j: RawResult;
  try { j = JSON.parse(stdout) as RawResult; } catch { return null; }
  if (j?.type !== 'result') return null;
  return {
    text: j.result ?? '', isError: j.is_error === true, subtype: j.subtype ?? 'unknown',
    apiErrorStatus: typeof j.api_error_status === 'number' ? j.api_error_status : null,
    sessionId: j.session_id ?? '', model: Object.keys(j.modelUsage ?? {})[0] ?? null, stopReason: j.stop_reason ?? null,
    usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
  };
};

/** True when a failed result reads as a login problem. */
export const isLoggedOut = (r: ClaudeResult): boolean => r.apiErrorStatus === 401 || /not logged in|\/login|authenticat/i.test(r.text);
/** True when a failed result is worth retrying (usage limit, rate limit, overload, gateway). */
export const isTransient = (r: ClaudeResult): boolean =>
  (r.apiErrorStatus !== null && [408, 429, 500, 502, 503, 504, 529].includes(r.apiErrorStatus)) || /usage limit|rate limit|overloaded/i.test(r.text);
