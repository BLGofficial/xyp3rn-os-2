import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import { connect } from '../db/client.ts';
import { LLM_TIMEOUT_MS } from '../llm/runner.ts';
import { HANDLERS } from '../runtime/handlers.ts';
import { createRuntimeLlmRunner } from '../runtime/programs.ts';
import { createRuntimeTools } from '../runtime/tools.ts';
import { dispatch } from './dispatch.ts';

// Usage: node core/orchestrator/cli.ts <agent-name> '<json input>'
// Prints the full trace: registry pickup → validation → authorization → execution → logged row.

const [name, rawInput = 'null'] = process.argv.slice(2);
if (!name) {
  console.error("usage: cli.ts <agent-name> '<json input>'");
  process.exit(2);
}

const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') });
const agent = registry.get(name);
console.log('1. registry pickup');
console.log(agent ? `   ${agent.path}\n   class=${agent.class} domain=${agent.domain} tools=[${agent.tools.join(', ')}] model=${agent.model}` : `   ${name}: not in registry`);
const failures = registry.validateAll();
console.log(`2. validateAll(agents/): ${failures.length} failure(s)`);
const sql = connect(undefined, { max: 2 });
const tools = createRuntimeTools({ sql });
console.log('3. authorization');
for (const t of agent?.tools ?? []) console.log(`   ${t}: ${JSON.stringify(tools.authorize(agent!.class, t))}`);

try {
  const result = await dispatch({ sql, registry, tools, handlers: HANDLERS, llmRunner: createRuntimeLlmRunner() }, name, JSON.parse(rawInput),
    agent && agent.model !== 'none' ? { timeoutMs: LLM_TIMEOUT_MS } : {});
  console.log(`4. execution: ${result.status} in ${result.latencyMs}ms${result.error ? ` — ${result.error}` : ''}`);
  const [row] = await sql`
    select id, agent_name, class, domain, input, output, tokens_used, latency_ms, status, error_detail, created_at, completed_at
    from agent_runs where id = ${result.runId}`;
  console.log('5. agent_runs row (SELECT … WHERE id = runId):');
  console.log(JSON.stringify(row, null, 2));
  if (result.status === 'error') process.exitCode = 1;
} finally {
  await sql.end();
}
