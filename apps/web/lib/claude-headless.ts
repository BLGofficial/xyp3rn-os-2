import { isLoggedOut, parseClaudeResult, runClaudeCli, type ClaudeRunner } from '../../../core/llm/claude-cli.ts';
import { REPO_ROOT } from '../../../core/repo.ts';
import type { SkillName } from './skills.ts';

/**
 * Mercury's headless Claude Code runs (tiers 1 and 3), on the owner's logged-in CLI. cwd is the repo
 * so project skills load; hooks and the style plugin are off so replies read aloud as plain text.
 * Every run has an explicit tool list and permission mode dontAsk (anything not allowed is denied).
 */

export const SKILL_TIMEOUT_MS = 30 * 60_000;
export const DEEP_TIMEOUT_MS = 20 * 60_000;
const SETTINGS = JSON.stringify({ disableAllHooks: true, enabledPlugins: { 'chisle@chisle': false } });
const BASE = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', SETTINGS, '--strict-mcp-config', '--permission-mode', 'dontAsk'];

// Bare Read/Grep/Glob would read any path on the machine (e.g. a prompt-injected fetch could try
// ~/.claude/.credentials.json), so allow rules are scoped to the repo (cwd) and --disallowedTools
// (deny wins over allow) blocks .env files within that scope. --disallowedTools sits before
// --allowedTools; --allowedTools is variadic, so it is always last.
export const skillArgs = (): string[] => [...BASE, '--tools', 'Bash,Read,Skill', '--disallowedTools', 'Read(./**/.env*)', 'Read(./.env*)', '--allowedTools', 'Bash(pnpm ask:*)', 'Read(./**)', 'Skill'];
export const deepArgs = (): string[] => [...BASE, '--disable-slash-commands', '--tools', 'Read,Grep,Glob,WebSearch,WebFetch,Bash', '--disallowedTools', 'Read(./**/.env*)', 'Read(./.env*)', '--allowedTools', 'Read(./**)', 'Grep(./**)', 'Glob(./**)', 'WebSearch', 'WebFetch', 'Bash(pnpm ask:*)'];

export type HeadlessOutcome = { readonly ok: boolean; readonly reply: string; readonly sessionId?: string };
type Opts = { readonly signal?: AbortSignal; readonly run?: ClaudeRunner; readonly cwd?: string };
/** Reply cap, matching the assistant's short-answer limit. */
const MAX_REPLY_CHARS = 600;
const cap = (s: string) => (s.length > MAX_REPLY_CHARS ? `${s.slice(0, MAX_REPLY_CHARS - 1)}…` : s);

const launch = async (args: string[], prompt: string, timeoutMs: number, o: Opts): Promise<HeadlessOutcome> => {
  const run = o.run ?? runClaudeCli;
  let out;
  try {
    out = await run(args, prompt, { cwd: o.cwd ?? REPO_ROOT, timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { name?: string };
    if (err.code === 'ENOENT') return { ok: false, reply: 'Claude Code is not installed on this PC (claude not found).' };
    if (o.signal?.aborted || err.name === 'AbortError') return { ok: false, reply: 'Cancelled.' };
    throw e;
  }
  if (out.stoppedBy === 'abort') return { ok: false, reply: 'Cancelled.' };
  if (out.stoppedBy === 'timeout') return { ok: false, reply: 'Claude Code timed out or was stopped before finishing.' };
  const r = parseClaudeResult(out.stdout);
  if (!r) return { ok: false, reply: out.code === null ? 'Claude Code timed out or was stopped before finishing.' : `Claude Code stopped without a result (exit ${out.code}).` };
  if (r.isError) {
    if (isLoggedOut(r)) return { ok: false, reply: 'Claude Code is not logged in on this PC. Run `claude` once and sign in.', sessionId: r.sessionId };
    return { ok: false, reply: `Claude Code reported an error (${r.apiErrorStatus ?? r.subtype}).`, sessionId: r.sessionId };
  }
  return { ok: true, reply: cap(r.text.trim()), sessionId: r.sessionId };
};

/** Tier 1: `/<skill> <text>`. The skill name comes from the allowlist; text is only its argument. */
export const runSkill = (skill: SkillName, text: string, o: Opts = {}) => launch(skillArgs(), `/${skill} ${text}`, SKILL_TIMEOUT_MS, o);
/** Tier 3: free-form task, read-only tools plus `pnpm ask`. */
export const runDeep = (text: string, o: Opts = {}) => launch(deepArgs(), text, DEEP_TIMEOUT_MS, o);
