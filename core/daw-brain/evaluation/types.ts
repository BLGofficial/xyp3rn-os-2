export const DAW_EVALUATION_CATEGORIES = [
  'daw_detection_accuracy',
  'state_observation_accuracy',
  'session_model_completeness',
  'plugin_identification_accuracy',
  'parameter_interpretation_accuracy',
  'audio_analysis_accuracy',
  'routing_interpretation_accuracy',
  'agent_recommendation_quality',
  'command_validation_correctness',
  'execution_reliability',
  'recovery_behavior',
] as const;

export type DawEvaluationCategory = (typeof DAW_EVALUATION_CATEGORIES)[number];

export type DawDatasetSourceKind =
  | 'synthetic_fixture'
  | 'user_approved_project'
  | 'reference_audio_wav'
  | 'controlled_plugin_config'
  | 'manual_ground_truth';

export type DawEvaluationProvenance = {
  readonly datasetId: string;
  readonly sourceKind: DawDatasetSourceKind;
  readonly sourcePath?: string | undefined;
  readonly sha256?: string | undefined;
  readonly manuallyVerifiedBy: string;
  readonly verifiedAt: string;
  readonly notes: string;
};

export type DawEvaluationCaseResult = {
  readonly caseId: string;
  readonly category: DawEvaluationCategory;
  readonly title: string;
  readonly provenance: DawEvaluationProvenance;
  readonly expectedOutput: unknown;
  readonly actualOutput: unknown;
  readonly error: string | null;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly passed: boolean;
  readonly score: number;
  readonly limitations: readonly string[];
  readonly durationMs: number;
};

export type DawCategoryThreshold = {
  readonly minAccuracy: number;
  readonly maxFailures: number;
  readonly rationale: string;
};

export type DawBaselineThresholds = Readonly<Record<DawEvaluationCategory, DawCategoryThreshold>>;

export type DawCategoryBenchmarkSummary = {
  readonly category: DawEvaluationCategory;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly accuracyRate: number;
  readonly meanScore: number;
  readonly threshold: DawCategoryThreshold;
  readonly meetsBaseline: boolean;
};

export type DawEvaluationReport = {
  readonly reportId: string;
  readonly schema: 'xyp3rn.daw-eval/v1';
  readonly generatedAt: string;
  readonly overallPassed: boolean;
  readonly overallAccuracy: number;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly thresholds: DawBaselineThresholds;
  readonly categorySummaries: readonly DawCategoryBenchmarkSummary[];
  readonly results: readonly DawEvaluationCaseResult[];
  readonly datasetManifest: readonly DawEvaluationProvenance[];
  readonly limitations: readonly string[];
};
