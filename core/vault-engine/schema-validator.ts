import { DOMAINS } from '../contracts/taxonomy.ts';
import { VaultValidationError } from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { VAULT_SECTORS } from './path-guard.ts';
import {
  RECOGNIZED_OS3_SCHEMAS,
  STRICT_PROVENANCE_SCHEMAS,
  VALID_ENTITY_STATUSES,
  type Os3SchemaId,
} from './vault-schemas.ts';

export type ValidationIssue = {
  readonly code:
    | 'INVALID_YAML'
    | 'INVALID_SCHEMA'
    | 'MISSING_ENTITY_ID'
    | 'INVALID_METADATA'
    | 'INVALID_ARCHIVE_OR_SUPERSESSION'
    | 'BROKEN_REFERENCE'
    | 'SECRET_DETECTED';
  readonly message: string;
  readonly field?: string | undefined;
};

export type EntityValidationResult = {
  readonly ok: boolean;
  readonly vaultPath: string;
  readonly entityId: string | null;
  readonly schema: string | null;
  readonly sha256: string;
  readonly issues: readonly ValidationIssue[];
};

const RECOGNIZED_SCHEMA_SET = new Set<string>(RECOGNIZED_OS3_SCHEMAS);
const VALID_DOMAIN_SET = new Set<string>(DOMAINS);
const VALID_SECTOR_SET = new Set<string>([...VAULT_SECTORS, 'ROOT_KB']);
const STABLE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/i;
const VALID_DAW_PERMISSIONS = new Set<string>(['observe', 'analyze', 'propose', 'prepare', 'execute', 'approve', 'rollback']);
const VALID_SESSION_TIERS = new Set<string>(['liveObserved', 'cached', 'savedProject', 'proposedModifications', 'appliedModifications']);
const VALID_HOST_SUPPORT = new Set<string>(['SUPPORTED', 'TEMPLATE_SCOPED', 'READ_ONLY', 'UNSUPPORTED']);

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'OpenRouter API key (sk-or-v1-...)', re: /\bsk-or-v1-[a-f0-9]{32,}\b/i },
  { label: 'Anthropic API key (sk-ant-...)', re: /\bsk-ant-[a-z0-9_-]{20,}\b/i },
  { label: 'OpenAI API key (sk-proj-...)', re: /\bsk-proj-[a-z0-9_-]{20,}\b/i },
  { label: 'GitHub Token (ghp_/github_pat_...)', re: /\b(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/ },
  { label: 'Groq API key (gsk_...)', re: /\bgsk_[a-z0-9]{20,}\b/i },
  { label: 'Google API key (AIza...)', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: 'Credentialed URI (user:pass@...)', re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s]+:[^@\s]+@/ },
  { label: 'PEM Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const SCHEMA_REQUIRED_FIELDS: Readonly<Record<Os3SchemaId, readonly string[]>> = {
  'xyp3rn.entity/v3': ['title', 'domain'],
  'xyp3rn.agent/v3': ['name', 'class', 'domain', 'model', 'capabilities', 'tools'],
  'xyp3rn.tool/v3': ['name', 'title', 'domain', 'capability', 'allowed_classes'],
  'xyp3rn.skill/v3': ['name', 'domain', 'capability'],
  'xyp3rn.workflow/v3': ['name', 'domain', 'steps'],
  'xyp3rn.knowledge/v3': ['title', 'domain', 'status'],
  'xyp3rn.canonical-prompt/v3': ['title', 'domain', 'prompt_text', 'model_scope', 'promoted_via'],
  'xyp3rn.prompt-variant/v3': ['title', 'domain', 'parent_prompt_id', 'variant_label', 'model_scope', 'prompt_text'],
  'xyp3rn.source/v3': ['title', 'domain', 'origin'],
  'xyp3rn.research-project/v3': ['slug', 'title', 'domain'],
  'xyp3rn.research-question/v3': ['project_slug', 'title', 'domain'],
  'xyp3rn.evidence/v3': ['title', 'source_ref', 'verbatim_quote', 'confidence'],
  'xyp3rn.finding/v3': ['title', 'confidence', 'evidence_ids'],
  'xyp3rn.contradiction/v3': ['title', 'claim_topic'],
  'xyp3rn.experiment/v3': ['title', 'trial_count'],
  'xyp3rn.decision-record/v3': ['decision_key', 'title', 'decided_by'],
  'xyp3rn.song/v3': ['title', 'artist', 'language'],
  'xyp3rn.lyric/v3': ['lineage_id', 'title', 'language'],
  'xyp3rn.track/v3': ['title', 'position'],
  'xyp3rn.release/v3': ['title', 'artist', 'kind'],
  'xyp3rn.rights-split/v3': ['title', 'total_percentage', 'has_unassigned_share', 'shares'],
  'xyp3rn.production-session/v3': ['title', 'daw_host', 'daw_edition', 'project_path', 'state_tier'],
  'xyp3rn.daw-capability/v3': ['title', 'capability_id', 'permission_tier', 'host_support'],
  'xyp3rn.daw-adapter/v3': ['title', 'adapter_id', 'host_name', 'transport_protocol', 'supported_capabilities'],
  'xyp3rn.daw-plugin/v3': ['title', 'plugin_format', 'vendor', 'category', 'edition_requirement'],
  'xyp3rn.daw-plugin-chain/v3': ['title', 'stage', 'plugins'],
  'xyp3rn.audio-analysis/v3': ['title', 'analysis_schema', 'source_sha256', 'integrated_lufs', 'true_peak_dbtp'],
  'xyp3rn.dsp-concept/v3': ['title', 'domain', 'category', 'acoustic_principle'],
  'xyp3rn.mix-reference/v3': ['title', 'stage', 'target_lufs_min', 'target_lufs_max', 'max_true_peak_dbtp'],
  'xyp3rn.production-workflow/v3': ['title', 'target_daw', 'stage', 'workflow_steps'],
  'xyp3rn.policy/v3': ['title', 'domain', 'enforcement'],
  'xyp3rn.approval/v3': ['title', 'item_type', 'item_id', 'proposer'],
};

