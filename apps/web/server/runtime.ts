import { join } from 'node:path';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { createContextEngine, type ContextEngine } from '../../../core/context-engine/context-engine.ts';
import { connect, type Sql } from '../../../core/db/client.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';

/**
 * The web server's one OS runtime per process (loaded through lib/os.ts, which Node caches): one
 * pool, one agent registry, one tool set, and the Context Engine loaded on first search.
 */

type Runtime = { readonly sql: Sql; readonly deps: DispatchDeps; readonly engine: () => Promise<ContextEngine>; readonly owner: string };

let current: Runtime | undefined;

/**
 * @returns the process's runtime, created on first use
 */
export const runtime = (): Runtime => {
  if (!current) {
    const sql = connect(undefined, { max: 4 });
    const deps: DispatchDeps = { sql, registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', '..', 'agents') }), tools: createRuntimeTools({ sql }), handlers: HANDLERS };
    let engine: Promise<ContextEngine> | undefined;
    current = { sql, deps, engine: () => (engine ??= loadEmbedder().then((e) => createContextEngine(sql, e))), owner: process.env.XYP_OWNER || 'owner' };
  }
  return current;
};
