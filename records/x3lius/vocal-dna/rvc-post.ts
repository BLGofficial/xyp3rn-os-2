import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import { RVC_OPTIONAL } from '../../../knowledge/ingestion/normalizers/vocal-dna.ts';
import { readVocalDna } from './read.ts';

/**
 * x3lius-rvc-post (Phase 10, Execution, deterministic): the RVC/Applio post-processing job spec
 * for an X3LIUS vocal, taken from the canonical Vocal DNA and nothing else. No audio is processed
 * here (the voice model runs in the operator's local pipeline); the spec names the canonical row
 * and version it came from, so a render can be traced to the vocal direction in force.
 * @param ctx - run context
 * @returns `{ status: 'job-spec', source, rvc, unset, vocal }`; `unset` lists the optional
 *   settings the Vocal DNA doesn't state (the local tool's own defaults apply; none are invented)
 */
export const rvcPost: AgentHandler = async (ctx) => {
  const dna = await readVocalDna(ctx);
  await ctx.useTool('log_message', { message: `x3lius-rvc-post: Vocal DNA ${dna.source.ref} v${dna.source.version} → ${dna.rvc.engine} model ${dna.rvc.model}` });
  return {
    output: {
      status: 'job-spec',
      source: { canonicalPromptId: dna.source.canonicalPromptId, slug: dna.source.slug, version: dna.source.version, ref: dna.source.ref },
      rvc: dna.rvc,
      unset: RVC_OPTIONAL.filter((k) => dna.rvc[k] === undefined),
      vocal: { tone: dna.tone, register: dna.register, delivery: dna.delivery, adlibs: dna.adlibs },
    },
    tokensUsed: 0,
  };
};
