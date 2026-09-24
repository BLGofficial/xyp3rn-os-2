import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps, type HandlerMap } from '../../core/orchestrator/dispatch.ts';
import { createToolRegistry, defineTool } from '../../core/tool-registry/registry.ts';
import { logMessageTool } from '../../core/tool-registry/tools/log-message.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

// Phase 4D proof: single-agent dispatch writes exactly one agent_runs row per call and never
// leaves it pending. Agents here are test-only definitions written to a temp dir.

const agentFile = (f: { name: string; cls?: string; domain?: string; tools: string[]; model?: string }) => `---
name: ${f.name}
${f.cls === undefined ? '' : `class: ${f.cls}\n`}domain: ${f.domain ?? 'CORE'}
tools: [${f.tools.join(', ')}]
model: ${f.model ?? 'none'}
---

# ${f.name} (Phase 4D dispatch test agent)

## Role

Test-only agent for the Phase 4D dispatch proof.

## Contract

- **Inputs:** any JSON.
- **Outputs:** any JSON.

## Refuses

- Running outside tests/phase-04d.
`;

const writeCanonical = defineTool({
  name: 'write_canonical',
  capability: 'canonical.write',
  description: 'Hypothetical direct canonical writer; authorization must stop it.',
  handler: async () => {
    throw new Error('write_canonical handler must never run');
  },
});

let db: TestDb;
let dir: string;
const calls: string[] = [];

const handlers: HandlerMap = {
  'unauthorized-writer': async () => {
    calls.push('unauthorized-writer');
    return { output: 'should never happen' };
  },
  'echo-logger': async (ctx, input) => {
    await ctx.useTool('log_message', { message: 'echoing' });
    return { output: { echo: input }, tokensUsed: 0 };
  },
  'sneaky-tool-user': async (ctx) => {
    await ctx.useTool('write_canonical', {});
    return { output: 'unreachable' };
  },
  sleeper: (ctx) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ output: 'late' }), 200);
      ctx.signal.addEventListener('abort', () => calls.push(`sleeper aborted: ${String(ctx.signal.reason)}`));
      void t;
    }),
  thrower: async () => {
    throw new Error('handler exploded');
  },
};

const deps = (): DispatchDeps => ({
  sql: db.sql,
  registry: createAgentRegistry({ dir, log: () => {} }),
  tools: createToolRegistry([logMessageTool, writeCanonical]),
  handlers,
});

const row = async (id: string) =>
  (await db.sql<{ agent_name: string; class: string | null; status: string; error_detail: string | null; output: unknown; completed_at: Date | null; latency_ms: number | null; tokens_used: number | null }[]>`
    select agent_name, class::text, status::text, error_detail, output, completed_at, latency_ms, tokens_used
    from agent_runs where id = ${id}`)[0]!;

beforeAll(async () => {
  db = await createTestDb('phase04d_dispatch', { migrated: true });
  dir = mkdtempSync(join(tmpdir(), 'xyp-dispatch-'));
  const put = (f: Parameters<typeof agentFile>[0]) => writeFileSync(join(dir, `${f.name}.agent.md`), agentFile(f));
  put({ name: 'unauthorized-writer', cls: 'Research', domain: 'RESEARCH_INTELLIGENCE', tools: ['write_canonical'] });
  put({ name: 'echo-logger', cls: 'Execution', tools: ['log_message'] });
  put({ name: 'sneaky-tool-user', cls: 'Execution', tools: ['log_message'] });
  put({ name: 'no-handler', cls: 'Execution', tools: [] });
  put({ name: 'llm-agent', cls: 'Creative', domain: 'RECORDS', tools: [], model: 'claude-sonnet-5' });
  put({ name: 'sleeper', cls: 'Execution', tools: [] });
  put({ name: 'thrower', cls: 'Execution', tools: [] });
  put({ name: 'classless', tools: [] });
});
afterAll(async () => {
  await db?.drop();
});

describe('authorization failure (written first)', () => {
  it('agent requesting an unauthorized tool → run logged as error, execution halted', async () => {
    const r = await dispatch(deps(), 'unauthorized-writer', { claim: 'x' });
    expect(r.status).toBe('error');
    expect(calls).not.toContain('unauthorized-writer');
    const run = await row(r.runId);
    expect(run).toMatchObject({ agent_name: 'unauthorized-writer', class: 'Research', status: 'error' });
    expect(run.error_detail).toBe(
      'tool authorization denied: write_canonical: capability canonical.write is granted to no agent class (requested by Research)',
    );
    expect(run.completed_at).not.toBeNull();
  });

  it('a handler invoking a tool it did not declare is stopped at invocation time', async () => {
    const r = await dispatch(deps(), 'sneaky-tool-user', {});
    expect(r.status).toBe('error');
    expect((await row(r.runId)).error_detail).toBe('tool not declared by agent sneaky-tool-user: write_canonical');
  });
});

describe('registry / executor failures are logged, never thrown past the caller', () => {
  it.each([
    ['ghost-agent', /^agent not in registry: ghost-agent$/],
    ['classless', /^agent failed registry validation: .*classless\.agent\.md: missing required field: class$/],
    ['no-handler', /^no handler registered for deterministic agent no-handler$/],
    ['llm-agent', /^LLM runner unavailable: ANTHROPIC_API_KEY is not set \(agent llm-agent uses model claude-sonnet-5\)$/],
    ['thrower', /^handler exploded$/],
  ])('%s → error row with a specific reason', async (name, reason) => {
    const r = await dispatch(deps(), name, {});
    expect(r.status).toBe('error');
    const run = await row(r.runId);
    expect(run.status).toBe('error');
    expect(run.error_detail).toMatch(reason);
    expect(run.completed_at).not.toBeNull();
  });

  it('an unresolvable agent is still logged, with class and domain null', async () => {
    const r = await dispatch(deps(), 'ghost-agent', {});
    expect(await row(r.runId)).toMatchObject({ agent_name: 'ghost-agent', class: null });
  });
});

describe('timeout', () => {
  it('fires at the stated value, marks the run error, aborts the handler, and a late result changes nothing', async () => {
    const r = await dispatch(deps(), 'sleeper', {}, { timeoutMs: 40 });
    expect(r.status).toBe('error');
    expect((await row(r.runId)).error_detail).toBe('timeout after 40ms');
    expect(calls).toContain('sleeper aborted: timeout after 40ms');
    await new Promise((res) => setTimeout(res, 250)); // let the handler resolve late
    const run = await row(r.runId);
    expect(run).toMatchObject({ status: 'error', error_detail: 'timeout after 40ms' });
  });
});

describe('happy path', () => {
  it('executes, captures output + tool logs + latency + tokens, one success row', async () => {
    const before = (await db.sql<{ n: number }[]>`select count(*)::int as n from agent_runs`)[0]!.n;
    const r = await dispatch(deps(), 'echo-logger', { ping: 'xyp' });
    expect(r.status).toBe('success');
    const run = await row(r.runId);
    expect(run).toMatchObject({ status: 'success', class: 'Execution', tokens_used: 0, error_detail: null });
    expect(run.output).toMatchObject({ result: { echo: { ping: 'xyp' } }, logs: [{ level: 'info', message: 'echoing' }] });
    expect(run.latency_ms).toBeGreaterThanOrEqual(0);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from agent_runs`)[0]!.n).toBe(before + 1);
  });

  it('never leaves a run pending', async () => {
    expect(await db.sql`select 1 from agent_runs where status = 'pending'`).toHaveLength(0);
  });
});
