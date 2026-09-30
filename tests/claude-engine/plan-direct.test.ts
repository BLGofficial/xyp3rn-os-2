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
    expect(planDirect('a song', { workflow: 'song-to-suno' })).toMatchObject({ action: 'run-workflow', workflow: WORKFLOWS['song-to-suno']!.path });
    expect(() => planDirect('a song', { workflow: '../etc/passwd' })).toThrow('unknown workflow');
  });
  it('retrieve-and-summarize plan input carries query equal to the request text', () => {
    const p = planDirect('vocal production notes', { workflow: 'retrieve-and-summarize' });
    expect(p).toMatchObject({ action: 'run-workflow', input: { request: 'vocal production notes', query: 'vocal production notes' } });
  });
  it('song-to-suno plan input picks the named Suno version as sunoModel, lower-cased', () => {
    const named = planDirect('a pop song for v4.5', { workflow: 'song-to-suno' });
    expect(named).toMatchObject({ action: 'run-workflow', input: { request: 'a pop song for v4.5', sunoModel: 'v4.5' } });

    const upperCase = planDirect('a song for V3.5A', { workflow: 'song-to-suno' });
    expect(upperCase).toMatchObject({ action: 'run-workflow', input: { request: 'a song for V3.5A', sunoModel: 'v3.5a' } });

    const none = planDirect('a pop song', { workflow: 'song-to-suno' });
    expect(none).toMatchObject({ action: 'run-workflow', input: { request: 'a pop song', sunoModel: 'v5' } });
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
