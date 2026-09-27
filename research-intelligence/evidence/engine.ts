import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';

/**
 * Evidence Engine (Phase 6C). The only write path for research_evidence. Enforces the schema
 * before the database does: source, model/version tag, confidence (with its inputs) and claim
 * text are all required; a structured claim, if given, needs both topic and value.
 */

export type EvidenceInput = {
  readonly research_source_id?: unknown;
  readonly claim?: unknown;
  readonly model_tag?: unknown;
  readonly confidence?: unknown;
  readonly confidence_inputs?: unknown;
  readonly claim_topic?: unknown;
  readonly claim_value?: unknown;
  /** The verbatim passage behind the claim (AOS-04); the DB checks it against the source. */
  readonly quote?: unknown;
};

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Validates an evidence write. Pure; returns every problem at once.
 * @param input - candidate evidence fields
 * @returns error messages, empty when valid
 */
export const validateEvidence = (input: EvidenceInput): string[] => {
  const errors: string[] = [];
  if (!nonEmpty(input.research_source_id)) errors.push('research_source_id is required');
  if (!nonEmpty(input.claim)) errors.push('claim is required');
  if (!nonEmpty(input.model_tag)) errors.push('model_tag is required');
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) errors.push('confidence must be a number in [0, 1]');
  const ci = input.confidence_inputs;
  if (ci === null || typeof ci !== 'object' || Array.isArray(ci) || Object.keys(ci).length === 0) {
    errors.push('confidence_inputs must be a non-empty object showing how confidence was derived');
  }
  if ((input.claim_topic === undefined) !== (input.claim_value === undefined)) errors.push('claim_topic and claim_value must be given together');
  if (input.quote !== undefined && input.quote !== null && !nonEmpty(input.quote)) errors.push('quote must be a non-empty string when given');
  return errors;
};

export type EvidenceContext = { readonly researchRunId: string; readonly agentRunId: string | null; readonly specialist: string };

/**
 * Writes one evidence row as xyp_research.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param ctx - research run, agent run and specialist responsible
 * @param input - evidence fields (validated first)
 * @returns the new evidence id
 * @throws Error "evidence rejected: …" listing every missing/invalid field
 */
export const writeEvidence = async (sql: Sql, ctx: EvidenceContext, input: EvidenceInput): Promise<string> => {
  const errors = validateEvidence(input);
  if (errors.length > 0) throw new Error(`evidence rejected: ${errors.join('; ')}`);
  return asRole(sql, RESEARCH_ROLE, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into research_evidence
        (research_run_id, research_source_id, agent_run_id, specialist, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value, quote)
      values (${ctx.researchRunId}, ${input.research_source_id as string}, ${ctx.agentRunId}, ${ctx.specialist},
              ${input.claim as string}, ${input.model_tag as string}, ${input.confidence as number},
              ${tx.json(input.confidence_inputs as postgres.JSONValue)},
              ${(input.claim_topic as string | undefined) ?? null},
              ${input.claim_value === undefined ? null : tx.json(input.claim_value as postgres.JSONValue)},
              ${(input.quote as string | null | undefined) ?? null})
      returning id`;
    return row!.id;
  });
};
