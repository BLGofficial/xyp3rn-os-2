import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';

export const OBSIDIAN_SYNC_AGENT = 'obsidian-sync';

/**
 * obsidian-sync (F54, Execution, deterministic): performs one step of a sync plan the owner previewed.
 * - `{ export: { vaultRoot, notePath, content, expectedSha, planHash } }` writes the note, then records it.
 * - `{ record: { vaultRoot, notePath, sha256, sourceId, planHash } }` records an imported note (its Vault
 *   file was added by vault-curator in its own run).
 * It decides nothing: the plan (knowledge/obsidian/sync.ts) names every path, hash and content.
 * @param ctx - run context
 * @param input - exactly one of export, record
 * @returns the step's result
 */
export const obsidianSync: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = Object.keys(i);
  if (ops.length !== 1 || (ops[0] !== 'export' && ops[0] !== 'record')) throw new Error('obsidian-sync input needs exactly one of { export: … } or { record: … }');
  const step = (i[ops[0]!] ?? {}) as Record<string, unknown>;
  if (ops[0] === 'record') {
    const recorded = await ctx.useTool('record_obsidian_sync', { ...step, direction: 'import' });
    return { output: recorded, tokensUsed: 0 };
  }
  const written = (await ctx.useTool('write_obsidian_note', {
    vaultRoot: step.vaultRoot, notePath: step.notePath, content: step.content, expectedSha: step.expectedSha ?? null,
  })) as { notePath: string; sha256: string; previousSha: string | null };
  const recorded = (await ctx.useTool('record_obsidian_sync', {
    vaultRoot: step.vaultRoot, notePath: written.notePath, direction: 'export', sha256: written.sha256, planHash: step.planHash,
  })) as { eventId: string };
  return { output: { ...written, eventId: recorded.eventId }, tokensUsed: 0 };
};
