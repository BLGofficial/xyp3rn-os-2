import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../core/vault-engine/frontmatter.ts';
import { sha256Hex } from '../../core/vault-engine/revision.ts';
import type { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { STUB_SCORER } from '../experiments/engine.ts';
import { modelScopesOverlap, type Os3ResearchEngine } from '../os3-research-engine.ts';
import type {
  ConflictingMigrationRecord,
  IncompleteMigrationRecord,
  LegacyMarkdownScanItem,
  MigratedRecordEntry,
  Os2ResearchExportPayload,
  RejectedMigrationRecord,
  ResearchMigrationReport,
  ResearchParityReport,
} from '../os3-research-types.ts';
import { createVaultTargetChecker, validateResearchVaultDocument } from '../os3-schemas.ts';
import { classifySource, normalizeUri, type ResearchSourceKind } from '../sources/verify.ts';
import { computeFindingConfidence, MODEL_AGNOSTIC } from '../synthesis/findings.ts';

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'OpenRouter API key', re: /\bsk-or-v1-[a-f0-9]{32,}\b/i },
  { label: 'Anthropic API key', re: /\bsk-ant-[a-z0-9_-]{20,}\b/i },
  { label: 'Groq API key', re: /\bgsk_[a-z0-9]{20,}\b/i },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: 'PEM Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const hasSecret = (raw: string): string | null => {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(raw)) return p.label;
  }
  return null;
};

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

const shortHash8 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type MigrateOs2ResearchOptions = {
  readonly payload: Os2ResearchExportPayload;
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly research: Os3ResearchEngine;
  readonly dryRun?: boolean | undefined;
  readonly legacyMarkdownRootDirs?: readonly string[] | undefined;
  readonly stageIncompleteLegacyMarkdown?: boolean | undefined;
  readonly actor?: string | undefined;
};

/**
 * Safely scans legacy Markdown research directories read-only (never deleting or modifying
 * original legacy files) and classifies every note as valid OS3, incomplete legacy, or rejected.
 */
