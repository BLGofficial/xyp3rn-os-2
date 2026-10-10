import { describe, expect, it } from 'vitest';
import type { GateResult } from '../../../knowledge/promotion-gate/gate.ts';
import { JarvisCore, type JarvisDeps } from './JarvisOrchestrator.ts';

const gateResult = (outcome: GateResult['outcome']): GateResult =>
  ({ outcome, steps: [], reasons: ['because'], promotionRunId: 'run-1', approvalId: outcome === 'pending_approval' ? 'appr-1' : undefined, canonicalPromptId: undefined, version: undefined });

const core = (outcome: GateResult['outcome'], retrieve: (...a: unknown[]) => Promise<{ items: unknown[] }> = async () => ({ items: [] })) =>
  new JarvisCore({ sql: {}, engine: { retrieve }, gate: async () => gateResult(outcome) } as unknown as JarvisDeps);

describe('JarvisCore canonical writes', () => {
  it('queues a candidate and reports PENDING_HUMAN_APPROVAL with the approval id', async () => {
    const r = await core('pending_approval').interceptAndExecute('voice', { type: 'canonical-write', candidateId: 'c1' });
    expect(r).toMatchObject({ status: 'PENDING_HUMAN_APPROVAL', source: 'voice', approvalIds: ['appr-1'] });
    expect(r.summary).toMatch(/^This awaits your approval, sir\./);
  });

  it('never relays a promotion the owner did not decide', async () => {
    const r = await core('promoted').interceptAndExecute('http', { type: 'canonical-write', candidateId: 'c1' });
    expect(r.status).toBe('ERROR');
  });

  it('reports a blocked candidate as BLOCKED', async () => {
    expect((await core('blocked').interceptAndExecute('cli', { type: 'canonical-write', candidateId: 'c1' })).status).toBe('BLOCKED');
  });
});

describe('JarvisCore ask', () => {
  it('retrieves knowledge and vault context before planning, and survives a retrieval failure', async () => {
    const calls: unknown[] = [];
    const ok = await core('blocked', async (...a: unknown[]) => { calls.push(a); return { items: [{}] }; })
      .interceptAndExecute('cli', { type: 'ask', request: 'zzqx' });
    expect(calls).toHaveLength(2);
    expect(ok.context).toEqual({ available: true, knowledgeItems: 1, vaultItems: 1 });
    const down = await core('blocked', async () => { throw new Error('model offline'); })
      .interceptAndExecute('cli', { type: 'ask', request: 'zzqx' });
    expect(down.context).toEqual({ available: false, reason: 'model offline' });
    expect(['HOLD', 'CLARIFY']).toContain(down.status);
  });
});
