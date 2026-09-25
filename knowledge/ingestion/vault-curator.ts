import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';

export const VAULT_CURATOR_AGENT = 'vault-curator';

/**
 * vault-curator (AOS-01, Execution, deterministic): adds one file to the Creative Vault, exactly
 * as given: `{ add: { path, sha256, mediaClass, title, language?, tags?, mimeType? } }`. Every value
 * is an input (addToVault derives them); it decides nothing and never turns a file into canonical
 * knowledge (that stays `pnpm ingest` and the Promotion Gate).
 * @param ctx - run context; register_vault_file carries the write
 * @param input - `{ add: … }`
 * @returns register_vault_file's result as the run output
 */
export const vaultCurator: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = Object.keys(i);
  if (ops.length !== 1 || ops[0] !== 'add') throw new Error('vault-curator input needs exactly { add: { path, sha256, mediaClass, title, … } }');
  return { output: await ctx.useTool('register_vault_file', i.add), tokensUsed: 0 };
};