export const scanLegacyResearchMarkdownDirs = async (
  dirs: readonly string[],
): Promise<{
  readonly items: readonly LegacyMarkdownScanItem[];
  readonly fileChecksumsBefore: Readonly<Record<string, string>>;
}> => {
  const items: LegacyMarkdownScanItem[] = [];
  const fileChecksumsBefore: Record<string, string> = {};

  const walk = async (rootDir: string, curDir: string): Promise<void> => {
    const entries = await fs.readdir(curDir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = join(curDir, ent.name);
      if (ent.isDirectory()) {
        await walk(rootDir, abs);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const raw = await fs.readFile(abs, 'utf8');
      const rel = relative(rootDir, abs).split(sep).join('/');
      const sha = sha256Hex(raw);
      fileChecksumsBefore[abs] = sha;

      const leaked = hasSecret(raw);
      const parsed = parseFrontmatterDocument(raw, { strict: false, vaultPath: rel });
      const fm = parsed.rawFrontmatter;
      const hasSchema = typeof fm.schema === 'string' && fm.schema.trim().length > 0;
      const hasStableId = typeof fm.id === 'string' && fm.id.trim().length >= 3;
      const hasProvenance =
        (typeof fm.provenance === 'string' && fm.provenance.trim().length > 0) ||
        (typeof fm.provenance === 'object' && fm.provenance !== null);

      const missingFields: string[] = [];
      if (!hasSchema) missingFields.push('schema');
      if (!hasStableId) missingFields.push('id');
      if (!hasProvenance) missingFields.push('provenance');
      if (typeof fm.created_at !== 'string') missingFields.push('created_at');

      const headingMatch = /^#\s+(.+)$/m.exec(parsed.body);
      const title =
        (typeof fm.title === 'string' && fm.title.trim()) ||
        (headingMatch?.[1]?.trim() ?? '') ||
        ent.name.replace(/\.md$/, '');
      const entityTypeHint = typeof fm.type === 'string' ? fm.type.trim() : null;

      let status: LegacyMarkdownScanItem['status'] = 'already_os3_valid';
      if (leaked || parsed.frontmatterError) {
        status = 'rejected_secret_or_invalid';
      } else if (!hasSchema || !hasStableId || !hasProvenance) {
        status = 'incomplete_legacy_markdown';
      }

      items.push({
        legacyPath: abs,
        sha256: sha,
        title,
        hasSchema,
        hasStableId,
        hasProvenance,
        entityTypeHint,
        status,
        missingFields,
      });
    }
  };

  for (const dir of dirs) {
    await walk(dir, dir);
  }

  return { items, fileChecksumsBefore };
};

/**
 * Idempotent OS 2 -> OS 3 Research Intelligence Migrator.
 * - Never deletes or modifies legacy source files or export records.
 * - Explicitly separates migrated, skippedIdempotent, rejected, conflicting, and incomplete records.
 */
export const migrateOs2ResearchToOs3 = async (
  opts: MigrateOs2ResearchOptions,
): Promise<ResearchMigrationReport> => {
  const startedAt = new Date().toISOString();
  const runId = `rmig-${shortHash8(`${startedAt}:${opts.payload.exportedAt}`)}`;
  const actor = opts.actor ?? 'os2-research-migrator';
  const dryRun = Boolean(opts.dryRun);

  const migrated: MigratedRecordEntry[] = [];
  const skippedIdempotent: MigratedRecordEntry[] = [];
  const rejected: RejectedMigrationRecord[] = [];
  const conflicting: ConflictingMigrationRecord[] = [];
  const incomplete: IncompleteMigrationRecord[] = [];

  const { payload, vault, db } = opts;
  const legacyCount =
    payload.projects.length +
    payload.questions.length +
    payload.runs.length +
    payload.sources.length +
    payload.evidence.length +
    payload.findings.length +
    payload.contradictions.length +
    payload.experiments.length +
    payload.experimentRuns.length;

  const projectById = new Map(payload.projects.map((p) => [p.id, p]));
  const questionById = new Map(payload.questions.map((q) => [q.id, q]));
  const runById = new Map(payload.runs.map((r) => [r.id, r]));
  const sourceById = new Map(payload.sources.map((s) => [s.id, s]));
  const evidenceById = new Map(payload.evidence.map((e) => [e.id, e]));
  const findingById = new Map(payload.findings.map((f) => [f.id, f]));
  const experimentById = new Map(payload.experiments.map((e) => [e.id, e]));

  const os3ProjectSlugByLegacyId = new Map<string, string>();
  const os3QuestionPathByLegacyId = new Map<string, string>();
  const os3QuestionIdByLegacyId = new Map<string, string>();
  const os3RunIdByLegacyId = new Map<string, string>();
  const os3SourcePathByLegacyId = new Map<string, string>();
  const os3SourceIdByLegacyId = new Map<string, string>();
  const os3EvidenceIdByLegacyId = new Map<string, string>();
  const os3EvidencePathByLegacyId = new Map<string, string>();
  const os3FindingIdByLegacyId = new Map<string, string>();
  const os3FindingPathByLegacyId = new Map<string, string>();
  const os3ExperimentPathByLegacyId = new Map<string, string>();
  const os3ExperimentIdByLegacyId = new Map<string, string>();

  const existingById = new Map(
    db
      .listIndexEntries(undefined, 20_000)
      .filter((e) => typeof e.frontmatter.id === 'string')
      .map((e) => [String(e.frontmatter.id), e]),
  );

  const checkExistingIdempotentOrConflict = async (params: {
    readonly legacyId: string;
    readonly entityKind: MigratedRecordEntry['entityKind'];
    readonly os3Id: string;
    readonly vaultPath: string;
    readonly schema: string;
    readonly expectedTopicOrSlug?: string | undefined;
    readonly expectedValueJson?: string | undefined;
    readonly expectedShaOrText?: string | undefined;
    readonly warnings?: readonly string[] | undefined;
  }): Promise<'proceed' | 'skip' | 'conflict'> => {
    const existing = db.getIndexEntry(params.vaultPath) ?? existingById.get(params.os3Id);
    if (!existing) return 'proceed';

    const doc = await vault.read(existing.vaultPath);
    const prov = doc.frontmatter.provenance as Record<string, unknown> | undefined;
    const sameLegacy = prov && String(prov.legacy_id ?? '') === params.legacyId;
    const sameSha = params.expectedShaOrText && String(doc.frontmatter.content_sha256 ?? '') === params.expectedShaOrText;
    const sameSlug =
      params.expectedTopicOrSlug &&
      (String(doc.frontmatter.slug ?? '') === params.expectedTopicOrSlug ||
        (String(doc.frontmatter.claim_topic ?? '') === params.expectedTopicOrSlug &&
          (!params.expectedValueJson || JSON.stringify(doc.frontmatter.claim_value) === params.expectedValueJson)));

    if (sameLegacy || sameSha || (sameSlug && String(doc.frontmatter.id ?? '') === params.os3Id)) {
      skippedIdempotent.push({
        legacyId: params.legacyId,
        entityKind: params.entityKind,
        os3Id: String(doc.frontmatter.id ?? params.os3Id),
        vaultPath: doc.vaultPath,
        schema: String(doc.frontmatter.schema ?? params.schema),
        sha256: doc.sha256,
        status: 'skipped_idempotent',
        warnings: params.warnings ?? [],
      });
      return 'skip';
    }

    conflicting.push({
      legacyId: params.legacyId,
      entityKind: params.entityKind,
      conflictKind: 'id_or_path_content_divergence',
      targetIdOrPath: doc.vaultPath,
      details: `Target "${doc.vaultPath}" (${String(doc.frontmatter.id)}) already exists with different origin or value; preserved untouched.`,
    });
    return 'conflict';
  };

  // ─── 1. Research Projects ──────────────────────────────────────────────────
  for (const lp of payload.projects) {
    const secretHit = hasSecret(`${lp.title}\n${lp.description ?? ''}`);
    if (secretHit) {
      rejected.push({
        legacyId: lp.id,
        entityKind: 'research_project',
        reasonCode: 'SECRET_DETECTED',
        message: `Project rejected: contains ${secretHit}`,
      });
      continue;
    }
    const cleanSlug = slugify(lp.slug);
    if (!lp.slug.trim() || !SLUG_RE.test(cleanSlug) || !lp.title.trim()) {
      rejected.push({
        legacyId: lp.id,
        entityKind: 'research_project',
        reasonCode: 'INVALID_PROJECT_METADATA',
        message: `Invalid slug "${lp.slug}" or blank title`,
      });
      continue;
    }
    const os3Id = `rprj-${cleanSlug}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${cleanSlug}.md`;
    os3ProjectSlugByLegacyId.set(lp.id, cleanSlug);

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lp.id,
      entityKind: 'research_project',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.research-project/v3',
      expectedTopicOrSlug: cleanSlug,
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: lp.id,
        entityKind: 'research_project',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.research-project/v3',
        sha256: sha256Hex(`${os3Id}:${lp.title}`),
        status: 'dry_run_planned',
        warnings: [],
      });
      continue;
    }

    const rec = await opts.research.createProject({
      idOverride: os3Id,
      slug: cleanSlug,
      title: lp.title,
      description: lp.description ?? undefined,
      status: lp.status,
      createdAt: lp.created_at,
      updatedAt: lp.updated_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_projects',
        legacy_id: lp.id,
        migrated_by: actor,
      },
      actor,
    });
    migrated.push({
      legacyId: lp.id,
      entityKind: 'research_project',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.research-project/v3',
      sha256: rec.sha256,
      status: 'migrated',
      warnings: [],
    });
  }

  // ─── 2. Research Questions + Research Links ────────────────────────────────
  const linksByQuestion = new Map<string, NonNullable<Os2ResearchExportPayload['researchLinks']>[number][]>();
  for (const rl of payload.researchLinks ?? []) {
    if (!questionById.has(rl.question_id)) {
      rejected.push({
        legacyId: rl.id,
        entityKind: 'research_link',
        reasonCode: 'MISSING_PARENT_QUESTION',
        message: `research_link references missing question "${rl.question_id}"`,
      });
      continue;
    }
    linksByQuestion.set(rl.question_id, [...(linksByQuestion.get(rl.question_id) ?? []), rl]);
  }

  for (const lq of payload.questions) {
    const secretHit = hasSecret(`${lq.question}\n${lq.intended_use ?? ''}`);
    if (secretHit) {
      rejected.push({
        legacyId: lq.id,
        entityKind: 'research_question',
        reasonCode: 'SECRET_DETECTED',
        message: `Question rejected: contains ${secretHit}`,
      });
      continue;
    }
    const proj = projectById.get(lq.project_id);
    if (!proj || !os3ProjectSlugByLegacyId.has(lq.project_id)) {
      rejected.push({
        legacyId: lq.id,
        entityKind: 'research_question',
        reasonCode: 'MISSING_PARENT_PROJECT',
        message: `Question references missing or rejected project "${lq.project_id}"`,
      });
      continue;
    }
    if (!lq.question.trim()) {
      rejected.push({
        legacyId: lq.id,
        entityKind: 'research_question',
        reasonCode: 'EMPTY_QUESTION',
        message: 'Question text cannot be empty',
      });
      continue;
    }

    const qLinks = linksByQuestion.get(lq.id) ?? [];
    const activeTargets = qLinks
      .filter((l) => !l.retracted_reason)
      .map((l) => {
        if (l.decision_key) return { kind: 'decision' as const, decisionKey: l.decision_key, role: l.role ?? undefined };
        if (l.workflow_name) {
          return {
            kind: 'workflow' as const,
            workflowName: l.workflow_name,
            workflowSha256: l.workflow_sha256 ?? undefined,
            role: l.role ?? undefined,
          };
        }
        return {
          kind: 'lineage' as const,
          artifactLineageId: String(l.artifact_lineage_id ?? ''),
          role: l.role ?? undefined,
        };
      });

    const missingFields: string[] = [];
    if (!lq.intended_use?.trim()) missingFields.push('intended_use');
    const isAbandoned = lq.status === 'abandoned';
    if (isAbandoned) missingFields.push('status=abandoned');

    const projSlug = os3ProjectSlugByLegacyId.get(lq.project_id)!;
    const shortId = shortHash8(`rqst:${lq.id}`);
    const os3Id = `rqst-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/QUESTIONS/RQST-${shortId}-${slugify(lq.question)}.md`;
    os3QuestionIdByLegacyId.set(lq.id, os3Id);
    os3QuestionPathByLegacyId.set(lq.id, vaultPath);

    if (missingFields.length > 0) {
      incomplete.push({
        legacyId: lq.id,
        entityKind: 'research_question',
        missingFields,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: 'Pre-AOS-04 question lacked intended_use or was marked abandoned; migrated with explicit fallback metadata',
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lq.id,
      entityKind: 'research_question',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.research-question/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: lq.id,
        entityKind: 'research_question',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.research-question/v3',
        sha256: sha256Hex(`${os3Id}:${lq.question}`),
        status: 'dry_run_planned',
        warnings: missingFields.length > 0 ? [`Missing pre-AOS04 fields: ${missingFields.join(', ')}`] : [],
      });
      continue;
    }

    const rec = await opts.research.createQuestion({
      idOverride: os3Id,
      projectSlug: projSlug,
      question: lq.question,
      intendedUse: lq.intended_use?.trim() || '[MIGRATED_PRE_AOS04_NO_INTENDED_USE]',
      urls: lq.urls,
      specialists: lq.specialists ?? undefined,
      targets: activeTargets,
      status: lq.status,
      createdAt: lq.created_at,
      updatedAt: lq.updated_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_questions',
        legacy_id: lq.id,
        migrated_by: actor,
        retracted_links: qLinks
          .filter((l) => Boolean(l.retracted_reason))
          .map((l) => ({ linkId: l.id, reason: l.retracted_reason })),
      },
      actor,
    });
    os3QuestionPathByLegacyId.set(lq.id, rec.vaultPath);
    migrated.push({
      legacyId: lq.id,
      entityKind: 'research_question',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.research-question/v3',
      sha256: rec.sha256,
      status: missingFields.length > 0 ? 'migrated_partial' : 'migrated',
      warnings: missingFields.length > 0 ? [`Incomplete fields defaulted: ${missingFields.join(', ')}`] : [],
    });
  }

  // ─── 3. Research Runs ──────────────────────────────────────────────────────
  for (const lr of payload.runs) {
    if (!questionById.has(lr.question_id) || !os3QuestionPathByLegacyId.has(lr.question_id)) {
      rejected.push({
        legacyId: lr.id,
        entityKind: 'research_run',
        reasonCode: 'MISSING_PARENT_QUESTION',
        message: `Research run references missing question "${lr.question_id}"`,
      });
      continue;
    }

    const shortId = shortHash8(`rrun:${lr.id}`);
    const os3Id = `rrun-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/RUNS/RRUN-${shortId}.md`;
    os3RunIdByLegacyId.set(lr.id, os3Id);

    const runGaps: string[] = [];
    if (lr.status === 'running' || !lr.completed_at) runGaps.push('completed_at(open/unsealed run)');
    if (lr.status === 'error' && !lr.error_detail) runGaps.push('error_detail');
    if (runGaps.length > 0) {
      incomplete.push({
        legacyId: lr.id,
        entityKind: 'research_run',
        missingFields: runGaps,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: 'OS2 run was unsealed/unfinished or missing completion metadata at export time',
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lr.id,
      entityKind: 'research_run',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.entity/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: lr.id,
        entityKind: 'research_run',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.entity/v3',
        sha256: sha256Hex(`${os3Id}:${lr.status}`),
        status: 'dry_run_planned',
        warnings: runGaps,
      });
      continue;
    }

    const rec = await opts.research.openResearchRun({
      idOverride: os3Id,
      questionPathOrId: os3QuestionPathByLegacyId.get(lr.question_id)!,
      selectedSpecialists: lr.selected_specialists,
      status: lr.status,
      errorDetail: lr.error_detail ?? undefined,
      expiresAt: lr.expires_at ?? undefined,
      createdAt: lr.created_at,
      completedAt: lr.completed_at ?? null,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_runs',
        legacy_id: lr.id,
        migrated_by: actor,
      },
      actor,
    });
    migrated.push({
      legacyId: lr.id,
      entityKind: 'research_run',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.entity/v3',
      sha256: rec.sha256,
      status: runGaps.length > 0 ? 'migrated_partial' : 'migrated',
      warnings: runGaps,
    });
  }

  // ─── 4. Sources ────────────────────────────────────────────────────────────
  for (const ls of payload.sources) {
    const rawBody = (ls.text ?? ls.excerpt ?? '').trim();
    const secretHit = hasSecret(`${ls.title}\n${rawBody}`);
    if (secretHit) {
      rejected.push({
        legacyId: ls.id,
        entityKind: 'research_source',
        reasonCode: 'SECRET_DETECTED',
        message: `Source rejected: contains ${secretHit}`,
      });
      continue;
    }
    if (!rawBody || !ls.uri.trim() || !ls.title.trim()) {
      rejected.push({
        legacyId: ls.id,
        entityKind: 'research_source',
        reasonCode: 'INVALID_SOURCE_PAYLOAD',
        message: 'Source requires non-empty uri, title, and text/excerpt',
      });
      continue;
    }

    const missingSrcFields: string[] = [];
    if (!ls.text?.trim()) missingSrcFields.push('text(only excerpt persisted)');
    if (ls.reliability === null || ls.reliability === undefined) missingSrcFields.push('reliability');

    const uriNorm = normalizeUri(ls.uri);
    const kind = (ls.kind as ResearchSourceKind) || 'doc';
    const computedSha = sha256Hex(rawBody);
    const contentHash = ls.content_sha256 && /^[0-9a-f]{64}$/i.test(ls.content_sha256) ? ls.content_sha256 : computedSha;
    // Notice registerSource() computes contentSha256 from sourceText, so use rawBody sha consistently
    const actualSha8 = computedSha.slice(0, 8);
    const os3Id = `src-${actualSha8}`;
    const vaultPath = `02_KNOWLEDGE/SOURCES/SRC-${actualSha8}-${slugify(ls.title)}.md`;
    os3SourceIdByLegacyId.set(ls.id, os3Id);
    os3SourcePathByLegacyId.set(ls.id, vaultPath);

    if (missingSrcFields.length > 0) {
      incomplete.push({
        legacyId: ls.id,
        entityKind: 'research_source',
        missingFields: missingSrcFields,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: `Source migrated from excerpt/classified rubric fallback (legacy sha prefix ${contentHash.slice(0, 8)})`,
      });
    }

    // Content-addressed dedup check
    const existingByHash = db
      .listIndexEntries('02_KNOWLEDGE', 5_000)
      .find((e) => e.vaultPath.startsWith('02_KNOWLEDGE/SOURCES/') && e.frontmatter.content_sha256 === computedSha);

    if (existingByHash) {
      os3SourceIdByLegacyId.set(ls.id, String(existingByHash.frontmatter.id));
      os3SourcePathByLegacyId.set(ls.id, existingByHash.vaultPath);
      skippedIdempotent.push({
        legacyId: ls.id,
        entityKind: 'research_source',
        os3Id: String(existingByHash.frontmatter.id),
        vaultPath: existingByHash.vaultPath,
        schema: String(existingByHash.frontmatter.schema ?? 'xyp3rn.source/v3'),
        sha256: existingByHash.sha256,
        status: 'skipped_idempotent',
        warnings: ['Content-addressed SHA-256 deduplicated cleanly'],
      });
      continue;
    }

    if (dryRun) {
      migrated.push({
        legacyId: ls.id,
        entityKind: 'research_source',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.source/v3',
        sha256: computedSha,
        status: 'dry_run_planned',
        warnings: missingSrcFields,
      });
      continue;
    }

    const rel = classifySource(kind, uriNorm);
    const rec = await opts.research.registerSource({
      idOverride: os3Id,
      kind,
      uri: uriNorm,
      title: ls.title,
      sourceText: rawBody,
      createdAt: ls.created_at ?? ls.retrieved_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_sources',
        legacy_id: ls.id,
        legacy_content_sha256: contentHash,
        migrated_by: actor,
        classified_reliability: rel.score,
      },
      actor,
    });
    os3SourceIdByLegacyId.set(ls.id, rec.id);
    os3SourcePathByLegacyId.set(ls.id, rec.vaultPath);
    migrated.push({
      legacyId: ls.id,
      entityKind: 'research_source',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.source/v3',
      sha256: rec.sha256,
      status: missingSrcFields.length > 0 ? 'migrated_partial' : 'migrated',
      warnings: missingSrcFields,
    });
  }

  // ─── 5. Evidence ───────────────────────────────────────────────────────────
  for (const le of payload.evidence) {
    const secretHit = hasSecret(`${le.claim}\n${le.quote ?? ''}\n${le.uncertainty_note ?? ''}`);
    if (secretHit) {
      rejected.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        reasonCode: 'SECRET_DETECTED',
        message: `Evidence rejected: contains ${secretHit}`,
      });
      continue;
    }
    const srcRow = sourceById.get(le.research_source_id);
    const srcPath = os3SourcePathByLegacyId.get(le.research_source_id);
    if (!srcRow || !srcPath) {
      rejected.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        reasonCode: 'MISSING_SOURCE_REFERENCE',
        message: `Evidence references missing/rejected source "${le.research_source_id}"`,
      });
      continue;
    }
    if (!Number.isFinite(le.confidence) || le.confidence < 0 || le.confidence > 1) {
      rejected.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        reasonCode: 'INVALID_CONFIDENCE',
        message: `Evidence confidence ${String(le.confidence)} must be in [0, 1]`,
      });
      continue;
    }
    if (!le.confidence_inputs || Object.keys(le.confidence_inputs).length === 0) {
      rejected.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        reasonCode: 'MISSING_CONFIDENCE_INPUTS',
        message: 'Evidence requires non-empty confidence_inputs explanation',
      });
      continue;
    }
    if (!le.claim.trim() || !le.model_tag.trim()) {
      rejected.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        reasonCode: 'INVALID_CLAIM_OR_MODEL_TAG',
        message: 'Evidence requires non-empty claim and model_tag',
      });
      continue;
    }

    const sourceBodyText = squash(srcRow.text ?? srcRow.excerpt ?? '');
    if (le.quote !== undefined && le.quote !== null && le.quote.trim().length > 0) {
      if (!sourceBodyText.toLowerCase().includes(squash(le.quote).toLowerCase())) {
        rejected.push({
          legacyId: le.id,
          entityKind: 'research_evidence',
          reasonCode: 'VERBATIM_QUOTE_MISMATCH',
          message: `Quoted passage "${le.quote.slice(0, 60)}" not found verbatim in source "${srcRow.id}"`,
        });
        continue;
      }
    }

    const evGaps: string[] = [];
    if (!le.quote?.trim()) evGaps.push('verbatim_quote(pre-AOS04 omission)');
    if (!le.uncertainty_note?.trim()) evGaps.push('uncertainty_note');
    if (!le.claim_topic?.trim()) evGaps.push('claim_topic');

    const topicSlug = slugify(le.claim_topic ?? 'unscoped');
    const shortId = shortHash8(`evid:${le.id}`);
    const os3Id = `evid-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-${shortId}-${topicSlug}.md`;
    os3EvidenceIdByLegacyId.set(le.id, os3Id);
    os3EvidencePathByLegacyId.set(le.id, vaultPath);

    if (evGaps.length > 0) {
      incomplete.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        missingFields: evGaps,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: 'Legacy pre-AOS04 evidence missing explicit verbatim quote/uncertainty; flagged incomplete until corroborated',
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: le.id,
      entityKind: 'research_evidence',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.evidence/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: le.id,
        entityKind: 'research_evidence',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.evidence/v3',
        sha256: sha256Hex(`${os3Id}:${le.claim}`),
        status: 'dry_run_planned',
        warnings: evGaps,
      });
      continue;
    }

    const quoteToStore = le.quote?.trim() || `[MIGRATED_PRE_AOS04_NO_QUOTE] ${sourceBodyText.slice(0, 120)}`;
    const hasRealQuote = Boolean(le.quote?.trim());

    const rec = await opts.research.recordEvidence({
      idOverride: os3Id,
      sourceRef: srcPath,
      specialist: le.specialist,
      verbatimQuote: quoteToStore,
      interpretation: le.claim,
      claimTopic: le.claim_topic?.trim() || 'legacy.unstructured',
      claimValue: le.claim_value ?? { legacyClaimText: le.claim },
      modelTag: le.model_tag,
      confidence: le.confidence,
      confidenceInputs: le.confidence_inputs,
      uncertaintyNote:
        le.uncertainty_note?.trim() || `[INCOMPLETE_LEGACY_MIGRATION: missing ${evGaps.join(', ')}]`,
      researchRunId: le.research_run_id ? os3RunIdByLegacyId.get(le.research_run_id) : undefined,
      verifyVerbatimQuote: hasRealQuote,
      createdAt: le.created_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_evidence',
        legacy_id: le.id,
        migrated_by: actor,
        has_verbatim_quote: hasRealQuote,
      },
    });
    os3EvidenceIdByLegacyId.set(le.id, rec.id);
    os3EvidencePathByLegacyId.set(le.id, rec.vaultPath);
    migrated.push({
      legacyId: le.id,
      entityKind: 'research_evidence',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.evidence/v3',
      sha256: rec.sha256,
      status: evGaps.length > 0 ? 'migrated_partial' : 'migrated',
      warnings: evGaps,
    });
  }

  // ─── 6. Findings ───────────────────────────────────────────────────────────
  const findingEvLinks = new Map<string, string[]>();
  for (const lf of payload.findings) {
    findingEvLinks.set(lf.id, [...(lf.evidence_ids ?? [])]);
  }
  for (const link of payload.findingEvidenceLinks ?? []) {
    findingEvLinks.set(link.finding_id, [...(findingEvLinks.get(link.finding_id) ?? []), link.evidence_id]);
  }

  const decisionByFinding = new Map((payload.findingDecisions ?? []).map((d) => [d.finding_id, d]));

  for (const lf of payload.findings) {
    const secretHit = hasSecret(`${lf.claim}\n${lf.uncertainty_note ?? ''}`);
    if (secretHit) {
      rejected.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        reasonCode: 'SECRET_DETECTED',
        message: `Finding rejected: contains ${secretHit}`,
      });
      continue;
    }
    const legacyEvIds = [...new Set(findingEvLinks.get(lf.id) ?? [])];
    const mappedEvIds = legacyEvIds
      .map((eid) => os3EvidenceIdByLegacyId.get(eid))
      .filter((x): x is string => Boolean(x));

    if (legacyEvIds.length === 0 || mappedEvIds.length !== legacyEvIds.length) {
      rejected.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        reasonCode: 'MISSING_OR_REJECTED_EVIDENCE',
        message: `Finding requires valid migrated evidence links (expected=${legacyEvIds.length}, valid=${mappedEvIds.length})`,
      });
      continue;
    }

    // Check model tag match before calling recordFinding
    let modelMismatch = false;
    for (const oldEvId of legacyEvIds) {
      const oldEv = evidenceById.get(oldEvId);
      if (oldEv && oldEv.model_tag !== lf.model_tag && oldEv.model_tag !== MODEL_AGNOSTIC) {
        modelMismatch = true;
        break;
      }
    }
    if (modelMismatch) {
      rejected.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        reasonCode: 'MODEL_SCOPE_MISMATCH',
        message: `Finding "${lf.id}" references evidence from incompatible model_tag`,
      });
      continue;
    }

    const shortId = shortHash8(`find:${lf.id}`);
    const os3Id = `find-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-${shortId}-${slugify(lf.claim_topic)}.md`;
    os3FindingIdByLegacyId.set(lf.id, os3Id);
    os3FindingPathByLegacyId.set(lf.id, vaultPath);

    const fGaps: string[] = [];
    if (!lf.uncertainty_note?.trim()) fGaps.push('uncertainty_note');
    if (fGaps.length > 0) {
      incomplete.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        missingFields: fGaps,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: 'Legacy OS2 finding had no separate uncertainty_note column; migrated with explicit fallback marker',
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lf.id,
      entityKind: 'research_finding',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.finding/v3',
      expectedTopicOrSlug: lf.claim_topic,
      expectedValueJson: JSON.stringify(lf.claim_value),
    });
    if (statusCheck !== 'proceed') continue;

    // Verify confidence consistency for reporting warnings
    const evSupports = legacyEvIds.map((id) => {
      const ev = evidenceById.get(id)!;
      const src = sourceById.get(ev.research_source_id)!;
      return {
        confidence: ev.confidence,
        reliability: src.reliability ?? 0.3,
        research_source_id: ev.research_source_id,
      };
    });
    const recomputedConf = computeFindingConfidence(evSupports).confidence;
    const warnings = [...fGaps];
    if (Math.abs(recomputedConf - lf.confidence) > 0.02) {
      warnings.push(`Legacy confidence ${lf.confidence} recomputed deterministically to ${recomputedConf.toFixed(3)}`);
    }

    if (dryRun) {
      migrated.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.finding/v3',
        sha256: sha256Hex(`${os3Id}:${lf.claim}`),
        status: 'dry_run_planned',
        warnings,
      });
      continue;
    }

    const rec = await opts.research.recordFinding({
      idOverride: os3Id,
      evidenceIds: mappedEvIds,
      claimTopic: lf.claim_topic,
      claimValue: lf.claim_value,
      interpretation: lf.claim,
      uncertaintyNote:
        lf.uncertainty_note?.trim() || '[INCOMPLETE_LEGACY_MIGRATION: verify applicability beyond original OS2 run]',
      modelTag: lf.model_tag,
      researchRunId: lf.research_run_id ? os3RunIdByLegacyId.get(lf.research_run_id) : undefined,
      createdAt: lf.created_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'research_findings',
        legacy_id: lf.id,
        legacy_confidence: lf.confidence,
        migrated_by: actor,
      },
      actor,
    });
    os3FindingIdByLegacyId.set(lf.id, rec.id);
    os3FindingPathByLegacyId.set(lf.id, rec.vaultPath);

    for (const c of rec.contradictions) {
      conflicting.push({
        legacyId: lf.id,
        entityKind: 'research_finding',
        conflictKind: 'claim_contradiction',
        targetIdOrPath: c.targetPath,
        contradictionPath: c.vaultPath,
        details: `Migrated finding "${lf.id}" conflicts on "${c.claimTopic}" (scope "${c.modelScope}"); created contradiction ${c.id}`,
      });
    }

    const dec = decisionByFinding.get(lf.id);
    if (dec && (dec.decision === 'accept' || dec.decision === 'reject') && dec.decided_by.trim() && dec.decision_reason.trim()) {
      await opts.research.recordFindingDecision({
        findingPathOrId: rec.vaultPath,
        decision: dec.decision,
        approver: dec.decided_by,
        reason: dec.decision_reason,
      });
    }

    migrated.push({
      legacyId: lf.id,
      entityKind: 'research_finding',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.finding/v3',
      sha256: rec.sha256,
      status: fGaps.length > 0 ? 'migrated_partial' : 'migrated',
      warnings,
    });
  }

  // ─── 7. Explicit Legacy Contradictions ─────────────────────────────────────
  for (const lc of payload.contradictions) {
    if (!findingById.has(lc.finding_id) || !os3FindingPathByLegacyId.has(lc.finding_id)) {
      rejected.push({
        legacyId: lc.id,
        entityKind: 'research_contradiction',
        reasonCode: 'MISSING_PARENT_FINDING',
        message: `Contradiction "${lc.id}" references missing or rejected finding "${lc.finding_id}"`,
      });
      continue;
    }
    const isResolved = lc.status === 'resolved' || lc.status === 'resolved_manual' || lc.status === 'resolved_experiment';
    const resObj = typeof lc.resolution === 'object' && lc.resolution !== null ? lc.resolution : null;
    const resReason =
      typeof lc.resolution === 'string'
        ? lc.resolution.trim()
        : typeof resObj?.reason === 'string'
          ? resObj.reason.trim()
          : '';
    if (isResolved && !resReason) {
      rejected.push({
        legacyId: lc.id,
        entityKind: 'research_contradiction',
        reasonCode: 'MISSING_RESOLUTION_REASON',
        message: `Resolved contradiction "${lc.id}" lacks a non-empty resolution reason`,
      });
      continue;
    }

    const findingId = os3FindingIdByLegacyId.get(lc.finding_id)!;
    const findingPath = os3FindingPathByLegacyId.get(lc.finding_id)!;
    const topic = String(lc.detail?.topic ?? findingById.get(lc.finding_id)!.claim_topic);
    const shortId = shortHash8(`cntr:${lc.id}`);
    const os3Id = `cntr-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/CNTR-${shortId}-${slugify(topic)}.md`;

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lc.id,
      entityKind: 'research_contradiction',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.contradiction/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: lc.id,
        entityKind: 'research_contradiction',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.contradiction/v3',
        sha256: sha256Hex(`${os3Id}:${topic}`),
        status: 'dry_run_planned',
        warnings: [],
      });
      continue;
    }

    const nowTs = lc.created_at ?? startedAt;
    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.contradiction/v3',
        id: os3Id,
        type: 'contradiction',
        title: `Migrated Contradiction on ${topic}: ${os3Id}`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: isResolved ? 'resolved' : 'open',
        version: 1,
        finding_id: findingId,
        finding_path: findingPath,
        target_path: lc.target_id,
        claim_topic: topic,
        finding_value: lc.detail?.finding_value ?? findingById.get(lc.finding_id)!.claim_value,
        target_value: lc.detail?.target_value ?? null,
        model_scope: String(lc.detail?.finding_model_tag ?? findingById.get(lc.finding_id)!.model_tag ?? MODEL_AGNOSTIC),
        target_model_scope: String(lc.detail?.target_model_scope ?? MODEL_AGNOSTIC),
        resolution: isResolved ? resReason : null,
        ...(isResolved ? { resolved_at: lc.resolved_at ?? nowTs } : {}),
        provenance: {
          origin: 'os2-research-migration',
          source_system: payload.sourceSystem,
          legacy_table: 'contradictions',
          legacy_id: lc.id,
          migrated_by: actor,
        },
        created_at: nowTs,
        updated_at: lc.resolved_at ?? nowTs,
        tags: ['xyp3rn', 'os3', 'contradiction', isResolved ? 'resolved' : 'open'],
      },
      [
        `# Contradiction \`${os3Id}\` (${topic})`,
        '',
        `- **Finding:** [[${findingPath.replace(/\.md$/, '')}|${findingId}]]`,
        `- **Target Reference:** \`${lc.target_type}:${lc.target_id}\``,
        `- **Status:** \`${isResolved ? 'resolved' : 'open'}\``,
        ...(isResolved ? ['', `## Resolution`, '', resReason] : []),
      ].join('\n'),
    );

    const written = await vault.write({
      vaultPath,
      content,
      actor,
      reason: `Migrate OS2 contradiction ${lc.id}`,
    });
    migrated.push({
      legacyId: lc.id,
      entityKind: 'research_contradiction',
      os3Id,
      vaultPath: written.vaultPath,
      schema: 'xyp3rn.contradiction/v3',
      sha256: written.sha256,
      status: 'migrated',
      warnings: [],
    });
  }

  // ─── 8. Experiments & Experiment Runs ──────────────────────────────────────
  for (const lex of payload.experiments) {
    const fId = lex.finding_id ?? lex.candidate_id;
    const mappedFindingPath = fId ? os3FindingPathByLegacyId.get(fId) : undefined;
    if (!mappedFindingPath) {
      rejected.push({
        legacyId: lex.id,
        entityKind: 'research_experiment',
        reasonCode: 'MISSING_PARENT_FINDING',
        message: `Experiment "${lex.id}" lacks valid migrated finding_id`,
      });
      continue;
    }
    if (!lex.hypothesis.trim() || !Number.isInteger(lex.n_per_variant) || lex.n_per_variant < 1) {
      rejected.push({
        legacyId: lex.id,
        entityKind: 'research_experiment',
        reasonCode: 'INVALID_EXPERIMENT_SPEC',
        message: 'Experiment requires hypothesis and integer n_per_variant >= 1',
      });
      continue;
    }

    const shortId = shortHash8(`expr:${lex.id}`);
    const os3Id = `expr-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-${shortId}-${slugify(lex.hypothesis)}.md`;
    os3ExperimentIdByLegacyId.set(lex.id, os3Id);
    os3ExperimentPathByLegacyId.set(lex.id, vaultPath);

    const expRuns = payload.experimentRuns.filter((r) => r.experiment_id === lex.id);
    const expGaps: string[] = [];
    if (expRuns.length < lex.n_per_variant * 2) {
      expGaps.push(`trials(${expRuns.length}/${lex.n_per_variant * 2})`);
    }
    if (lex.scoring_method === STUB_SCORER) {
      expGaps.push(`stub_scorer(${STUB_SCORER})`);
    }
    if (expGaps.length > 0) {
      incomplete.push({
        legacyId: lex.id,
        entityKind: 'research_experiment',
        missingFields: expGaps,
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: 'Experiment has incomplete trial count or stub scorer; must not be treated as validated',
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: lex.id,
      entityKind: 'research_experiment',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.experiment/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: lex.id,
        entityKind: 'research_experiment',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.experiment/v3',
        sha256: sha256Hex(`${os3Id}:${lex.hypothesis}`),
        status: 'dry_run_planned',
        warnings: expGaps,
      });
      continue;
    }

    const rec = await opts.research.designExperiment({
      idOverride: os3Id,
      findingPathOrId: mappedFindingPath,
      hypothesis: lex.hypothesis,
      variantA: lex.variant_a,
      variantB: lex.variant_b,
      nPerVariant: lex.n_per_variant,
      scorerId: lex.scoring_method,
      createdAt: lex.created_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'experiments',
        legacy_id: lex.id,
        migrated_by: actor,
      },
      actor,
    });
    os3ExperimentPathByLegacyId.set(lex.id, rec.vaultPath);
    migrated.push({
      legacyId: lex.id,
      entityKind: 'research_experiment',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.experiment/v3',
      sha256: rec.sha256,
      status: expGaps.length > 0 ? 'migrated_partial' : 'migrated',
      warnings: expGaps,
    });
  }

  for (const ler of payload.experimentRuns) {
    const expRow = experimentById.get(ler.experiment_id);
    const expPath = os3ExperimentPathByLegacyId.get(ler.experiment_id);
    const expOs3Id = os3ExperimentIdByLegacyId.get(ler.experiment_id);
    if (!expRow || !expPath || !expOs3Id) {
      rejected.push({
        legacyId: ler.id,
        entityKind: 'research_experiment_run',
        reasonCode: 'MISSING_PARENT_EXPERIMENT',
        message: `Experiment run "${ler.id}" references missing or rejected experiment "${ler.experiment_id}"`,
      });
      continue;
    }
    if ((ler.variant !== 'a' && ler.variant !== 'b') || ler.trial < 1 || ler.trial > expRow.n_per_variant) {
      rejected.push({
        legacyId: ler.id,
        entityKind: 'research_experiment_run',
        reasonCode: 'INVALID_TRIAL_BOUNDS',
        message: `Experiment run "${ler.id}" has invalid variant/trial (${ler.variant} #${ler.trial})`,
      });
      continue;
    }
    if (ler.score !== null && (!Number.isFinite(ler.score) || ler.score < 0 || ler.score > 1)) {
      rejected.push({
        legacyId: ler.id,
        entityKind: 'research_experiment_run',
        reasonCode: 'INVALID_SCORE_RANGE',
        message: `Experiment run score ${String(ler.score)} must be null or in [0, 1]`,
      });
      continue;
    }

    const os3Id = `erun-${expOs3Id.slice(5)}-${ler.variant}${ler.trial}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/ERUN-${expOs3Id.slice(5)}-${ler.variant}${ler.trial}.md`;

    if (ler.score === null || ler.scored_by === STUB_SCORER) {
      incomplete.push({
        legacyId: ler.id,
        entityKind: 'research_experiment_run',
        missingFields: ['real_score'],
        disposition: 'migrated_with_explicit_gaps',
        os3VaultPath: vaultPath,
        notes: `Experiment run scored by "${ler.scored_by}" with null/stub score`,
      });
    }

    const statusCheck = await checkExistingIdempotentOrConflict({
      legacyId: ler.id,
      entityKind: 'research_experiment_run',
      os3Id,
      vaultPath,
      schema: 'xyp3rn.entity/v3',
    });
    if (statusCheck !== 'proceed') continue;

    if (dryRun) {
      migrated.push({
        legacyId: ler.id,
        entityKind: 'research_experiment_run',
        os3Id,
        vaultPath,
        schema: 'xyp3rn.entity/v3',
        sha256: sha256Hex(`${os3Id}:${String(ler.score)}`),
        status: 'dry_run_planned',
        warnings: [],
      });
      continue;
    }

    const rec = await opts.research.recordExperimentRun({
      idOverride: os3Id,
      experimentPathOrId: expPath,
      variant: ler.variant,
      trial: ler.trial,
      output: ler.output ?? {},
      scorer: {
        id: ler.scored_by,
        score: async () => ({
          score: ler.score,
          inputs: ler.score_inputs ?? { migratedFromOs2: true },
        }),
      },
      createdAt: ler.created_at,
      provenance: {
        origin: 'os2-research-migration',
        source_system: payload.sourceSystem,
        legacy_table: 'experiment_runs',
        legacy_id: ler.id,
        migrated_by: actor,
      },
      actor,
    });
    migrated.push({
      legacyId: ler.id,
      entityKind: 'research_experiment_run',
      os3Id: rec.id,
      vaultPath: rec.vaultPath,
      schema: 'xyp3rn.entity/v3',
      sha256: rec.sha256,
      status: ler.score === null ? 'migrated_partial' : 'migrated',
      warnings: [],
    });
  }

  // ─── 9. Optional Read-Only Scan of Unstructured Legacy Vault Markdown ──────
  const { items: legacyMarkdownScan, fileChecksumsBefore } = await scanLegacyResearchMarkdownDirs(
    opts.legacyMarkdownRootDirs ?? [],
  );

  for (const item of legacyMarkdownScan) {
    if (item.status === 'rejected_secret_or_invalid') {
      rejected.push({
        legacyId: item.legacyPath,
        entityKind: 'legacy_markdown',
        reasonCode: 'INVALID_OR_SECRET_LEGACY_MARKDOWN',
        message: `Legacy markdown "${item.legacyPath}" contains secrets or malformed YAML`,
      });
    } else if (item.status === 'incomplete_legacy_markdown') {
      let stagedPath: string | undefined;
      if (!dryRun && opts.stageIncompleteLegacyMarkdown) {
        const raw = await fs.readFile(item.legacyPath, 'utf8');
        const parsed = parseFrontmatterDocument(raw, { strict: false, vaultPath: item.legacyPath });
        const short = item.sha256.slice(0, 8);
        stagedPath = `03_RESEARCH_INTELLIGENCE/BRIEFS/BRF-MIG-${short}-${slugify(item.title)}.md`;
        if (!db.getIndexEntry(stagedPath)) {
          const ts = new Date().toISOString();
          const stagedDoc = serializeFrontmatterDocument(
            {
              schema: 'xyp3rn.entity/v3',
              id: `brf-mig-${short}`,
              type: 'research_brief',
              title: item.title,
              domain: 'RESEARCH_INTELLIGENCE',
              sector: '03_RESEARCH_INTELLIGENCE',
              status: 'draft',
              verification_status: 'incomplete',
              version: 1,
              project_slug: 'legacy-vault-import',
              legacy_path: item.legacyPath,
              legacy_sha256: item.sha256,
              provenance: {
                origin: 'legacy-markdown-readonly-import',
                legacy_path: item.legacyPath,
                legacy_sha256: item.sha256,
                migrated_by: actor,
              },
              created_at: ts,
              updated_at: ts,
              tags: ['xyp3rn', 'os3', 'research-brief', 'legacy-import'],
            },
            `${parsed.body.trim()}\n\n> Migrated read-only from legacy note \`${item.legacyPath}\` (missing fields in original: ${item.missingFields.join(', ')})`,
          );
          const written = await vault.write({
            vaultPath: stagedPath,
            content: stagedDoc,
            actor,
            reason: `Stage legacy research note non-destructively from ${item.legacyPath}`,
          });
          migrated.push({
            legacyId: item.legacyPath,
            entityKind: 'research_brief',
            os3Id: `brf-mig-${short}`,
            vaultPath: written.vaultPath,
            schema: 'xyp3rn.entity/v3',
            sha256: written.sha256,
            status: 'migrated_partial',
            warnings: [`Missing frontmatter in legacy file: ${item.missingFields.join(', ')}`],
          });
        }
      }
      incomplete.push({
        legacyId: item.legacyPath,
        entityKind: 'legacy_markdown',
        missingFields: item.missingFields,
        disposition: stagedPath ? 'migrated_with_explicit_gaps' : 'quarantined_unmigrated',
        os3VaultPath: stagedPath,
        legacyPath: item.legacyPath,
        notes: 'Legacy pre-OS3 markdown note left completely unmodified on disk',
      });
    }
  }

  // Verify zero legacy files were mutated or deleted
  let legacyDataUntouched = true;
  for (const [absPath, beforeSha] of Object.entries(fileChecksumsBefore)) {
    const afterRaw = await fs.readFile(absPath, 'utf8').catch(() => null);
    if (afterRaw === null || sha256Hex(afterRaw) !== beforeSha) {
      legacyDataUntouched = false;
      break;
    }
  }

  void modelScopesOverlap;
  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun,
    legacyDataUntouched,
    totals: {
      legacyInputCount: legacyCount,
      migratedCount: migrated.length,
      skippedIdempotentCount: skippedIdempotent.length,
      rejectedCount: rejected.length,
      conflictingCount: conflicting.length,
      incompleteCount: incomplete.length,
      legacyMarkdownScannedCount: legacyMarkdownScan.length,
    },
    migrated,
    skippedIdempotent,
    rejected,
    conflicting,
    incomplete,
    legacyMarkdownScan,
  };
};

