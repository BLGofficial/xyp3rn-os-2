import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeRunner } from '../../../core/llm/claude-cli';
import { REPO_ROOT } from '../../../core/repo';
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
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1)).toEqual(['Bash(pnpm ask:*)', 'Read(./**)', 'Skill']);
    expect(c.args.join(' ')).not.toMatch(/bypassPermissions|dangerously/);
  });

  it('scopes allowed reads to the repo and denies .env reads, deny listed before allow', async () => {
    const f = fake(ok('done'));
    await runSkill('xyp-music', 'x', { run: f.run, cwd: '/repo' });
    const c = f.calls[0]!;
    expect(c.args.indexOf('--disallowedTools')).toBeGreaterThan(-1);
    expect(c.args.indexOf('--disallowedTools')).toBeLessThan(c.args.indexOf('--allowedTools'));
    expect(c.args.slice(c.args.indexOf('--disallowedTools') + 1, c.args.indexOf('--allowedTools'))).toEqual(['Read(./**/.env*)', 'Read(./.env*)']);
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

  it('reports cancellation instead of throwing when the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run: ClaudeRunner = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    expect(await runSkill('xyp-music', 'x', { run, cwd: '/r', signal: controller.signal })).toEqual({ ok: false, reply: 'Cancelled.' });
  });

  it('reports a timeout when the process is stopped before producing a result', async () => {
    const run: ClaudeRunner = async () => ({ code: null, stdout: '', stderr: '' });
    expect(await runSkill('xyp-music', 'x', { run, cwd: '/r' })).toEqual({ ok: false, reply: 'Claude Code timed out or was stopped before finishing.' });
  });

  it('maps a resolved stoppedBy:abort to Cancelled (win32 path)', async () => {
    const run: ClaudeRunner = async () => ({ code: 1, stdout: '', stderr: '', stoppedBy: 'abort' });
    expect(await runSkill('xyp-music', 'x', { run, cwd: '/r' })).toEqual({ ok: false, reply: 'Cancelled.' });
  });

  it('maps a resolved stoppedBy:timeout to the timeout reply (win32 path)', async () => {
    const run: ClaudeRunner = async () => ({ code: 1, stdout: '', stderr: '', stoppedBy: 'timeout' });
    expect(await runSkill('xyp-music', 'x', { run, cwd: '/r' })).toEqual({ ok: false, reply: 'Claude Code timed out or was stopped before finishing.' });
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
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1)).toEqual(['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'WebSearch', 'WebFetch', 'Bash(pnpm ask:*)']);
    expect(c.args.join(' ')).not.toMatch(/\bEdit\b|\bWrite\b/);
  });

  it('scopes allowed reads/greps/globs to the repo and denies .env reads, deny listed before allow', async () => {
    const f = fake(ok('done'));
    await runDeep('x', { run: f.run, cwd: '/repo' });
    const c = f.calls[0]!;
    expect(c.args.indexOf('--disallowedTools')).toBeGreaterThan(-1);
    expect(c.args.indexOf('--disallowedTools')).toBeLessThan(c.args.indexOf('--allowedTools'));
    expect(c.args.slice(c.args.indexOf('--disallowedTools') + 1, c.args.indexOf('--allowedTools'))).toEqual(['Read(./**/.env*)', 'Read(./.env*)']);
  });
});

describe('F11: default cwd is the shared, frozen REPO_ROOT, not a live env lookup', () => {
  it('runSkill and runDeep ignore a later XYP_REPO_ROOT change and still use core/repo.ts\'s REPO_ROOT', async () => {
    const saved = process.env.XYP_REPO_ROOT;
    process.env.XYP_REPO_ROOT = 'Z:/somewhere-else';
    try {
      const f = fake(ok('done'));
      await runSkill('xyp-music', 'x', { run: f.run });
      expect(f.calls[0]!.cwd).toBe(REPO_ROOT);
      expect(f.calls[0]!.cwd).not.toBe('Z:/somewhere-else');
      const g = fake(ok('done'));
      await runDeep('x', { run: g.run });
      expect(g.calls[0]!.cwd).toBe(REPO_ROOT);
    } finally {
      if (saved === undefined) delete process.env.XYP_REPO_ROOT; else process.env.XYP_REPO_ROOT = saved;
    }
  });
});

describe('F4: project permissions must not widen headless skill/deep runs', () => {
  // skillArgs/deepArgs run with --setting-sources project, so .claude/settings.json merges into
  // every headless skill/deep run. Its own explicit --tools/--allowedTools/--disallowedTools list
  // is the only thing this guarantees the permission surface stays inside; a `permissions.allow`
  // rule, a looser `permissions.defaultMode`, or an `additionalDirectories` entry in the checked-in
  // project settings would widen that surface underneath it. This test fails loudly if that
  // ever happens, rather than relying on someone noticing during review.
  it('.claude/settings.json has no permissions.allow, defaultMode, or additionalDirectories', () => {
    const path = join(import.meta.dirname, '../../../.claude/settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8')) as { permissions?: { allow?: unknown[]; defaultMode?: unknown; additionalDirectories?: unknown[] } };
    const permissions = settings.permissions ?? {};
    expect(Array.isArray(permissions.allow) ? permissions.allow.length : 0,
      '.claude/settings.json sets permissions.allow, which merges into headless skill/deep runs (--setting-sources project) and would widen what they can do').toBe(0);
    expect(permissions.defaultMode,
      '.claude/settings.json sets permissions.defaultMode, which merges into headless skill/deep runs (--setting-sources project) and could relax --permission-mode dontAsk').toBeUndefined();
    expect(Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories.length : 0,
      '.claude/settings.json sets permissions.additionalDirectories, which merges into headless skill/deep runs (--setting-sources project) and would widen the repo-scoped Read/Grep/Glob rules').toBe(0);
  });
});
