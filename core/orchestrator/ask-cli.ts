import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import { connect } from '../db/client.ts';
import { LLM_TIMEOUT_MS } from '../llm/runner.ts';
import { HANDLERS } from '../runtime/handlers.ts';
import { createRuntimeLlmRunner } from '../runtime/programs.ts';
import { createRuntimeTools } from '../runtime/tools.ts';
import { hasLlmSteps, loadWorkflow, runWorkflow } from '../workflow-engine/engine.ts';
import { runResearch } from '../../research-intelligence/entrypoint.ts';
import { runMusicSystem } from '../../records/x3lius/entrypoint.ts';
import { runTechSystem } from '../../tech/entrypoint.ts';
import { ENTRYPOINTS, planDirect, planRequest, WORKFLOWS } from './orchestrate.ts';
import { ROUTABLE_DOMAINS, type RoutableDomain } from './router.ts';

// Usage: node core/orchestrator/ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]
// The OS front door: route → plan → run the domain entrypoint (or say why not).
// --domain / --workflow skip keyword routing: used by Claude Code skills that already chose.

const USAGE = 'usage: ask-cli.ts "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]';
const bad = (why: string): never => { console.error(`${why}
${USAGE}`); process.exit(2); };
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  return value !== undefined && !value.startsWith('--') ? value : bad(`${name} requires a value`);
};
const request = process.argv[2];
const projectSlug = flag('--project') ?? 'ad-hoc';
const domain = flag('--domain');
const workflow = flag('--workflow');
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
  const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') });
  const deps = { sql, registry, tools: createRuntimeTools({ sql }), handlers: HANDLERS, llmRunner: createRuntimeLlmRunner() };
  if (plan.action === 'run-service' && plan.service === 'run-research') {
    const r = await runResearch(deps, { question: request!, projectSlug });
    console.log(JSON.stringify(r, null, 2));
    if (r.status === 'error') process.exitCode = 1;
  } else if (plan.action === 'run-service' && plan.service === 'x3lius-music-system') {
    const r = await runMusicSystem(deps, { request: request! });
    console.log(JSON.stringify(r, null, 2));
    if (r.status !== 'success') process.exitCode = 1;
  } else if (plan.action === 'run-service' && plan.service === 'tech-system') {
    const r = await runTechSystem(deps, { request: request! });
    console.log(JSON.stringify(r, null, 2));
    if (r.status !== 'success') process.exitCode = 1;
  } else if (plan.action === 'run-workflow') {
    const wf = loadWorkflow(plan.workflow, registry);
    const r = await runWorkflow(deps, wf, plan.input, hasLlmSteps(wf, registry) ? { timeoutMs: LLM_TIMEOUT_MS } : {});
    console.log(JSON.stringify(r, null, 2));
    if (r.status === 'error') process.exitCode = 1;
  } else {
    throw new Error(`unknown entrypoint service: ${plan.service}`);
  }
} finally {
  await sql.end();
}
