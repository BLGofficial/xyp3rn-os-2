import type { Sql } from '../core/db/client.ts';
import { OPERATOR_ROLE } from '../knowledge/promotion-gate/gate.ts';
import { asRole } from '../knowledge/source-registry/vault-tools.ts';

/** A decision on one creative version and where the lineage's approved pointer now stands. */
export type ArtifactDecision = {
  readonly approvalId: string;
  readonly artifactId: string;
  readonly lineageId: string;
  readonly version: number;
  readonly status: 'approved' | 'rejected';
  /** The lineage's highest approved version after this decision; null when none is. */
  readonly approvedVersion: number | null;
};

/**
 * The owner's decision on a creative version (AOS-01 §4.4, F8, D2): recorded already decided in
 * approval_queue through xyp_decide_artifact (SECURITY DEFINER, EXECUTE held by service_role only).
 * One decision per version: a second one is refused (23505). Approving a version moves the
 * lineage's approved pointer only if it is newer; nothing else ever moves it.
 * @param sql - pool allowed to SET ROLE service_role
 * @param artifactId - creative_artifacts.id (any version)
 * @param d - approve or reject, who decided, and why (both required)
 * @returns the recorded decision and the approved version
 */
export const decideArtifact = (
  sql: Sql,
  artifactId: string,
  d: { readonly decision: 'approve' | 'reject'; readonly approver: string; readonly reason: string },
): Promise<ArtifactDecision> =>
  asRole(sql, OPERATOR_ROLE, async (tx) => {
    let q: { id: string } | undefined;
    try {
      [q] = await tx<{ id: string }[]>`select xyp_decide_artifact(${artifactId}, ${d.decision}, ${d.approver}, ${d.reason})::text as id`;
    } catch (e) {
      // The DB's refusal, said in the owner's terms; the SQLSTATE stays on the error.
      if ((e as { code?: string }).code === '23505') {
        throw Object.assign(new Error(`version ${artifactId} already has a decision: one per version (a change of mind is a new version)`), { code: '23505' });
      }
      throw e;
    }
    const [a] = await tx<{ lineage_id: string; version: number; status: 'approved' | 'rejected'; approved_version: number | null }[]>`
      select lineage_id, version, status, approved_version from artifact_approvals where id = ${artifactId}`;
    return { approvalId: q!.id, artifactId, lineageId: a!.lineage_id, version: a!.version, status: a!.status, approvedVersion: a!.approved_version };
  });
