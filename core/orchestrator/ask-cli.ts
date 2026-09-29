import { connect } from '../db/client.ts';
import { createRuntimeDeps } from '../runtime/deps.ts';
import { askFailed, runPlan } from './ask.ts';
import { ENTRYPOINTS, planDirect, planRequest, WORKFLOWS } from './orchestrate.ts';
import { ROUTABLE_DOMAINS, type RoutableDomain } from './router.ts';

// Usage: node core/orchestrator/ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]
// The OS front door: route → plan → run the domain entrypoint (or say why not).
// --domain / --workflow skip keyword routing: used by Claude Code skills that already chose.

const USAGE = 'usage: ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]';
const flag = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const request = process.argv[2];
const projectSlug = flag('--project') ?? 'ad-hoc';
const domain = flag('--domain');
const workflow = flag('--workflow');
const bad = (why: string) => { console.error(`${why}\n${USAGE}`); process.exit(2); };
if (!request || request.startsWith('--')) bad('missing request');
if (domain && workflow) bad('use --domain or --workflow, not both');
if (domain && !(ROUTABLE_DOMAINS as readonly string[]).includes(domain)) bad(`unknown domain: ${domain}`);
if (workflow && !Object.hasOwn(WORKFLOWS, workflow)) bad(`unknown workflow: ${workflow}`);

const plan = domain ? planDirect(request!, { domain: domain as RoutableDomain })
  : workflow ? planDirect(request!, { workflow })
  : planRequest(request!, ENTRYPOINTS);
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
