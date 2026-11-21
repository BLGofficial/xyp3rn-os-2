/**
 * Canonical OS 3.0 Research Intelligence & OS 2 -> OS 3 Migration Contracts (Phase 19).
 * Covers all 8 core concepts (Projects, Questions, Runs, Sources, Evidence, Findings,
 * Contradictions, Experiments/Runs), plus Briefs, Tier-1 Decisions, Links, DAW Brain
 * documentation/research integration, and 4-way migration safety reports.
 */

export const RESEARCH_ENTITY_CONCEPTS = [
  'research_project',
  'research_question',
  'research_run',
  'research_source',
  'research_evidence',
  'research_finding',
  'research_contradiction',
  'research_experiment',
  'research_experiment_run',
  'research_brief',
] as const;

export type ResearchEntityConcept = (typeof RESEARCH_ENTITY_CONCEPTS)[number];

export const DAW_RESEARCH_CATEGORIES = [
  'daw_documentation',
  'plugin_documentation',
  'dsp_research',
  'audio_engineering_reference',
  'production_technique',
  'daw_compatibility_finding',
] as const;

export type DawResearchCategory = (typeof DAW_RESEARCH_CATEGORIES)[number];

export const EVIDENCE_ATTRIBUTION_TIERS = [
  'official_vendor_doc',
  'observed_host_probe',
  'dsp_measurement',
  'studio_observation',
  'independent_benchmark',
  'community_claim',
  'inference_unverified',
] as const;

export type EvidenceAttributionTier = (typeof EVIDENCE_ATTRIBUTION_TIERS)[number];

export type VerificationStatus =
  | 'verified'
  | 'corroborated'
  | 'single_source_capped'
  | 'contradiction_blocked'
  | 'unverified'
  | 'incomplete'
  | 'rejected';

export type ResearchTargetRef =
  | { readonly kind: 'decision'; readonly decisionKey: string; readonly role?: string | undefined }
  | { readonly kind: 'workflow'; readonly workflowName: string; readonly workflowSha256?: string | undefined; readonly role?: string | undefined }
  | { readonly kind: 'lineage'; readonly artifactLineageId: string; readonly role?: string | undefined }
  | { readonly kind: 'daw_entity'; readonly dawCategory: DawResearchCategory; readonly targetVaultPath: string; readonly role?: string | undefined };

// ─── Legacy OS2 Export Shapes (matching supabase/migrations/20260924* & 20260926*) ───

export type LegacyResearchProjectRow = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly status: 'open' | 'closed' | string;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
};

export type LegacyResearchQuestionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly question: string;
  readonly intended_use?: string | null | undefined;
  readonly urls?: readonly string[] | undefined;
  readonly specialists?: readonly string[] | null | undefined;
  readonly status: 'open' | 'answered' | 'abandoned' | string;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
};

export type LegacyResearchRunRow = {
  readonly id: string;
  readonly question_id: string;
  readonly status: 'running' | 'success' | 'error' | string;
  readonly selected_specialists?: readonly string[] | undefined;
  readonly selection?: Record<string, unknown> | undefined;
  readonly workflow_run_id?: string | null | undefined;
  readonly error_detail?: string | null | undefined;
  readonly created_at?: string | undefined;
  readonly completed_at?: string | null | undefined;
  readonly expires_at?: string | null | undefined;
};

export type LegacyResearchSourceRow = {
  readonly id: string;
  readonly research_run_id?: string | null | undefined;
  readonly source_id?: string | null | undefined;
  readonly kind: 'web' | 'doc' | 'changelog' | 'observation' | 'ingested' | string;
  readonly uri: string;
  readonly title: string;
  readonly content_sha256?: string | null | undefined;
  readonly excerpt?: string | null | undefined;
  readonly text?: string | null | undefined;
  readonly reliability?: number | null | undefined;
  readonly reliability_inputs?: Record<string, unknown> | null | undefined;
  readonly retrieved_at?: string | undefined;
  readonly created_at?: string | undefined;
};

export type LegacyResearchEvidenceRow = {
  readonly id: string;
  readonly research_run_id?: string | null | undefined;
  readonly research_source_id: string;
  readonly specialist: string;
  readonly claim: string;
  readonly quote?: string | null | undefined;
  readonly uncertainty_note?: string | null | undefined;
  readonly claim_topic?: string | null | undefined;
  readonly claim_value?: unknown;
  readonly model_tag: string;
  readonly confidence: number;
  readonly confidence_inputs?: Record<string, unknown> | null | undefined;
  readonly created_at?: string | undefined;
};

export type LegacyResearchFindingRow = {
  readonly id: string;
  readonly research_run_id?: string | null | undefined;
  readonly claim: string;
  readonly claim_topic: string;
  readonly claim_value: unknown;
  readonly model_tag: string;
  readonly confidence: number;
  readonly confidence_inputs?: Record<string, unknown> | null | undefined;
  readonly uncertainty_note?: string | null | undefined;
  readonly evidence_ids?: readonly string[] | undefined;
  readonly created_at?: string | undefined;
};

export type LegacyContradictionRow = {
  readonly id: string;
  readonly finding_id: string;
  readonly target_type: 'knowledge_candidate' | 'canonical_prompt' | 'finding' | string;
  readonly target_id: string;
  readonly detail?: Record<string, unknown> | null | undefined;
  readonly status: 'open' | 'resolved_manual' | 'resolved_experiment' | 'resolved' | string;
  readonly resolution?: Record<string, unknown> | string | null | undefined;
  readonly created_at?: string | undefined;
  readonly resolved_at?: string | null | undefined;
};

