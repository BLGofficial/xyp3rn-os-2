/**
 * Knowledge Promotion Gate — the decision rule (Phase 6D), kept pure so every branch is provable
 * without a database. gate.ts gathers the inputs; this decides.
 */

/** The guide's state machine, in its exact order. */
export const GATE_STEPS = [
  'candidate',
  'source-verification',
  'model-version-tagging',
  'controlled-test',
  'evaluation',
  'confidence-assignment',
  'validated-rule',
  'canonical-write',
  'propagation',
] as const;

export type GateStep = (typeof GATE_STEPS)[number];

/**
 * Auto-approve threshold on finding confidence = mean(evidence confidence × source reliability)
 * × min(1, 0.5 + 0.25k) (6C). Why 0.8:
 * - one source is capped at 0.75 of its own support, so no single page, doc or studio session
 *   can ever auto-approve;
 * - two independent sources need a mean support of 0.8+, e.g. two official changelogs
 *   (reliability 0.9) each stated at confidence ≥ 0.89, or vendor pages (0.8) at 1.0;
 * - community (0.4) or unknown-host (0.3) evidence can never reach it at any k.
 * Changing this is a flagged decision (docs/ARCHITECTURE.md F14), never a silent edit.
 * Since F35 D2 (Artist OS) nothing auto-approves: the threshold is kept as a reason shown to the
 * owner, who decides every canonical change.
 */
export const AUTO_APPROVE_CONFIDENCE = 0.8;

/** What the owner sees for a candidate that meets every former auto-approve condition (F35 D2). */
export const ALL_CONDITIONS_HOLD = `every automatic condition holds (validated experiment, fresh sources, confidence ≥ ${AUTO_APPROVE_CONFIDENCE}); the owner decides (F35 D2)`;

/**
 * Freshness re-check: AI music models ship major versions every few months (Suno v4 → v4.5 → v5
 * inside a year), so evidence retrieved more than ~two release cycles ago goes to a human.
 */
export const SOURCE_MAX_AGE_DAYS = 180;

export type GateInputs = {
  /** No open contradiction touches the candidate (6C eligibility). */
  readonly eligible: boolean;
  /** Candidate, finding and every evidence row agree on the model/version tag. */
  readonly tagsConsistent: boolean;
  /** Every cited source was retrieved within SOURCE_MAX_AGE_DAYS. */
  readonly sourcesFresh: boolean;
  /** The latest controlled experiment is complete, really scored, and the candidate variant won. */
  readonly experimentValidated: boolean;
  /** Finding confidence (6C formula). */
  readonly confidence: number;
};

export type Decision = {
  readonly outcome: 'blocked' | 'rejected' | 'human';
  readonly reasons: readonly string[];
};

/**
 * Decides a candidate's fate. Precedence: an open contradiction blocks (fixable: resolve it and
 * re-run); inconsistent tags reject (the evidence can't support the rule as scoped); everything else
 * goes to the owner (F35 D2: no auto-approval), with every failing condition listed — or, when all
 * hold, a reason saying so.
 * @param i - evaluated gate inputs
 * @returns outcome and the reasons behind it (never empty for `human`)
 */
export const decide = (i: GateInputs): Decision => {
  if (!i.eligible) return { outcome: 'blocked', reasons: ['open contradiction'] };
  if (!i.tagsConsistent) return { outcome: 'rejected', reasons: ['model/version tags inconsistent'] };
  const reasons = [
    ...(i.experimentValidated ? [] : ['experiment not validated']),
    ...(i.sourcesFresh ? [] : [`sources older than ${SOURCE_MAX_AGE_DAYS} days`]),
    ...(i.confidence >= AUTO_APPROVE_CONFIDENCE ? [] : [`confidence ${i.confidence} below ${AUTO_APPROVE_CONFIDENCE}`]),
  ];
  return { outcome: 'human', reasons: reasons.length === 0 ? [ALL_CONDITIONS_HOLD] : reasons };
};
