import { describe, expect, it } from 'vitest';
import { askFailed, formatReply, MAX_REPLY_CHARS, refsOf, runPlan, type AskResult, type RunnablePlan } from './ask.ts';
import { planRequest } from './orchestrate.ts';
import type { EngineDeps } from '../workflow-engine/engine.ts';

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
});
