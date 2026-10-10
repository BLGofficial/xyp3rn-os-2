import { join } from 'node:path';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { createAgentRegistry } from '../../agent-registry/registry.ts';
import { createContextEngine, type ContextEngine } from '../../context-engine/context-engine.ts';
import { connect } from '../../db/client.ts';
import { ROUTABLE_DOMAINS, type RoutableDomain } from '../../orchestrator/router.ts';
import { HANDLERS } from '../../runtime/handlers.ts';
import { createRuntimeLlmRunner } from '../../runtime/programs.ts';
import { createRuntimeTools } from '../../runtime/tools.ts';
import { JarvisCore, type JarvisRequest } from '../jarvis/JarvisOrchestrator.ts';

// pnpm jarvis "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]    (a bare request means ask)
// pnpm jarvis ask|dispatch|workflow|promote ...   — the one entry point; each command goes through JarvisCore.

const USAGE = `usage: jarvis "<request>" [--domain <DOMAIN> | --workflow <id>] [--project <slug>]
       jarvis dispatch <agent> '<json>'
       jarvis workflow <path.workflow.yaml> '<json>'
       jarvis promote <candidateId>      send a canonical-write candidate to the Promotion Gate (a human approves)
       jarvis propose-split <trackId> '<[{"payee":"X3LIUS","percentage":100}]>' "<reason>"   queue the next split set (a human approves)
       jarvis apply-split <approvalId>   write an approved, still-current split proposal`;
const bad = (why: string): never => { console.error(`${why}\n${USAGE}`); process.exit(2); };

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value !== undefined && !value.startsWith('--') ? value : bad(`${name} requires a value`);
};
const json = (text: string | undefined, what: string): Record<string, unknown> => {
  try { return text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { return bad(`${what} must be JSON`); }
};

const parse = (): JarvisRequest => {
  const [cmd, a, b, c] = args;
  if (!cmd) return bad('missing command');
  if (cmd === 'dispatch') return a ? { type: 'dispatch', agent: a, input: json(b, 'input') } : bad('dispatch needs an agent');
  if (cmd === 'workflow') return a ? { type: 'workflow', path: a, input: json(b, 'input') } : bad('workflow needs a path');
  if (cmd === 'promote') return a ? { type: 'canonical-write', candidateId: a } : bad('promote needs a candidate id');
  if (cmd === 'propose-split') {
    if (!a || !b || !c) return bad('propose-split needs a track id, a JSON array of splits and a reason');
    let splits: unknown;
    try { splits = JSON.parse(b); } catch { return bad('splits must be a JSON array'); }
    if (!Array.isArray(splits)) return bad('splits must be a JSON array');
    return { type: 'propose-split', trackId: a, splits, reason: c };
  }
  if (cmd === 'apply-split') return a ? { type: 'apply-split', approvalId: a } : bad('apply-split needs an approval id');
  const request = cmd === 'ask' ? a : cmd;
  if (!request || request.startsWith('--')) return bad('missing request');
  const domain = flag('--domain');
  const workflow = flag('--workflow');
  if (domain && workflow) bad('use --domain or --workflow, not both');
  if (domain && !(ROUTABLE_DOMAINS as readonly string[]).includes(domain)) bad(`unknown domain: ${domain}`);
  const projectSlug = flag('--project');
  return { type: 'ask', request, ...(domain ? { domain: domain as RoutableDomain } : {}), ...(workflow ? { workflow } : {}), ...(projectSlug ? { projectSlug } : {}) };
};

const request = parse();
const sql = connect(undefined, { max: 3 });
try {
  let engine: ContextEngine | undefined;
  // The gte-small model loads on the first retrieval only, so dispatch / workflow / promote never pay for it.
  const lazyEngine = { retrieve: async (...a: Parameters<ContextEngine['retrieve']>) => (engine ??= createContextEngine(sql, await loadEmbedder())).retrieve(...a) } as Pick<ContextEngine, 'retrieve'>;
  const registry = createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', '..', 'agents') });
  const jarvis = new JarvisCore({ sql, registry, tools: createRuntimeTools({ sql }), handlers: HANDLERS, llmRunner: createRuntimeLlmRunner(), engine: lazyEngine });
  const result = await jarvis.interceptAndExecute('cli', request);
  const asJson = args.includes('--json'); // machine mode (galaxy/jarvis_brain.py): one JSON document, nothing else
  if (!asJson) console.log(result.summary);
  console.log(JSON.stringify({ status: result.status, summary: result.summary, context: result.context, approvalIds: result.approvalIds, data: result.data }, null, asJson ? 0 : 2));
  if (result.status === 'ERROR' || result.status === 'BLOCKED') process.exitCode = 1;
} finally {
  await sql.end();
}
