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
