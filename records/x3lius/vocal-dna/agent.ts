import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import { readVocalDna } from './read.ts';

/**
 * x3lius-vocal-dna (Phase 10, Knowledge, deterministic; replaces the Phase 7 stub): answers "what
 * is the X3LIUS vocal signature?" with the canonical Vocal DNA, through the same reader the RVC
 * step uses.
 * @param ctx - run context
 * @param input - `{ request }`, as the X3LIUS Music System entrypoint routes it
 * @returns `{ subdomain, status: 'known', request, vocalDna }`
 */
export const vocalDnaAgent: AgentHandler = async (ctx, input) => {
  const request = (input as { request?: unknown } | null)?.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  const vocalDna = await readVocalDna(ctx);
  await ctx.useTool('log_message', { message: `x3lius-vocal-dna: ${vocalDna.source.ref} v${vocalDna.source.version}` });
  return { output: { subdomain: 'x3lius-vocal-dna', status: 'known', request, vocalDna }, tokensUsed: 0 };
};
