import type postgres from 'postgres';
import { SUNO_PACKAGE_SCHEMA_ID } from '../creative/schemas.ts';

/**
 * The Suno prompt package as the owner takes it to Suno by hand (AOS-03, S3): the four Suno fields,
 * every version they came from with its approval status, the workflow run that built it, and whether
 * it may be handed off (S4). Read-only; the UI and `pnpm studio export` read it as xyp_web.
 */
export const SUNO_PACKAGE_EXPORT_FORMAT = 'xyp-suno-package/v1';

export type SunoPackageExport = {
  readonly format: typeof SUNO_PACKAGE_EXPORT_FORMAT;
  readonly package: { readonly id: string; readonly version: number; readonly createdAt: string };
  readonly sunoModel: string;
  readonly title: string;
  readonly style: string;
  readonly excludeStyles: readonly string[];
  readonly lyrics: string;
  /** The canonical length limits applied when it was built (F20), each with its claim ref. */
  readonly limits: readonly { readonly field: string; readonly max: number; readonly actual: number; readonly ref: string }[];
  readonly sources: readonly { readonly role: string; readonly artifactId: string; readonly schemaId: string; readonly version: number; readonly status: string }[];
  readonly workflow: { readonly runId: string; readonly name: string; readonly sha256: string; readonly status: string } | null;
  readonly ready: boolean;
  /** Why it can't be handed off yet (xyp_suno_package_ready); empty when ready. */
  readonly blockers: readonly string[];
};

type Body = { sunoModel: string; title: string; style: string; excludeStyles: string[]; lyrics: string; limits: SunoPackageExport['limits']; sources: { role: string; artifactId: string; schemaId: string; version: number }[] };

/**
 * @param tx - a transaction whose role reads creative_artifacts, artifact_approvals, agent_runs and
 *   workflow_runs and may execute xyp_suno_package_ready (xyp_web)
 * @param packageId - a x3lius.suno-package/v1 artifact id
 * @returns the package export
 * @throws when there is no such artifact, or it is not a package
 */
export const readPackageExport = async (tx: postgres.TransactionSql, packageId: string): Promise<SunoPackageExport> => {
  const [a] = await tx<{ id: string; version: number; schema_id: string; body: Body; created_at: Date; agent_run_id: string }[]>`
    select id, version, schema_id, body, created_at, agent_run_id from creative_artifacts where id = ${packageId}`;
  if (!a) throw new Error(`no package ${packageId}`);
  if (a.schema_id !== SUNO_PACKAGE_SCHEMA_ID) throw new Error(`${packageId} is a ${a.schema_id}, not a ${SUNO_PACKAGE_SCHEMA_ID}`);
  const ids = a.body.sources.map((s) => s.artifactId);
  const statuses = new Map((await tx<{ id: string; status: string }[]>`select id, status from artifact_approvals where id = any(${ids}::uuid[])`).map((r) => [r.id, r.status]));
  const [w] = await tx<{ id: string; workflow_name: string; spec_sha256: string; status: string }[]>`
    select w.id, w.workflow_name, w.spec_sha256, w.status::text as status
    from agent_runs r join workflow_runs w on w.id = r.workflow_run_id where r.id = ${a.agent_run_id}`;
  const [ready] = await tx<{ reasons: string[] }[]>`select xyp_suno_package_ready(${packageId}) as reasons`;
  const b = a.body;
  return {
    format: SUNO_PACKAGE_EXPORT_FORMAT,
    package: { id: a.id, version: a.version, createdAt: a.created_at.toISOString() },
    sunoModel: b.sunoModel, title: b.title, style: b.style, excludeStyles: b.excludeStyles, lyrics: b.lyrics, limits: b.limits,
    sources: b.sources.map((s) => ({ role: s.role, artifactId: s.artifactId, schemaId: s.schemaId, version: s.version, status: statuses.get(s.artifactId) ?? 'missing' })),
    workflow: w ? { runId: w.id, name: w.workflow_name, sha256: w.spec_sha256, status: w.status } : null,
    ready: ready!.reasons.length === 0,
    blockers: ready!.reasons,
  };
};

/**
 * The package as copy-paste blocks, one per field of Suno's custom-mode form, in the form's order.
 * @param e - the package export
 * @returns the text, ending with a newline
 */
export const packageText = (e: SunoPackageExport): string =>
  [['SONG TITLE', e.title], ['STYLE OF MUSIC', e.style], ['EXCLUDE STYLES', e.excludeStyles.join(', ')], ['LYRICS', e.lyrics]]
    .map(([label, value]) => `${label}\n${value}\n`).join('\n');
