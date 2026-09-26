import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';
import { recordFinding } from './findings.ts';

export type SynthesisResult = {
  readonly findings: readonly { readonly findingId: string; readonly claimTopic: string; readonly evidenceIds: readonly string[] }[];
  /** Evidence with no claim_topic: listed, not synthesized (a finding needs a structured claim). */
  readonly unsynthesized: readonly string[];
};

type Row = { id: string; claim: string; claim_topic: string | null; value: string | null; model_tag: string; confidence: string };

/**
 * Synthesis (AOS-04 §6), deterministic: a run's evidence not yet in any finding, grouped by (claim_topic,
 * claim_value as JSON, model_tag), becomes one finding per group through recordFinding (which computes the
 * confidence and runs the contradiction engine). The finding's claim is its most confident evidence's claim.
 * Two values for one topic are two findings: the workbench shows them side by side. Idempotent: evidence
 * already in a finding is skipped.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param researchRunId - the run
 * @returns the findings written and the untopical evidence ids
 */
export const synthesizeRun = async (sql: Sql, researchRunId: string): Promise<SynthesisResult> => {
  const rows = await asRole(sql, RESEARCH_ROLE, (tx) => tx<Row[]>`
    select e.id, e.claim, e.claim_topic, e.claim_value::text as value, e.model_tag, e.confidence
    from research_evidence e
    where e.research_run_id = ${researchRunId}
      and not exists (select from research_finding_evidence fe where fe.evidence_id = e.id)
    order by e.created_at, e.id`);
  const unsynthesized = rows.filter((r) => r.claim_topic === null).map((r) => r.id);
  // jsonb::text is canonical (key order, spacing), so equal values group together.
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.claim_topic !== null)) {
    const key = JSON.stringify([r.claim_topic, r.value, r.model_tag]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const findings: SynthesisResult['findings'][number][] = [];
  for (const g of groups.values()) {
    const best = [...g].sort((x, y) => Number(y.confidence) - Number(x.confidence) || x.id.localeCompare(y.id))[0]!;
    const evidenceIds = g.map((x) => x.id);
    const f = await recordFinding(sql, {
      researchRunId, claim: best.claim, claim_topic: best.claim_topic!, claim_value: JSON.parse(best.value!) as unknown,
      model_tag: best.model_tag, evidenceIds,
    });
    findings.push({ findingId: f.findingId, claimTopic: best.claim_topic!, evidenceIds });
  }
  return { findings, unsynthesized };
};
