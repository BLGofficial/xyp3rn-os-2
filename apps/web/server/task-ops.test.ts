import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Sql } from '../../../core/db/client.ts';
import type { AskResult } from '../../../core/orchestrator/ask.ts';
import { startTask, validateTask } from './task-ops.ts';
import { getAsk, startAsk, type AskRunners } from './ask-ops.ts';
import { recentJobs } from '../lib/ask-jobs.ts';

const input = { task: 'lyrics', text: 'A hopeful chorus in Bulgarian', knowledge: [], inputMethod: 'typed', language: 'bg' };
const runners = (patch: Partial<AskRunners> = {}): AskRunners => ({ engine: false,
  answerLookup: async () => { throw new Error('Unexpected lookup'); },
  runSkill: async () => { throw new Error('Unexpected skill'); },
  runDeep: async () => ({ ok: true, reply: 'Finished' }),
  runPlan: async () => ({ kind: 'workflow', result: { workflowRunId: randomUUID(), status: 'success', steps: [], skippedSteps: [] } }) as AskResult,
  ...patch,
});
describe('task launcher trust boundary', () => {
  it('rejects unknown targets, forged references, duplicates and oversized input', () => {
    for (const patch of [{ task: '../../exec' }, { text: ' ' }, { text: 'x'.repeat(8001) }, { knowledge: ['file:../../secret'] }, { knowledge: Array(7).fill(`module:${randomUUID()}`) }, { inputMethod: 'shell' }, { language: 'xx' }]) {
      expect(() => validateTask({ ...input, ...patch })).toThrow();
    }
    const id = `prompt:${randomUUID()}`;
    expect(() => validateTask({ ...input, knowledge: [id, id] })).toThrow();
  });
  it('routes a chosen task directly even when the brief starts with a different spoken skill', async () => {
    const owner = randomUUID(); let workflow = '';
    const id = await startTask(owner, { ...input, text: 'Research this lyric theme' }, {} as Sql, runners({
      engine: true, runPlan: async plan => { workflow = plan.action === 'run-workflow' ? plan.workflow : ''; return { kind: 'workflow', result: { workflowRunId: randomUUID(), status: 'success', steps: [], skippedSteps: [] } } as AskResult; },
    }));
    expect(workflow).toBe('records/x3lius/write-lyrics.workflow.yaml');
    expect(getAsk(owner, id)?.route.domain).toBe('lyrics');
    expect(recentJobs(owner).map(r => r.requestId)).toContain(id);
    expect(recentJobs(randomUUID())).toEqual([]);
  });
  it('uses the registered Suno workflow and preserves selected text', async () => {
    let path = '', request = '';
    await startTask(randomUUID(), { ...input, task: 'song-to-suno' }, {} as Sql, runners({ runPlan: async plan => {
      path = plan.action === 'run-workflow' ? plan.workflow : ''; request = plan.input.request;
      return { kind: 'workflow', result: { workflowRunId: randomUUID(), status: 'success', steps: [], skippedSteps: [] } } as AskResult;
    } }));
    expect(path).toBe('records/x3lius/song-to-suno.workflow.yaml');
    expect(request).toContain(input.text);
    expect(request).toContain('Brief language: bg');
  });
  it('retains engine gates and concurrency limits for explicit tasks', async () => {
    await expect(startAsk(randomUUID(), { text: 'brief', deep: true }, runners())).rejects.toThrow('LLM_ENGINE');
    const owner = randomUUID(), pending = runners({ runPlan: () => new Promise<never>(() => {}) });
    await startTask(owner, input, {} as Sql, pending); await startTask(owner, input, {} as Sql, pending);
    await expect(startTask(owner, input, {} as Sql, pending)).rejects.toThrow('Two requests');
    await expect(startAsk(randomUUID(), { text: 'brief', task: 'arbitrary' }, runners())).rejects.toThrow('Unknown task');
  });
});
