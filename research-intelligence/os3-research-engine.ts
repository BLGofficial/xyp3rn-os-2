import { randomUUID } from 'node:crypto';
import type { Os3VaultAgentRegistry } from '../core/agent-registry/os3-agent-registry.ts';
import type { Os3Orchestrator } from '../core/orchestrator/os3-orchestrator.ts';
import type { PendingApprovalRecord, SqliteRuntimeDb } from '../core/sqlite/client.ts';
import { sha256Hex } from '../core/vault-engine/revision.ts';
import { serializeFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import type { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import { validateEvidence } from './evidence/engine.ts';
import { STUB_SCORER, summarizeExperiment, type TrialScorer } from './experiments/engine.ts';
import { parseScope, planResearch, type ResearchPlan } from './orchestrator/select.ts';
import { classifySource, normalizeUri, type ResearchSourceKind, type SourceClass } from './sources/verify.ts';
import { computeFindingConfidence, MODEL_AGNOSTIC } from './synthesis/findings.ts';
import type {
  DawResearchCategory,
  EvidenceAttributionTier,
  ResearchTargetRef,
  VerificationStatus,
} from './os3-research-types.ts';

/**
 * Maps Phase 9 requested analytical capabilities to ONLY the existing 21 RESEARCH_INTELLIGENCE
 * agents migrated from OS2 (`agents/*.agent.md`). No unapproved agents are invented.
 */
export const OS2_RESEARCH_CAPABILITY_MAP: Readonly<
  Record<
    string,
    { readonly existingAgent: string | null; readonly rationale: string }
  >
> = {
  Researcher: {
    existingAgent: 'suno-researcher',
    rationale: '20 migrated Research specialists led by suno-researcher gather source-backed evidence.',
  },
  'Evidence Engine': {
    existingAgent: 'research-orchestrator',
    rationale: 'Deterministic Evidence Engine validates verbatim quotes, source_ref, confidence_inputs, and model_tag.',
  },
  'Contradiction Engine': {
    existingAgent: 'research-orchestrator',
    rationale: 'Deterministic Contradiction Engine inspects topic/value/model_scope conflicts on every finding.',
  },
  'Fact Checker': {
    existingAgent: 'evaluation-researcher',
    rationale: 'Mapped to evaluation-researcher + deterministic verbatim quote verification against source_text.',
  },
  Historian: {
    existingAgent: 'model-version-changelog-researcher',
    rationale: 'Mapped to existing model-version-changelog-researcher covering version history & regressions.',
  },
  Methodologist: {
    existingAgent: 'benchmark-scoring-methodology-researcher',
    rationale: 'Mapped to existing benchmark-scoring-methodology-researcher & Experiment Engine rubric.',
  },
  'Hypothesis Generator': {
    existingAgent: 'research-orchestrator',
    rationale: 'Handled by research-orchestrator scoping + Research Question / Experiment hypothesis design.',
  },
  "Devil's Advocate": {
    existingAgent: 'negative-prompt-failure-mode-researcher',
    rationale: 'Mapped to existing negative-prompt-failure-mode-researcher focused on counterexamples & failures.',
  },
  'Science Advisor': {
    existingAgent: 'benchmark-scoring-methodology-researcher',
    rationale: 'Mapped to existing benchmark-scoring-methodology-researcher; no separate unapproved Science Advisor agent invented.',
  },
  'Technology Assessor': {
    existingAgent: 'frontier-tool-scanner-researcher',
    rationale: 'Mapped to existing frontier-tool-scanner-researcher & mix-master-ai-tooling-researcher.',
  },
  'Trend Forecaster': {
    existingAgent: 'release-strategy-platform-algo-researcher',
    rationale: 'Mapped to existing release-strategy-platform-algo-researcher & frontier-tool-scanner-researcher.',
  },
} as const;

export const modelScopesOverlap = (a: string, b: string): boolean =>
  a === b || a === MODEL_AGNOSTIC || b === MODEL_AGNOSTIC;

const squashWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

export type ResearchProjectRecord = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly vaultPath: string;
  readonly sha256: string;
};

export type ResearchQuestionRecord = {
  readonly id: string;
  readonly projectSlug: string;
  readonly question: string;
  readonly intendedUse: string;
  readonly vaultPath: string;
  readonly sha256: string;
};

export type ResearchRunRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly questionId: string;
  readonly selectedSpecialists: readonly string[];
  readonly vaultPath: string;
  readonly sha256: string;
};

export type ResearchSourceRecord = {
  readonly id: string;
  readonly uri: string;
  readonly title: string;
  readonly origin: ResearchSourceKind;
  readonly sourceClass: SourceClass;
  readonly reliability: number;
  readonly contentSha256: string;
  readonly deduplicated: boolean;
  readonly vaultPath: string;
  readonly sha256: string;
};

export type ResearchEvidenceRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly sourceRef: string;
  readonly specialist: string;
  readonly verbatimQuote: string;
  readonly interpretation: string;
  readonly uncertaintyNote: string;
  readonly claimTopic: string;
  readonly claimValue: unknown;
  readonly modelTag: string;
  readonly confidence: number;
  readonly sha256: string;
};

export type ResearchContradictionRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly findingId: string;
  readonly targetPath: string;
  readonly claimTopic: string;
  readonly findingValue: unknown;
  readonly targetValue: unknown;
  readonly modelScope: string;
  readonly status: 'open' | 'resolved';
  readonly resolution: string | null;
  readonly sha256: string;
};

export type ResearchFindingRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly claimTopic: string;
  readonly claimValue: unknown;
  readonly interpretation: string;
  readonly uncertaintyNote: string;
  readonly modelTag: string;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly contradictions: readonly ResearchContradictionRecord[];
  readonly canonicalStatus: 'draft' | 'candidate' | 'promoted';
  readonly sha256: string;
};

export type ResearchExperimentRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly findingId: string;
  readonly hypothesis: string;
  readonly nPerVariant: number;
  readonly scorer: string;
  readonly sha256: string;
};

export type ResearchExperimentRunRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly experimentId: string;
  readonly variant: 'a' | 'b';
  readonly trial: number;
  readonly score: number | null;
  readonly scoredBy: string;
  readonly sha256: string;
};

export type ResearchBriefRecord = {
  readonly id: string;
  readonly vaultPath: string;
  readonly title: string;
  readonly projectSlug: string;
  readonly questionId: string;
  readonly findingIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly openContradictionIds: readonly string[];
  readonly verificationStatus: VerificationStatus;
  readonly sha256: string;
};

export type ResearchSynthesisResult = {
  readonly researchRunId: string;
  readonly findings: readonly ResearchFindingRecord[];
  readonly skippedExistingFindingEvidenceIds: readonly string[];
  readonly unsynthesizedEvidenceIds: readonly string[];
};

export type FindingVerificationReport = {
  readonly findingId: string;
  readonly vaultPath: string;
  readonly ok: boolean;
  readonly verificationStatus: VerificationStatus;
  readonly independentSourceCount: number;
  readonly verifiedEvidenceCount: number;
  readonly openContradictionCount: number;
  readonly experimentValidated: boolean | null;
  readonly issues: readonly string[];
};

const nowIso = (): string => new Date().toISOString();

const makeProvenance = (
  method: string,
  actor: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  origin: 'os3-research-engine',
  method,
  actor,
  ...(extra ?? {}),
});

/**
 * OS 3.0 Vault-First Research Intelligence Engine.
 * Preserves OS2 evidence/verbatim/uncertainty/contradiction/experiment rigor while storing
 * all canonical entities as validated Markdown/YAML files through `VaultEngine`.
 */
export class Os3ResearchEngine {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;
  readonly #agents: Os3VaultAgentRegistry | undefined;