/**
 * Verifies post-migration OS2 <-> OS3 Vault parity, schema compliance, reference integrity,
 * and legacy non-destruction across all migrated entities.
 */
export const verifyResearchMigrationParity = async (params: {
  readonly payload: Os2ResearchExportPayload;
  readonly report: ResearchMigrationReport;
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
}): Promise<ResearchParityReport> => {
  const { report, vault, db } = params;
  const targetExists = createVaultTargetChecker(db);
  const vaultValidationFailed: { readonly vaultPath: string; readonly issues: readonly string[] }[] = [];
  const unresolvedReferences: string[] = [];
  const discrepancies: string[] = [];
  let vaultValidationPassed = 0;

  const allEntries = [...report.migrated, ...report.skippedIdempotent];
  const seenPaths = new Set<string>();

  for (const entry of allEntries) {
    if (seenPaths.has(entry.vaultPath) || entry.status === 'dry_run_planned') continue;
    seenPaths.add(entry.vaultPath);

    try {
      const doc = await vault.read(entry.vaultPath);
      const val = validateResearchVaultDocument(entry.vaultPath, doc.rawContent, {
        targetExists,
        strictProvenance: true,
      });
      if (!val.ok) {
        const msgs = val.issues.map((i) => `${i.code}: ${i.message}`);
        vaultValidationFailed.push({ vaultPath: entry.vaultPath, issues: msgs });
        for (const i of val.issues) {
          if (i.code === 'BROKEN_REFERENCE') unresolvedReferences.push(`${entry.vaultPath} -> ${i.message}`);
        }
        discrepancies.push(`Validation failed on ${entry.vaultPath}: ${msgs.join('; ')}`);
      } else {
        vaultValidationPassed += 1;
      }
    } catch (err) {
      const msg = (err as Error).message;
      vaultValidationFailed.push({ vaultPath: entry.vaultPath, issues: [msg] });
      discrepancies.push(`Missing migrated entity in Vault: ${entry.vaultPath} (${msg})`);
    }
  }

  if (!report.legacyDataUntouched) {
    discrepancies.push('Legacy files on disk were modified or deleted during migration');
  }

  const kinds = [
    ['research_project', params.payload.projects.length],
    ['research_question', params.payload.questions.length],
    ['research_run', params.payload.runs.length],
    ['research_source', params.payload.sources.length],
    ['research_evidence', params.payload.evidence.length],
    ['research_finding', params.payload.findings.length],
    ['research_contradiction', params.payload.contradictions.length],
    ['research_experiment', params.payload.experiments.length],
    ['research_experiment_run', params.payload.experimentRuns.length],
  ] as const;

  const entityCounts: Record<
    string,
    { legacyValid: number; os3Present: number; matched: number; rejected: number; incomplete: number }
  > = {};

  for (const [kind, totalInput] of kinds) {
    const rejCount = report.rejected.filter((r) => r.entityKind === kind).length;
    const incCount = report.incomplete.filter((i) => i.entityKind === kind).length;
    const mig = report.migrated.filter((m) => m.entityKind === kind && m.status !== 'dry_run_planned').length;
    const skip = report.skippedIdempotent.filter((s) => s.entityKind === kind).length;
    const legacyValid = Math.max(0, totalInput - rejCount);
    const matched = mig + skip;
    entityCounts[kind] = {
      legacyValid,
      os3Present: matched,
      matched,
      rejected: rejCount,
      incomplete: incCount,
    };
    if (!report.dryRun && matched < legacyValid) {
      const conflictGap = report.conflicting.filter(
        (c) => c.entityKind === kind && c.conflictKind === 'id_or_path_content_divergence',
      ).length;
      if (matched + conflictGap < legacyValid) {
        discrepancies.push(
          `Count mismatch for ${kind}: valid=${legacyValid}, matched=${matched}, conflicts=${conflictGap}`,
        );
      }
    }
  }

  return {
    ok: discrepancies.length === 0 && vaultValidationFailed.length === 0 && unresolvedReferences.length === 0,
    checkedAt: new Date().toISOString(),
    vaultValidationPassed,
    vaultValidationFailed,
    unresolvedReferences,
    legacyChecksumVerified: report.legacyDataUntouched,
    entityCounts,
    discrepancies,
  };
};

