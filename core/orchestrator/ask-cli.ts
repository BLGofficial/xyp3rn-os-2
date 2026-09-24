import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import { connect } from '../db/client.ts';
import { HANDLERS } from '../runtime/handlers.ts';
import { createRuntimeTools } from '../runtime/tools.ts';
import { loadWorkflow, runWorkflow } from '../workflow-engine/engine.ts';
import { runResearch } from '../../research-intelligence/entrypoint.ts';
import { runMusicSystem } from '../../records/x3lius/entrypoint.ts';
import { ENTRYPOINTS, planRequest } from './orchestrate.ts';

// Usage: node core/orchestrator/ask-cli.ts "<request>" [--project <slug>]
// The OS front door: route → plan → run the domain entrypoint (or say why not).

const request = process.argv[2];
const projectAt = process.argv.indexOf('--project');
const projectSlug = projectAt > 0 ? process.argv[projectAt + 1]! : 'ad-hoc';
if (!request) {
  console.error('usage: ask-cli.ts "<request>" [--project <slug>]');
  process.exit(2);
}

const plan = planRequest(request, ENTRYPOINTS);
console.log(`route: ${JSON.stringify({ status: plan.route.status, ...('domain' in plan.route ? { domain: plan.route.domain } : {}), evidence: plan.route.evidence })}`);
if (plan.action === 'hold' || plan.action === 'clarify') {
  console.log(`${plan.action}: ${plan.reason}`);
  process.exit(plan.action === 'clarify' ? 1 : 0);
}

const sql = connect(undefined, { max: 3 });
try {
  const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') });
  const deps = { sql, registry, tools: createRuntimeTools({ sql }), handlers: HANDLERS };
  if (plan.action === 'run-service' && plan.service === 'run-research') {
    const r = await runResearch(deps, { question: request, projectSlug });
    console.log(JSON.stringify(r, null, 2));
    if (r.status === 'error') process.exitCode = 1;
  } else if (plan.action === 'run-service' && plan.service === 'x3lius-music-system') {
    const r = await runMusicSystem(deps, { request });
    console.log(JSON.stringify(r, null, 2));
    if (r.status !== 'success') process.exitCode = 1;
  } else if (plan.action === 'run-workflow') {
    const r = await runWorkflow(deps, loadWorkflow(plan.workflow, registry), plan.input);
    console.log(JSON.stringify(r, null, 2));
    if (r.status === 'error') process.exitCode = 1;
  } else {
    throw new Error(`unknown entrypoint service: ${plan.service}`);
  }
} finally {
  await sql.end();
}
