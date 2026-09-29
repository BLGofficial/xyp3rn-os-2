import { spawn } from 'node:child_process';

/**
 * Drives the real `claude` CLI (Claude Code) as a child process, for the claude-code LLM engine and
 * Mercury's headless skill/deep runs. Personal use of the owner's logged-in CLI: this module never
 * reads credentials. Arguments are an array with no shell; text goes through stdin.
 */

export type ClaudeRun = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
export type ClaudeRunner = (
  args: readonly string[],
  stdin: string,
  opts: { readonly cwd: string; readonly signal?: AbortSignal; readonly timeoutMs?: number },
) => Promise<ClaudeRun>;

/** `CLAUDE_BIN` overrides the binary (tests, non-PATH installs). */
export const runClaudeCli: ClaudeRunner = (args, stdin, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', [...args], {
      cwd: opts.cwd, shell: false, windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? Object.assign(new Error('claude CLI not found on PATH (install Claude Code or set CLAUDE_BIN)'), { code: 'ENOENT' }) : e);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
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
