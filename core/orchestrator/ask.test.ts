import { describe, expect, it, vi } from 'vitest';
import { askFailed, formatReply, MAX_REPLY_CHARS, refsOf, runPlan, type AskResult, type RunnablePlan } from './ask.ts';
import { LLM_TIMEOUT_MS } from '../llm/runner.ts';
import { planRequest } from './orchestrate.ts';
import type { EngineDeps } from '../workflow-engine/engine.ts';

const engineCalls = vi.hoisted(() => ({ options: [] as { timeoutMs?: number }[] }));
vi.mock('../workflow-engine/engine.ts', async (actual) => ({
  ...(await actual<typeof import('../workflow-engine/engine.ts')>()),
  loadWorkflow: (path: string) => ({
    path, sha256: 'x', name: 'wf', requiredInput: [], output: undefined,
    steps: path === 'llm.workflow.yaml' ? [{ id: 's1', agent: 'llm-agent' }] : [{ id: 's1', agent: 'none-agent' }],
  }),
  runWorkflow: async (_deps: unknown, _wf: unknown, _input: unknown, options: { timeoutMs?: number }) => {
    engineCalls.options.push(options);
    return { workflowRunId: 'w', status: 'success', skippedSteps: [], steps: [] };
  },
}));

const research = planRequest('Research the best current method for controlling dark baritone vocals in Suno.', { RESEARCH_INTELLIGENCE: { service: 'run-research' } });
const selection = { selected: [], evidence: [] } as never;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ask front door: reply text comes only from the real plan/result', () => {
  it('hold and clarify replies carry the planner reason', () => {
    expect(formatReply(planRequest('Research the best current method for vocals.', {}))).toBe('On hold: no entrypoint registered for RESEARCH_INTELLIGENCE yet (built in Phase 6A).');
    expect(formatReply(planRequest('zzz', {}))).toBe('Needs clarification: no domain matched; rephrase with domain terms.');
  });

  it('summarises each entrypoint result, flags failures, and keeps raw error text out', () => {
    const cases: [AskResult, string, boolean][] = [
      [{ kind: 'research', result: { researchRunId: 'r1', status: 'success', selected: ['a', 'b'], workflowRunId: 'w' } }, 'Research run finished. Specialists: a, b.', false],
      [{ kind: 'research', result: { researchRunId: 'r1', status: 'error', selected: [], workflowRunId: 'w', error: 'specialist step vocal-analyst failed: model said SECRET PROMPT' } }, 'Research run failed at specialist vocal-analyst. Details are on research run r1.', true],
      [{ kind: 'music', result: { status: 'success', selected: ['lyrics'], selection, workflowRunId: 'w', outputs: {} } }, 'X3LIUS music system finished. Sub-domains: lyrics.', false],
      [{ kind: 'music', result: { status: 'clarify', selected: [], selection, workflowRunId: null, outputs: {}, reason: 'name it' } }, 'Needs clarification: name it.', true],
      [{ kind: 'music', result: { status: 'error', selected: ['mix'], selection, workflowRunId: 'w9', outputs: {}, reason: 'sub-domain step mix failed: anthropic API error 401' } }, 'X3LIUS music system failed at mix. Details are on workflow run w9.', true],
      [{ kind: 'workflow', result: { workflowRunId: 'w', status: 'error', failedStep: 's2', error: 'x', skippedSteps: [], steps: [] } }, 'Workflow failed at s2. Details are on workflow run w.', true],
      [{ kind: 'tech', result: { status: 'success', selected: ['trace'], selection, workflowRunId: 'w', outputs: {} } }, 'Tech system finished. Components: trace.', false],
      [{ kind: 'tech', result: { status: 'clarify', selected: [], selection, workflowRunId: null, outputs: {}, reason: 'which component' } }, 'Needs clarification: which component.', true],
      [{ kind: 'tech', result: { status: 'error', selected: ['trace'], selection, workflowRunId: 'w8', outputs: {}, reason: 'component step trace failed: provider said SECRET' } }, 'Tech system failed at trace. Details are on workflow run w8.', true],
    ];
    for (const [outcome, reply, failed] of cases) {
      expect(formatReply(research, outcome)).toBe(reply);
      expect(askFailed(outcome)).toBe(failed);
    }
  });

  it('lifts run, artifact and approval ids (only ids) and reports required approvals', () => {
    const outcome: AskResult = { kind: 'music', result: { status: 'success', selected: ['release'], selection, workflowRunId: 'w1', outputs: {
      release: { artifact: { id: id(1), prompt: 'SECRET PROMPT' }, nested: { artifact_id: id(2), approvalId: id(3) } }, notAnId: { approvalId: 'drop table' },
    } } };
    expect(refsOf(outcome)).toEqual({ workflowRunId: 'w1', agentRunIds: [], artifactIds: [id(1), id(2)], approvalIds: [id(3)] });
    expect(formatReply(research, outcome)).toBe('X3LIUS music system finished. Sub-domains: release. Approval required: 1 item(s) pending in Governance.');
    const wf: AskResult = { kind: 'workflow', result: { workflowRunId: 'w2', status: 'success', skippedSteps: [], steps: [{ stepId: 's1', agentRunId: 'a1', status: 'success' }] } };
    expect(refsOf(wf).agentRunIds).toEqual(['a1']);
  });

  it('bounds the reply length', () => {
    const outcome: AskResult = { kind: 'research', result: { researchRunId: 'r', status: 'success', selected: Array.from({ length: 200 }, (_, i) => `specialist-${i}`), workflowRunId: 'w' } };
    const reply = formatReply(research, outcome);
    expect(reply.length).toBe(MAX_REPLY_CHARS);
    expect(reply.endsWith('…')).toBe(true);
  });

  it('refuses an unknown entrypoint service without touching deps', async () => {
    const plan = { ...research, service: 'nope' } as RunnablePlan;
    await expect(runPlan({} as EngineDeps, plan)).rejects.toThrow('unknown entrypoint service: nope');
  });

  it('mirrors pnpm workflow: run-workflow gets the LLM timeout only when a step is model-backed', async () => {
    const registry = { get: (name: string) => (name === 'llm-agent' ? { model: 'claude-sonnet-5' } : { model: 'none' }) };
    const deps = { registry } as unknown as EngineDeps;
    const llmPlan = { ...research, action: 'run-workflow', workflow: 'llm.workflow.yaml', input: { request: 'x' } } as RunnablePlan;
    const nonePlan = { ...research, action: 'run-workflow', workflow: 'none.workflow.yaml', input: { request: 'x' } } as RunnablePlan;
    engineCalls.options.length = 0;
    await runPlan(deps, llmPlan);
    await runPlan(deps, nonePlan);
    expect(engineCalls.options[0]).toMatchObject({ timeoutMs: LLM_TIMEOUT_MS });
    expect(engineCalls.options[1]).not.toHaveProperty('timeoutMs');
  });
});
