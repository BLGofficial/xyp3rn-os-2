import { createContextEngine } from '../context-engine/context-engine.ts';
import type { Sql } from '../db/client.ts';
import { createLongTermMemory, type LongTermMemory } from '../memory/memory.ts';
import { createToolRegistry, type ToolRegistry } from '../tool-registry/registry.ts';
import { logMessageTool } from '../tool-registry/tools/log-message.ts';
import { createRetrieveContextTool } from '../tool-registry/tools/retrieve-context.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';

/**
 * The live tool set. Adding a tool here is the only way it becomes requestable.
 * @param deps - pool the Context Engine reads through (as xyp_runtime)
 * @returns registry with log_message + retrieve_context
 */
export const createRuntimeTools = (deps: { readonly sql: Sql }): ToolRegistry => {
  let longTerm: Promise<LongTermMemory> | undefined;
  const lazyLongTerm = () => (longTerm ??= loadEmbedder().then((e) => createLongTermMemory(createContextEngine(deps.sql, e))));
  return createToolRegistry([logMessageTool, createRetrieveContextTool(lazyLongTerm)]);
};