  constructor(options: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly agents?: Os3VaultAgentRegistry | undefined;
  }) {
    this.#vault = options.vault;
    this.#db = options.db;
    this.#agents = options.agents;
  }

  /**
   * Lists the migrated OS2 RESEARCH_INTELLIGENCE specialists from `04_AGENTS/`
   * (strictly preserving only existing repository agents).
   */
  listAvailableSpecialists(): ReadonlyArray<{ readonly name: string; readonly scope: string }> {
    if (!this.#agents) return [];
    return this.#agents
      .list()
      .filter((a) => a.class === 'Research' && typeof a.sections.Scope === 'string' && a.sections.Scope.trim().length > 0)
      .map((a) => ({ name: a.name, scope: a.sections.Scope! }));
  }

  /**
   * Uses OS2 keyword-scope scoring (`planResearch`) over the migrated Research roster.
   */
  planSpecialists(question: string, ownerSpecialists?: readonly string[]): ResearchPlan {
    const scopes = this.listAvailableSpecialists().map((s) => parseScope(s.name, s.scope));
    return planResearch(question, scopes, ownerSpecialists);
  }

  async createProject(input: {
    readonly idOverride?: string | undefined;
    readonly slug: string;
    readonly title: string;
    readonly description?: string | undefined;
    readonly status?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchProjectRecord> {
    const cleanSlug = slugify(input.slug);
    const vaultPath = `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${cleanSlug}.md`;
    const id = input.idOverride?.trim() || `rprj-${cleanSlug}`;
    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;

    // Idempotent check: return existing project if already created
    const existing = this.#db.getIndexEntry(vaultPath);
    if (existing) {
      return {
        id: String(existing.frontmatter.id ?? id),
        slug: cleanSlug,
        title: existing.title,
        vaultPath,
        sha256: existing.sha256,
      };
    }

    const mappedStatus = input.status === 'closed' ? 'complete' : input.status === 'complete' ? 'complete' : 'active';
    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.research-project/v3',
        id,
        slug: cleanSlug,
        type: 'research_project',
        title: input.title.trim(),
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: mappedStatus,
        ...(input.status && input.status !== mappedStatus ? { legacy_status: input.status } : {}),
        version: 1,
        provenance: input.provenance ?? makeProvenance('createProject', actor),
        created_at: createdAt,
        updated_at: updatedAt,
        tags: ['xyp3rn', 'os3', 'research-project'],
      },
      `# Research Project: ${input.title.trim()}\n\n${input.description?.trim() || 'Active OS3 research project.'}`,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Create research project ${cleanSlug}`,
    });

    return {
      id,
      slug: cleanSlug,
      title: input.title.trim(),
      vaultPath: written.vaultPath,
      sha256: written.sha256,
    };
  }

  async createQuestion(input: {
    readonly idOverride?: string | undefined;
    readonly projectSlug: string;
    readonly question: string;
    readonly intendedUse: string;
    readonly specialists?: readonly string[] | undefined;
    readonly urls?: readonly string[] | undefined;
    readonly parentQuestionId?: string | undefined;
    readonly targets?: readonly ResearchTargetRef[] | undefined;
    readonly status?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchQuestionRecord> {
    const projectSlug = slugify(input.projectSlug);
    if (!input.question.trim()) throw new Error('Research Question cannot be empty');
    if (!input.intendedUse.trim()) throw new Error('Research Question requires intendedUse');

    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const rawId = input.idOverride?.trim();
    const shortId = rawId ? rawId.replace(/^rqst-/i, '').slice(0, 12) : randomUUID().slice(0, 8);
    const id = rawId || `rqst-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/QUESTIONS/RQST-${shortId}-${slugify(input.question)}.md`;
    const mappedStatus =
      input.status === 'answered'
        ? 'answered'
        : input.status === 'abandoned' || input.status === 'cancelled'
          ? 'cancelled'
          : 'open';

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.research-question/v3',
        id,
        project_slug: projectSlug,
        project_ref: `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${projectSlug}.md`,
        ...(input.parentQuestionId ? { parent_question_id: input.parentQuestionId } : {}),
        type: 'research_question',
        title: input.question.trim(),
        intended_use: input.intendedUse.trim(),
        allowed_urls: input.urls ? [...input.urls] : [],
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: mappedStatus,
        ...(input.status && input.status !== mappedStatus ? { legacy_status: input.status } : {}),
        version: 1,
        specialists: input.specialists ? [...input.specialists] : [],
        ...(input.targets && input.targets.length > 0 ? { targets: input.targets } : {}),
        provenance: input.provenance ?? makeProvenance('createQuestion', actor),
        created_at: createdAt,
        updated_at: updatedAt,
        tags: ['xyp3rn', 'os3', 'research-question'],
      },
      [
        `# Research Question: ${input.question.trim()}`,
        '',
        `- **Project:** [[03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${projectSlug}|${projectSlug}]]`,
        `- **Intended Use:** ${input.intendedUse.trim()}`,
        ...(input.parentQuestionId ? [`- **Parent Question:** \`${input.parentQuestionId}\``] : []),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Create research question ${id}`,
    });

    return {
      id,
      projectSlug,
      question: input.question.trim(),
      intendedUse: input.intendedUse.trim(),
      vaultPath: written.vaultPath,
      sha256: written.sha256,
    };
  }

  /**
   * Workflow 2 — Question Decomposition: splits a parent question into scoped sub-questions,
   * selects matching existing Research specialists (`planResearch`), and binds brief targets.
   */
  async decomposeQuestion(input: {
    readonly questionPathOrId: string;
    readonly subQuestions: ReadonlyArray<{
      readonly question: string;
      readonly intendedUse?: string | undefined;
      readonly specialists?: readonly string[] | undefined;
      readonly targets?: readonly ResearchTargetRef[] | undefined;
    }>;
    readonly actor?: string | undefined;
  }): Promise<{
    readonly parentQuestionId: string;
    readonly parentVaultPath: string;
    readonly subQuestions: ReadonlyArray<{
      readonly record: ResearchQuestionRecord;
      readonly selectedSpecialists: readonly string[];
    }>;
  }> {
    const parentEntry = this.#findEntryByPathOrId(input.questionPathOrId, '03_RESEARCH_INTELLIGENCE/QUESTIONS/');
    if (!parentEntry) {
      throw new Error(`Research question not found: "${input.questionPathOrId}"`);
    }
    if (input.subQuestions.length === 0) {
      throw new Error('decomposeQuestion requires at least one sub-question');
    }

    const parentId = String(parentEntry.frontmatter.id);
    const projectSlug = String(parentEntry.frontmatter.project_slug ?? 'default');
    const parentIntended = String(parentEntry.frontmatter.intended_use ?? 'Structured question decomposition');
    const created: { readonly record: ResearchQuestionRecord; readonly selectedSpecialists: readonly string[] }[] = [];

    for (const sub of input.subQuestions) {
      const plan = this.planSpecialists(sub.question, sub.specialists);
      const selectedSpecialists = plan.selection.selected.map((s) => s.name);
      const rec = await this.createQuestion({
        projectSlug,
        question: sub.question,
        intendedUse: sub.intendedUse?.trim() || parentIntended,
        specialists: selectedSpecialists,
        parentQuestionId: parentId,
        targets: sub.targets,
        actor: input.actor ?? 'research-orchestrator',
      });
      created.push({ record: rec, selectedSpecialists });
    }

    return {
      parentQuestionId: parentId,
      parentVaultPath: parentEntry.vaultPath,
      subQuestions: created,
    };
  }

  async openResearchRun(input: {
    readonly idOverride?: string | undefined;
    readonly questionPathOrId: string;
    readonly selectedSpecialists?: readonly string[] | undefined;
    readonly orchestrator?: Os3Orchestrator | undefined;
    readonly status?: string | undefined;
    readonly errorDetail?: string | undefined;
    readonly expiresAt?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly completedAt?: string | null | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchRunRecord> {
    const qEntry = this.#findEntryByPathOrId(input.questionPathOrId, '03_RESEARCH_INTELLIGENCE/QUESTIONS/');
    if (!qEntry) {
      throw new Error(`Research question not found: "${input.questionPathOrId}"`);
    }

    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = input.createdAt ?? nowIso();
    const qId = String(qEntry.frontmatter.id);
    let selected = input.selectedSpecialists ? [...input.selectedSpecialists] : [];
    if (selected.length === 0 && this.#agents) {
      const plan = this.planSpecialists(qEntry.title);
      selected = plan.selection.selected.map((s) => s.name);
    }

    const job = this.#db.enqueueJob({
      kind: 'research',
      name: `research:${qId}`,
      input: { questionId: qId, questionPath: qEntry.vaultPath, selected },
      startImmediately: true,
    });

    const rawId = input.idOverride?.trim();
    const shortId = rawId ? rawId.replace(/^rrun-/i, '').slice(0, 12) : job.id.slice(0, 8);
    const runId = rawId || `rrun-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/RUNS/RRUN-${shortId}.md`;

    if (input.orchestrator && selected.length > 0 && this.#agents) {
      const existingSelected = selected.filter((name) => Boolean(this.#agents?.get(name)));
      if (existingSelected.length > 0) {
        await input.orchestrator.executeMultiAgent(
          `research-specialists:${runId}`,
          existingSelected.map((name) => ({
            stepId: name,
            agentName: name,
            input: { question: qEntry.title, researchRunId: runId },
          })),
        );
      }
    }

    const mappedStatus =
      input.status === 'running'
        ? 'running'
        : input.status === 'error'
          ? 'cancelled'
          : input.status === 'success' || input.status === undefined
            ? 'complete'
            : 'complete';

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: runId,
        type: 'research_run',
        title: `Research Run ${runId}: ${qEntry.title}`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: mappedStatus,
        ...(input.status ? { legacy_status: input.status } : {}),
        version: 1,
        question_id: qId,
        question_ref: qEntry.vaultPath,
        job_id: job.id,
        selected_specialists: selected,
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
        ...(input.errorDetail ? { error_detail: input.errorDetail } : {}),
        ...(input.completedAt !== undefined ? { completed_at: input.completedAt } : { completed_at: nowIso() }),
        provenance: input.provenance ?? makeProvenance('openResearchRun', actor),
        created_at: createdAt,
        updated_at: input.completedAt ?? createdAt,
        tags: ['xyp3rn', 'os3', 'research-run'],
      },
      [
        `# Research Run \`${runId}\``,
        '',
        `- **Question:** [[${qEntry.vaultPath.replace(/\.md$/, '')}|${qEntry.title}]]`,
        `- **SQLite Job ID:** \`${job.id}\``,
        `- **Selected Specialists (${selected.length}):** ${selected.join(', ') || '(none)'}`,
        ...(input.errorDetail ? [`- **Error Detail:** ${input.errorDetail}`] : []),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Open research run ${runId}`,
    });

    this.#db.completeJob(job.id, { runId, vaultPath: written.vaultPath, selected }, []);

    return {
      id: runId,
      jobId: job.id,
      questionId: qId,
      selectedSpecialists: selected,
      vaultPath: written.vaultPath,
      sha256: written.sha256,
    };
  }

  async registerSource(input: {
    readonly idOverride?: string | undefined;
    readonly kind: ResearchSourceKind;
    readonly uri: string;
    readonly title: string;
    readonly sourceText: string;
    readonly dawCategory?: DawResearchCategory | undefined;
    readonly evidenceTier?: EvidenceAttributionTier | undefined;
    readonly domainOverride?: 'KNOWLEDGE' | 'TECH' | 'RECORDS' | undefined;
    readonly createdAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchSourceRecord> {
    const uri = normalizeUri(input.uri);
    const textClean = input.sourceText.trim();
    if (!textClean) throw new Error('Source registration requires non-empty sourceText');
    const contentSha256 = sha256Hex(textClean);
    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = input.createdAt ?? nowIso();

    // Content-addressed deduplication across existing 02_KNOWLEDGE/SOURCES/
    const existingSources = this.#db.listIndexEntries('02_KNOWLEDGE', 5_000);
    for (const s of existingSources) {
      if (s.vaultPath.startsWith('02_KNOWLEDGE/SOURCES/') && s.frontmatter.content_sha256 === contentSha256) {
        return {
          id: String(s.frontmatter.id),
          uri: String(s.frontmatter.uri ?? uri),
          title: s.title,
          origin: (s.frontmatter.origin as ResearchSourceKind) ?? input.kind,
          sourceClass: (s.frontmatter.source_class as SourceClass) ?? 'unknown',
          reliability: Number(s.frontmatter.reliability ?? 0.3),
          contentSha256,
          deduplicated: true,
          vaultPath: s.vaultPath,
          sha256: s.sha256,
        };
      }
    }

    const rel = classifySource(input.kind, uri);
    const shortHash = contentSha256.slice(0, 8);
    const id = input.idOverride?.trim() || `src-${shortHash}`;
    const vaultPath = `02_KNOWLEDGE/SOURCES/SRC-${shortHash}-${slugify(input.title)}.md`;
    const tier: EvidenceAttributionTier =
      input.evidenceTier ??
      (rel.class === 'first_party' || rel.class === 'official' || rel.class === 'vendor'
        ? 'official_vendor_doc'
        : rel.class === 'studio_observation'
          ? 'studio_observation'
          : rel.class === 'independent_test'
            ? 'independent_benchmark'
            : rel.class === 'community'
              ? 'community_claim'
              : 'inference_unverified');

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.source/v3',
        id,
        type: 'source',
        title: input.title.trim(),
        domain: input.domainOverride ?? 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'approved',
        version: 1,
        origin: rel.class === 'first_party' ? 'first_party' : input.kind,
        source_class: rel.class,
        evidence_tier: tier,
        ...(input.dawCategory ? { daw_category: input.dawCategory } : {}),
        reliability: rel.score,
        reliability_inputs: rel.inputs,
        uri,
        content_sha256: contentSha256,
        media_class: 'document',
        verification_status: rel.score >= 0.7 ? 'verified' : 'unverified',
        provenance: input.provenance ?? makeProvenance('registerSource', actor, { uri, origin: input.kind }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: [
          'xyp3rn',
          'os3',
          'source',
          `reliability/${rel.class}`,
          ...(input.dawCategory ? [`daw/${input.dawCategory}`] : []),
        ],
      },
      [
        `# Source: ${input.title.trim()}`,
        '',
        `- **URI:** \`${uri}\``,
        `- **Class / Reliability:** \`${rel.class}\` (${rel.score}) · Tier: \`${tier}\``,
        ...(input.dawCategory ? [`- **DAW Research Category:** \`${input.dawCategory}\``] : []),
        '',
        '## Verbatim Source Text',
        '',
        textClean,
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Register verified source ${id}`,
    });

    return {
      id,
      uri,
      title: input.title.trim(),
      origin: input.kind,
      sourceClass: rel.class,
      reliability: rel.score,
      contentSha256,
      deduplicated: false,
      vaultPath: written.vaultPath,
      sha256: written.sha256,
    };
  }

  /**
   * Records an Evidence note strictly via `VaultEngine`:
   * - Requires an existing registered Source (`sourceRef`).
   * - Verifies `verbatimQuote` exists verbatim (whitespace-normalized) inside the Source document!
   * - Separates verbatim source statement (`verbatimQuote`) from interpretation (`interpretation`) & uncertainty (`uncertaintyNote`).
   */
  async recordEvidence(input: {
    readonly idOverride?: string | undefined;
    readonly sourceRef: string;
    readonly specialist: string;
    readonly verbatimQuote: string;
    readonly interpretation: string;
    readonly claimTopic: string;
    readonly claimValue: unknown;
    readonly modelTag: string;
    readonly confidence: number;
    readonly confidenceInputs: Record<string, unknown>;
    readonly uncertaintyNote: string;
    readonly researchRunId?: string | undefined;
    readonly verifyVerbatimQuote?: boolean | undefined;
    readonly evidenceTier?: EvidenceAttributionTier | undefined;
    readonly dawCategory?: DawResearchCategory | undefined;
    readonly hostInstalledVerified?: boolean | undefined;
    readonly createdAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
  }): Promise<ResearchEvidenceRecord> {
    const valErrors = validateEvidence({
      research_source_id: input.sourceRef,
      claim: input.interpretation,
      model_tag: input.modelTag,
      confidence: input.confidence,
      confidence_inputs: input.confidenceInputs,
      claim_topic: input.claimTopic,
      claim_value: input.claimValue,
      quote: input.verbatimQuote,
    });
    if (valErrors.length > 0) {
      throw new Error(`evidence rejected: ${valErrors.join('; ')}`);
    }
    if (!input.uncertaintyNote.trim()) {
      throw new Error('evidence rejected: uncertaintyNote is required to preserve epistemic uncertainty');
    }
    if (input.hostInstalledVerified === true && input.evidenceTier === 'official_vendor_doc') {
      throw new Error('evidence rejected: official_vendor_doc cannot set host_installed_verified=true');
    }

    const srcEntry = this.#findEntryByPathOrId(input.sourceRef, '02_KNOWLEDGE/SOURCES/');
    if (!srcEntry) {
      throw new Error(`evidence rejected: referenced source "${input.sourceRef}" not found in 02_KNOWLEDGE/SOURCES/`);
    }

    if (input.verifyVerbatimQuote ?? true) {
      const srcDoc = await this.#vault.read(srcEntry.vaultPath);
      const normBody = squashWhitespace(srcDoc.body).toLowerCase();
      const normQuote = squashWhitespace(input.verbatimQuote).toLowerCase();
      if (!normBody.includes(normQuote)) {
        throw new Error(
          `evidence rejected: verbatimQuote not found verbatim inside source "${srcEntry.vaultPath}"`,
        );
      }
    }

    const createdAt = input.createdAt ?? nowIso();
    const rawId = input.idOverride?.trim();
    const shortId = rawId ? rawId.replace(/^evid-/i, '').slice(0, 12) : randomUUID().slice(0, 8);
    const id = rawId || `evid-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-${shortId}-${slugify(input.claimTopic)}.md`;
    const tier: EvidenceAttributionTier =
      input.evidenceTier ??
      ((srcEntry.frontmatter.evidence_tier as EvidenceAttributionTier | undefined) ?? 'studio_observation');

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.evidence/v3',
        id,
        type: 'evidence',
        title: `Evidence (${input.claimTopic}): ${input.specialist}`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'approved',
        version: 1,
        verification_status: (input.verifyVerbatimQuote ?? true) ? 'verified' : 'incomplete',
        specialist: input.specialist,
        research_run_id: input.researchRunId ?? null,
        source_ref: srcEntry.vaultPath,
        source_id: srcEntry.frontmatter.id ?? srcEntry.vaultPath,
        evidence_tier: tier,
        ...(input.dawCategory ? { daw_category: input.dawCategory } : {}),
        ...(input.hostInstalledVerified !== undefined ? { host_installed_verified: input.hostInstalledVerified } : {}),
        verbatim_quote: input.verbatimQuote.trim(),
        interpretation: input.interpretation.trim(),
        uncertainty_note: input.uncertaintyNote.trim(),
        claim_topic: input.claimTopic.trim(),
        claim_value: input.claimValue,
        model_tag: input.modelTag.trim(),
        confidence: input.confidence,
        confidence_inputs: input.confidenceInputs,
        provenance: input.provenance ?? makeProvenance('recordEvidence', input.specialist, { sourceRef: srcEntry.vaultPath }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: [
          'xyp3rn',
          'os3',
          'evidence',
          `model/${input.modelTag.trim()}`,
          ...(input.dawCategory ? [`daw/${input.dawCategory}`] : []),
        ],
      },
      [
        `# Evidence \`${id}\``,
        '',
        `- **Source:** [[${srcEntry.vaultPath.replace(/\.md$/, '')}|${srcEntry.title}]]`,
        `- **Attribution Tier:** \`${tier}\` · **Model Scope:** \`${input.modelTag.trim()}\` · **Confidence:** \`${input.confidence}\``,
        '',
        '## Verbatim Source Statement',
        '',
        `> ${input.verbatimQuote.trim()}`,
        '',
        '## Analyst Interpretation',
        '',
        input.interpretation.trim(),
        '',
        '## Uncertainty & Limitations',
        '',
        input.uncertaintyNote.trim(),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.specialist,
      reason: `Record verified evidence ${id}`,
    });

    return {
      id,
      vaultPath: written.vaultPath,
      sourceRef: srcEntry.vaultPath,
      specialist: input.specialist,
      verbatimQuote: input.verbatimQuote.trim(),
      interpretation: input.interpretation.trim(),
      uncertaintyNote: input.uncertaintyNote.trim(),
      claimTopic: input.claimTopic.trim(),
      claimValue: input.claimValue,
      modelTag: input.modelTag.trim(),
      confidence: input.confidence,
      sha256: written.sha256,
    };
  }

  /**
   * Synthesizes a Research Finding from verified Evidence notes:
   * - Requires >= 1 valid `evidence_ids` referencing existing `xyp3rn.evidence/v3` files.
   * - Computes OS2 finding confidence (`computeFindingConfidence`) with single-source cap (0.75).
   * - Never silently overwrites prior findings (uses unique versioned ID + `writeMode: 'reject-overwrite'`).
   * - Runs OS2 Contradiction Detection across canonical knowledge + existing findings, automatically creating
   *   `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/` notes when conflicting claims with overlapping model scopes are found.
   */
  async recordFinding(input: {
    readonly idOverride?: string | undefined;
    readonly evidenceIds: readonly string[];
    readonly claimTopic: string;
    readonly claimValue: unknown;
    readonly interpretation: string;
    readonly uncertaintyNote: string;
    readonly modelTag: string;
    readonly researchRunId?: string | undefined;
    readonly dawCategory?: DawResearchCategory | undefined;
    readonly evidenceTier?: EvidenceAttributionTier | undefined;
    readonly createdAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchFindingRecord> {
    if (input.evidenceIds.length === 0) {
      throw new Error('finding rejected: at least one evidence ID is required');
    }

    const evEntries: {
      readonly id: string;
      readonly vaultPath: string;
      readonly confidence: number;
      readonly reliability: number;
      readonly sourceRef: string;
      readonly modelTag: string;
    }[] = [];

    for (const evId of input.evidenceIds) {
      const entry = this.#findEntryByPathOrId(evId, '03_RESEARCH_INTELLIGENCE/EVIDENCE/');
      if (!entry) {
        throw new Error(`finding rejected: unknown evidence "${evId}"`);
      }
      const evModel = String(entry.frontmatter.model_tag ?? '');
      if (evModel !== input.modelTag && evModel !== MODEL_AGNOSTIC) {
        throw new Error(
          `finding rejected: evidence "${evId}" is tagged "${evModel}", finding is "${input.modelTag}"`,
        );
      }
      const srcRef = String(entry.frontmatter.source_ref ?? '');
      const srcEntry = this.#findEntryByPathOrId(srcRef, '02_KNOWLEDGE/SOURCES/');
      const reliability = srcEntry ? Number(srcEntry.frontmatter.reliability ?? 0.3) : 0.3;

      evEntries.push({
        id: String(entry.frontmatter.id),
        vaultPath: entry.vaultPath,
        confidence: Number(entry.frontmatter.confidence ?? 0.5),
        reliability,
        sourceRef: srcRef,
        modelTag: evModel,
      });
    }

    const confCalc = computeFindingConfidence(
      evEntries.map((e) => ({
        confidence: e.confidence,
        reliability: e.reliability,
        research_source_id: e.sourceRef,
      })),
    );
    const roundedConfidence = Math.round(confCalc.confidence * 1000) / 1000;

    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = input.createdAt ?? nowIso();
    const rawId = input.idOverride?.trim();
    const shortId = rawId ? rawId.replace(/^find-/i, '').slice(0, 12) : randomUUID().slice(0, 8);
    const id = rawId || `find-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-${shortId}-${slugify(input.claimTopic)}.md`;

    // Detect contradictions against canonical knowledge and existing findings BEFORE promoting
    const detectedContradictions: ResearchContradictionRecord[] = [];
    const serializedFindingVal = JSON.stringify(input.claimValue);

    const candidatesToCompare = [
      ...this.#db.listIndexEntries('02_KNOWLEDGE', 5_000).filter((e) => e.vaultPath.startsWith('02_KNOWLEDGE/CANONICAL/')),
      ...this.#db.listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000).filter((e) => e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/')),
    ];

    for (const existing of candidatesToCompare) {
      if (String(existing.frontmatter.id ?? '') === id) continue;
      // Compare structured claim_topic / model_tag on findings or claims[] on canonical knowledge
      const pairs: { readonly topic: string; readonly value: unknown; readonly scope: string }[] = [];
      if (typeof existing.frontmatter.claim_topic === 'string') {
        pairs.push({
          topic: existing.frontmatter.claim_topic,
          value: existing.frontmatter.claim_value,
          scope: String(existing.frontmatter.model_tag ?? MODEL_AGNOSTIC),
        });
      }
      if (Array.isArray(existing.frontmatter.claims)) {
        for (const c of existing.frontmatter.claims as Record<string, unknown>[]) {
          if (c && typeof c.topic === 'string') {
            pairs.push({
              topic: c.topic,
              value: c.value,
              scope: String(c.model_scope ?? existing.frontmatter.model_scope ?? MODEL_AGNOSTIC),
            });
          }
        }
      }

      for (const pair of pairs) {
        if (
          pair.topic === input.claimTopic &&
          modelScopesOverlap(pair.scope, input.modelTag) &&
          JSON.stringify(pair.value) !== serializedFindingVal
        ) {
          const contrId = `cntr-${randomUUID().slice(0, 8)}`;
          const contrPath = `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/CNTR-${contrId.slice(5)}-${slugify(input.claimTopic)}.md`;
          const contrContent = serializeFrontmatterDocument(
            {
              schema: 'xyp3rn.contradiction/v3',
              id: contrId,
              type: 'contradiction',
              title: `Contradiction on ${input.claimTopic}: ${id} vs ${String(existing.frontmatter.id ?? existing.title)}`,
              domain: 'RESEARCH_INTELLIGENCE',
              sector: '03_RESEARCH_INTELLIGENCE',
              status: 'open',
              version: 1,
              finding_id: id,
              finding_path: vaultPath,
              target_path: existing.vaultPath,
              claim_topic: input.claimTopic,
              finding_value: input.claimValue,
              target_value: pair.value,
              model_scope: input.modelTag,
              target_model_scope: pair.scope,
              resolution: null,
              provenance: makeProvenance('recordFinding:contradictionEngine', 'contradiction-engine'),
              created_at: createdAt,
              updated_at: createdAt,
              tags: ['xyp3rn', 'os3', 'contradiction', 'open'],
            },
            [
              `# Contradiction Alert: \`${input.claimTopic}\``,
              '',
              `- **New Finding:** \`${id}\` (\`${serializedFindingVal}\`, scope \`${input.modelTag}\`)`,
              `- **Conflicting Record:** [[${existing.vaultPath.replace(/\.md$/, '')}|${existing.title}]] (\`${JSON.stringify(pair.value)}\`, scope \`${pair.scope}\`)`,
              '- **Status:** `open` (blocks canonical promotion until resolved manually or via Experiment)',
            ].join('\n'),
          );

          const contrWritten = await this.#vault.write({
            vaultPath: contrPath,
            content: contrContent,
            actor: 'contradiction-engine',
            reason: `Auto-detected conflict on topic ${input.claimTopic}`,
          });

          detectedContradictions.push({
            id: contrId,
            vaultPath: contrWritten.vaultPath,
            findingId: id,
            targetPath: existing.vaultPath,
            claimTopic: input.claimTopic,
            findingValue: input.claimValue,
            targetValue: pair.value,
            modelScope: input.modelTag,
            status: 'open',
            resolution: null,
            sha256: contrWritten.sha256,
          });
        }
      }
    }

    const verificationStatus: VerificationStatus =
      detectedContradictions.length > 0
        ? 'contradiction_blocked'
        : confCalc.inputs.independent_sources >= 2
          ? 'corroborated'
          : 'single_source_capped';

    const distinctSourceRefs = [...new Set(evEntries.map((e) => e.sourceRef))];
    const findingContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.finding/v3',
        id,
        type: 'finding',
        title: `Finding (${input.claimTopic}): ${input.interpretation.slice(0, 72)}`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: detectedContradictions.length > 0 ? 'contradiction_blocked' : 'draft',
        verification_status: verificationStatus,
        version: 1,
        research_run_id: input.researchRunId ?? null,
        claim_topic: input.claimTopic.trim(),
        claim_value: input.claimValue,
        interpretation: input.interpretation.trim(),
        uncertainty_note: input.uncertaintyNote.trim(),
        model_tag: input.modelTag.trim(),
        ...(input.dawCategory ? { daw_category: input.dawCategory } : {}),
        ...(input.evidenceTier ? { evidence_tier: input.evidenceTier } : {}),
        confidence: roundedConfidence,
        confidence_inputs: confCalc.inputs,
        evidence_ids: evEntries.map((e) => e.id),
        evidence_refs: evEntries.map((e) => e.vaultPath),
        source_refs: distinctSourceRefs,
        contradiction_ids: detectedContradictions.map((c) => c.id),
        canonical_status: 'draft',
        provenance: input.provenance ?? makeProvenance('recordFinding', actor, { evidenceIds: evEntries.map((e) => e.id) }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: [
          'xyp3rn',
          'os3',
          'finding',
          `model/${input.modelTag.trim()}`,
          ...(input.dawCategory ? [`daw/${input.dawCategory}`] : []),
        ],
      },
      [
        `# Research Finding \`${id}\``,
        '',
        `- **Topic:** \`${input.claimTopic.trim()}\` = \`${serializedFindingVal}\``,
        `- **Model Scope:** \`${input.modelTag.trim()}\` · **Verification:** \`${verificationStatus}\``,
        `- **Confidence:** \`${roundedConfidence}\` (${confCalc.inputs.independent_sources} independent source(s))`,
        '',
        '## Interpretation',
        '',
        input.interpretation.trim(),
        '',
        '## Uncertainty & Scope Limits',
        '',
        input.uncertaintyNote.trim(),
        '',
        '## Supporting Evidence',
        '',
        ...evEntries.map((e) => `- [[${e.vaultPath.replace(/\.md$/, '')}|${e.id}]]`),
        ...(detectedContradictions.length > 0
          ? [
              '',
              '## Open Contradictions',
              '',
              ...detectedContradictions.map((c) => `- [[${c.vaultPath.replace(/\.md$/, '')}|${c.id}]]`),
            ]
          : []),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content: findingContent,
      actor,
      writeMode: 'reject-overwrite',
      reason: `Record synthesized finding ${id} (never overwrites prior findings)`,
    });

    return {
      id,
      vaultPath: written.vaultPath,
      claimTopic: input.claimTopic.trim(),
      claimValue: input.claimValue,
      interpretation: input.interpretation.trim(),
      uncertaintyNote: input.uncertaintyNote.trim(),
      modelTag: input.modelTag.trim(),
      confidence: roundedConfidence,
      evidenceIds: evEntries.map((e) => e.id),
      contradictions: detectedContradictions,
      canonicalStatus: 'draft',
      sha256: written.sha256,
    };
  }

  /**
   * Workflow 8 — Deterministic Synthesis (OS3 Vault parity for `synthesis/synthesize.ts`):
   * groups un-synthesized `EVID-*` records for `researchRunId` by `(claim_topic, JSON(claim_value), model_tag)`,
   * idempotently recording one `FIND-*` note per unique group without duplicating already synthesized evidence.
   */
  async synthesizeRun(researchRunId: string, actor = 'research-orchestrator'): Promise<ResearchSynthesisResult> {
    const allResearch = this.#db.listIndexEntries('03_RESEARCH_INTELLIGENCE', 10_000);
    const runEvidence = allResearch
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/EVIDENCE/') &&
          e.frontmatter.research_run_id === researchRunId,
      )
      .sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));

    const existingFindings = allResearch.filter((e) => e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/'));
    const alreadySynthesizedIds = new Set<string>();
    for (const f of existingFindings) {
      const ids = Array.isArray(f.frontmatter.evidence_ids) ? f.frontmatter.evidence_ids.map(String) : [];
      for (const id of ids) alreadySynthesizedIds.add(id);
    }

    const skippedExistingFindingEvidenceIds: string[] = [];
    const unsynthesizedEvidenceIds: string[] = [];
    const groups = new Map<string, typeof runEvidence>();

    for (const ev of runEvidence) {
      const evId = String(ev.frontmatter.id);
      if (alreadySynthesizedIds.has(evId)) {
        skippedExistingFindingEvidenceIds.push(evId);
        continue;
      }
      const topic = typeof ev.frontmatter.claim_topic === 'string' ? ev.frontmatter.claim_topic.trim() : '';
      if (!topic || ev.frontmatter.claim_value === undefined) {
        unsynthesizedEvidenceIds.push(evId);
        continue;
      }
      const modelTag = String(ev.frontmatter.model_tag ?? MODEL_AGNOSTIC);
      const key = JSON.stringify([topic, ev.frontmatter.claim_value, modelTag]);
      groups.set(key, [...(groups.get(key) ?? []), ev]);
    }

    const findings: ResearchFindingRecord[] = [];
    for (const group of groups.values()) {
      const sorted = [...group].sort(
        (a, b) =>
          Number(b.frontmatter.confidence ?? 0) - Number(a.frontmatter.confidence ?? 0) ||
          String(a.frontmatter.id).localeCompare(String(b.frontmatter.id)),
      );
      const best = sorted[0]!;
      const finding = await this.recordFinding({
        evidenceIds: group.map((g) => String(g.frontmatter.id)),
        claimTopic: String(best.frontmatter.claim_topic),
        claimValue: best.frontmatter.claim_value,
        interpretation: String(best.frontmatter.interpretation ?? best.title),
        uncertaintyNote: group
          .map((g) => String(g.frontmatter.uncertainty_note ?? '').trim())
          .filter(Boolean)
          .join(' | '),
        modelTag: String(best.frontmatter.model_tag ?? MODEL_AGNOSTIC),
        researchRunId,
        actor,
      });
      findings.push(finding);
    }

    return {
      researchRunId,
      findings,
      skippedExistingFindingEvidenceIds,
      unsynthesizedEvidenceIds,
    };
  }

  /**
   * Workflow 7 — Verification: inspects cited source checksums/existence, verbatim quote preservation,
   * confidence calculation vs independent source count, open contradictions, and optional experiment validation.
   */
  async verifyFinding(
    findingPathOrId: string,
    experimentPathOrId?: string,
  ): Promise<FindingVerificationReport> {
    const fEntry = this.#findEntryByPathOrId(findingPathOrId, '03_RESEARCH_INTELLIGENCE/FINDINGS/');
    if (!fEntry) throw new Error(`Finding not found: "${findingPathOrId}"`);
    const doc = await this.#vault.read(fEntry.vaultPath);
    const fm = doc.frontmatter;
    const findingId = String(fm.id);
    const issues: string[] = [];

    const evidenceIds = Array.isArray(fm.evidence_ids) ? fm.evidence_ids.map(String) : [];
    const independentSources = new Set<string>();
    let verifiedEvidenceCount = 0;

    for (const evId of evidenceIds) {
      const evEntry = this.#findEntryByPathOrId(evId, '03_RESEARCH_INTELLIGENCE/EVIDENCE/');
      if (!evEntry) {
        issues.push(`Missing cited evidence: ${evId}`);
        continue;
      }
      const evDoc = await this.#vault.read(evEntry.vaultPath);
      const srcRef = String(evDoc.frontmatter.source_ref ?? '');
      const srcEntry = this.#findEntryByPathOrId(srcRef, '02_KNOWLEDGE/SOURCES/');
      if (!srcEntry) {
        issues.push(`Evidence ${evId} references missing source ${srcRef}`);
        continue;
      }
      const srcDoc = await this.#vault.read(srcEntry.vaultPath);
      const normBody = squashWhitespace(srcDoc.body).toLowerCase();
      const quote = String(evDoc.frontmatter.verbatim_quote ?? '');
      if (!quote.trim() || !normBody.includes(squashWhitespace(quote).toLowerCase())) {
        issues.push(`Verbatim quote verification failed for evidence ${evId} against ${srcEntry.vaultPath}`);
        continue;
      }
      independentSources.add(String(srcEntry.frontmatter.id ?? srcEntry.vaultPath));
      verifiedEvidenceCount += 1;
    }

    const openContradictions = this.#db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') &&
          e.frontmatter.status === 'open' &&
          (e.frontmatter.finding_id === findingId || e.frontmatter.target_path === fEntry.vaultPath),
      );

    if (openContradictions.length > 0) {
      issues.push(`${openContradictions.length} open contradiction(s) block canonical verification`);
    }

    let experimentValidated: boolean | null = null;
    if (experimentPathOrId) {
      const expSummary = this.summarizeExperimentRuns(experimentPathOrId);
      experimentValidated = expSummary.validated;
      if (!expSummary.validated) {
        issues.push(`Experiment "${experimentPathOrId}" not validated: ${expSummary.reason}`);
      }
    }

    const conf = Number(fm.confidence ?? 0);
    if (independentSources.size === 1 && conf > 0.75 + 1e-6) {
      issues.push(`Single-source confidence ${conf} exceeds 0.75 rubric cap`);
    }

    const verificationStatus: VerificationStatus =
      issues.some((i) => i.includes('Verbatim') || i.includes('Missing') || i.includes('exceeds'))
        ? 'rejected'
        : openContradictions.length > 0
          ? 'contradiction_blocked'
          : experimentValidated === false
            ? 'unverified'
            : independentSources.size >= 2 || experimentValidated === true
              ? 'verified'
              : 'single_source_capped';

    return {
      findingId,
      vaultPath: fEntry.vaultPath,
      ok: issues.length === 0,
      verificationStatus,
      independentSourceCount: independentSources.size,
      verifiedEvidenceCount,
      openContradictionCount: openContradictions.length,
      experimentValidated,
      issues,
    };
  }

  /**
   * Tier 1 Findings Library Decision (`accept` | `reject`, matching OS2 `xyp_decide_finding`).
   * Recorded once per finding in SQLite `pending_approvals` and reflected in the Finding frontmatter.
   */
  async recordFindingDecision(input: {
    readonly findingPathOrId: string;
    readonly decision: 'accept' | 'reject';
    readonly approver: string;
    readonly reason: string;
  }): Promise<{ readonly findingId: string; readonly approvalId: string; readonly decision: 'accept' | 'reject' }> {
    if (!input.approver.trim() || !input.reason.trim()) {
      throw new Error('Finding decision requires non-empty human approver and reason');
    }
    const fEntry = this.#findEntryByPathOrId(input.findingPathOrId, '03_RESEARCH_INTELLIGENCE/FINDINGS/');
    if (!fEntry) throw new Error(`Finding not found: "${input.findingPathOrId}"`);
    const findingId = String(fEntry.frontmatter.id);

    const doc = await this.#vault.read(fEntry.vaultPath, input.approver);
    if (doc.frontmatter.owner_decision === 'accepted' || doc.frontmatter.owner_decision === 'rejected') {
      throw new Error(`Finding "${findingId}" is already decided (${String(doc.frontmatter.owner_decision)})`);
    }

    const appr = this.#db.queueApproval({
      itemType: 'vault_promotion',
      itemId: `research-decision:${findingId}`,
      proposer: 'research-orchestrator',
      request: {
        tier: 'findings_library_decision',
        findingId,
        findingPath: fEntry.vaultPath,
        decision: input.decision,
      },
    });
    this.#db.decideApproval({
      approvalId: appr.id,
      decision: input.decision === 'accept' ? 'approved' : 'rejected',
      approver: input.approver.trim(),
      reason: input.reason.trim(),
    });

    const mappedDecision = input.decision === 'accept' ? 'accepted' : 'rejected';
    const updatedContent = serializeFrontmatterDocument(
      {
        ...doc.frontmatter,
        owner_decision: mappedDecision,
        decided_by: input.approver.trim(),
        decided_at: nowIso(),
        decision_reason: input.reason.trim(),
        updated_at: nowIso(),
      },
      `${doc.body.trim()}\n\n## Tier-1 Findings Library Decision\n\n- **Decision:** \`${mappedDecision}\` by \`${input.approver.trim()}\`\n- **Reason:** ${input.reason.trim()}`,
    );

    await this.#vault.update({
      vaultPath: doc.vaultPath,
      content: updatedContent,
      actor: input.approver.trim(),
      expectedSha256: doc.sha256,
      reason: `Record Findings Library decision (${mappedDecision})`,
    });

    return {
      findingId,
      approvalId: appr.id,
      decision: input.decision,
    };
  }

  /**
   * Workflow 9 — Research Brief Generation: creates a validated `03_RESEARCH_INTELLIGENCE/BRIEFS/BRF-*.md`
   * report preserving exact source attribution, verbatim quotes, synthesized findings, uncertainty caveats,
   * and any open contradiction warnings cleanly.
   */
  async generateBrief(input: {
    readonly questionPathOrId: string;
    readonly title?: string | undefined;
    readonly findingPathsOrIds?: readonly string[] | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchBriefRecord> {
    const qEntry = this.#findEntryByPathOrId(input.questionPathOrId, '03_RESEARCH_INTELLIGENCE/QUESTIONS/');
    if (!qEntry) throw new Error(`Research question not found: "${input.questionPathOrId}"`);
    const questionId = String(qEntry.frontmatter.id);
    const projectSlug = String(qEntry.frontmatter.project_slug ?? 'research');
    const actor = input.actor ?? 'research-orchestrator';
    const createdAt = nowIso();

    const allResearch = this.#db.listIndexEntries('03_RESEARCH_INTELLIGENCE', 10_000);
    const runs = allResearch.filter(
      (e) =>
        e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/RUNS/') &&
        e.frontmatter.question_id === questionId,
    );
    const runIds = new Set(runs.map((r) => String(r.frontmatter.id)));

    const findingEntries = input.findingPathsOrIds?.length
      ? input.findingPathsOrIds
          .map((f) => this.#findEntryByPathOrId(f, '03_RESEARCH_INTELLIGENCE/FINDINGS/'))
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : allResearch.filter(
          (e) =>
            e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/') &&
            typeof e.frontmatter.research_run_id === 'string' &&
            runIds.has(e.frontmatter.research_run_id),
        );

    const findingIds: string[] = [];
    const evidenceIds = new Set<string>();
    const sourceRefs = new Set<string>();
    const openContradictionIds = new Set<string>();
    const evidenceQuotes: string[] = [];
    const uncertaintyLines: string[] = [];

    for (const f of findingEntries) {
      const fid = String(f.frontmatter.id);
      findingIds.push(fid);
      const evs = Array.isArray(f.frontmatter.evidence_ids) ? f.frontmatter.evidence_ids.map(String) : [];
      for (const eid of evs) {
        evidenceIds.add(eid);
        const ev = this.#findEntryByPathOrId(eid, '03_RESEARCH_INTELLIGENCE/EVIDENCE/');
        if (ev) {
          if (typeof ev.frontmatter.source_ref === 'string') sourceRefs.add(ev.frontmatter.source_ref);
          evidenceQuotes.push(
            `- [${fid}/${eid}] \`${String(ev.frontmatter.model_tag ?? MODEL_AGNOSTIC)}\` (${String(ev.frontmatter.evidence_tier ?? 'source')}): "${String(ev.frontmatter.verbatim_quote ?? '')}"`,
          );
          if (typeof ev.frontmatter.uncertainty_note === 'string' && ev.frontmatter.uncertainty_note.trim()) {
            uncertaintyLines.push(`- ${fid}: ${ev.frontmatter.uncertainty_note.trim()}`);
          }
        }
      }
      for (const c of allResearch) {
        if (
          c.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') &&
          c.frontmatter.status === 'open' &&
          (c.frontmatter.finding_id === fid || c.frontmatter.target_path === f.vaultPath)
        ) {
          openContradictionIds.add(String(c.frontmatter.id));
        }
      }
    }

    const verificationStatus: VerificationStatus =
      openContradictionIds.size > 0
        ? 'contradiction_blocked'
        : sourceRefs.size >= 2
          ? 'corroborated'
          : findingIds.length > 0
            ? 'single_source_capped'
            : 'incomplete';

    const shortId = randomUUID().slice(0, 8);
    const id = `brf-${shortId}`;
    const briefTitle = input.title?.trim() || `Research Brief: ${qEntry.title}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/BRIEFS/BRF-${shortId}-${slugify(briefTitle)}.md`;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id,
        type: 'research_brief',
        title: briefTitle,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: openContradictionIds.size > 0 ? 'contradiction_blocked' : 'complete',
        verification_status: verificationStatus,
        version: 1,
        project_slug: projectSlug,
        project_ref: `03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${projectSlug}.md`,
        question_id: questionId,
        question_ref: qEntry.vaultPath,
        run_ids: [...runIds],
        finding_ids: findingIds,
        evidence_ids: [...evidenceIds],
        source_refs: [...sourceRefs],
        open_contradiction_ids: [...openContradictionIds],
        provenance: makeProvenance('generateBrief', actor, { questionId, findingCount: findingIds.length }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: ['xyp3rn', 'os3', 'research-brief'],
      },
      [
        `# ${briefTitle}`,
        '',
        `- **Project:** [[03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-${projectSlug}|${projectSlug}]]`,
        `- **Question:** [[${qEntry.vaultPath.replace(/\.md$/, '')}|${qEntry.title}]]`,
        `- **Intended Use:** ${String(qEntry.frontmatter.intended_use ?? 'Unspecified')}`,
        `- **Verification Status:** \`${verificationStatus}\``,
        '',
        '## Synthesized Findings',
        ...(findingEntries.length > 0
          ? findingEntries.map(
              (f) =>
                `- [[${f.vaultPath.replace(/\.md$/, '')}|${String(f.frontmatter.id)}]] (\`${String(f.frontmatter.claim_topic)}\`, conf=${String(f.frontmatter.confidence)}): ${String(f.frontmatter.interpretation ?? f.title)}`,
            )
          : ['- (No findings synthesized yet for this question)']),
        '',
        '## Verbatim Source Evidence (Distinct from Inference)',
        ...(evidenceQuotes.length > 0 ? evidenceQuotes : ['- (No evidence citations attached)']),
        '',
        '## Uncertainties, Scope Limits & Contradictions',
        ...(uncertaintyLines.length > 0 ? uncertaintyLines : ['- Preserve model/host scope limits; no extrapolation beyond verified sources.']),
        ...(openContradictionIds.size > 0
          ? [
              '',
              `> [!WARNING] ${openContradictionIds.size} open contradiction(s) block canonical promotion: ${[...openContradictionIds].join(', ')}`,
            ]
          : []),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Generate research brief ${id} for ${questionId}`,
    });

    return {
      id,
      vaultPath: written.vaultPath,
      title: briefTitle,
      projectSlug,
      questionId,
      findingIds,
      evidenceIds: [...evidenceIds],
      sourceRefs: [...sourceRefs],
      openContradictionIds: [...openContradictionIds],
      verificationStatus,
      sha256: written.sha256,
    };
  }

  /**
   * Resolves an open Contradiction note via compare-and-swap update on `03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/`.
   */
  async resolveContradiction(input: {
    readonly contradictionPathOrId: string;
    readonly method: 'manual' | 'experiment';
    readonly reason: string;
    readonly experimentRef?: string | undefined;
    readonly actor: string;
  }): Promise<ResearchContradictionRecord> {
    if (!input.reason.trim()) throw new Error('Contradiction resolution requires a reason');
    if (input.method === 'experiment' && !input.experimentRef?.trim()) {
      throw new Error('Experiment-based contradiction resolution requires experimentRef');
    }

    const entry = this.#findEntryByPathOrId(input.contradictionPathOrId, '03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/');
    if (!entry) throw new Error(`Contradiction not found: "${input.contradictionPathOrId}"`);
    if (entry.frontmatter.status !== 'open') {
      throw new Error(`Contradiction "${entry.vaultPath}" is already resolved`);
    }

    const doc = await this.#vault.read(entry.vaultPath, input.actor);
    const updatedContent = serializeFrontmatterDocument(
      {
        ...doc.frontmatter,
        status: 'resolved',
        resolution_method: input.method,
        resolution: input.reason.trim(),
        experiment_ref: input.experimentRef ?? null,
        resolved_by: input.actor,
        resolved_at: new Date().toISOString(),
      },
      `${doc.body.trim()}\n\n## Resolution (${input.method})\n\nResolved by \`${input.actor}\`: ${input.reason.trim()}`,
    );

    const updated = await this.#vault.update({
      vaultPath: doc.vaultPath,
      content: updatedContent,
      actor: input.actor,
      expectedSha256: doc.sha256,
      reason: `Resolve contradiction via ${input.method}`,
    });

    return {
      id: String(doc.frontmatter.id),
      vaultPath: updated.vaultPath,
      findingId: String(doc.frontmatter.finding_id ?? ''),
      targetPath: String(doc.frontmatter.target_path ?? ''),
      claimTopic: String(doc.frontmatter.claim_topic ?? ''),
      findingValue: doc.frontmatter.finding_value,
      targetValue: doc.frontmatter.target_value,
      modelScope: String(doc.frontmatter.model_scope ?? MODEL_AGNOSTIC),
      status: 'resolved',
      resolution: input.reason.trim(),
      sha256: updated.sha256,
    };
  }

  /**
   * Queues a Finding for human review in `pending_approvals`.
   * Blocks immediately if any open Contradiction references the Finding.
   */
  requestCanonicalPromotion(input: {
    readonly findingPathOrId: string;
    readonly proposer: string;
  }): PendingApprovalRecord {
    const fEntry = this.#findEntryByPathOrId(input.findingPathOrId, '03_RESEARCH_INTELLIGENCE/FINDINGS/');
    if (!fEntry) throw new Error(`Finding not found: "${input.findingPathOrId}"`);

    const findingId = String(fEntry.frontmatter.id);
    const openContradictions = this.#db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') &&
          e.frontmatter.status === 'open' &&
          (e.frontmatter.finding_id === findingId || e.frontmatter.target_path === fEntry.vaultPath),
      );

    if (openContradictions.length > 0) {
      throw new Error(
        `Promotion blocked: finding "${findingId}" has ${openContradictions.length} open contradiction(s) (${openContradictions.map((c) => String(c.frontmatter.id)).join(', ')})`,
      );
    }

    return this.#db.queueApproval({
      itemType: 'vault_promotion',
      itemId: findingId,
      proposer: input.proposer,
      request: {
        findingId,
        findingPath: fEntry.vaultPath,
        claimTopic: fEntry.frontmatter.claim_topic,
        confidence: fEntry.frontmatter.confidence,
        modelTag: fEntry.frontmatter.model_tag,
      },
    });
  }

  /**
   * Promotes an explicitly human-approved Finding into `02_KNOWLEDGE/CANONICAL/` via `VaultEngine.promote()`.
   */
  async promoteFindingToCanonical(input: {
    readonly findingPathOrId: string;
    readonly approvalId: string;
    readonly targetSlug: string;
    readonly title: string;
  }) {
    const fEntry = this.#findEntryByPathOrId(input.findingPathOrId, '03_RESEARCH_INTELLIGENCE/FINDINGS/');
    if (!fEntry) throw new Error(`Finding not found: "${input.findingPathOrId}"`);
    const doc = await this.#vault.read(fEntry.vaultPath);
    const fm = doc.frontmatter as Record<string, unknown>;
    const findingId = String(fm.id ?? '');

    const openContradictions = this.#db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') &&
          e.frontmatter.status === 'open' &&
          (e.frontmatter.finding_id === findingId || e.frontmatter.target_path === fEntry.vaultPath),
      );
    if (openContradictions.length > 0) {
      throw new Error(
        `Promotion blocked: finding "${findingId}" still has ${openContradictions.length} open contradiction(s)`,
      );
    }

    const evidenceIds = Array.isArray(fm.evidence_ids) ? fm.evidence_ids.map(String) : [];
    const sourceRefs = Array.isArray(fm.evidence_refs) ? fm.evidence_refs.map(String) : [];

    return this.#vault.promote({
      approvalId: input.approvalId,
      targetVaultPath: `02_KNOWLEDGE/CANONICAL/KNOW-${slugify(input.targetSlug)}.md`,
      entityId: `know-${slugify(input.targetSlug)}`,
      title: input.title,
      body: `${String(fm.interpretation ?? doc.body)}\n\n- **Source Finding:** [[${fEntry.vaultPath.replace(/\.md$/, '')}|${String(fm.id)}]]\n- **Uncertainty Note:** ${String(fm.uncertainty_note ?? 'Preserved')}`,
      domain: 'KNOWLEDGE',
      sourceRefs,
      evidenceIds,
      confidence: Number(fm.confidence ?? 0.8),
      provenance: `finding:${String(fm.id)}`,
      tags: ['xyp3rn', 'canonical', `model/${String(fm.model_tag ?? 'model-agnostic')}`],
      metadata: {
        model_scope: String(fm.model_tag ?? MODEL_AGNOSTIC),
        claims: [
          {
            topic: fm.claim_topic,
            value: fm.claim_value,
            model_scope: String(fm.model_tag ?? MODEL_AGNOSTIC),
          },
        ],
      },
    });
  }

  async designExperiment(input: {
    readonly idOverride?: string | undefined;
    readonly findingPathOrId: string;
    readonly hypothesis: string;
    readonly variantA: unknown;
    readonly variantB: unknown;
    readonly nPerVariant: number;
    readonly scorerId?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchExperimentRecord> {
    const fEntry = this.#findEntryByPathOrId(input.findingPathOrId, '03_RESEARCH_INTELLIGENCE/FINDINGS/');
    if (!fEntry) throw new Error(`Finding not found: "${input.findingPathOrId}"`);
    if (input.nPerVariant < 1) throw new Error('Experiment nPerVariant must be >= 1');

    const actor = input.actor ?? 'benchmark-scoring-methodology-researcher';
    const createdAt = input.createdAt ?? nowIso();
    const rawId = input.idOverride?.trim();
    const shortId = rawId ? rawId.replace(/^expr-/i, '').slice(0, 12) : randomUUID().slice(0, 8);
    const id = rawId || `expr-${shortId}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-${shortId}-${slugify(input.hypothesis)}.md`;
    const scorer = input.scorerId ?? STUB_SCORER;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.experiment/v3',
        id,
        type: 'experiment',
        title: `Experiment: ${input.hypothesis.trim()}`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'active',
        version: 1,
        finding_id: fEntry.frontmatter.id,
        finding_ref: fEntry.vaultPath,
        hypothesis: input.hypothesis.trim(),
        variant_a: input.variantA,
        variant_b: input.variantB,
        n_per_variant: input.nPerVariant,
        trial_count: 0,
        scorer,
        provenance: input.provenance ?? makeProvenance('designExperiment', actor, { findingId: fEntry.frontmatter.id }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: ['xyp3rn', 'os3', 'experiment'],
      },
      `# Controlled Experiment \`${id}\`\n\n**Hypothesis:** ${input.hypothesis.trim()}\n\nTarget Finding: [[${fEntry.vaultPath.replace(/\.md$/, '')}|${String(fEntry.frontmatter.id)}]]`,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Design controlled experiment ${id}`,
    });

    return {
      id,
      vaultPath: written.vaultPath,
      findingId: String(fEntry.frontmatter.id),
      hypothesis: input.hypothesis.trim(),
      nPerVariant: input.nPerVariant,
      scorer,
      sha256: written.sha256,
    };
  }

  async recordExperimentRun(input: {
    readonly idOverride?: string | undefined;
    readonly experimentPathOrId: string;
    readonly variant: 'a' | 'b';
    readonly trial: number;
    readonly output: unknown;
    readonly scorer: TrialScorer;
    readonly createdAt?: string | undefined;
    readonly provenance?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }): Promise<ResearchExperimentRunRecord> {
    const expEntry = this.#findEntryByPathOrId(input.experimentPathOrId, '03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-');
    if (!expEntry) throw new Error(`Experiment not found: "${input.experimentPathOrId}"`);

    const nPerVar = Number(expEntry.frontmatter.n_per_variant ?? 1);
    if (input.trial < 1 || input.trial > nPerVar) {
      throw new Error(`Experiment trial must be in 1..${nPerVar}`);
    }

    const actor = input.actor ?? 'evaluation-researcher';
    const createdAt = input.createdAt ?? nowIso();
    const scoreRes = await input.scorer.score(input.output);
    const expId = String(expEntry.frontmatter.id);
    const runId = input.idOverride?.trim() || `erun-${expId.slice(5)}-${input.variant}${input.trial}`;
    const vaultPath = `03_RESEARCH_INTELLIGENCE/EXPERIMENTS/ERUN-${expId.slice(5)}-${input.variant}${input.trial}.md`;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: runId,
        type: 'experiment_run',
        title: `Experiment Run ${runId} (Variant ${input.variant.toUpperCase()} #${input.trial})`,
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: scoreRes.score !== null ? 'approved' : 'draft',
        verification_status: scoreRes.score !== null && input.scorer.id !== STUB_SCORER ? 'verified' : 'incomplete',
        version: 1,
        experiment_id: expId,
        experiment_ref: expEntry.vaultPath,
        variant: input.variant,
        trial: input.trial,
        score: scoreRes.score,
        score_inputs: scoreRes.inputs,
        scored_by: input.scorer.id,
        provenance: input.provenance ?? makeProvenance('recordExperimentRun', actor, { experimentId: expId }),
        created_at: createdAt,
        updated_at: createdAt,
        tags: ['xyp3rn', 'os3', 'experiment-run'],
      },
      `# Experiment Run \`${runId}\`\n\n- **Variant:** \`${input.variant}\` (trial ${input.trial})\n- **Score:** \`${String(scoreRes.score)}\` via \`${input.scorer.id}\``,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor,
      reason: `Record experiment run ${runId}`,
    });

    return {
      id: runId,
      vaultPath: written.vaultPath,
      experimentId: expId,
      variant: input.variant,
      trial: input.trial,
      score: scoreRes.score,
      scoredBy: input.scorer.id,
      sha256: written.sha256,
    };
  }

  summarizeExperimentRuns(experimentPathOrId: string) {
    const expEntry = this.#findEntryByPathOrId(experimentPathOrId, '03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-');
    if (!expEntry) throw new Error(`Experiment not found: "${experimentPathOrId}"`);
    const expId = String(expEntry.frontmatter.id);
    const nPerVar = Number(expEntry.frontmatter.n_per_variant ?? 1);

    const runs = this.#db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/EXPERIMENTS/ERUN-') &&
          e.frontmatter.experiment_id === expId,
      )
      .map((e) => ({
        variant: (e.frontmatter.variant === 'a' ? 'a' : 'b') as 'a' | 'b',
        score: typeof e.frontmatter.score === 'number' ? e.frontmatter.score : null,
        scored_by: String(e.frontmatter.scored_by ?? STUB_SCORER),
      }));

    const status = runs.length >= nPerVar * 2 ? 'complete' : 'running';
    return summarizeExperiment({ status, n_per_variant: nPerVar }, runs);
  }

  #findEntryByPathOrId(pathOrId: string, prefix: string) {
    const clean = pathOrId.trim();
    const direct = this.#db.getIndexEntry(clean);
    if (direct) return direct;

    const all = this.#db.listIndexEntries(undefined, 10_000);
    return (
      all.find(
        (e) =>
          e.vaultPath.startsWith(prefix) &&
          (e.vaultPath === clean || e.frontmatter.id === clean || e.frontmatter.slug === clean),
      ) ?? null
    );
  }
}
