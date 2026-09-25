import { describe, expect, it } from 'vitest';
import { ALL_CONDITIONS_HOLD, AUTO_APPROVE_CONFIDENCE, decide, GATE_STEPS, SOURCE_MAX_AGE_DAYS } from './decide.ts';

// The gate's decision rule, as a pure function. The DB path can't exercise auto-approval until
// Phase 12 provides a real scorer, so its branches are proven here.

const ok = { eligible: true, tagsConsistent: true, sourcesFresh: true, experimentValidated: true, confidence: 0.85 };

describe('gate decision rule', () => {
  it('runs the nine steps in the guide\'s exact order', () => {
    expect(GATE_STEPS).toEqual([
      'candidate',
      'source-verification',
      'model-version-tagging',
      'controlled-test',
      'evaluation',
      'confidence-assignment',
      'validated-rule',
      'canonical-write',
      'propagation',
    ]);
  });

  it('threshold is 0.8 (≈ two corroborating high-reliability sources) and freshness 180 days', () => {
    expect(AUTO_APPROVE_CONFIDENCE).toBe(0.8);
    expect(SOURCE_MAX_AGE_DAYS).toBe(180);
  });

  it('never auto-approves (F35 D2): when every condition holds, the owner decides, and is told so', () => {
    expect(decide(ok)).toEqual({ outcome: 'human', reasons: [ALL_CONDITIONS_HOLD] });
  });

  it('blocks on an open contradiction before anything else', () => {
    expect(decide({ ...ok, eligible: false, tagsConsistent: false })).toEqual({ outcome: 'blocked', reasons: ['open contradiction'] });
  });

  it('rejects outright on inconsistent model/version tags', () => {
    expect(decide({ ...ok, tagsConsistent: false })).toEqual({ outcome: 'rejected', reasons: ['model/version tags inconsistent'] });
  });

  it.each([
    [{ experimentValidated: false }, ['experiment not validated']],
    [{ sourcesFresh: false }, ['sources older than 180 days']],
    [{ confidence: 0.79 }, ['confidence 0.79 below 0.8']],
    [{ experimentValidated: false, confidence: 0.4 }, ['experiment not validated', 'confidence 0.4 below 0.8']],
  ])('routes to human approval with every reason: %o', (patch, reasons) => {
    expect(decide({ ...ok, ...patch })).toEqual({ outcome: 'human', reasons });
  });
});
