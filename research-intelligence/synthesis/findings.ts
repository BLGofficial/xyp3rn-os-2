import type postgres from 'postgres';
import type { Domain } from '../../core/contracts/taxonomy.ts';
import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';

/**
 * Findings and candidates (Phase 6C synthesis primitives). An LLM synthesis agent will decide
 * *what* a finding says; these functions decide how it is recorded: confidence from its
 * evidence (formula below), one model/version per finding, and a structured claim that the
 * in-DB Contradiction Engine checks the moment the row lands.
 */

export const MODEL_AGNOSTIC = 'model-agnostic';

/**
 * Finding confidence, every input shown:
 *   support_i   = evidence_i.confidence × source_i.reliability
 *   corroborate = min(1, 0.5 + 0.25 × k), k = distinct sources   (k=1 → 0.75, k≥2 → 1)
 *   confidence  = mean(support_i) × corroborate
 * A single source can never produce more than 75% of its own support: one page is not proof.
 * @param evidence - evidence confidence, its source's reliability, and the source id
 * @returns confidence in [0,1] and its inputs
 */
export const computeFindingConfidence = (
  evidence: ReadonlyArray<{ readonly confidence: number; readonly reliability: number; readonly research_source_id: string }>,
) => {
  if (evidence.length === 0) throw new Error('a finding needs at least one evidence row');
  const support = evidence.map((e) => e.confidence * e.reliability);
  const k = new Set(evidence.map((e) => e.research_source_id)).size;
  const corroboration = Math.min(1, 0.5 + 0.25 * k);
  const mean = support.reduce((a, b) => a + b, 0) / support.length;
  return {
    confidence: Math.min(1, mean * corroboration),
    inputs: { formula: 'mean(confidence × reliability) × min(1, 0.5 + 0.25k)', support, mean_support: mean, independent_sources: k, corroboration_factor: corroboration },
  };
};

export type FindingInput = {
  readonly researchRunId: string;
  readonly agentRunId?: string;
  readonly claim: string;
  readonly claim_topic: string;
  readonly claim_value: unknown;
  readonly model_tag: string;
  readonly evidenceIds: readonly string[];
};

export type ContradictionRow = { readonly id: string; readonly target_type: string; readonly target_id: string; readonly detail: Record<string, unknown> };

/**
 * Records a finding from its evidence. The contradiction trigger runs on insert; the result
 * reports what it found and how many live canonical rows it could not check (no claims).
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param input - claim + structured claim + model tag + supporting evidence ids
 * @returns finding id, confidence (with inputs), contradictions raised, coverage report
 * @throws Error if evidence is missing or tagged for a different model version
 */
export const recordFinding = async (sql: Sql, input: FindingInput) =>
  asRole(sql, RESEARCH_ROLE, async (tx) => {
    const ev = await tx<{ id: string; confidence: string; model_tag: string; reliability: string | null; research_source_id: string }[]>`
      select e.id, e.confidence, e.model_tag, s.reliability, e.research_source_id
      from research_evidence e join research_sources s on s.id = e.research_source_id
      where e.id = any(${[...input.evidenceIds]}::uuid[])`;
    const missing = input.evidenceIds.filter((id) => !ev.some((e) => e.id === id));
    if (missing.length > 0) throw new Error(`finding rejected: unknown evidence ${missing.join(', ')}`);
    for (const e of ev) {
      if (e.model_tag !== input.model_tag && e.model_tag !== MODEL_AGNOSTIC) {
        throw new Error(`finding rejected: evidence ${e.id} is tagged ${e.model_tag}, finding is ${input.model_tag}`);
      }
    }
    // Unscored sources count as the rubric's floor (0.3), never as fully reliable.
    const { confidence, inputs } = computeFindingConfidence(
      ev.map((e) => ({ confidence: Number(e.confidence), reliability: e.reliability === null ? 0.3 : Number(e.reliability), research_source_id: e.research_source_id })),
    );
    const [f] = await tx<{ id: string }[]>`
      insert into research_findings (research_run_id, agent_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
      values (${input.researchRunId}, ${input.agentRunId ?? null}, ${input.claim}, ${input.model_tag},
              ${Math.round(confidence * 1000) / 1000}, ${tx.json(inputs as postgres.JSONValue)},
              ${input.claim_topic}, ${tx.json(input.claim_value as postgres.JSONValue)})
      returning id`;
    for (const e of ev) await tx`insert into research_finding_evidence (finding_id, evidence_id) values (${f!.id}, ${e.id})`;
    const contradictions = await tx<ContradictionRow[]>`
      select id, target_type::text, target_id, detail from contradictions where finding_id = ${f!.id} order by created_at, id`;
    const [cov] = await tx<{ with_claims: number; without: number }[]>`
      select count(*) filter (where structured ? 'claims')::int as with_claims,
             count(*) filter (where not coalesce(structured ? 'claims', false))::int as without
      from canonical_prompts cp
      where cp.version = (select max(x.version) from canonical_prompts x where x.slug = cp.slug)`;
    return {
      findingId: f!.id,
      confidence,
      confidenceInputs: inputs,
      contradictions,
      coverage: { canonicalRowsWithClaims: cov!.with_claims, canonicalRowsUncheckable: cov!.without },
    };
  });

export type CandidateInput = {
  readonly findingId: string;
  readonly proposed_kind: 'canonical_prompt' | 'module';
  readonly target_slug: string;
  readonly title: string;
  readonly body: string;
  readonly domain: Domain;
  readonly structured?: Record<string, unknown>;
  readonly tags?: readonly string[];
};

/**
 * Proposes a knowledge candidate from a finding. The claim and model tag are inherited from the
 * finding — a candidate can't quietly restate or re-scope what the evidence supports.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param input - what the canonical entry would look like
 * @returns candidate id (status 'proposed'; only the 6D gate moves it)
 */
export const proposeCandidate = async (sql: Sql, input: CandidateInput): Promise<string> =>
  asRole(sql, RESEARCH_ROLE, async (tx) => {
    const [f] = await tx<{ claim_topic: string; claim_value: unknown; model_tag: string }[]>`
      select claim_topic, claim_value, model_tag from research_findings where id = ${input.findingId}`;
    if (!f) throw new Error(`candidate rejected: unknown finding ${input.findingId}`);
    const [c] = await tx<{ id: string }[]>`
      insert into knowledge_candidates (finding_id, proposed_kind, target_slug, title, body, structured, model_tag, domain, tags, claim_topic, claim_value)
      values (${input.findingId}, ${input.proposed_kind}, ${input.target_slug}, ${input.title}, ${input.body},
              ${input.structured ? tx.json(input.structured as postgres.JSONValue) : null}, ${f.model_tag}, ${input.domain},
              ${[...(input.tags ?? [])]}, ${f.claim_topic}, ${tx.json(f.claim_value as postgres.JSONValue)})
      returning id`;
    return c!.id;
  });
