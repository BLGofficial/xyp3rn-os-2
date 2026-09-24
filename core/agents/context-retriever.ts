import type { ContextBundle } from '../context-engine/context-engine.ts';
import type { AgentHandler } from '../orchestrator/dispatch.ts';

/**
 * Handler for agents/context-retriever.agent.md: "what do we already know?" — asks long-term
 * memory through the retrieve_context tool (capability context.read) and returns the ranked,
 * traceable items (full text included) minus the per-hop reason objects — `why` keeps them
 * human-readable, and the full reasons stay reproducible from the same generation.
 * @param ctx - run context
 * @param input - `{ query }`
 * @returns `{ query, generation, cache, items }`
 */
export const contextRetriever: AgentHandler = async (ctx, input) => {
  const query = (input as { query?: unknown } | null)?.query;
  if (typeof query !== 'string' || query.trim() === '') throw new Error('query must be a non-empty string');
  const bundle = (await ctx.useTool('retrieve_context', { query })) as ContextBundle;
  await ctx.useTool('log_message', { message: `retrieved ${bundle.items.length} item(s), cache ${bundle.cache}` });
  return {
    output: {
      query,
      generation: bundle.generation,
      cache: bundle.cache,
      items: bundle.items.map(({ ref, slug, title, snippet, text, domain, score, why, source }) => ({ ref, slug, title, snippet, text, domain, score, why, source })),
    },
    tokensUsed: 0,
  };
};
