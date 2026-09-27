import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';
import { writeEvidence, type EvidenceInput } from '../evidence/engine.ts';
import { citeIngestedSource } from '../sources/verify.ts';

/**
 * write_evidence (capability research.write): the Evidence Engine exposed as a tool. The
 * specialist and agent run come from the run context, never from the caller's arguments. AOS-04: an
 * agent's claim carries the verbatim `quote` behind it and cites exactly one of a fetched page
 * (`research_source_id`) or an ingested source through the canonical row that quotes it
 * (`canonical_prompt_id`); the DB verifies the quote.
 * @param deps - pool the write runs through (as xyp_research)
 * @returns the tool definition
 */
export const createWriteEvidenceTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_evidence',
    capability: 'research.write',
    description: 'Record one model/version-tagged claim with the verbatim quote behind it, citing a fetched page or a canonical row\'s source (Evidence Engine).',
    handler: async (ctx, args) => {
      if (!ctx.researchRunId) throw new Error('write_evidence requires a research run');
      const a = (args ?? {}) as EvidenceInput & { canonical_prompt_id?: unknown };
      if (typeof a.quote !== 'string' || a.quote.trim() === '') throw new Error('evidence rejected: quote is required (the verbatim passage behind the claim)');
      const hasPage = typeof a.research_source_id === 'string';
      const hasCanonical = typeof a.canonical_prompt_id === 'string';
      if (hasPage === hasCanonical) throw new Error('evidence rejected: exactly one of research_source_id or canonical_prompt_id');
      let researchSourceId = a.research_source_id as string | undefined;
      if (hasCanonical) {
        const [cp] = await asRole(deps.sql, RESEARCH_ROLE, (tx) => tx<{ source_id: string | null }[]>`
          select source_id from canonical_prompts where id = ${a.canonical_prompt_id as string}`);
        if (!cp) throw new Error(`evidence rejected: no canonical row ${String(a.canonical_prompt_id)}`);
        if (!cp.source_id) throw new Error(`evidence rejected: canonical row ${String(a.canonical_prompt_id)} has no source; not citable`);
        researchSourceId = (await citeIngestedSource(deps.sql, { researchRunId: ctx.researchRunId, sourceId: cp.source_id, excerpt: a.quote })).id;
      }
      const { canonical_prompt_id: _canonical, ...fields } = a;
      const id = await writeEvidence(
        deps.sql,
        { researchRunId: ctx.researchRunId, agentRunId: ctx.runId, specialist: ctx.agentName },
        { ...fields, research_source_id: researchSourceId },
      );
      ctx.log('info', `write_evidence → ${id}`);
      return { evidence_id: id, research_source_id: researchSourceId };
    },
  });
