import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import type { Sql } from '../db/client.ts';
import type { DispatchDeps } from '../orchestrator/dispatch.ts';
import { HANDLERS } from './handlers.ts';
import { createRuntimeLlmRunner } from './programs.ts';
import { createRuntimeTools } from './tools.ts';

/**
 * The live dispatch dependencies for a CLI: agents/ registry, the runtime tools, deterministic
 * handlers and the LLM runner (provider keys from the environment).
 * @param sql - pool the tools run through
 * @returns deps for dispatch / evaluate
 */
export const createRuntimeDeps = (sql: Sql): DispatchDeps => ({
  sql,
  registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') }),
  tools: createRuntimeTools({ sql }),
  handlers: HANDLERS,
  llmRunner: createRuntimeLlmRunner(),
});
