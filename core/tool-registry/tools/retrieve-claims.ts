import { readClaims } from '../../context-engine/context-engine.ts';
import type { Sql } from '../../db/client.ts';
import { defineTool, type Tool } from '../registry.ts';

/**
 * retrieve_claims (capability context.read): current canonical claims by topic prefix, read-only.
 * The exact counterpart to retrieve_context's ranked search; needs no embedding model.
 * @param deps - pool the read runs through (as xyp_runtime)
 * @returns the tool definition
 */
export const createRetrieveClaimsTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'retrieve_claims',
    capability: 'context.read',
    description: 'Current canonical claims whose topic starts with topicPrefix (e.g. "x3lius."), each with its canonical row and source.',
    handler: async (_ctx, args) => {
      const prefix = (args as { topicPrefix?: unknown } | null)?.topicPrefix;
      if (typeof prefix !== 'string') throw new Error('retrieve_claims: topicPrefix must be a string');
      return readClaims(deps.sql, prefix);
    },
  });
