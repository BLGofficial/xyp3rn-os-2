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
  it('a flag with no value (end of args, or followed by another flag) exits 2 with usage', async () => {
    const noValue = await runCli('x', '--domain');
    expect(noValue.code).toBe(2);
    expect(noValue.stderr).toContain('usage: ask-cli.ts');
    expect((await runCli('x', '--workflow')).code).toBe(2);
    expect((await runCli('x', '--domain', '--project', 'p')).code).toBe(2);
  });
});