/**
 * Renders a deterministic Markdown Migration & Parity Report summarizing migrated, skipped,
 * rejected, conflicting, and incomplete items alongside schema validation parity checks.
 */
export const formatResearchMigrationReportMarkdown = (
  report: ResearchMigrationReport,
  parity?: ResearchParityReport,
): string => {
  const lines: string[] = [
    '# XYP3RN OS 3.0 — Phase 19 Research Intelligence Migration & Parity Report',
    '',
    `- **Migration Run ID:** \`${report.runId}\``,
    `- **Mode:** \`${report.dryRun ? 'DRY_RUN (zero disk writes)' : 'EXECUTED_IDEMPOTENT'}\``,
    `- **Legacy Data Untouched:** \`${String(report.legacyDataUntouched)}\``,
    `- **Completed At:** \`${report.completedAt}\``,
    '',
    '## 1. Migration Outcome Totals',
    '',
    '| Classification | Count |',
    '| :--- | :--- |',
    `| Legacy Structured Records Input | ${report.totals.legacyInputCount} |`,
    `| Migrated (Written to Vault) | ${report.totals.migratedCount} |`,
    `| Skipped (Idempotent / Already Present) | ${report.totals.skippedIdempotentCount} |`,
    `| Rejected (Invalid / Secret / Unverified Quote) | ${report.totals.rejectedCount} |`,
    `| Conflicting (Divergence or Claim Contradiction) | ${report.totals.conflictingCount} |`,
    `| Incomplete (Partial / Pre-AOS04 / Legacy Markdown) | ${report.totals.incompleteCount} |`,
    `| Legacy Markdown Notes Inspected Read-Only | ${report.totals.legacyMarkdownScannedCount} |`,
    '',
  ];

  if (parity) {
    lines.push(
      '## 2. Entity Reconciliation & Validation Parity',
      '',
      `- **Parity Verdict:** **${parity.ok ? 'PASS (Reconciled)' : 'FAIL'}**`,
      `- **Vault Schema + Reference Validations Passed:** \`${parity.vaultValidationPassed}\` (Failed: \`${parity.vaultValidationFailed.length}\`)`,
      `- **Unresolved References:** \`${parity.unresolvedReferences.length}\``,
      '',
      '| Entity Kind | Valid Legacy | OS3 Present | Matched | Rejected | Incomplete |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
      ...Object.entries(parity.entityCounts).map(
        ([k, v]) => `| \`${k}\` | ${v.legacyValid} | ${v.os3Present} | ${v.matched} | ${v.rejected} | ${v.incomplete} |`,
      ),
      '',
    );
  }

  if (report.rejected.length > 0) {
    lines.push(
      '## 3. Rejected Legacy Records (Quarantined Cleanly)',
      '',
      '| Legacy ID | Kind | Reason Code | Detail |',
      '| :--- | :--- | :--- | :--- |',
      ...report.rejected.map((r) => `| \`${r.legacyId}\` | \`${r.entityKind}\` | \`${r.reasonCode}\` | ${r.message.replace(/\|/g, '\\|')} |`),
      '',
    );
  }

  if (report.conflicting.length > 0) {
    lines.push(
      '## 4. Conflicting Records & Contradiction Alerts',
      '',
      '| Legacy ID | Kind | Conflict Kind | Target / Contradiction |',
      '| :--- | :--- | :--- | :--- |',
      ...report.conflicting.map(
        (c) =>
          `| \`${c.legacyId}\` | \`${c.entityKind}\` | \`${c.conflictKind}\` | \`${c.contradictionPath ?? c.targetIdOrPath}\`: ${c.details.replace(/\|/g, '\\|')} |`,
      ),
      '',
    );
  }

  if (report.incomplete.length > 0) {
    lines.push(
      '## 5. Incomplete / Legacy Pre-OS3 Records',
      '',
      '| Legacy ID | Kind | Disposition | Missing Fields | Target / Legacy Path |',
      '| :--- | :--- | :--- | :--- | :--- |',
      ...report.incomplete.map(
        (i) =>
          `| \`${i.legacyId}\` | \`${i.entityKind}\` | \`${i.disposition}\` | \`${i.missingFields.join(', ')}\` | \`${i.os3VaultPath ?? i.legacyPath ?? ''}\` |`,
      ),
      '',
    );
  }

  return lines.join('\n');
};
