import { describe, expect, it, vi } from 'vitest';
import { LLM_TIMEOUT_MS } from '../core/llm/runner.ts';
import type { EngineDeps } from '../core/workflow-engine/engine.ts';

// Focused, DB-free test for the F1 fix: runResearch's runWorkflow call must carry the LLM
// per-step timeout, the same way core/workflow-engine/cli.ts and runPlan's run-workflow branch do.
// dispatch and the workflow engine are mocked; a tiny fake `sql` answers just the queries
// runResearch issues, in the order it issues them (no real Postgres involved).

const engine = vi.hoisted(() => ({ calls: [] as { timeoutMs?: number; researchRunId?: string }[] }));
vi.mock('../core/workflow-engine/engine.ts', () => ({
  compileWorkflow: () => ({ name: 'generated-wf', sha256: 'x', requiredInput: [], output: undefined, steps: [], path: 'generated:test' }),
  runWorkflow: async (_deps: unknown, _wf: unknown, _input: unknown, options: { timeoutMs?: number; researchRunId?: string }) => {
    engine.calls.push(options);
    return { workflowRunId: 'w1', status: 'success', skippedSteps: [], steps: [] };
  },
}));
vi.mock('../core/orchestrator/dispatch.ts', () => ({
  dispatch: async () => ({
    runId: 'orch-run',
    status: 'success',
    output: { selection: { selected: [{ name: 'vocal-analyst' }], evidence: [] }, workflow: { name: 'generated', steps: [] } },
    latencyMs: 1,
  }),
}));

const { runResearch } = await import('./entrypoint.ts');

/** Answers only the queries runResearch issues (matched by a substring of the query text). */
const fakeSql = () => {
  const tag = (async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('select id from research_projects')) return [{ id: 'project-1' }];
    if (text.includes('insert into research_questions')) return [{ id: 'question-1' }];
    if (text.includes('insert into research_runs')) return [{ id: 'run-1' }];
    return [];
  }) as unknown as EngineDeps['sql'];
  Object.assign(tag as object, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(tag),
    unsafe: async () => undefined,
    json: (v: unknown) => v,
  });
  return tag;
};

describe('runResearch: workflow timeout (F1)', () => {
  it('passes timeoutMs: LLM_TIMEOUT_MS to runWorkflow, keeping researchRunId', async () => {
    const registry = { list: () => [{ name: 'vocal-analyst', class: 'Research', sections: { Scope: 'vocals' } }] };
    const deps = { sql: fakeSql(), registry } as unknown as EngineDeps;
    engine.calls.length = 0;
    const result = await runResearch(deps, { question: 'what compression works for vocals?', projectSlug: 'ad-hoc' });
    expect(result.status).toBe('success');
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]).toMatchObject({ timeoutMs: LLM_TIMEOUT_MS, researchRunId: 'run-1' });
  });
});
