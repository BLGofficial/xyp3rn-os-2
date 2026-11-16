import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';

describe('OS 3.0 Phase 1 — Minimal Local SQLite Runtime (core/sqlite)', () => {
  let db: SqliteRuntimeDb;

  beforeEach(() => {
    db = openRuntimeDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('tracks agent_runs lifecycle and enforces append-then-seal triggers', () => {
    const run = db.startAgentRun({
      agentName: 'x3lius-lyrics',
      class: 'Creative',
      domain: 'RECORDS',
      model: 'openrouter:nemotron',
      input: { request: 'dark drill verse' },
    });

    expect(run.status).toBe('pending');
    expect(run.completedAt).toBeNull();

    // Identity columns cannot be mutated even while pending
    expect(() => {
      db.raw.prepare('UPDATE agent_runs SET agent_name = ? WHERE id = ?').run('tampered', run.id);
    }).toThrow(/identity columns are immutable/i);

    const done = db.completeAgentRun(run.id, {
      output: { artifactId: 'art-1' },
      tokensUsed: 412,
      latencyMs: 1280,
    });

    expect(done.status).toBe('success');
    expect(done.tokensUsed).toBe(412);
    expect(done.latencyMs).toBe(1280);
    expect(done.completedAt).toBeTruthy();

    // Sealed run refuses any subsequent UPDATE or DELETE
    expect(() => {
      db.completeAgentRun(run.id, { output: { tampered: true } });
    }).toThrow(/sealed once status leaves pending/i);

    expect(() => {
      db.raw.prepare('DELETE FROM agent_runs WHERE id = ?').run(run.id);
    }).toThrow(/append-only; deletion is forbidden/i);
  });

  it('requires non-empty error_detail on failed agent_runs and jobs', () => {
    const run = db.startAgentRun({
      agentName: 'health-check',
      class: 'Execution',
      domain: 'CORE',
      input: {},
    });

    const failed = db.failAgentRun(run.id, { errorDetail: 'upstream timeout after 120s' });
    expect(failed.status).toBe('error');
    expect(failed.errorDetail).toBe('upstream timeout after 120s');

    const job = db.enqueueJob({
      kind: 'workflow',
      name: 'song-to-suno',
      specSha256: 'abc123',
      input: { songId: 's-1' },
    });
    expect(job.status).toBe('queued');

    db.startJob(job.id);
    const failedJob = db.failJob(job.id, 'step x3lius-lyrics failed', 'step-2');
    expect(failedJob.status).toBe('error');
    expect(failedJob.failedStep).toBe('step-2');

    // Terminal job is sealed
    expect(() => {
      db.completeJob(job.id, { ok: true });
    }).toThrow(/sealed once terminal/i);
  });

  it('manages cooperative resource locks with TTL and owner isolation', () => {
    expect(db.acquireLock('vault:05_XYP3RN_RECORDS/song.md', 'agent-a', 10_000)).toBe(true);
    expect(db.acquireLock('vault:05_XYP3RN_RECORDS/song.md', 'agent-b', 10_000)).toBe(false);
    // Same owner can renew lock
    expect(db.acquireLock('vault:05_XYP3RN_RECORDS/song.md', 'agent-a', 10_000)).toBe(true);

    // Wrong owner cannot release
    expect(db.releaseLock('vault:05_XYP3RN_RECORDS/song.md', 'agent-b')).toBe(false);
    expect(db.releaseLock('vault:05_XYP3RN_RECORDS/song.md', 'agent-a')).toBe(true);
    expect(db.getLock('vault:05_XYP3RN_RECORDS/song.md')).toBeNull();
  });

  it('persists operator sessions and caps exchange history', () => {
    db.upsertSession({
      id: 'sess-1',
      source: 'ui',
      activeSector: '01_CORE',
      selectedJobId: 'jarvis-agent',
    });

    for (let i = 1; i <= 5; i++) {
      db.appendSessionExchange('sess-1', { id: `ex-${i}`, prompt: `cmd ${i}` }, 3, 'ui');
    }

    const sess = db.getSession('sess-1');
    expect(sess).not.toBeNull();
    expect(sess!.exchanges).toHaveLength(3);
    expect((sess!.exchanges[0] as { id: string }).id).toBe('ex-3');
  });

  it('enforces strict append-only immutability on runtime_events', () => {
    const ev1 = db.appendEvent({
      eventType: 'vault.write',
      domain: 'KNOWLEDGE',
      actor: 'vault-curator',
      targetPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/test.md',
      checksumSha256: 'deadbeef',
      payload: { bytes: 128 },
    });
    const ev2 = db.appendEvent({
      eventType: 'jarvis.route',
      domain: 'CORE',
      actor: 'jarvis',
      payload: { domain: 'RECORDS' },
    });

    const page = db.listEvents({ afterId: ev1.id });
    expect(page).toHaveLength(1);
    expect(page[0]!.id).toBe(ev2.id);

    expect(() => {
      db.raw.prepare('UPDATE runtime_events SET actor = ? WHERE id = ?').run('hacker', ev1.id);
    }).toThrow(/immutable; updates are forbidden/i);

    expect(() => {
      db.raw.prepare('DELETE FROM runtime_events WHERE id = ?').run(ev1.id);
    }).toThrow(/append-only; deletion is forbidden/i);
  });

  it('enforces human approval lifecycle and seals decided pending_approvals rows', () => {
    const item = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'cand-42',
      proposer: 'research-orchestrator',
      request: { targetPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/Rule-01.md' },
    });

    expect(item.status).toBe('pending');
    expect(db.listApprovals('pending')).toHaveLength(1);

    const decided = db.decideApproval({
      approvalId: item.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'verified against Suno v6 fieldnotes',
    });

    expect(decided.status).toBe('approved');
    expect(decided.approver).toBe('blago');
    expect(decided.decidedAt).toBeTruthy();

    // Cannot flip or re-decide once sealed
    expect(() => {
      db.decideApproval({
        approvalId: item.id,
        decision: 'rejected',
        approver: 'blago',
        reason: 'changed mind',
      });
    }).toThrow(/sealed once decided/i);
  });
});
