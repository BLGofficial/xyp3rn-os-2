import { describe, expect, it } from 'vitest';
import { ENTRYPOINT_PHASE, planRequest } from './orchestrate.ts';

describe('orchestrator entry: classify BEFORE dispatch', () => {
  it('routes the Phase 17 request and says which phase builds that domain\'s entrypoint', () => {
    const plan = planRequest('Research the best current method for controlling dark baritone vocals in Suno.', {});
    expect(plan).toMatchObject({ action: 'hold', route: { status: 'routed', domain: 'RESEARCH_INTELLIGENCE' } });
    expect(plan.action === 'hold' && plan.reason).toBe('no entrypoint registered for RESEARCH_INTELLIGENCE yet (built in Phase 6A)');
  });

  it('dispatches the registered entrypoint workflow when one exists', () => {
    const plan = planRequest('Write a hook and two verses for the new X3LIUS track', { RECORDS: 'records/workflows/x3lius-entry.workflow.yaml' });
    expect(plan).toEqual({
      action: 'run-workflow',
      workflow: 'records/workflows/x3lius-entry.workflow.yaml',
      input: { request: 'Write a hook and two verses for the new X3LIUS track' },
      route: expect.objectContaining({ status: 'routed', domain: 'RECORDS' }),
    });
  });

  it('routes research to the registered research service (Phase 6A)', () => {
    const plan = planRequest('Research the best current method for controlling dark baritone vocals in Suno.', { RESEARCH_INTELLIGENCE: { service: 'run-research' } });
    expect(plan).toMatchObject({ action: 'run-service', service: 'run-research' });
  });

  it('never dispatches an ambiguous request; asks for clarification naming the candidates', () => {
    const plan = planRequest('Check the rights on this track', { RECORDS: 'x.yaml', GOVERNANCE: 'y.yaml' });
    expect(plan.action).toBe('clarify');
    expect(plan.action === 'clarify' && plan.reason).toMatch(/ambiguous between GOVERNANCE and RECORDS/);
  });

  it('never picks a default domain for an unroutable request', () => {
    expect(planRequest('hello there', {})).toMatchObject({ action: 'clarify', reason: 'no domain matched; rephrase with domain terms' });
  });

  it('knows the building phase for every routable domain', () => {
    expect(ENTRYPOINT_PHASE).toEqual({ RESEARCH_INTELLIGENCE: '6A', RECORDS: '7', TECH: '14', GOVERNANCE: '15' });
  });
});
