# Claude Code Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run XYP3RN's agents on the owner's Claude Code subscription, and let Mercury start named skills and free-form tasks as headless Claude Code runs, with instant answers from existing data, while keeping every agent, domain, workflow, approval and trace.

**Architecture:** One shared child-process runner (`core/llm/claude-cli.ts`) drives the real `claude` CLI. The LLM provider layer uses it as a fourth transport when `LLM_ENGINE=claude-code`. Mercury's `POST /api/ask` gains a deterministic tier selector: skill (tier 1), lookup (tier 2), deep task (tier 3), or the unchanged `planRequest` path. Skills are project skills that call `pnpm ask --domain/--workflow`, so all work still runs through the OS.

**Tech Stack:** TypeScript on Node ≥22 (type stripping, `.ts` imports), vitest, postgres.js, Next.js route handler, React client component, Claude Code CLI 2.1.285.

**Spec:** `docs/superpowers/specs/2026-09-30-claude-code-engine-design.md`

## Global Constraints

- Branch `feat/claude-code-engine`. Commit after every task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Personal use only: the app only spawns the real `claude` binary; it never reads, copies or embeds a login token.
- Every `claude` spawn: argument array, `shell: false`, no string interpolation into a shell. Long text goes through stdin or a temp file, never a single huge argument.
- No run uses `--dangerously-skip-permissions` or `bypassPermissions`. Every run has an explicit `--tools` list.
- Engine calls (`LLM_ENGINE=claude-code`): cwd is a neutral temp directory, `--tools ""`, `--setting-sources project`, `--strict-mcp-config`, `--no-session-persistence`, `--disable-slash-commands`.
- Skill runs: cwd repo root, tools `Bash,Read,Skill`, allowed `Bash(pnpm ask:*)`, `Read`, `Skill`.
- Deep runs: cwd repo root, tools `Read,Grep,Glob,WebSearch,WebFetch,Bash`, allowed `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Bash(pnpm ask:*)`. No Edit, no Write.
- Skill and deep runs load project settings with `disableAllHooks: true` and `enabledPlugins: { "chisle@chisle": false }`.
- Replies shown or spoken are capped at `MAX_REPLY_CHARS` (600) from `core/orchestrator/ask.ts`.
- Limits: skill run 30 min; deep run 20 min; at most 2 running jobs per user (`MAX_RUNNING_PER_USER`), of which at most 1 deep.
- Error text returned to clients never includes raw CLI output or model text (existing rule: run ids point to detail).
- `LLM_ENGINE` unset: behaviour identical to today.

## Review Focus

1. Dictated skill names arrive with casing and punctuation ("Research: dark vocals", "song-to-suno.") and must still match the skill; text that only *contains* a skill word mid-sentence must not. Test: Task 3.
2. `claude` missing from PATH or logged out must produce a clear, specific error ("claude CLI not found" / "not logged in"), not a generic failure. Test: Task 1.
3. User text that starts with `/`, contains newlines, quotes or shell metacharacters must reach the chosen skill as plain argument text and never select a different command. Test: Task 4.
4. A normal creative request containing a lookup word ("Write a hook for the latest track") must not be diverted to tier 2. Test: Task 5.
5. A tier 2 question with no stored data must answer "nothing stored" and start no run. Test: Task 6.

---

## File map

| File | Responsibility |
|---|---|
| `core/llm/claude-cli.ts` (new) | Spawn `claude`, collect output; parse the `--output-format json` result object |
| `core/llm/providers.ts` (modify) | `claudeCodeTransport`; `LLM_ENGINE` selection in `createLlmClient` |
| `core/orchestrator/orchestrate.ts` (modify) | `WORKFLOWS` registry and `planDirect` (skip keyword routing) |
| `core/orchestrator/ask-cli.ts` (modify) | `--domain` / `--workflow` flags |
| `.claude/skills/xyp-*/SKILL.md` (new, 4) | Project skills that call `pnpm ask` |
| `apps/web/lib/skills.ts` (new) | Skill allowlist and spoken-name matching |
| `apps/web/lib/claude-headless.ts` (new) | Build skill/deep CLI args; run headless and shape the reply |
| `apps/web/lib/tiers.ts` (new) | Deterministic tier selection |
| `apps/web/lib/ask-jobs.ts` (modify) | Abortable jobs, `cancelJob`, `runningCount` |
| `core/orchestrator/lookup.ts` (new) | Tier 2 read-only answers |
| `apps/web/app/api/[...path]/route.ts` (modify) | Tier dispatch in `POST /api/ask`; cancel endpoint |
| `apps/web/components/MercuryShell.tsx` (modify) | Skill buttons, Deep task toggle, Cancel, processing note |
| `docs/ARCHITECTURE.md` (modify) | One paragraph on the engine and tiers |

---

### Task 1: Claude CLI runner and engine transport

**Files:**
- Create: `core/llm/claude-cli.ts`
- Modify: `core/llm/providers.ts` (transport table area near `TRANSPORTS`, and `createLlmClient`)
- Test: `tests/claude-engine/claude-cli-transport.test.ts`

**Interfaces:**
- Produces:
  - `type ClaudeRun = { readonly code: number | null; readonly stdout: string; readonly stderr: string }`
  - `type ClaudeRunner = (args: readonly string[], stdin: string, opts: { readonly cwd: string; readonly signal?: AbortSignal; readonly timeoutMs?: number }) => Promise<ClaudeRun>`
  - `runClaudeCli: ClaudeRunner`
  - `type ClaudeResult = { readonly text: string; readonly isError: boolean; readonly subtype: string; readonly apiErrorStatus: number | null; readonly sessionId: string; readonly model: string | null; readonly stopReason: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }`
  - `parseClaudeResult(stdout: string): ClaudeResult | null` (null when stdout is not a result object)
  - `createLlmClient` gains option `runClaude?: ClaudeRunner`; honours `env.LLM_ENGINE === 'claude-code'`.

- [ ] **Step 1: Write the failing test**

Create `tests/claude-engine/claude-cli-transport.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../../core/llm/json-schema.ts';
import { parseClaudeResult, type ClaudeRunner } from '../../core/llm/claude-cli.ts';
import { createLlmClient } from '../../core/llm/providers.ts';

// FAKE runner: records each spawn and answers with a canned CLI result. Proves the arguments, cwd,
// stdin, parsing and error mapping; the live proof is Task 1 Step 6.
const SCHEMA: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const REQ = { system: 'SYSTEM PROMPT', user: 'USER "quoted"\nline two', schema: { name: 'ok_schema', schema: SCHEMA } };
const result = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '```json\n{"ok":true}\n```',
  session_id: 's-1', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 },
  modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 3 } }, ...over,
});
type Call = { args: readonly string[]; stdin: string; cwd: string; systemPrompt: string };
const fake = (outputs: { code?: number | null; stdout?: string; stderr?: string; throws?: Error }[]) => {
  const calls: Call[] = [];
  let i = 0;
  const run: ClaudeRunner = async (args, stdin, opts) => {
    const at = args.indexOf('--system-prompt-file');
    calls.push({ args, stdin, cwd: opts.cwd, systemPrompt: at >= 0 ? readFileSync(args[at + 1]!, 'utf8') : '' });
    const o = outputs[Math.min(i++, outputs.length - 1)]!;
    if (o.throws) throw o.throws;
    return { code: o.code ?? 0, stdout: o.stdout ?? '', stderr: o.stderr ?? '' };
  };
  return { run, calls };
};
const client = (run: ClaudeRunner, env: Record<string, string | undefined> = { LLM_ENGINE: 'claude-code' }) =>
  createLlmClient({ model: 'claude-sonnet-5', agentName: 'test-agent', env, runClaude: run, retryDelaysMs: [0] });

describe('parseClaudeResult', () => {
  it('reads the result object and returns null for anything else', () => {
    expect(parseClaudeResult(result())).toMatchObject({ text: '```json\n{"ok":true}\n```', isError: false, subtype: 'success', sessionId: 's-1', model: 'claude-sonnet-5', usage: { inputTokens: 10, outputTokens: 3 } });
    expect(parseClaudeResult('not json')).toBeNull();
    expect(parseClaudeResult('{"type":"system"}')).toBeNull();
  });
});

describe('LLM_ENGINE=claude-code', () => {
  it('spawns claude with the engine flags, no API key, prompt on stdin, schema in the system prompt', async () => {
    const f = fake([{ stdout: result() }]);
    const r = await client(f.run).complete(REQ);
    expect(r.json).toEqual({ ok: true });
    expect(r.model).toBe('claude-sonnet-5');
    const c = f.calls[0]!;
    expect(c.stdin).toBe(REQ.user);
    expect(c.cwd).not.toBe(process.cwd());
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'claude-sonnet-5', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']));
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.systemPrompt).toContain('SYSTEM PROMPT');
    expect(c.systemPrompt).toContain('RESPONSE FORMAT');
  });

  it('leaves groq/openrouter and the unset engine on their normal transports', async () => {
    const f = fake([{ stdout: result() }]);
    await expect(client(f.run, {}).complete(REQ)).rejects.toThrow('ANTHROPIC_API_KEY is not set');
    expect(f.calls).toHaveLength(0);
  });

  it('retries usage limits and overload as transient', async () => {
    const f = fake([{ code: 1, stdout: result({ is_error: true, subtype: 'error', api_error_status: 429, result: 'rate limited' }) }, { stdout: result() }]);
    expect((await client(f.run).complete(REQ)).json).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  it('maps a missing CLI and a logged-out CLI to specific errors', async () => {
    const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    await expect(client(fake([{ throws: missing }]).run).complete(REQ)).rejects.toThrow('claude CLI not found');
    await expect(client(fake([{ code: 1, stdout: result({ is_error: true, subtype: 'error', result: 'Not logged in · Please run /login' }) }]).run).complete(REQ)).rejects.toThrow('claude CLI is not logged in');
  });

  it('never copies raw output into errors, and still validates the schema', async () => {
    await expect(client(fake([{ code: 2, stdout: 'SECRET RAW OUTPUT' }]).run).complete(REQ)).rejects.toThrow(/^claude-code exited 2 without a result$/);
    await expect(client(fake([{ stdout: result({ result: '{"ok":"yes"}' }) }]).run).complete(REQ)).rejects.toThrow('violates schema ok_schema');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/claude-engine/claude-cli-transport.test.ts`
