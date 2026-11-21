import type { SqliteRuntimeDb } from '../core/sqlite/client.ts';
import { parseFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import { validateEntityContent, type EntityValidationResult, type ValidationIssue } from '../core/vault-engine/schema-validator.ts';
import { EVIDENCE_ATTRIBUTION_TIERS, type VerificationStatus } from './os3-research-types.ts';

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const VERIFICATION_STATUSES = new Set<VerificationStatus>([
  'verified',
  'corroborated',
  'single_source_capped',
  'contradiction_blocked',
  'unverified',
  'incomplete',
  'rejected',
]);
const ATTRIBUTION_TIERS = new Set<string>(EVIDENCE_ATTRIBUTION_TIERS);

export type ResearchDocumentValidationResult = EntityValidationResult & {
  readonly conceptType: string | null;
  readonly hasProvenance: boolean;
  readonly hasRelationships: boolean;
  readonly verificationStatus: string | null;
};

/**
 * Validates any OS 3.0 Research Intelligence document on top of `validateEntityContent()`,
 * enforcing Phase 19 canonical requirements:
 * - Stable entity ID & recognized v3 schema (`xyp3rn.* /v3`)
 * - Explicit provenance & ISO timestamps
 * - Verifiable `source_ref` / `evidence_ids` / `question_ref` / `project_ref` relationships
 * - Epistemic separation between verbatim source quotes, interpretations & uncertainty notes
 * - Validated confidence bounds [0..1] and verification status
 * - For DAW Brain docs/plugins: never claims `host_installed_verified` from doc ingestion alone.
 */
export const validateResearchVaultDocument = (
  vaultPath: string,
  rawContent: string,
  options: {
    readonly targetExists?: ((target: string) => boolean) | undefined;
    readonly strictProvenance?: boolean | undefined;
  } = {},
): ResearchDocumentValidationResult => {
  const base = validateEntityContent(vaultPath, rawContent, {
    requireSchema: true,
    checkReferences: Boolean(options.targetExists),
    targetExists: options.targetExists,
  });

  const issues: ValidationIssue[] = [...base.issues];
  const parsed = parseFrontmatterDocument(rawContent, { strict: false, vaultPath });
  const fm = parsed.rawFrontmatter;
  const conceptType = typeof fm.type === 'string' ? fm.type.trim() : null;
  const schema = base.schema ?? '';

  const prov = fm.provenance;
  const hasProvenance =
    (typeof prov === 'string' && prov.trim().length > 0) ||
    (typeof prov === 'object' && prov !== null && !Array.isArray(prov) && Object.keys(prov).length > 0);

  if (options.strictProvenance !== false && !hasProvenance) {
    issues.push({
      code: 'INVALID_METADATA',
      message: `Research document "${vaultPath}" requires non-empty provenance metadata`,
      field: 'provenance',
    });
  }

  for (const tsField of ['created_at', 'updated_at'] as const) {
    const val = fm[tsField];
    if (options.strictProvenance !== false && (typeof val !== 'string' || !ISO_TS_RE.test(val) || Number.isNaN(Date.parse(val)))) {
      issues.push({
        code: 'INVALID_METADATA',
        message: `Research document "${vaultPath}" requires valid ISO timestamp "${tsField}"`,
        field: tsField,
      });
    }
  }

  const verificationStatus =
    typeof fm.verification_status === 'string' && fm.verification_status.trim().length > 0
      ? fm.verification_status.trim()
      : null;

  if (verificationStatus !== null && !VERIFICATION_STATUSES.has(verificationStatus as VerificationStatus)) {
    issues.push({
      code: 'INVALID_METADATA',
      message: `Invalid verification_status "${verificationStatus}" in "${vaultPath}"`,
      field: 'verification_status',
    });
  }

  let hasRelationships = false;

  if (schema === 'xyp3rn.source/v3') {
    hasRelationships = typeof fm.uri === 'string' && fm.uri.trim().length > 0;
    const rel = Number(fm.reliability);
    if (fm.reliability !== undefined && (!Number.isFinite(rel) || rel < 0 || rel > 1)) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: `Source "${vaultPath}" reliability must be in [0, 1]`,
        field: 'reliability',
      });
    }
    if (typeof fm.evidence_tier === 'string' && !ATTRIBUTION_TIERS.has(fm.evidence_tier)) {
      issues.push({
        code: 'INVALID_METADATA',
        message: `Invalid evidence_tier "${fm.evidence_tier}" in "${vaultPath}"`,
        field: 'evidence_tier',
      });
    }
  } else if (schema === 'xyp3rn.research-project/v3') {
    hasRelationships = typeof fm.slug === 'string' && fm.slug.trim().length > 0;
  } else if (schema === 'xyp3rn.research-question/v3') {
    hasRelationships = typeof fm.project_slug === 'string' && fm.project_slug.trim().length > 0;
  } else if (schema === 'xyp3rn.evidence/v3') {
    hasRelationships = typeof fm.source_ref === 'string' && fm.source_ref.trim().length > 0;
    const q = typeof fm.verbatim_quote === 'string' ? fm.verbatim_quote.trim() : '';
    const interp = typeof fm.interpretation === 'string' ? fm.interpretation.trim() : '';
    const unc = typeof fm.uncertainty_note === 'string' ? fm.uncertainty_note.trim() : '';
    if (!q || !interp || !unc) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: `Evidence "${vaultPath}" requires non-empty verbatim_quote, interpretation, and uncertainty_note`,
        field: 'verbatim_quote',
      });
    }
    if (fm.evidence_tier !== undefined && (!fm.evidence_tier || !ATTRIBUTION_TIERS.has(String(fm.evidence_tier)))) {
      issues.push({
        code: 'INVALID_METADATA',
        message: `Invalid evidence_tier in "${vaultPath}"`,
        field: 'evidence_tier',
      });
    }
    if (
      fm.daw_category !== undefined &&
      fm.host_installed_verified === true &&
      fm.evidence_tier === 'official_vendor_doc'
    ) {
      issues.push({
        code: 'INVALID_METADATA',
        message: `Plugin/DAW doc evidence in "${vaultPath}" must not claim host_installed_verified=true from vendor docs alone`,
        field: 'host_installed_verified',
      });
    }
  } else if (schema === 'xyp3rn.finding/v3') {
    const evIds = Array.isArray(fm.evidence_ids) ? fm.evidence_ids : [];
    hasRelationships = evIds.length > 0;
    if (evIds.length === 0) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: `Finding "${vaultPath}" must reference >= 1 evidence_ids`,
        field: 'evidence_ids',
      });
    }
  } else if (schema === 'xyp3rn.contradiction/v3') {
    hasRelationships =
      typeof fm.finding_id === 'string' &&
      fm.finding_id.trim().length > 0 &&
      typeof fm.target_path === 'string' &&
      fm.target_path.trim().length > 0;
  } else if (schema === 'xyp3rn.experiment/v3') {
    hasRelationships =
      typeof fm.finding_id === 'string' &&
      fm.finding_id.trim().length > 0 &&
      typeof fm.scorer === 'string' &&
      fm.scorer.trim().length > 0;
  } else if (schema === 'xyp3rn.entity/v3' && conceptType === 'research_run') {
    hasRelationships = typeof fm.question_id === 'string' && fm.question_id.trim().length > 0;
  } else if (schema === 'xyp3rn.entity/v3' && conceptType === 'research_brief') {
    hasRelationships =
      (Array.isArray(fm.finding_ids) && fm.finding_ids.length > 0) ||
      typeof fm.question_id === 'string' ||
      typeof fm.project_slug === 'string';
  } else if (schema === 'xyp3rn.entity/v3' && conceptType === 'experiment_run') {
    hasRelationships = typeof fm.experiment_id === 'string' && fm.experiment_id.trim().length > 0;
  }

  return {
    ok: issues.length === 0,
    vaultPath,
    entityId: base.entityId,
    schema: base.schema,
    sha256: base.sha256,
    issues,
    conceptType,
    hasProvenance,
    hasRelationships,
    verificationStatus,
  };
};

/**
 * Validates reference resolution across indexed OS3 Research entities in `SqliteRuntimeDb`.
 */
export const createVaultTargetChecker = (db: SqliteRuntimeDb): ((target: string) => boolean) => {
  const entries = db.listIndexEntries(undefined, 20_000);
  const pathSet = new Set<string>();
  const stemSet = new Set<string>();
  const idSet = new Set<string>();

  for (const e of entries) {
    pathSet.add(e.vaultPath);
    pathSet.add(e.vaultPath.replace(/\.md$/i, ''));
    const stem = e.vaultPath.split('/').pop()?.replace(/\.md$/i, '');
    if (stem) stemSet.add(stem);
    if (typeof e.frontmatter.id === 'string' && e.frontmatter.id.trim()) {
      idSet.add(e.frontmatter.id.trim());
    }
  }

  return (target: string): boolean => {
    const clean = target.trim().replace(/\.md$/i, '');
    return pathSet.has(target.trim()) || pathSet.has(clean) || stemSet.has(clean) || idSet.has(clean);
  };
};
