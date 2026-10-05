import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../tests/helpers/db.ts';
import { musicKnowledge, startTask } from './task-ops.ts';
import { getAsk, type AskRunners } from './ask-ops.ts';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { loadWorkflow, runWorkflow } from '../../../core/workflow-engine/engine.ts';
import { join } from 'node:path';
import { insertCanonical } from '../../../tests/helpers/research-fixture.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';

let db: TestDb;
let music: string, prompt: string, secondPrompt: string;
const tech = randomUUID();
beforeAll(async () => {
  db = await createTestDb('web_task_context', { migrated: true });
  const first = await insertCanonical(db.sql, { slug: 'fixture-hook', body: 'Use internal rhyme with concrete images' });
  prompt = first.canonicalPromptId;
  secondPrompt = (await insertCanonical(db.sql, { slug: 'fixture-chorus', body: 'Use a restrained chorus' })).canonicalPromptId;
  music = (await db.sql<{ module_id: string }[]>`select module_id from canonical_prompts where id = ${prompt}`)[0]!.module_id;
  await db.sql.begin(async tx => {
    await tx`insert into modules (id,slug,title,domain,source_id,promoted_via) values (${tech},'fixture-tech','Tech fixture','TECH',${first.sourceId},'bootstrap')`;
    await tx`insert into knowledge_versions (canonical_table,canonical_id,version,promoted_via,snapshot) values ('modules',${tech},1,'bootstrap','{}'::jsonb)`;
  });
});
afterAll(async () => { await db?.drop(); });
describe('music task context and engine integration', () => {
  it('lists real music sources while excluding other domains', async () => {
    const rows = await musicKnowledge(db.sql);
    expect(rows.map(r => r.id)).toContain(`module:${music}`);
    expect(rows.map(r => r.id)).toContain(`prompt:${prompt}`);
    expect(rows.map(r => r.id)).not.toContain(`module:${tech}`);
    expect(rows.every(r => !('content' in r))).toBe(true);
  });
  it('combines selected sources and executes the real workflow engine with a fixture handler', async () => {
    let received = '';
    const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', '..', 'agents') });
    const owner = randomUUID();
    const runners: AskRunners = { engine: false, answerLookup: async () => { throw new Error('unexpected'); }, runSkill: async () => { throw new Error('unexpected'); }, runDeep: async () => { throw new Error('unexpected'); },
      runPlan: async plan => {
        if (plan.action !== 'run-workflow') throw new Error('Expected registered lyrics workflow');
        const wf = loadWorkflow(plan.workflow, registry);
        const result = await runWorkflow({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: {}, llmRunner: async (_ctx, input) => { received = String((input as { request: string }).request); return { output: { fixture: true } }; } }, wf, plan.input);
        return { kind: 'workflow', result };
      },
    };
    const id = await startTask(owner, { task: 'lyrics', text: '[FIXTURE] A short chorus', knowledge: [`prompt:${secondPrompt}`, `prompt:${prompt}`], inputMethod: 'wispr-flow', language: 'en' }, db.sql, runners);
    for (let i = 0; i < 100 && getAsk(owner, id)?.state === 'running'; i++) await new Promise(r => setTimeout(r, 20));
    const result = getAsk(owner, id)!;
    expect(result.status).toBe('success');
    expect(result.refs?.workflowRunId).toBeTruthy();
    expect(received).toContain('restrained chorus');
    expect(received).toContain('internal rhyme');
    expect(received).toContain(`prompt:${prompt}`);
    const runs = await db.sql`select status from workflow_runs where id = ${result.refs!.workflowRunId!}`;
    expect(runs[0]?.status).toBe('success');
    await expect(startTask(owner, { task: 'lyrics', text: 'brief', knowledge: [`module:${tech}`], inputMethod: 'typed', language: 'en' }, db.sql, runners)).rejects.toThrow('no longer available');
  });
});