Expected: FAIL, `Failed to resolve import "../../core/llm/claude-cli.ts"`.

- [ ] **Step 3: Create `core/llm/claude-cli.ts`**

```ts
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
```

- [ ] **Step 4: Add the transport to `core/llm/providers.ts`**

Add imports at the top:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoggedOut, isTransient, parseClaudeResult, runClaudeCli, type ClaudeRunner } from './claude-cli.ts';
```

Add after `TRANSPORTS`:

```ts
/**
 * LLM_ENGINE=claude-code: Anthropic agents run through the owner's logged-in Claude Code CLI
 * (subscription) instead of the API. No Claude Code tools: the OS still runs every agent tool.
 * cwd is a neutral directory so project hooks and plugins cannot touch the JSON reply.
 */
const ENGINE_FLAGS = ['-p', '--output-format', 'json', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'] as const;
const engineDir = (): string => { const d = join(tmpdir(), 'xyp-claude-engine'); mkdirSync(d, { recursive: true }); return d; };

const claudeCodeTransport = (run: ClaudeRunner): Transport => async (_key, model, req) => {
  // System prompts can exceed Windows' command-line limit, so they go through a file.
  const dir = mkdtempSync(join(tmpdir(), 'xyp-sys-'));
  const file = join(dir, 'system.txt');
  writeFileSync(file, `${req.system}\n\n${schemaInstruction(req)}`);
  try {
    let out;
    try {
      out = await run([...ENGINE_FLAGS, '--model', model, '--system-prompt-file', file], req.user, { cwd: engineDir(), ...(req.signal ? { signal: req.signal } : {}) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('claude CLI not found on PATH (install Claude Code or set CLAUDE_BIN)');
      throw e;
    }
    const r = parseClaudeResult(out.stdout);
    if (!r) throw new Error(`claude-code exited ${out.code} without a result`);
    if (r.isError) {
      if (isLoggedOut(r)) throw new Error('claude CLI is not logged in; run `claude` once and sign in');
      if (isTransient(r)) throw new TransientProviderError(`claude-code transient error (${r.apiErrorStatus ?? r.subtype})`);
      throw new Error(`claude-code error (${r.apiErrorStatus ?? r.subtype})`);
    }
    return { provider: 'anthropic', model: r.model ?? model, text: r.text, usage: r.usage, stopReason: r.stopReason };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
```

In `createLlmClient`, add the option to the options type:

```ts
  /** Claude CLI runner override (tests); used only when env.LLM_ENGINE is `claude-code`. */
  readonly runClaude?: ClaudeRunner;
```

and replace the body of `complete` with:

```ts
    complete: async (req) => {
      const viaCli = modelRef.provider === 'anthropic' && options.env.LLM_ENGINE === 'claude-code';
      const { keyEnv } = PROVIDERS[modelRef.provider];
      const key = options.env[keyEnv] ?? '';
      if (!viaCli && !key) throw new Error(`LLM runner unavailable: ${keyEnv} is not set (agent ${options.agentName} uses model ${options.model})`);
      const transport = viaCli ? claudeCodeTransport(options.runClaude ?? runClaudeCli) : TRANSPORTS[modelRef.provider];
      const raw = await withRetries(() => transport(key, modelRef.model, req, options.fetch), delays, req.signal);
      const json = parseReply(modelRef.provider, raw.text);
      const errors = validateJson(req.schema.schema, json);
      if (errors.length > 0) throw new Error(`${modelRef.provider} reply violates schema ${req.schema.name}: ${errors.join('; ')}`);
      return { ...raw, json };
    },
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/claude-engine/claude-cli-transport.test.ts tests/phase-08/llm-runner.test.ts && pnpm typecheck`
Expected: all PASS; typecheck clean (phase-08 proves the API path is unchanged).

- [ ] **Step 6: Live smoke**

Run from repo root (uses the subscription, one small call):

```bash
LLM_ENGINE=claude-code ANTHROPIC_API_KEY= node -e "
import('./core/llm/providers.ts').then(async ({createLlmClient})=>{
  const c=createLlmClient({model:'claude-haiku-4-5-20251001',agentName:'smoke',env:process.env});
  const r=await c.complete({system:'You answer tersely.',user:'Is water wet?',schema:{name:'yn',schema:{type:'object',properties:{answer:{type:'boolean'}},required:['answer'],additionalProperties:false}}});
  console.log(r.model, JSON.stringify(r.json), r.usage);
})"
```

Expected: a line like `claude-haiku-4-5-20251001 {"answer":true} { inputTokens: …, outputTokens: … }`.

- [ ] **Step 7: Commit**

```bash
git add core/llm/claude-cli.ts core/llm/providers.ts tests/claude-engine/claude-cli-transport.test.ts
git commit -m "feat(llm): run Anthropic agents through Claude Code when LLM_ENGINE=claude-code"
```

---

### Task 2: Direct planning and `ask-cli` flags

**Files:**
- Modify: `core/orchestrator/orchestrate.ts` (append after `ENTRYPOINTS`)
- Modify: `core/orchestrator/ask-cli.ts`
- Test: `tests/claude-engine/plan-direct.test.ts`

**Interfaces:**
- Consumes: `routeRequest`, `RoutableDomain`, `ROUTABLE_DOMAINS` (`router.ts`); `ENTRYPOINTS`, `RequestPlan`, `ENTRYPOINT_PHASE`.
- Produces:
  - `WORKFLOWS: Readonly<Record<string, string>>` = `{ 'song-to-suno': 'records/x3lius/song-to-suno.workflow.yaml', 'retrieve-and-summarize': 'core/workflows/retrieve-and-summarize.workflow.yaml' }`
  - `planDirect(request: string, target: { readonly domain: RoutableDomain } | { readonly workflow: string }, entrypoints?: Entrypoints): RequestPlan`
  - CLI: `ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]`

- [ ] **Step 1: Write the failing test**

```ts
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ENTRYPOINTS, planDirect, WORKFLOWS } from '../../core/orchestrator/orchestrate.ts';

describe('planDirect: a skill has already chosen the target', () => {
  it('runs the named domain even when keywords would route elsewhere', () => {
    const p = planDirect('write a hook about research', { domain: 'RESEARCH_INTELLIGENCE' });
    expect(p).toMatchObject({ action: 'run-service', service: 'run-research', input: { request: 'write a hook about research' } });
  });
  it('holds a domain with no entrypoint', () => {
    expect(planDirect('x', { domain: 'TECH' })).toMatchObject({ action: 'hold' });
  });
  it('runs a registered workflow by id and refuses unknown ids', () => {
    expect(planDirect('a song', { workflow: 'song-to-suno' })).toMatchObject({ action: 'run-workflow', workflow: WORKFLOWS['song-to-suno'] });
    expect(() => planDirect('a song', { workflow: '../etc/passwd' })).toThrow('unknown workflow');
  });
  it('uses the registered entrypoints by default', () => {
    expect(planDirect('x', { domain: 'RECORDS' })).toMatchObject({ service: (ENTRYPOINTS.RECORDS as { service: string }).service });
  });
});

describe('ask-cli flags', () => {
  const cli = join(import.meta.dirname, '../../core/orchestrator/ask-cli.ts');
  const runCli = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args]).then(r => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
  it('--domain skips routing (hold proves it without a DB), bad values exit 2', async () => {
    const hold = await runCli('write a song', '--domain', 'GOVERNANCE');
    expect(hold.code).toBe(0);
    expect(hold.stdout).toContain('hold: no entrypoint registered for GOVERNANCE');
    expect((await runCli('x', '--domain', 'NOPE')).code).toBe(2);
    expect((await runCli('x', '--workflow', 'nope')).code).toBe(2);
    expect((await runCli('x', '--domain', 'RECORDS', '--workflow', 'song-to-suno')).code).toBe(2);
  });
});
```

Save as `tests/claude-engine/plan-direct.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/claude-engine/plan-direct.test.ts`
Expected: FAIL, `planDirect` is not exported.

- [ ] **Step 3: Implement in `orchestrate.ts`**

Change the first import to `import { routeRequest, type RouteDecision, type RoutableDomain } from './router.ts';` (unchanged) and append:

```ts
/** Workflows a skill may run by id (paths relative to the repo root, where `pnpm ask` runs). */
export const WORKFLOWS: Readonly<Record<string, string>> = {
  'song-to-suno': 'records/x3lius/song-to-suno.workflow.yaml',
  'retrieve-and-summarize': 'core/workflows/retrieve-and-summarize.workflow.yaml',
};

/**
 * Plans a request whose target was chosen explicitly (a Claude Code skill), skipping keyword
 * routing. The route decision is still computed and carried as evidence only.
 * @throws Error for a workflow id not in WORKFLOWS
 */
export const planDirect = (
  request: string,
  target: { readonly domain: RoutableDomain } | { readonly workflow: string },
  entrypoints: Entrypoints = ENTRYPOINTS,
): RequestPlan => {
  const route = routeRequest(request);
  if ('workflow' in target) {
    const path = Object.hasOwn(WORKFLOWS, target.workflow) ? WORKFLOWS[target.workflow] : undefined;
    if (!path) throw new Error(`unknown workflow: ${target.workflow}`);
    return { action: 'run-workflow', workflow: path, input: { request }, route };
  }
  const entry = entrypoints[target.domain];
  if (!entry) return { action: 'hold', route, reason: `no entrypoint registered for ${target.domain} yet (built in Phase ${ENTRYPOINT_PHASE[target.domain]})` };
  return typeof entry === 'string'
    ? { action: 'run-workflow', workflow: entry, input: { request }, route }
    : { action: 'run-service', service: entry.service, input: { request }, route };
};
```

- [ ] **Step 4: Implement flags in `ask-cli.ts`**

Replace the usage comment, argument parsing and `const plan = …` line with:

```ts
// Usage: node core/orchestrator/ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]
// The OS front door: route → plan → run the domain entrypoint (or say why not).
// --domain / --workflow skip keyword routing: used by Claude Code skills that already chose.

const USAGE = 'usage: ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]';
const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const request = process.argv[2];
const projectSlug = flag('--project') ?? 'ad-hoc';
const domain = flag('--domain');
const workflow = flag('--workflow');
const bad = (why: string) => { console.error(`${why}\n${USAGE}`); process.exit(2); };
if (!request || request.startsWith('--')) bad('missing request');
if (domain && workflow) bad('use --domain or --workflow, not both');
if (domain && !(ROUTABLE_DOMAINS as readonly string[]).includes(domain)) bad(`unknown domain: ${domain}`);
if (workflow && !Object.hasOwn(WORKFLOWS, workflow)) bad(`unknown workflow: ${workflow}`);

const plan = domain ? planDirect(request!, { domain: domain as RoutableDomain })
  : workflow ? planDirect(request!, { workflow })
  : planRequest(request!, ENTRYPOINTS);
```

Update imports:

```ts
import { ENTRYPOINTS, planDirect, planRequest, WORKFLOWS } from './orchestrate.ts';
import { ROUTABLE_DOMAINS, type RoutableDomain } from './router.ts';
```

The rest of the file (route line, hold/clarify, run) is unchanged. The existing usage test still expects `usage: ask-cli.ts` in stderr with exit 2, which `bad` preserves.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/claude-engine/plan-direct.test.ts apps/web/tests/api-route.test.ts && pnpm typecheck`
Expected: PASS (the existing CLI test in `api-route.test.ts` still passes).

- [ ] **Step 6: Commit**

```bash
git add core/orchestrator/orchestrate.ts core/orchestrator/ask-cli.ts tests/claude-engine/plan-direct.test.ts
git commit -m "feat(orchestrator): planDirect and ask-cli --domain/--workflow flags"
```

---

### Task 3: Project skills and the skill allowlist

**Files:**
- Create: `.claude/skills/xyp-research/SKILL.md`, `.claude/skills/xyp-music/SKILL.md`, `.claude/skills/xyp-song-to-suno/SKILL.md`, `.claude/skills/xyp-retrieve-summarize/SKILL.md`
- Create: `apps/web/lib/skills.ts`
- Test: `apps/web/tests/skills.test.ts`

**Interfaces:**
- Produces:
  - `SKILLS: readonly { readonly name: SkillName; readonly label: string; readonly spoken: readonly string[]; readonly command: string }[]`
  - `type SkillName = 'xyp-research' | 'xyp-music' | 'xyp-song-to-suno' | 'xyp-retrieve-summarize'`
  - `isSkillName(v: unknown): v is SkillName`
  - `matchSkill(text: string): { readonly skill: SkillName; readonly text: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSkillName, matchSkill, SKILLS } from '../lib/skills';

const ROOT = join(import.meta.dirname, '../../..');

describe('skill files match the allowlist', () => {
  it.each(SKILLS.map(s => [s.name, s] as const))('%s has a SKILL.md with its name and exact command', (name, s) => {
    const md = readFileSync(join(ROOT, '.claude/skills', name, 'SKILL.md'), 'utf8');
    expect(md).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    expect(md).toContain(s.command);
  });
});

describe('matchSkill: spoken names at the start only', () => {
  it.each([
    ['research dark baritone vocals in Suno', 'xyp-research', 'dark baritone vocals in Suno'],
    ['Research: dark vocals', 'xyp-research', 'dark vocals'],
    ['MUSIC, write a verse', 'xyp-music', 'write a verse'],
    ['song to suno the new track', 'xyp-song-to-suno', 'the new track'],
    ['song-to-suno. the new track', 'xyp-song-to-suno', 'the new track'],
    ['retrieve and summarize vocal notes', 'xyp-retrieve-summarize', 'vocal notes'],
  ])('%s', (text, skill, rest) => expect(matchSkill(text)).toEqual({ skill, text: rest }));
  it.each(['Write a hook about research', 'researching is fun', 'musical ideas please', 'research'])('no match: %s', (text) => expect(matchSkill(text)).toBeNull());
  it('allowlist', () => {
    expect(isSkillName('xyp-music')).toBe(true);
    expect(isSkillName('xyp-music/../x')).toBe(false);
    expect(isSkillName(7)).toBe(false);
  });
});
```

(`'research'` alone does not match: a skill needs text to act on.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/tests/skills.test.ts`
Expected: FAIL, cannot resolve `../lib/skills`.

- [ ] **Step 3: Create `apps/web/lib/skills.ts`**

```ts
/**
 * Claude Code skills Mercury may start (server-side allowlist). Each wraps one OS entrypoint via
 * `pnpm ask`, so the work, traces and approvals stay in the OS. Files: .claude/skills/<name>/SKILL.md.
 */
export const SKILLS = [
  { name: 'xyp-research', label: 'Research', spoken: ['research'], command: 'pnpm ask "$ARGUMENTS" --domain RESEARCH_INTELLIGENCE' },
  { name: 'xyp-music', label: 'Music', spoken: ['music'], command: 'pnpm ask "$ARGUMENTS" --domain RECORDS' },
  { name: 'xyp-song-to-suno', label: 'Song to Suno', spoken: ['song to suno', 'song-to-suno'], command: 'pnpm ask "$ARGUMENTS" --workflow song-to-suno' },
  { name: 'xyp-retrieve-summarize', label: 'Retrieve & summarize', spoken: ['retrieve and summarize', 'retrieve & summarize'], command: 'pnpm ask "$ARGUMENTS" --workflow retrieve-and-summarize' },
] as const;

export type SkillName = (typeof SKILLS)[number]['name'];
const NAMES: readonly string[] = SKILLS.map(s => s.name);
export const isSkillName = (v: unknown): v is SkillName => typeof v === 'string' && NAMES.includes(v);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest spoken names first so "song to suno" wins over any shorter prefix.
const PATTERNS = SKILLS.flatMap(s => s.spoken.map(p => ({ skill: s.name, re: new RegExp(`^\\s*${escape(p)}\\s*[:,.\\-–—]?\\s+(\\S[\\s\\S]*)$`, 'i'), len: p.length })))
  .sort((a, b) => b.len - a.len);

/** Matches a spoken skill name at the very start of the text, followed by the text to act on. */
export const matchSkill = (text: string): { readonly skill: SkillName; readonly text: string } | null => {
  for (const p of PATTERNS) { const m = p.re.exec(text); if (m) return { skill: p.skill, text: m[1]!.trim() }; }
  return null;
};
```

- [ ] **Step 4: Create the four skill files**

`.claude/skills/xyp-research/SKILL.md`:

```markdown
---
name: xyp-research
description: Run an XYP3RN research question through the OS Research domain (research orchestrator and specialist agents). Use when asked to research, investigate or find the best current method for something.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask "$ARGUMENTS" --domain RESEARCH_INTELLIGENCE

Rules:
- Do not do the research yourself; the OS agents do it and record evidence.
- If the request is empty, reply "What should I research?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the outcome, the key findings if any, and the research run id. If approvals are pending, say so.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.
```

`.claude/skills/xyp-music/SKILL.md`:

```markdown
---
name: xyp-music
description: Send a request to the XYP3RN Records domain (the X3LIUS music system: songwriting, lyrics, hooks, arrangement, production). Use for song and track work.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask "$ARGUMENTS" --domain RECORDS

Rules:
- Do not write lyrics or music yourself; the OS agents do it.
- If the request is empty, reply "What should the music system work on?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the status, which sub-domains ran, and the workflow run id. If approvals are pending, say so.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.
```

`.claude/skills/xyp-song-to-suno/SKILL.md`:

```markdown
---
name: xyp-song-to-suno
description: Run the XYP3RN song-to-suno workflow, which turns a song request into a Suno-ready prompt through the OS agents.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask "$ARGUMENTS" --workflow song-to-suno

Rules:
- Do not write the prompt yourself; the workflow does it.
- If the request is empty, reply "Which song should I prepare for Suno?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the status and the workflow run id. If a step failed, name it.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.
```

`.claude/skills/xyp-retrieve-summarize/SKILL.md`:

```markdown
---
name: xyp-retrieve-summarize
description: Run the XYP3RN retrieve-and-summarize workflow over the knowledge base for a topic.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask "$ARGUMENTS" --workflow retrieve-and-summarize

Rules:
- Do not search or summarize yourself; the workflow does it.
- If the request is empty, reply "What topic should I retrieve and summarize?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the summary and the workflow run id.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/web/tests/skills.test.ts && pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills apps/web/lib/skills.ts apps/web/tests/skills.test.ts
git commit -m "feat(skills): four OS skills and the Mercury skill allowlist"
```

---

### Task 4: Headless launcher

**Files:**
- Create: `apps/web/lib/claude-headless.ts`
- Test: `apps/web/tests/claude-headless.test.ts`

**Interfaces:**
- Consumes: `ClaudeRunner`, `runClaudeCli`, `parseClaudeResult`, `isLoggedOut` (Task 1); `SkillName` (Task 3); `MAX_REPLY_CHARS` (`core/orchestrator/ask.ts`).
- Produces:
  - `skillArgs(): string[]`, `deepArgs(): string[]`
  - `SKILL_TIMEOUT_MS = 30 * 60_000`, `DEEP_TIMEOUT_MS = 20 * 60_000`
  - `type HeadlessOutcome = { readonly ok: boolean; readonly reply: string; readonly sessionId?: string }`
  - `runSkill(skill: SkillName, text: string, opts?: { signal?: AbortSignal; run?: ClaudeRunner; cwd?: string }): Promise<HeadlessOutcome>`
  - `runDeep(text: string, opts?: { signal?: AbortSignal; run?: ClaudeRunner; cwd?: string }): Promise<HeadlessOutcome>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { ClaudeRunner } from '../../../core/llm/claude-cli';
import { DEEP_TIMEOUT_MS, runDeep, runSkill, SKILL_TIMEOUT_MS } from '../lib/claude-headless';

const ok = (text: string, sessionId = 'sess-1') => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, usage: {} });
const fake = (stdout: string, code = 0) => {
  const calls: { args: readonly string[]; stdin: string; cwd: string; timeoutMs?: number }[] = [];
  const run: ClaudeRunner = async (args, stdin, o) => { calls.push({ args, stdin, cwd: o.cwd, timeoutMs: o.timeoutMs }); return { code, stdout, stderr: '' }; };
  return { run, calls };
};
const valueAfter = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe('runSkill', () => {
  it('sends /<skill> <text> on stdin with the restricted skill flags', async () => {
    const f = fake(ok('Research run r1 finished.'));
    const r = await runSkill('xyp-research', 'dark vocals', { run: f.run, cwd: '/repo' });
    expect(r).toEqual({ ok: true, reply: 'Research run r1 finished.', sessionId: 'sess-1' });
    const c = f.calls[0]!;
    expect(c.stdin).toBe('/xyp-research dark vocals');
    expect(c.cwd).toBe('/repo');
    expect(c.timeoutMs).toBe(SKILL_TIMEOUT_MS);
    expect(valueAfter(c.args, '--tools')).toBe('Bash,Read,Skill');
    expect(valueAfter(c.args, '--permission-mode')).toBe('dontAsk');
    expect(JSON.parse(valueAfter(c.args, '--settings')!)).toEqual({ disableAllHooks: true, enabledPlugins: { 'chisle@chisle': false } });
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1)).toEqual(['Bash(pnpm ask:*)', 'Read', 'Skill']);
    expect(c.args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
  });

  it('keeps hostile text as the argument of the chosen skill', async () => {
    const f = fake(ok('done'));
    const hostile = '/xyp-music"; rm -rf / \n--tools Edit $(whoami)';
    await runSkill('xyp-research', hostile, { run: f.run, cwd: '/repo' });
    expect(f.calls[0]!.stdin).toBe(`/xyp-research ${hostile}`);
    expect(f.calls[0]!.args).not.toContain(hostile);
  });

  it('caps the reply and reports failures without raw output', async () => {
    expect((await runSkill('xyp-music', 'x', { run: fake(ok('a'.repeat(900))).run, cwd: '/r' })).reply).toHaveLength(600);
    expect(await runSkill('xyp-music', 'x', { run: fake('RAW SECRET', 1).run, cwd: '/r' })).toEqual({ ok: false, reply: 'Claude Code stopped without a result (exit 1).' });
    const loggedOut = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in', session_id: 's' });
    expect((await runSkill('xyp-music', 'x', { run: fake(loggedOut, 1).run, cwd: '/r' })).reply).toBe('Claude Code is not logged in on this PC. Run `claude` once and sign in.');
  });
});

