import { connect } from '../db/client.ts';
import { createRuntimeDeps } from '../runtime/deps.ts';
import { askFailed, runPlan } from './ask.ts';
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
  const outcome = await runPlan(createRuntimeDeps(sql), plan, { projectSlug });
  console.log(JSON.stringify(outcome.result, null, 2));
  if (askFailed(outcome)) process.exitCode = 1;
} finally {
  await sql.end();
}
