import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE, VERIFIER_ROLE } from '../db.ts';

/**
 * Contradiction Engine, service side (Phase 6C). Detection lives in the database
 * (xyp_detect_contradictions, fired on every finding and candidate insert) so no code path can
 * skip it. This module reads eligibility and records resolutions.
 */

/**
 * Whether a candidate may reach the Promotion Gate.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param candidateId - knowledge_candidates.id
 * @returns blocked flag, open contradiction count, and the open rows
 */
export const candidateEligibility = async (sql: Sql, candidateId: string) =>
  asRole(sql, RESEARCH_ROLE, async (tx) => {
    const [e] = await tx<{ finding_id: string; open_contradictions: number }[]>`
      select finding_id, open_contradictions from knowledge_candidate_eligibility where candidate_id = ${candidateId}`;
    if (!e) throw new Error(`unknown candidate ${candidateId}`);
    const open = await tx<{ id: string; target_type: string; target_id: string; detail: Record<string, unknown> }[]>`
      select id, target_type::text, target_id, detail from contradictions
      where status = 'open' and (finding_id = ${e.finding_id} or (target_type = 'knowledge_candidate' and target_id = ${candidateId}))
      order by created_at, id`;
    return { blocked: e.open_contradictions > 0, openContradictions: e.open_contradictions, open };
  });

/**
 * Resolves a contradiction, manually (with a reason) or by a tie-breaking experiment.
 * @param sql - pool allowed to SET ROLE xyp_verifier
 * @param contradictionId - contradictions.id
 * @param resolution - method, reason, and the experiment for method 'experiment'
 * @throws Error if already resolved or an experiment resolution names no experiment
 */
export const resolveContradiction = async (
  sql: Sql,
  contradictionId: string,
  resolution: { readonly method: 'manual' | 'experiment'; readonly reason: string; readonly experimentId?: string },
): Promise<void> => {
  if (resolution.reason.trim() === '') throw new Error('a resolution needs a reason');
  if (resolution.method === 'experiment' && !resolution.experimentId) throw new Error('an experiment resolution must name the experiment');
  await asRole(sql, VERIFIER_ROLE, async (tx) => {
    const updated = await tx`
      update contradictions
      set status = ${resolution.method === 'manual' ? 'resolved_manual' : 'resolved_experiment'},
          resolution = ${tx.json(resolution as unknown as postgres.JSONValue)}, resolved_at = now()
      where id = ${contradictionId} and status = 'open'`;
    if (updated.count !== 1) throw new Error(`contradiction ${contradictionId} is not open`);
  });
};