describe('runDeep', () => {
  it('uses read-only tools plus pnpm ask, no Edit/Write, slash commands off, 20 min', async () => {
    const f = fake(ok('Plan ready.', 'sess-9'));
    expect(await runDeep('plan the release', { run: f.run, cwd: '/repo' })).toEqual({ ok: true, reply: 'Plan ready.', sessionId: 'sess-9' });
    const c = f.calls[0]!;
    expect(c.stdin).toBe('plan the release');
    expect(c.timeoutMs).toBe(DEEP_TIMEOUT_MS);
    expect(valueAfter(c.args, '--tools')).toBe('Read,Grep,Glob,WebSearch,WebFetch,Bash');
    expect(c.args).toContain('--disable-slash-commands');
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash(pnpm ask:*)']);
    expect(c.args.join(' ')).not.toMatch(/\bEdit\b|\bWrite\b/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/tests/claude-headless.test.ts`
Expected: FAIL, cannot resolve `../lib/claude-headless`.

- [ ] **Step 3: Implement `apps/web/lib/claude-headless.ts`**

```ts
import { isLoggedOut, parseClaudeResult, runClaudeCli, type ClaudeRunner } from '../../../core/llm/claude-cli';
import { MAX_REPLY_CHARS } from '../../../core/orchestrator/ask';
import type { SkillName } from './skills';

/**
 * Mercury's headless Claude Code runs (tiers 1 and 3), on the owner's logged-in CLI. cwd is the repo
 * so project skills load; hooks and the style plugin are off so replies read aloud as plain text.
 * Every run has an explicit tool list and permission mode dontAsk (anything not allowed is denied).
 */

export const SKILL_TIMEOUT_MS = 30 * 60_000;
export const DEEP_TIMEOUT_MS = 20 * 60_000;
const SETTINGS = JSON.stringify({ disableAllHooks: true, enabledPlugins: { 'chisle@chisle': false } });
const BASE = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--settings', SETTINGS, '--strict-mcp-config', '--permission-mode', 'dontAsk'];

// --allowedTools is variadic, so it is always last.
export const skillArgs = (): string[] => [...BASE, '--tools', 'Bash,Read,Skill', '--allowedTools', 'Bash(pnpm ask:*)', 'Read', 'Skill'];
export const deepArgs = (): string[] => [...BASE, '--disable-slash-commands', '--tools', 'Read,Grep,Glob,WebSearch,WebFetch,Bash', '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash(pnpm ask:*)'];

export type HeadlessOutcome = { readonly ok: boolean; readonly reply: string; readonly sessionId?: string };
type Opts = { readonly signal?: AbortSignal; readonly run?: ClaudeRunner; readonly cwd?: string };
const cap = (s: string) => (s.length > MAX_REPLY_CHARS ? `${s.slice(0, MAX_REPLY_CHARS - 1)}…` : s);

const launch = async (args: string[], prompt: string, timeoutMs: number, o: Opts): Promise<HeadlessOutcome> => {
  const run = o.run ?? runClaudeCli;
  let out;
  try {
    out = await run(args, prompt, { cwd: o.cwd ?? process.env.XYP_REPO_ROOT ?? process.cwd(), timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reply: 'Claude Code is not installed on this PC (claude not found).' };
    throw e;
  }
  const r = parseClaudeResult(out.stdout);
  if (!r) return { ok: false, reply: `Claude Code stopped without a result (exit ${out.code}).` };
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/web/tests/claude-headless.test.ts && pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 5: Live check of one skill (confirms flags on this CLI version)**

The web lib uses extensionless imports, which plain Node cannot load, so run the exact command `runSkill` builds, from the repo root:

```bash
echo "/xyp-research best current method for dark baritone vocals in Suno" | claude -p --output-format json \
  --setting-sources project --settings '{"disableAllHooks":true,"enabledPlugins":{"chisle@chisle":false}}' \
  --strict-mcp-config --permission-mode dontAsk --tools Bash,Read,Skill --allowedTools "Bash(pnpm ask:*)" Read Skill
```

Expected: a JSON object with `"is_error":false`, a `result` that names a research run id, `"permission_denials":[]`, and a new row in `research_runs`.
If the reply says the skill is unknown, `/xyp-research` was not expanded: confirm `.claude/skills/xyp-research/SKILL.md` exists and that `Skill` is in both `--tools` and `--allowedTools`, then rerun. If the reply mentions a denied `Bash` command, copy the exact denied command into the task notes and stop for review; do not widen `--allowedTools`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/claude-headless.ts apps/web/tests/claude-headless.test.ts
git commit -m "feat(web): headless Claude Code launcher for skills and deep tasks"
```

---

### Task 5: Tier selection, abortable jobs, and the API

**Files:**
- Create: `apps/web/lib/tiers.ts`
- Modify: `apps/web/lib/ask-jobs.ts`
- Modify: `apps/web/app/api/[...path]/route.ts` (`POST /api/ask` block; new cancel path)
- Test: `apps/web/tests/tiers.test.ts`, `apps/web/tests/api-tiers.test.ts`

**Interfaces:**
- Consumes: `matchSkill`, `isSkillName`, `SkillName` (Task 3); `runSkill`, `runDeep` (Task 4).
- Produces:
  - `type Tier = { readonly kind: 'skill'; readonly skill: SkillName; readonly text: string } | { readonly kind: 'deep'; readonly text: string } | { readonly kind: 'lookup' } | { readonly kind: 'plan' } | { readonly kind: 'invalid-skill' }`
  - `selectTier(text: string, opts?: { readonly skill?: unknown; readonly deep?: boolean }): Tier`
  - `ask-jobs`: `AskView` gains `sessionId?: string`; `createJob` `work` becomes `(signal: AbortSignal) => Promise<AskView>`; new `cancelJob(userId: string, requestId: string): boolean`; new `runningCount(userId: string, action?: string): number`; `MAX_DEEP_PER_USER = 1`.
  - API: body `{ request, requestId, projectSlug?, skill?, deep? }`; `POST /api/ask/<id>/cancel`.

- [ ] **Step 1: Write the failing tier test** (`apps/web/tests/tiers.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { selectTier } from '../lib/tiers';

describe('selectTier: first match wins', () => {
  it.each([
    ['research dark vocals', {}, { kind: 'skill', skill: 'xyp-research', text: 'research dark vocals' }],
    ['dark vocals', { skill: 'xyp-research' }, { kind: 'skill', skill: 'xyp-research', text: 'dark vocals' }],
    ['dark vocals', { skill: 'rm -rf' }, { kind: 'invalid-skill' }],
    ['Claude, plan next month', {}, { kind: 'deep', text: 'plan next month' }],
    ['plan next month', { deep: true }, { kind: 'deep', text: 'plan next month' }],
    ['What did the latest research find about vocals?', {}, { kind: 'lookup' }],
    ['how many approvals are pending', {}, { kind: 'lookup' }],
    ['Status of the last workflow run?', {}, { kind: 'lookup' }],
    ['Write a hook for the latest track', {}, { kind: 'plan' }],
    ['What rhymes with orange', {}, { kind: 'plan' }],
    ['Research the best current method for vocals', {}, { kind: 'skill', skill: 'xyp-research', text: 'the best current method for vocals' }],
  ] as const)('%s', (text, opts, expected) => {
    const t = selectTier(text, opts);
    // An explicit skill keeps the whole text; a spoken one strips the name.
    if (expected.kind === 'skill' && !('skill' in opts)) expect(t).toMatchObject({ kind: 'skill', skill: expected.skill });
    else expect(t).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/web/tests/tiers.test.ts`
Expected: FAIL, cannot resolve `../lib/tiers`.

- [ ] **Step 3: Implement `apps/web/lib/tiers.ts`**

```ts
import { isSkillName, matchSkill, type SkillName } from './skills';

/**
 * Deterministic tier selection for Mercury requests (no model call). First match wins:
 * explicit or spoken skill (1) → explicit deep trigger (3) → question about stored data (2) → planRequest.
 * Tier 2 needs both a question opener and a data noun, so creative requests that mention
 * "latest" or "release" still go to the domain agents.
 */
export type Tier =
  | { readonly kind: 'skill'; readonly skill: SkillName; readonly text: string }
  | { readonly kind: 'deep'; readonly text: string }
  | { readonly kind: 'lookup' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'invalid-skill' };

const DEEP = /^\s*claude\s*[,:]\s+(\S[\s\S]*)$/i;
const QUESTION = /^\s*(what|which|how many|how much|is|are|did|was|were|show|list|any|status)\b/i;
const DATA = /\b(findings?|research|releases?|approvals?|runs?|workflows?|pending)\b/i;

export const selectTier = (text: string, opts: { readonly skill?: unknown; readonly deep?: boolean } = {}): Tier => {
  if (opts.skill !== undefined) return isSkillName(opts.skill) ? { kind: 'skill', skill: opts.skill, text } : { kind: 'invalid-skill' };
  const spoken = matchSkill(text);
  if (spoken) return { kind: 'skill', ...spoken };
  if (opts.deep) return { kind: 'deep', text };
  const deep = DEEP.exec(text);
  if (deep) return { kind: 'deep', text: deep[1]!.trim() };
  if (QUESTION.test(text) && DATA.test(text)) return { kind: 'lookup' };
  return { kind: 'plan' };
};
```

- [ ] **Step 4: Run tier test**

Run: `pnpm vitest run apps/web/tests/tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Make jobs abortable in `apps/web/lib/ask-jobs.ts`**

Add `readonly sessionId?: string;` to `AskView` after `approvalRequired`. Change the `Job` type and `createJob`, and add two exports:

```ts
type Job = { readonly userId: string; readonly fingerprint: string; readonly createdAt: number; view: AskView; readonly controller: AbortController };

export const MAX_DEEP_PER_USER = 1;

/** Running jobs for a user, optionally only one action (e.g. 'deep'). */
export const runningCount = (userId: string, action?: string) =>
  [...jobs.values()].filter((j) => j.userId === userId && j.view.state === 'running' && (!action || j.view.action === action)).length;

/**
 * Cancels the caller's own running job: aborts its work (a headless run is killed) and marks it done.
 * @returns false for an unknown, finished or other user's job
 */
export const cancelJob = (userId: string, requestId: string): boolean => {
  const job = jobs.get(keyOf(userId, requestId));
  if (!job || job.view.state !== 'running') return false;
  job.view = { ...job.view, state: 'done', status: 'cancelled', reply: 'Cancelled. Anything it already started is listed in Live Events.' };
  job.controller.abort(new Error('cancelled'));
  return true;
};
```

In `createJob`: change the `work` parameter type to `work?: (signal: AbortSignal) => Promise<AskView>`, replace the busy check with `if (work && runningCount(userId) >= MAX_RUNNING_PER_USER) return 'busy';`, build the job as `const job: Job = { userId, fingerprint, createdAt: now, view: initial, controller: new AbortController() };`, and replace the `work().then(…)` block with:

```ts
  if (work) {
    work(job.controller.signal).then((v) => { if (job.view.status !== 'cancelled') job.view = v; }, (error: unknown) => {
      if (job.view.status === 'cancelled') return;
      console.error('mercury ask failed:', error instanceof Error ? error.message : error);
      job.view = failed!();
    });
  }
```

Existing callers pass `async()=>…` and ignore the signal; they keep working.

- [ ] **Step 6: Write the failing API test** (`apps/web/tests/api-tiers.test.ts`)

```ts
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db', () => ({ sql: {} }));
vi.mock('../../../core/runtime/deps', () => ({ createRuntimeDeps: () => ({}) }));
const cli = vi.hoisted(() => ({ calls: [] as { kind: string; skill?: string; text: string; signal?: AbortSignal }[], hold: false }));
vi.mock('../lib/claude-headless', () => {
  const wait = (signal?: AbortSignal) => new Promise<void>((res, rej) => { if (!cli.hold) return res(); signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
  return {
    runSkill: async (skill: string, text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'skill', skill, text, signal: o.signal }); await wait(o.signal); return { ok: true, reply: `ran ${skill}`, sessionId: 's1' }; },
    runDeep: async (text: string, o: { signal?: AbortSignal }) => { cli.calls.push({ kind: 'deep', text, signal: o.signal }); await wait(o.signal); return { ok: true, reply: 'deep done', sessionId: 's2' }; },
  };
});
const lookup = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../../core/orchestrator/lookup', () => ({ answerLookup: async (_sql: unknown, q: string) => { lookup.calls.push(q); return { reply: 'Nothing stored yet about that.', source: 'none' }; }, summarizerFromEnv: () => undefined }));
vi.mock('../../../governance/auth', async (actual) => ({
  ...(await actual<typeof import('../../../governance/auth')>()),
  authenticate: async (_sql: unknown, token: string) => (token === 'operator' ? { id: 'u1', name: 'op', role: 'operator', permissions: ['system.read', 'runtime.execute'] } : token === 'viewer' ? { id: 'u3', name: 'v', role: 'viewer', permissions: ['system.read'] } : null),
}));
const { GET, POST } = await import('../app/api/[...path]/route');

const base = 'http://127.0.0.1:3000';
const headers = (token: string) => ({ 'content-type': 'application/json', host: '127.0.0.1:3000', origin: base, cookie: `mercury_session=${token}` });
const ask = (body: Record<string, unknown>, token = 'operator') => POST(new NextRequest(`${base}/api/ask`, { method: 'POST', body: JSON.stringify(body), headers: headers(token) }));
const cancel = (id: string, token = 'operator') => POST(new NextRequest(`${base}/api/ask/${id}/cancel`, { method: 'POST', body: '{}', headers: headers(token) }));
const until = async (id: string) => { for (let i = 0; i < 50; i++) { const b = await (await GET(new NextRequest(`${base}/api/ask/${id}`, { headers: { cookie: 'mercury_session=operator' } }))).json(); if (b.state === 'done') return b; await new Promise(r => setTimeout(r, 10)); } throw new Error('still running'); };
beforeEach(() => { cli.calls = []; cli.hold = false; lookup.calls = []; });

describe('POST /api/ask tiers', () => {
  it('tier 1: button skill and spoken skill run the skill with the session id', async () => {
    const id = randomUUID();
    expect((await ask({ request: 'dark vocals', requestId: id, skill: 'xyp-research' })).status).toBe(202);
    expect(await until(id)).toMatchObject({ action: 'skill', status: 'success', reply: 'ran xyp-research', sessionId: 's1' });
    const id2 = randomUUID();
    await ask({ request: 'music, write a verse', requestId: id2 });
    await until(id2);
    expect(cli.calls.map(c => [c.skill, c.text])).toEqual([['xyp-research', 'dark vocals'], ['xyp-music', 'write a verse']]);
  });

  it('rejects an unknown skill name without running anything', async () => {
    expect((await ask({ request: 'x', requestId: randomUUID(), skill: '../../evil' })).status).toBe(400);
    expect(cli.calls).toHaveLength(0);
  });

  it('tier 2: answers immediately from lookup, starts nothing', async () => {
    const r = await ask({ request: 'What did the latest research find?', requestId: randomUUID() });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: 'done', action: 'lookup', reply: 'Nothing stored yet about that.' });
    expect(lookup.calls).toEqual(['What did the latest research find?']);
    expect(cli.calls).toHaveLength(0);
  });

  it('tier 3: one deep job at a time, cancel aborts it, other users cannot cancel', async () => {
    cli.hold = true;
    const id = randomUUID();
    expect((await ask({ request: 'plan the release', requestId: id, deep: true })).status).toBe(202);
    expect((await ask({ request: 'Claude, another', requestId: randomUUID() })).status).toBe(429);
    expect((await cancel(id, 'viewer')).status).toBe(403);
    expect((await cancel(randomUUID())).status).toBe(404);
    expect((await cancel(id)).status).toBe(200);
    expect(cli.calls[0]!.signal!.aborted).toBe(true);
    expect(await until(id)).toMatchObject({ state: 'done', status: 'cancelled' });
    expect((await cancel(id)).status).toBe(404);
  });

  it('keeps the planRequest path for everything else', async () => {
    const r = await ask({ request: 'zzz qqq', requestId: randomUUID() });
    expect(await r.json()).toMatchObject({ action: 'clarify' });
    expect(cli.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm vitest run apps/web/tests/api-tiers.test.ts`
Expected: FAIL (the route ignores `skill`/`deep`; `core/orchestrator/lookup` does not exist yet, but it is mocked, so failures are assertion failures such as `expected 'run-service'` or status mismatches).

- [ ] **Step 8: Wire tiers into `route.ts`**

In the `/api/ask` block, after the `projectSlug` validation line and before `const {ENTRYPOINTS,planRequest}=…`, insert:

```ts
      const {selectTier}=await import('../../../lib/tiers');const {runSkill,runDeep}=await import('../../../lib/claude-headless');
      const tier=selectTier(request,{...(input.skill!==undefined?{skill:input.skill}:{}),deep:input.deep===true});
      if(tier.kind==='invalid-skill')return json({error:'unknown skill'},400);
```

Extend the existing `ask-jobs` import line (so no new `await` sits between `findJob` and `createJob`):

```ts
      const {createJob,findJob,runningCount,MAX_RUNNING_PER_USER,MAX_DEEP_PER_USER}=await import('../../../lib/ask-jobs');const {createRuntimeDeps}=await import('../../../../../core/runtime/deps');
```

Change the fingerprint line to include the tier inputs:

```ts
      const fingerprint=`${projectSlug}\n${String(input.skill??'')}\n${input.deep===true}\n${request}`;const existing=findJob(identity.id,requestId);
```

Immediately after the `if(existing){…}` line, insert the three new tiers. Skill and deep reach `createJob` with no `await`, so the dedup guarantee holds. Lookup awaits its read-only answer first; a duplicate lookup can at worst read twice, which changes nothing:

```ts
      if(tier.kind==='skill'||tier.kind==='deep'){
        if(tier.kind==='deep'&&runningCount(identity.id,'deep')>=MAX_DEEP_PER_USER)return json({error:'A deep task is already running; wait for it or cancel it'},429);
        const route={status:tier.kind,...(tier.kind==='skill'?{domain:tier.skill}:{})};
        const job=createJob(identity.id,requestId,fingerprint,{requestId,state:'running',action:tier.kind,route,status:'running',reply:tier.kind==='skill'?'Working. Claude Code is running the skill.':'Working. Claude Code is on it.'},
          async(signal)=>{const r=tier.kind==='skill'?await runSkill(tier.skill,tier.text,{signal}):await runDeep(tier.text,{signal});
            return {requestId,state:'done',action:tier.kind,route,status:r.ok?'success':'error',reply:r.reply,...(r.sessionId?{sessionId:r.sessionId}:{})};},
          ()=>({requestId,state:'done',action:tier.kind,route,status:'error',reply:'Claude Code did not finish. It was not retried.'}));
        if(job==='busy')return json({error:`At most ${MAX_RUNNING_PER_USER} requests may run at once; wait for one to finish`},429);
        if(job==='full')return json({error:'Too many requests; try again later'},429);
        return json(job.view,202);
      }
      if(tier.kind==='lookup'){
        const {answerLookup,summarizerFromEnv}=await import('../../../../../core/orchestrator/lookup');
        const a=await answerLookup(sql,request,summarizerFromEnv(process.env));
        const job=createJob(identity.id,requestId,fingerprint,{requestId,state:'done',action:'lookup',route:{status:'lookup'},status:a.source,reply:a.reply});
        return typeof job==='string'?json({error:'Too many requests; try again later'},429):json(job.view);
      }
```

The existing `const plan=planRequest(…)` path follows unchanged.

In `POST`, before `if(path==='/api/health-check')`, add the cancel path (identity is already resolved at this point in `POST`, as for the other paths):

```ts
    const cancelMatch=/^\/api\/ask\/([0-9a-f-]{36})\/cancel$/i.exec(path);
    if(cancelMatch){
      requirePermission(identity,'runtime.execute');
      const {cancelJob}=await import('../../../lib/ask-jobs');
      return cancelJob(identity.id,cancelMatch[1]!)?json({cancelled:true}):json({error:'Unknown or finished request'},404);
    }
```

- [ ] **Step 9: Update the one existing test the tier change affects**

`apps/web/tests/api-route.test.ts:38` sends `'Research the best current method …'`, which now starts with the spoken skill name "research" and would become a tier 1 skill run instead of the `planRequest` path that test covers. Keep that test on the planner path by moving the word out of first position (the routing weights are unchanged: research 3 + best current method 3 against vocal 2, still routed to RESEARCH_INTELLIGENCE):

```ts
const RESEARCH = 'Find the best current method for controlling dark baritone vocals in Suno research.';
```

- [ ] **Step 10: Run tests**

Run: `pnpm vitest run apps/web/tests && pnpm typecheck:web`
Expected: PASS, including `api-route.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add apps/web/lib/tiers.ts apps/web/lib/ask-jobs.ts "apps/web/app/api/[...path]/route.ts" apps/web/tests/tiers.test.ts apps/web/tests/api-tiers.test.ts apps/web/tests/api-route.test.ts
git commit -m "feat(web): tier selection, skill and deep jobs, cancel endpoint"
```

---

### Task 6: Tier 2 lookup

**Files:**
- Create: `core/orchestrator/lookup.ts`
- Test: `tests/claude-engine/lookup.test.ts`

**Interfaces:**
- Consumes: `Queryable` (`core/db/client.ts`); `createLlmClient` (Task 1).
- Produces:
  - `type LookupAnswer = { readonly reply: string; readonly source: 'template' | 'model' | 'none' }`
  - `type Summarize = (question: string, facts: string) => Promise<string>`
  - `answerLookup(sql: Queryable, question: string, summarize?: Summarize): Promise<LookupAnswer>`
  - `summarizerFromEnv(env: Readonly<Record<string, string | undefined>>): Summarize | undefined` (Haiku through `createLlmClient`; undefined when neither `LLM_ENGINE=claude-code` nor `ANTHROPIC_API_KEY` is set)

- [ ] **Step 1: Write the failing test**

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerLookup } from '../../core/orchestrator/lookup.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('claude_engine_lookup', { migrated: true }); });
afterAll(async () => { await db?.drop(); });

describe('answerLookup: read-only answers from stored data', () => {
  it('says nothing is stored, for every topic, on an empty DB', async () => {
    for (const q of ['how many approvals are pending', 'what releases are scheduled', 'status of the last workflow run', 'what did the latest research find']) {
      expect(await answerLookup(db.sql, q), q).toEqual({ reply: expect.stringMatching(/^Nothing stored yet/), source: 'none' });
    }
  });

  it('answers pending approvals and releases from templates, without a model', async () => {
    await db.sql`insert into approval_queue (item_type, item_id, request) values ('knowledge_candidate', ${randomUUID()}, '{}'::jsonb)`;
    await db.sql`insert into releases (title, kind, status, release_date) values ('Night Drive', 'single', 'scheduled', '2026-11-01')`;
    let called = false;
    const spy = async () => { called = true; return 'x'; };
    expect(await answerLookup(db.sql, 'how many approvals are pending', spy)).toEqual({ reply: '1 approval is pending: knowledge_candidate.', source: 'template' });
    expect(await answerLookup(db.sql, 'what releases are coming', spy)).toEqual({ reply: 'Latest releases: Night Drive (single, scheduled, 2026-11-01).', source: 'template' });
    expect(called).toBe(false);
  });

  it('writes nothing', async () => {
    const before = await db.sql`select (select count(*) from workflow_runs)::int w, (select count(*) from agent_runs)::int a, (select count(*) from research_runs)::int r`;
    await answerLookup(db.sql, 'what did the latest research find about vocals');
    expect(await db.sql`select (select count(*) from workflow_runs)::int w, (select count(*) from agent_runs)::int a, (select count(*) from research_runs)::int r`).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/claude-engine/lookup.test.ts`
Expected: FAIL, cannot resolve `core/orchestrator/lookup.ts`.

- [ ] **Step 3: Implement `core/orchestrator/lookup.ts`**

```ts
import type { Queryable } from '../db/client.ts';
import { createLlmClient } from '../llm/providers.ts';

/**
 * Tier 2: answers questions about data the OS already stored. Read-only: no run, no approval,
 * no write. Counts and statuses come from templates; open questions about research findings are
 * phrased by one small model call over the matched rows (when a summarizer is available).
 */

export type LookupAnswer = { readonly reply: string; readonly source: 'template' | 'model' | 'none' };
export type Summarize = (question: string, facts: string) => Promise<string>;

const NONE: LookupAnswer = { reply: 'Nothing stored yet about that. Send it as a normal request to start a run.', source: 'none' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const STOP = new Set(['what', 'which', 'about', 'latest', 'research', 'find', 'found', 'findings', 'there', 'their', 'would', 'should', 'yesterday', 'today']);

export const answerLookup = async (sql: Queryable, question: string, summarize?: Summarize): Promise<LookupAnswer> => {
  const q = question.toLowerCase();
  if (/\b(approvals?|pending)\b/.test(q)) {
    const rows = await sql<{ item_type: string }[]>`select item_type from approval_queue where status = 'pending' order by requested_at desc limit 5`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from approval_queue where status = 'pending'`;
    if (n === 0) return NONE;
    return { reply: `${plural(n, 'approval is', 'approvals are')} pending: ${rows.map(r => r.item_type).join(', ')}.`, source: 'template' };
  }
  if (/\breleases?\b/.test(q)) {
    const rows = await sql<{ title: string; kind: string; status: string; release_date: string | null }[]>`
      select title, kind, status, to_char(release_date, 'YYYY-MM-DD') release_date from releases order by coalesce(release_date, created_at::date) desc limit 5`;
    if (rows.length === 0) return NONE;
    return { reply: `Latest releases: ${rows.map(r => `${r.title} (${r.kind}, ${r.status}${r.release_date ? `, ${r.release_date}` : ''})`).join('; ')}.`, source: 'template' };
  }
  if (/\b(runs?|workflows?)\b/.test(q) && !/\bfind/.test(q)) {
    const rows = await sql<{ workflow_name: string; status: string; failed_step: string | null }[]>`
      select workflow_name, status, failed_step from workflow_runs order by created_at desc limit 5`;
    if (rows.length === 0) return NONE;
    return { reply: `Recent runs: ${rows.map(r => `${r.workflow_name} ${r.status}${r.failed_step ? ` at ${r.failed_step}` : ''}`).join('; ')}.`, source: 'template' };
  }
  const rows = await sql<{ claim: string; confidence: string }[]>`select claim, confidence::text from research_findings order by created_at desc limit 20`;
  const words = q.match(/[a-z]{5,}/g)?.filter(w => !STOP.has(w)) ?? [];
  const matched = words.length ? rows.filter(r => words.some(w => r.claim.toLowerCase().includes(w))) : rows;
  const picked = (matched.length ? matched : rows).slice(0, 8);
  if (picked.length === 0) return NONE;
  const facts = picked.map(r => `- ${r.claim} (confidence ${r.confidence})`).join('\n');
  if (summarize) return { reply: await summarize(question, facts), source: 'model' };
  return { reply: `Latest findings: ${picked.slice(0, 3).map(r => r.claim).join(' ')}`, source: 'template' };
};

/** Haiku summarizer, through the claude-code engine or the API, whichever is configured. */
export const summarizerFromEnv = (env: Readonly<Record<string, string | undefined>>): Summarize | undefined => {
  if (env.LLM_ENGINE !== 'claude-code' && !env.ANTHROPIC_API_KEY) return undefined;
  const llm = createLlmClient({ model: 'claude-haiku-4-5-20251001', agentName: 'mercury-lookup', env });
  return async (question, facts) => {
    const r = await llm.complete({
      system: 'Answer the question using only the stored findings given. Plain sentences, at most 500 characters, suitable to be read aloud. If the findings do not answer it, say so.',
      user: `Question: ${question}\n\nStored findings:\n${facts}`,
      schema: { name: 'lookup_answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
      maxTokens: 800,
    });
    return (r.json as { answer: string }).answer;
  };
};
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/claude-engine/lookup.test.ts apps/web/tests/api-tiers.test.ts && pnpm typecheck && pnpm typecheck:web`
Expected: PASS (local Postgres running, as for the other DB tests).

- [ ] **Step 5: Commit**

```bash
git add core/orchestrator/lookup.ts tests/claude-engine/lookup.test.ts
git commit -m "feat(orchestrator): tier 2 read-only lookup answers"
```

---

### Task 7: Mercury UI

**Files:**
- Modify: `apps/web/components/MercuryShell.tsx` (assistant panel: `AskReply` type, `send`, form, log item)

**Interfaces:**
- Consumes: `SKILLS` (Task 3); API body `{ request, requestId, skill?, deep? }`, `POST /api/ask/<id>/cancel`, `AskView.sessionId` (Task 5).

- [ ] **Step 1: Extend types and imports**

Add `import { SKILLS } from '../lib/skills';` to the imports. In `type AskReply`, add `sessionId?:string;`.

- [ ] **Step 2: Send skill/deep with the request**

In the assistant component add state: `const [deep,setDeep]=useState(false);`. Change `send` to accept an optional skill and pass it through:

```tsx
  const send=async(e:FormEvent|null,skill?:string)=>{e?.preventDefault();
```

and replace `await post('ask',{request:sent,requestId:id})` with:

```tsx
await post('ask',{request:sent,requestId:id,...(skill?{skill}:{}),...(deep&&!skill?{deep:true}:{})})
```

Change the "clear the draft" condition to include the new actions:

```tsx
      if(r.action.startsWith('run-')||r.action==='skill'||r.action==='deep')setText(t=>t===sent?'':t);
```

The `submission.current` dedupe key must include the mode, so a resend with a different button is a new request: replace `if(submission.current?.text!==sent)` with

```tsx
const mode=`${skill??''}|${deep}`;if(submission.current?.text!==sent||submission.current.mode!==mode)submission.current={text:sent,id:crypto.randomUUID(),mode};
```

and change the ref type to `useRef<{text:string;id:string;mode:string}|null>(null)`.

- [ ] **Step 3: Add skill buttons, Deep toggle and processing note**

After the Send button inside the form:

```tsx
      <fieldset className="skill-row" aria-label="Run a skill with this text"><legend>Skills</legend>
        {SKILLS.map(s=><button key={s.name} type="button" className="run-check" disabled={!canRun||busy||!text.trim()} onClick={()=>void send(null,s.name)}>{s.label}</button>)}
      </fieldset>
      <label className="deep-toggle"><input type="checkbox" checked={deep} onChange={e=>setDeep(e.target.checked)} disabled={!canRun||busy}/> Deep task (Claude Code, read-only, up to 20 min)</label>
```

Replace the "Reasoning" list item with:

```tsx
        <li><b>Reasoning</b> Routing is local. Skills and deep tasks run Claude Code on this PC with your subscription; agents use Claude Code when LLM_ENGINE=claude-code, otherwise their configured cloud API.</li>
```

- [ ] **Step 4: Cancel button and session id in the log**

Inside the log item, after the reply paragraph:

```tsx
      {e.view?.state==='running'&&!e.error&&<button type="button" className="run-check" onClick={()=>void post(`ask/${e.id}/cancel`,{}).then(()=>track(e.id)).catch(()=>undefined)}>Cancel</button>}
      {e.view?.sessionId&&<small>Claude session <code>{e.view.sessionId}</code> (reopen: <code>claude --resume {e.view.sessionId}</code>)</small>}
```

`post` already prefixes `/api/` and throws on non-2xx; the existing `track` loop picks up the `cancelled` state.

- [ ] **Step 5: Styles**

Append to `apps/web/app/mercury.css`:

```css
.command-panel .skill-row{display:flex;flex-wrap:wrap;gap:.4rem;border:0;padding:0;margin:.5rem 0 0}
.command-panel .skill-row legend{font-size:.7rem;letter-spacing:.08em;opacity:.7;margin-bottom:.25rem}
.command-panel .deep-toggle{display:flex;gap:.4rem;align-items:center;font-size:.8rem;margin-top:.4rem}
```

- [ ] **Step 6: Typecheck and browser check**

Run: `pnpm typecheck:web && pnpm vitest run apps/web/tests`
Expected: PASS.
Then `pnpm dev`, sign in as an operator, and check in the browser: four skill buttons appear and are disabled with an empty box; typing "dark vocals" and pressing Research shows "Working. Claude Code is running the skill." then a reply with a session id; ticking Deep task and sending shows a Cancel button that ends the job as "Cancelled."; with the speech toggle on, replies are spoken.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/MercuryShell.tsx apps/web/app/mercury.css
git commit -m "feat(web): skill buttons, deep task toggle and cancel in the assistant panel"
```

---

### Task 8: End-to-end verification and docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (the "Front doors" paragraph)

- [ ] **Step 1: Update the architecture doc**

Append to the "Front doors" paragraph in `docs/ARCHITECTURE.md`:

```markdown
Claude Code engine (spec `docs/superpowers/specs/2026-09-30-claude-code-engine-design.md`): with `LLM_ENGINE=claude-code`, Anthropic agents run through the local logged-in `claude` CLI (`core/llm/claude-cli.ts`) instead of the API. `POST /api/ask` selects a tier deterministically (`apps/web/lib/tiers.ts`): a skill (`.claude/skills/xyp-*`, run headless and calling `pnpm ask --domain/--workflow`), a read-only lookup over stored data (`core/orchestrator/lookup.ts`), an explicit deep task (headless Claude Code, read-only tools plus `pnpm ask`, cancellable), or the unchanged `planRequest` path.
```

- [ ] **Step 2: Full test suite**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`
Expected: all PASS.

- [ ] **Step 3: Live end-to-end on the subscription**

With `LLM_ENGINE=claude-code` in the environment and `ANTHROPIC_API_KEY` unset:

1. `pnpm ask "Research the best current method for controlling dark baritone vocals in Suno."` completes with `"status"` other than `"error"`.
2. `pnpm ask "Write a hook and two verses for the new X3LIUS track"` completes.
3. In Mercury: each of the four skill buttons completes with a run id in the reply.
4. Dictated "research dark vocals" runs `xyp-research`.
5. "What did the latest research find?" answers in seconds and creates no new row in `workflow_runs` (`select count(*) from workflow_runs` before and after).
6. A deep task completes, and a second one is cancelled mid-run; its `claude` process is gone (`tasklist | grep claude` shows no leftover process for it).

Record each result (pass/fail and run ids) in the PR description.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: Claude Code engine and request tiers"
```
