import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import { connect } from '../db/client.ts';
import { HANDLERS } from '../runtime/handlers.ts';
import { createRuntimeTools } from '../runtime/tools.ts';
import { loadWorkflow, runWorkflow } from './engine.ts';

// Usage: node core/workflow-engine/cli.ts <spec.workflow.yaml> '<json input>'
// Prints the validated spec, each step's run, the output, and the rows written. Exits 1 on failure.

const [specPath, rawInput = '{}'] = process.argv.slice(2);
if (!specPath) {
  console.error("usage: cli.ts <spec.workflow.yaml> '<json input>'");
  process.exit(2);
}

const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') });
const wf = loadWorkflow(specPath, registry);
console.log(`spec: ${wf.name} (${wf.path}, sha256 ${wf.sha256.slice(0, 12)}…) steps: ${wf.steps.map((s) => `${s.id}=${s.agent}`).join(' → ')}`);

const sql = connect(undefined, { max: 3 });
try {
  const run = await runWorkflow({ sql, registry, tools: createRuntimeTools({ sql }), handlers: HANDLERS }, wf, JSON.parse(rawInput));
  console.log(`status: ${run.status}${run.failedStep ? ` (failed at ${run.failedStep}: ${run.error})` : ''}`);
  console.log(`output:\n${JSON.stringify(run.output ?? null, null, 2)}`);
  const [w] = await sql`select id, workflow_name, status, failed_step, skipped_steps, created_at, completed_at from workflow_runs where id = ${run.workflowRunId}`;
  console.log(`workflow_runs row:\n${JSON.stringify(w, null, 2)}`);
  const steps = await sql`
    select id, step_id, agent_name, class, status, latency_ms, tokens_used, output->'logs' as logs
    from agent_runs where workflow_run_id = ${run.workflowRunId} order by created_at`;
  console.log(`agent_runs rows (one per step):\n${JSON.stringify(steps, null, 2)}`);
  if (run.status === 'error') process.exitCode = 1;
} finally {
  await sql.end();
}
