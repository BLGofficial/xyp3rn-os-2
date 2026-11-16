import { VaultValidationError } from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { RECOGNIZED_OS3_SCHEMAS, type Os3SchemaId } from './vault-foundation.ts';

export type ValidationIssue = {
  readonly code:
    | 'INVALID_YAML'
    | 'INVALID_SCHEMA'
    | 'MISSING_ENTITY_ID'
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

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'OpenRouter API key (sk-or-v1-...)', re: /\bsk-or-v1-[a-f0-9]{32,}\b/i },
  { label: 'Anthropic API key (sk-ant-...)', re: /\bsk-ant-[a-z0-9_-]{20,}\b/i },
  { label: 'Groq API key (gsk_...)', re: /\bgsk_[a-z0-9]{20,}\b/i },
  { label: 'Google API key (AIza...)', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: 'PEM Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const SCHEMA_REQUIRED_FIELDS: Readonly<Record<Os3SchemaId, readonly string[]>> = {
  'xyp3rn.entity/v3': ['title', 'domain'],
  'xyp3rn.agent/v3': ['name', 'class', 'domain', 'model', 'capabilities', 'tools'],
  'xyp3rn.workflow/v3': ['name', 'domain', 'steps'],
  'xyp3rn.skill/v3': ['name', 'domain', 'capability'],
  'xyp3rn.knowledge/v3': ['title', 'domain', 'status'],
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
  'xyp3rn.policy/v3': ['title', 'domain', 'enforcement'],
  'xyp3rn.approval/v3': ['title', 'item_type', 'item_id', 'proposer'],
};

export type ValidateEntityOptions = {
  readonly requireSchema?: boolean | undefined;
  readonly checkReferences?: boolean | undefined;
  readonly targetExists?: ((target: string) => boolean) | undefined;
};

/**
 * Validates a Markdown/YAML entity document for YAML syntax, secret leakage,
 * recognized `xyp3rn.<type>/v3` schema, required schema fields, stable `id`,
 * and optional reference integrity (`[[wikilinks]]` and `source_ref`).
 */
export const validateEntityContent = (
  vaultPath: string,
  rawContent: string,
  options: ValidateEntityOptions = {},
): EntityValidationResult => {
  const issues: ValidationIssue[] = [];

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
