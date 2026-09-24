import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { writeEvidence, type EvidenceInput } from '../evidence/engine.ts';

/**
 * write_evidence (capability research.write): the Evidence Engine exposed as a tool. The
 * specialist and agent run come from the run context, never from the caller's arguments.
 * @param deps - pool the write runs through (as xyp_research)
 * @returns the tool definition
 */
export const createWriteEvidenceTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_evidence',
    capability: 'research.write',
    description: 'Record one model/version-tagged claim backed by a research source (Evidence Engine).',
    handler: async (ctx, args) => {
      if (!ctx.researchRunId) throw new Error('write_evidence requires a research run');
      const id = await writeEvidence(
        deps.sql,
        { researchRunId: ctx.researchRunId, agentRunId: ctx.runId, specialist: ctx.agentName },
        (args ?? {}) as EvidenceInput,
      );
      ctx.log('info', `write_evidence → ${id}`);
      return { evidence_id: id };
    },
  });