const isNonEmptyString = (val: unknown): val is string =>
  typeof val === 'string' && val.trim().length > 0;

const isValidIsoTimestamp = (val: unknown): boolean =>
  typeof val === 'string' && !Number.isNaN(Date.parse(val));

export type ValidateEntityOptions = {
  readonly requireSchema?: boolean | undefined;
  readonly checkReferences?: boolean | undefined;
  readonly targetExists?: ((target: string) => boolean) | undefined;
};

/**
 * Validates a Markdown/YAML entity document for YAML syntax, secret leakage,
 * stable ID, complete OS3 metadata, document-specific schema invariants,
 * explicit archive/supersession fields, and optional reference integrity.
 */
export const validateEntityContent = (
  vaultPath: string,
  rawContent: string,
  options: ValidateEntityOptions = {},
): EntityValidationResult => {
  const issues: ValidationIssue[] = [];

  if (rawContent.includes('\0')) {
    issues.push({
      code: 'INVALID_YAML',
      message: `Corrupted document "${vaultPath}": binary NUL bytes detected in text note`,
    });
    return {
      ok: false,
      vaultPath,
      entityId: null,
      schema: null,
      sha256: parseFrontmatterDocument(rawContent, { strict: false, vaultPath }).sha256,
      issues,
    };
  }

  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(rawContent)) {
      issues.push({
        code: 'SECRET_DETECTED',
        message: `Forbidden secret detected in "${vaultPath}": ${pat.label}`,
      });
    }
  }

  const parsed = parseFrontmatterDocument(rawContent, { strict: false, vaultPath });
  if (parsed.frontmatterError) {
    issues.push({
      code: 'INVALID_YAML',
      message: `Invalid YAML frontmatter in "${vaultPath}": ${parsed.frontmatterError}`,
    });
    return {
      ok: false,
      vaultPath,
      entityId: null,
      schema: null,
      sha256: parsed.sha256,
      issues,
    };
  }

  const fm = parsed.rawFrontmatter;
  const rawId = fm.id;
  const entityId =
    typeof rawId === 'string' && rawId.trim().length > 0
      ? rawId.trim()
      : typeof rawId === 'number'
        ? String(rawId)
        : null;

  const rawSchema = typeof fm.schema === 'string' && fm.schema.trim().length > 0 ? fm.schema.trim() : null;
  const requireSchema = options.requireSchema ?? rawSchema !== null;

  if (requireSchema) {
    if (!entityId) {
      issues.push({
        code: 'MISSING_ENTITY_ID',
        message: `Missing required stable entity "id" in frontmatter of "${vaultPath}"`,
        field: 'id',
      });
    } else if (!STABLE_ID_RE.test(entityId)) {
      issues.push({
        code: 'INVALID_METADATA',
        message: `Entity id "${entityId}" in "${vaultPath}" must be stable kebab/dot/underscore format (>=3 chars, no spaces)`,
        field: 'id',
      });
    }

    if (!rawSchema || !RECOGNIZED_SCHEMA_SET.has(rawSchema)) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: `Unrecognized or missing schema "${rawSchema ?? '(none)'}" in "${vaultPath}"`,
        field: 'schema',
      });
    } else {
      const schemaId = rawSchema as Os3SchemaId;
      const requiredFields = SCHEMA_REQUIRED_FIELDS[schemaId] ?? [];
      for (const reqField of requiredFields) {
        const val = fm[reqField];
        if (val === undefined || val === null || (typeof val === 'string' && val.trim().length === 0)) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "${schemaId}" requires non-empty frontmatter field "${reqField}" in "${vaultPath}"`,
            field: reqField,
          });
        }
      }

      // Common OS3 metadata checks
      if (fm.domain !== undefined && (!isNonEmptyString(fm.domain) || !VALID_DOMAIN_SET.has(fm.domain.trim()))) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `Invalid domain "${String(fm.domain)}" in "${vaultPath}"`,
          field: 'domain',
        });
      }
      if (fm.sector !== undefined && (!isNonEmptyString(fm.sector) || !VALID_SECTOR_SET.has(fm.sector.trim()))) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `Invalid sector "${String(fm.sector)}" in "${vaultPath}"`,
          field: 'sector',
        });
      }
      if (fm.status !== undefined && (!isNonEmptyString(fm.status) || !VALID_ENTITY_STATUSES.has(fm.status.trim()))) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `Invalid status "${String(fm.status)}" in "${vaultPath}"`,
          field: 'status',
        });
      }
      if (fm.version !== undefined) {
        const ver = Number(fm.version);
        if (!Number.isInteger(ver) || ver < 1) {
          issues.push({
            code: 'INVALID_METADATA',
            message: `Entity version must be an integer >= 1 in "${vaultPath}" (got ${String(fm.version)})`,
            field: 'version',
          });
        }
      }
      if (fm.created_at !== undefined && !isValidIsoTimestamp(fm.created_at)) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `Invalid created_at ISO timestamp in "${vaultPath}"`,
          field: 'created_at',
        });
      }
      if (fm.updated_at !== undefined && !isValidIsoTimestamp(fm.updated_at)) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `Invalid updated_at ISO timestamp in "${vaultPath}"`,
          field: 'updated_at',
        });
      }
      if (fm.tags !== undefined && (!Array.isArray(fm.tags) || fm.tags.some((t) => typeof t !== 'string'))) {
        issues.push({
          code: 'INVALID_METADATA',
          message: `tags must be an array of strings in "${vaultPath}"`,
          field: 'tags',
        });
      }

      // Enforce explicit provenance + timestamps on new Phase 03 document schemas
      if (STRICT_PROVENANCE_SCHEMAS.has(schemaId)) {
        const prov = fm.provenance;
        const hasValidProv =
          isNonEmptyString(prov) ||
          (typeof prov === 'object' && prov !== null && !Array.isArray(prov) && Object.keys(prov).length > 0);
        if (!hasValidProv) {
          issues.push({
            code: 'INVALID_METADATA',
            message: `Schema "${schemaId}" requires non-empty provenance metadata in "${vaultPath}"`,
            field: 'provenance',
          });
        }
        if (!isValidIsoTimestamp(fm.created_at) || !isValidIsoTimestamp(fm.updated_at)) {
          issues.push({
            code: 'INVALID_METADATA',
            message: `Schema "${schemaId}" requires valid created_at and updated_at ISO timestamps in "${vaultPath}"`,
            field: 'created_at',
          });
        }
      }

      // Explicit supersession & archive metadata enforcement
      const statusStr = typeof fm.status === 'string' ? fm.status.trim() : '';
      if (statusStr === 'superseded') {
        if (!isNonEmptyString(fm.superseded_by) || !isValidIsoTimestamp(fm.superseded_at)) {
          issues.push({
            code: 'INVALID_ARCHIVE_OR_SUPERSESSION',
            message: `Superseded document "${vaultPath}" must specify non-empty "superseded_by" and valid ISO "superseded_at"`,
            field: 'superseded_by',
          });
        }
      }
      if (statusStr === 'archived' && entityId !== 'arch-0001-archive-index') {
        if (!isNonEmptyString(fm.archive_reason) || !isValidIsoTimestamp(fm.archived_at)) {
          issues.push({
            code: 'INVALID_ARCHIVE_OR_SUPERSESSION',
            message: `Archived document "${vaultPath}" must specify "archive_reason" and valid ISO "archived_at"`,
            field: 'archive_reason',
          });
        }
      }

      // Document-specific invariants
      if (schemaId === 'xyp3rn.rights-split/v3') {
        const total = Number(fm.total_percentage);
        if (!Number.isFinite(total) || Math.abs(total - 100) > 0.001) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.rights-split/v3" requires total_percentage === 100 (got ${String(fm.total_percentage)})`,
            field: 'total_percentage',
          });
        }
        if (
          typeof fm.has_unassigned_share !== 'boolean' ||
          (fm.status !== 'draft' && fm.has_unassigned_share !== false)
        ) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message:
              'Schema "xyp3rn.rights-split/v3" requires boolean has_unassigned_share (and false when non-draft)',
            field: 'has_unassigned_share',
          });
        }
      }

      if (schemaId === 'xyp3rn.evidence/v3' || schemaId === 'xyp3rn.finding/v3') {
        const conf = Number(fm.confidence);
        if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "${schemaId}" requires confidence in [0, 1] (got ${String(fm.confidence)})`,
            field: 'confidence',
          });
        }
      }

      if (schemaId === 'xyp3rn.production-session/v3') {
        if (!isNonEmptyString(fm.state_tier) || !VALID_SESSION_TIERS.has(fm.state_tier.trim())) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.production-session/v3" requires state_tier in liveObserved|cached|savedProject|proposedModifications|appliedModifications (got ${String(fm.state_tier)})`,
            field: 'state_tier',
          });
        }
      }

      if (schemaId === 'xyp3rn.daw-capability/v3') {
        if (!isNonEmptyString(fm.permission_tier) || !VALID_DAW_PERMISSIONS.has(fm.permission_tier.trim())) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Invalid DAW permission_tier "${String(fm.permission_tier)}" in "${vaultPath}"`,
            field: 'permission_tier',
          });
        }
        if (fm.host_support && typeof fm.host_support === 'object' && !Array.isArray(fm.host_support)) {
          for (const [host, sup] of Object.entries(fm.host_support as Record<string, unknown>)) {
            if (!isNonEmptyString(sup) || !VALID_HOST_SUPPORT.has(sup.trim())) {
              issues.push({
                code: 'INVALID_SCHEMA',
                message: `Invalid host_support "${String(sup)}" for host "${host}" in "${vaultPath}"`,
                field: 'host_support',
              });
            }
          }
        }
      }

      if (schemaId === 'xyp3rn.daw-plugin-chain/v3') {
        if (!Array.isArray(fm.plugins) || fm.plugins.length === 0) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.daw-plugin-chain/v3" requires a non-empty plugins array in "${vaultPath}"`,
            field: 'plugins',
          });
        }
      }

      if (schemaId === 'xyp3rn.mix-reference/v3') {
        if (!isNonEmptyString(fm.stage) || !['mix', 'master'].includes(fm.stage.trim())) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.mix-reference/v3" stage must be "mix" or "master" in "${vaultPath}"`,
            field: 'stage',
          });
        }
        const minLufs = Number(fm.target_lufs_min);
        const maxLufs = Number(fm.target_lufs_max);
        const peak = Number(fm.max_true_peak_dbtp);
        if (!Number.isFinite(minLufs) || !Number.isFinite(maxLufs) || minLufs > maxLufs) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.mix-reference/v3" requires finite target_lufs_min <= target_lufs_max in "${vaultPath}"`,
            field: 'target_lufs_min',
          });
        }
        if (!Number.isFinite(peak) || peak > 0) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.mix-reference/v3" requires max_true_peak_dbtp <= 0 dBTP in "${vaultPath}"`,
            field: 'max_true_peak_dbtp',
          });
        }
      }

      if (schemaId === 'xyp3rn.audio-analysis/v3') {
        const lufs = Number(fm.integrated_lufs);
        const peak = Number(fm.true_peak_dbtp);
        if (!Number.isFinite(lufs) || lufs > 3 || lufs < -120) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.audio-analysis/v3" integrated_lufs out of physical range in "${vaultPath}"`,
            field: 'integrated_lufs',
          });
        }
        if (!Number.isFinite(peak) || peak > 24 || peak < -120) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.audio-analysis/v3" true_peak_dbtp out of range in "${vaultPath}"`,
            field: 'true_peak_dbtp',
          });
        }
      }

      if (schemaId === 'xyp3rn.production-workflow/v3') {
        if (!Array.isArray(fm.workflow_steps) || fm.workflow_steps.length === 0) {
          issues.push({
            code: 'INVALID_SCHEMA',
            message: `Schema "xyp3rn.production-workflow/v3" requires non-empty workflow_steps array in "${vaultPath}"`,
            field: 'workflow_steps',
          });
        }
      }
    }
  }

  if (options.checkReferences && options.targetExists) {
    for (const link of parsed.wikilinks) {
      if (!options.targetExists(link.target)) {
        issues.push({
          code: 'BROKEN_REFERENCE',
          message: `Broken wikilink reference "[[${link.target}]]" in "${vaultPath}"`,
          field: 'wikilinks',
        });
      }
    }
    if (typeof fm.source_ref === 'string' && fm.source_ref.trim().length > 0) {
      if (!options.targetExists(fm.source_ref.trim())) {
        issues.push({
          code: 'BROKEN_REFERENCE',
          message: `Broken source_ref "${fm.source_ref}" in "${vaultPath}"`,
          field: 'source_ref',
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    vaultPath,
    entityId,
    schema: rawSchema,
    sha256: parsed.sha256,
    issues,
  };
};

/**
 * Validates an entity and throws a typed `VaultValidationError` on the first failing issue.
 */
export const assertValidEntityContent = (
  vaultPath: string,
  rawContent: string,
  options: ValidateEntityOptions = {},
): EntityValidationResult => {
  const res = validateEntityContent(vaultPath, rawContent, options);
  const first = res.issues[0];
  if (first) {
    throw new VaultValidationError(first.code, first.message, {
      vaultPath,
      details: { issues: res.issues, field: first.field },
    });
  }
  return res;
};