export type LegacyExperimentRow = {
  readonly id: string;
  readonly candidate_id?: string | null | undefined;
  readonly finding_id?: string | null | undefined;
  readonly hypothesis: string;
  readonly variant_a: unknown;
  readonly variant_b: unknown;
  readonly n_per_variant: number;
  readonly scoring_method: string;
  readonly status: 'planned' | 'running' | 'complete' | 'error' | string;
  readonly created_at?: string | undefined;
  readonly completed_at?: string | null | undefined;
};

export type LegacyExperimentRunRow = {
  readonly id: string;
  readonly experiment_id: string;
  readonly variant: 'a' | 'b' | string;
  readonly trial: number;
  readonly output?: unknown;
  readonly score: number | null;
  readonly score_inputs?: Record<string, unknown> | null | undefined;
  readonly scored_by: string;
  readonly created_at?: string | undefined;
};

export type LegacyResearchLinkRow = {
  readonly id: string;
  readonly question_id: string;
  readonly role?: string | null | undefined;
  readonly artifact_lineage_id?: string | null | undefined;
  readonly workflow_name?: string | null | undefined;
  readonly workflow_sha256?: string | null | undefined;
  readonly decision_key?: string | null | undefined;
  readonly retracted_reason?: string | null | undefined;
};

export type LegacyFindingDecisionRow = {
  readonly finding_id: string;
  readonly decision: 'accept' | 'reject' | string;
  readonly decided_by: string;
  readonly decided_at?: string | undefined;
  readonly decision_reason: string;
};

export type Os2ResearchExportPayload = {
  readonly exportedAt: string;
  readonly sourceSystem: string;
  readonly projects: readonly LegacyResearchProjectRow[];
  readonly questions: readonly LegacyResearchQuestionRow[];
  readonly runs: readonly LegacyResearchRunRow[];
  readonly sources: readonly LegacyResearchSourceRow[];
  readonly evidence: readonly LegacyResearchEvidenceRow[];
  readonly findings: readonly LegacyResearchFindingRow[];
  readonly findingEvidenceLinks?: readonly { readonly finding_id: string; readonly evidence_id: string }[] | undefined;
  readonly contradictions: readonly LegacyContradictionRow[];
  readonly experiments: readonly LegacyExperimentRow[];
  readonly experimentRuns: readonly LegacyExperimentRunRow[];
  readonly researchLinks?: readonly LegacyResearchLinkRow[] | undefined;
  readonly findingDecisions?: readonly LegacyFindingDecisionRow[] | undefined;
};

export type MigratedRecordEntry = {
  readonly legacyId: string;
  readonly entityKind: ResearchEntityConcept;
  readonly os3Id: string;
  readonly vaultPath: string;
  readonly schema: string;
  readonly sha256: string;
  readonly status: 'migrated' | 'migrated_partial' | 'skipped_idempotent' | 'dry_run_planned';
  readonly warnings: readonly string[];
};

export type RejectedMigrationRecord = {
  readonly legacyId: string;
  readonly entityKind: ResearchEntityConcept | 'legacy_markdown' | 'research_link';
  readonly reasonCode: string;
  readonly message: string;
};

export type ConflictingMigrationRecord = {
  readonly legacyId: string;
  readonly entityKind: ResearchEntityConcept | 'legacy_markdown';
  readonly conflictKind: 'id_or_path_content_divergence' | 'claim_contradiction';
  readonly targetIdOrPath: string;
  readonly contradictionPath?: string | undefined;
  readonly details: string;
};

export type IncompleteMigrationRecord = {
  readonly legacyId: string;
  readonly entityKind: ResearchEntityConcept | 'legacy_markdown';
  readonly missingFields: readonly string[];
  readonly disposition: 'quarantined_unmigrated' | 'migrated_with_explicit_gaps';
  readonly os3VaultPath?: string | undefined;
  readonly legacyPath?: string | undefined;
  readonly notes: string;
};

export type LegacyMarkdownScanItem = {
  readonly legacyPath: string;
  readonly sha256: string;
  readonly title: string;
  readonly hasSchema: boolean;
  readonly hasStableId: boolean;
  readonly hasProvenance: boolean;
  readonly entityTypeHint: string | null;
  readonly status: 'already_os3_valid' | 'incomplete_legacy_markdown' | 'rejected_secret_or_invalid';
  readonly missingFields: readonly string[];
};

export type ResearchMigrationReport = {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly dryRun: boolean;
  readonly legacyDataUntouched: boolean;
  readonly totals: {
    readonly legacyInputCount: number;
    readonly migratedCount: number;
    readonly skippedIdempotentCount: number;
    readonly rejectedCount: number;
    readonly conflictingCount: number;
    readonly incompleteCount: number;
    readonly legacyMarkdownScannedCount: number;
  };
  readonly migrated: readonly MigratedRecordEntry[];
  readonly skippedIdempotent: readonly MigratedRecordEntry[];
  readonly rejected: readonly RejectedMigrationRecord[];
  readonly conflicting: readonly ConflictingMigrationRecord[];
  readonly incomplete: readonly IncompleteMigrationRecord[];
  readonly legacyMarkdownScan: readonly LegacyMarkdownScanItem[];
};

export type ResearchParityReport = {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly vaultValidationPassed: number;
  readonly vaultValidationFailed: readonly { readonly vaultPath: string; readonly issues: readonly string[] }[];
  readonly unresolvedReferences: readonly string[];
  readonly legacyChecksumVerified: boolean;
  readonly entityCounts: Readonly<
    Record<
      string,
      {
        readonly legacyValid: number;
        readonly os3Present: number;
        readonly matched: number;
        readonly rejected: number;
        readonly incomplete: number;
      }
    >
  >;
  readonly discrepancies: readonly string[];
};
