import type { LongTermMemory } from '../../memory/memory.ts';
import { defineTool, type Tool } from '../registry.ts';

/**
 * retrieve_context (capability context.read): the only way an agent reaches long-term memory.
 * Going through a tool puts retrieval under the same authorization as every other capability.
 * @param longTerm - lazy accessor, so the embedding model loads only on first use
 * @returns the tool definition
 */
export const createRetrieveContextTool = (longTerm: () => Promise<LongTermMemory>): Tool =>
  defineTool({
    name: 'retrieve_context',
    capability: 'context.read',
    description: 'Ranked, traceable context bundle from long-term memory (Phase 3 Context Engine); optional scope.modules narrows it to modules (Phase 7).',
    handler: async (_ctx, args) => {
      const a = (args ?? {}) as { query?: unknown; scope?: { modules?: unknown } };
      if (typeof a.query !== 'string' || a.query.trim() === '') throw new Error('retrieve_context: query must be a non-empty string');
      if (a.scope === undefined) return (await longTerm()).recall(a.query);
      const modules = a.scope?.modules;
      if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string')) {
        throw new Error('retrieve_context: scope.modules must be an array of module slugs');
      }
      // A scope only narrows what is read, so it needs no capability beyond context.read.
      return (await longTerm()).recall(a.query, { scope: { modules } });
    },
  });
