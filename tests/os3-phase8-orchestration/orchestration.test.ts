import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import { Os3ModelGateway, Os3ModelGatewayError } from '../../core/llm/os3-model-gateway.ts';
import {
  MAX_ORCHESTRATION_STEPS,
  Os3Orchestrator,
  type Os3AgentHandler,
} from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  Os3WorkflowEngine,
  validateAndCompileOs3Workflow,
} from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Representative handler shapes for the agents the OS2 workflows reference. The business logic of
 * each agent is migrated in Phases 9–10; here the OS2 workflow graphs and their data bindings are
 * executed through the new runtime (registry, authorization, orchestrator, job/run tracking).
 */
const WORKFLOW_HANDLERS: Readonly<Record<string, Os3AgentHandler>> = {
  'context-retriever': async (_ctx, input) => ({ output: { items: [{ id: 'i1', query: input.query }] } }),
  'extractive-summarizer': async (_ctx, input) => ({
    output: { summary: `summary of ${String(input.query)}`, cited: (input.items as unknown[]).length },
  }),
  'x3lius-songwriting': async () => ({ output: { artifact: { id: 'art-structure-1' } } }),
  'x3lius-lyrics': async (_ctx, input) => ({
    output: { artifact: { id: 'art-lyrics-1' }, structureArtifactId: input.structureArtifactId ?? null },
  }),
  'x3lius-genre-style': async () => ({ output: { artifact: { id: 'art-genre-1' } } }),
  'x3lius-suno': async (_ctx, input) => ({
    output: { artifact: { id: 'art-suno-1' }, lyricsArtifactIds: input.lyricsArtifactIds },
  }),
  'records-rights-splits': async () => ({ output: { pass: true, unassignedShare: 0 } }),
  'records-release-calendar': async (_ctx, input) => ({ output: { scheduled: true, input } }),
  'tech-audio-tools': async () => ({ output: { analysisId: 'an-1' } }),
  'x3lius-mix-master': async () => ({ output: { artifact: { id: 'art-mix-1' } } }),
};

describe('Phase 8 — JARVIS Core, Orchestrator, Workflow Engine & Model Gateway', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p8-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(vaultRoot, '04_AGENTS'), toolRegistry: tools });
    const orchestrator = new Os3Orchestrator({ db, agents, tools, handlers: WORKFLOW_HANDLERS });
    const workflows = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });
    const contextEngine = new Os3ContextEngine({ vault, db });
    const jarvis = new Os3JarvisCore({ db, agents, tools, contextEngine, orchestrator, workflows });
    return { dir, vaultRoot, db, vault, tools, agents, orchestrator, workflows, jarvis };
  };

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1. Loads all 7 existing OS2 workflows from 05_WORKFLOWS/DEFINITIONS/ with zero validation failures', async () => {
    const { workflows } = await createFixture();
    expect(workflows.failures).toEqual([]);
    expect(workflows.list().map((w) => w.name)).toEqual([
      'records-register-track',
      'records-schedule-release',
      'retrieve-and-summarize',
      'tech-trace-intake',
      'x3lius-song-to-suno',
      'x3lius-write-lyrics',
      'build-suno-package',
    ].sort());
  });

  it('2. Executes representative OS2 workflows end-to-end with traceable runs, jobs and data bindings', async () => {
    const { db, workflows } = await createFixture();

    const summarize = await workflows.execute('retrieve-and-summarize', { query: 'portamento 808' });
    expect(summarize.status).toBe('success');
    expect(summarize.output).toEqual({ summary: 'summary of portamento 808', cited: 1 });

    // DAG with fan-in: structure -> lyrics, genre (independent) -> formula
    const songToSuno = await workflows.execute('x3lius-song-to-suno', { request: 'night drill', sunoModel: 'suno-v6' });
    expect(songToSuno.status).toBe('success');
    expect(songToSuno.steps.map((s) => s.stepId)).toEqual(['structure', 'lyrics', 'genre', 'formula']);
    expect(songToSuno.output).toMatchObject({ artifact: { id: 'art-suno-1' }, lyricsArtifactIds: ['art-lyrics-1'] });

    const trace = await workflows.execute('tech-trace-intake', { analysis: { lufs: -14 }, takeId: null });
    expect(trace.status).toBe('success');

    const schedule = await workflows.execute('records-schedule-release', { releaseId: 'rel-1', releaseDate: '2026-12-01' });
    expect(schedule.status).toBe('success');

    // Every run has a unique id; every step has a traceable agent_runs row linked to its job
    const jobs = db.listJobs(20).filter((j) => j.kind === 'workflow');
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    expect(jobs.every((j) => j.status === 'success')).toBe(true);
    const runs = db.listAgentRunsByJob(songToSuno.workflowRunId);
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.status === 'success' && r.stepId !== null)).toBe(true);

    const history = workflows.getExecutionHistory('x3lius-song-to-suno');
    expect(history).toHaveLength(1);
    expect(history[0]!.stepRuns).toHaveLength(4);
  });

  it('3. Records failures with failed step + skipped steps, and rejects missing required input', async () => {
    const { db, workflows, orchestrator } = await createFixture();

    const missing = await workflows.execute('x3lius-write-lyrics', {});
    expect(missing.status).toBe('error');
    expect(missing.failedStep).toBe('(input)');

    orchestrator.registerHandler('x3lius-songwriting', async () => {
      throw new Error('songwriting exploded');
    });
    const failed = await workflows.execute('x3lius-song-to-suno', { request: 'x', sunoModel: 'suno-v6' });
    expect(failed.status).toBe('error');
    expect(failed.failedStep).toBe('structure');
    expect(failed.skippedSteps).toEqual(expect.arrayContaining(['lyrics', 'genre', 'formula']));
    expect(failed.error).toContain('songwriting exploded');

    const job = db.getJob(failed.workflowRunId)!;
    expect(job.status).toBe('error');
    expect(job.failedStep).toBe('structure');
    const run = db.listAgentRunsByJob(failed.workflowRunId)[0]!;
    expect(run.status).toBe('error');
    expect(run.errorDetail).toContain('songwriting exploded');
  });

  it('4. Workflow validation rejects unknown agents, cycles, undeclared tools, unknown fields and bad bindings', async () => {
    const { agents, tools } = await createFixture();
    const compile = (y: string) => validateAndCompileOs3Workflow(y, agents, tools, 'inline');

    const bad = compile(
      [
        'name: bad-flow',
        'description: bad',
        'bogus: 1',
        'input: { required: [q] }',
        'steps:',
        '  - id: a',
        '    agent: no-such-agent',
        '    dependsOn: [b]',
        '  - id: b',
        '    agent: context-retriever',
        '    dependsOn: [a]',
        '    tools: [write_splits]',
        '    input: { x: { $from: input.undeclared } }',
      ].join('\n'),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const all = bad.errors.join('\n');
      expect(all).toContain('unknown field: bogus');
      expect(all).toContain('unknown agent no-such-agent');
      expect(all).toContain('cycle detected');
    }

    const badTool = compile(
      [
        'name: bad-tool',
        'description: bad tool',
        'steps:',
        '  - id: a',
        '    agent: context-retriever',
        '    tools: [write_splits]',
      ].join('\n'),
    );
    expect(badTool.ok).toBe(false);
    if (!badTool.ok) expect(badTool.errors.join('\n')).toContain('not declared by agent');
  });

  it('5. Supports conditional steps, retry policy, fallback recovery and human approval gates', async () => {
    const { db, agents, tools, orchestrator, workflows } = await createFixture();
    let attempts = 0;
    orchestrator.registerHandler('context-retriever', async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return { output: { items: [], mode: 'draft' } };
    });
    orchestrator.registerHandler('extractive-summarizer', async () => ({ output: { summary: 's' } }));

    const wf = validateAndCompileOs3Workflow(
      [
        'name: gated-flow',
        'description: conditional + retry + approval',
        'input: { required: [query] }',
        'steps:',
        '  - id: retrieve',
        '    agent: context-retriever',
        '    retryPolicy: { maxRetries: 1 }',
        '    input: { query: { $from: input.query } }',
        '  - id: only-final',
        '    agent: extractive-summarizer',
        '    dependsOn: [retrieve]',
        '    when: { $from: steps.retrieve.output.mode, equals: final }',
        '    input: { q: { $from: input.query } }',
        '  - id: approve-publish',
        '    agent: extractive-summarizer',
        '    dependsOn: [retrieve]',
        '    approvalGate: { itemType: knowledge_candidate, reason: review before publish }',
        '    input: { q: { $from: input.query } }',
        'output: { $from: steps.approve-publish.output }',
      ].join('\n'),
      agents,
      tools,
      'inline',
    );
    expect(wf.ok).toBe(true);
    if (!wf.ok) return;

    const engine = workflows;

    const first = await engine.execute(wf.workflow, { query: 'q' });
    expect(attempts).toBe(2);
    expect(first.status).toBe('awaiting_approval');
    expect(first.awaitingStep).toBe('approve-publish');
    expect(first.skippedSteps).toEqual(['only-final']);
    expect(first.pendingApprovalId).toBeTruthy();

    // Not approved yet -> gate refuses
    const refused = await engine.execute(wf.workflow, { query: 'q' }, { stepApprovals: { 'approve-publish': first.pendingApprovalId! } });
    expect(refused.status).toBe('error');
    expect(refused.error).toContain('Approval gate rejected');

    db.decideApproval({
      approvalId: first.pendingApprovalId!,
      decision: 'approved',
      approver: 'blago',
      reason: 'reviewed',
    });
    const approved = await engine.execute(wf.workflow, { query: 'q' }, { stepApprovals: { 'approve-publish': first.pendingApprovalId! } });
    expect(approved.status).toBe('success');
    expect(approved.output).toEqual({ summary: 's' });
  });

  it('6. Orchestrator: sequential, conditional, multi-agent, cancellation, timeout, fallback and bounded steps', async () => {
    const { db, orchestrator } = await createFixture();
    orchestrator.registerHandler('context-retriever', async () => ({ output: { mode: 'final' } }));
    orchestrator.registerHandler('extractive-summarizer', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { output: { summary: 'late' } };
    });

    const seq = await orchestrator.executeSequential('seq', [
      { stepId: 'a', agentName: 'context-retriever', input: {} },
      { stepId: 'skipme', agentName: 'context-retriever', input: {}, condition: { field: 'a.mode', equals: 'draft' } },
      { stepId: 'b', agentName: 'context-retriever', input: (prev) => ({ got: prev.a }) },
    ]);
    expect(seq.status).toBe('success');
    expect(seq.skippedSteps).toEqual(['skipme']);
    expect(seq.outputsByStep.b).toBeDefined();

    const multi = await orchestrator.executeMultiAgent('multi', [
      { stepId: 'x', agentName: 'context-retriever', input: {} },
      { stepId: 'y', agentName: 'context-retriever', input: {} },
    ]);
    expect(multi.status).toBe('success');
    expect(multi.stepResults).toHaveLength(2);

    const timedOut = await orchestrator.executeSingleAgent('extractive-summarizer', {}, { timeoutMs: 30 });
    expect(timedOut.status).toBe('error');
    expect(timedOut.error).toContain('timeout after 30ms');

    const recovered = await orchestrator.executeSingleAgent('extractive-summarizer', {}, {
      timeoutMs: 30,
      fallbackOutput: { summary: 'fallback' },
    });
    expect(recovered.status).toBe('success');
    expect(recovered.output).toMatchObject({ summary: 'fallback', recoveredFromError: expect.stringContaining('timeout') });

    const ctl = new AbortController();
    ctl.abort('operator cancelled');
    const cancelled = await orchestrator.executeSequential('cancelled', [{ stepId: 'a', agentName: 'context-retriever', input: {} }], {}, { signal: ctl.signal });
    expect(cancelled.status).toBe('cancelled');
    expect(db.getJob(cancelled.jobId)!.status).toBe('cancelled');

    const many = Array.from({ length: MAX_ORCHESTRATION_STEPS + 1 }, (_, i) => ({ stepId: `s${i}`, agentName: 'context-retriever', input: {} }));
    await expect(orchestrator.executeSequential('too-many', many)).rejects.toThrow(/MAX_ORCHESTRATION_STEPS/);
  });

  it('7. No agent can bypass authorization: undeclared tools and unknown agents are refused and recorded', async () => {
    const { db, orchestrator } = await createFixture();
    orchestrator.registerHandler('suno-researcher', async (ctx) => {
      await ctx.useTool('write_splits', {});
      return { output: {} };
    });
    const res = await orchestrator.executeSingleAgent('suno-researcher', {});
    expect(res.status).toBe('error');
    expect(res.error).toContain('undeclared/unassigned tool "write_splits"');

    const unknown = await orchestrator.executeSingleAgent('ghost-agent', {});
    expect(unknown.status).toBe('error');

    const runs = db.listAgentRuns(10);
    expect(runs.every((r) => r.status === 'error')).toBe(true);
    expect(runs.every((r) => r.errorDetail && r.errorDetail.length > 0)).toBe(true);
  });

  it('8. Model Gateway separates provider/model/auth/rate-limit/usage and never hardcodes model IDs', async () => {
    const { db } = await createFixture();
    const schema = {
      name: 'probe',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    } as const;

    const noKey = new Os3ModelGateway({ env: {}, db });
    await expect(noKey.complete({ agentName: 'a', model: 'openrouter:vendor/some-model', request: { system: 's', user: 'u', schema } }))
      .rejects.toMatchObject({ name: 'Os3ModelGatewayError', code: 'AUTH_MISSING' });
    expect(() => noKey.resolveModel('none')).toThrow(Os3ModelGatewayError);

    const gw = new Os3ModelGateway({
      env: {},
      db,
      rateLimits: { openrouter: { maxRequestsPerWindow: 2, windowMs: 60_000 } },
      customAdapters: {
        openrouter: async (ref) => ({ text: '{"ok":true}', json: { ok: true }, inputTokens: 10, outputTokens: 5, stopReason: `served-${ref.model}` }),
      },
    });
    const model = 'openrouter:any-vendor/any-model:free';
    const r1 = await gw.complete({ agentName: 'suno-researcher', model, request: { system: 's', user: 'u', schema } });
    expect(r1.model).toBe('any-vendor/any-model:free');
    await gw.complete({ agentName: 'suno-researcher', model, request: { system: 's', user: 'u', schema } });
    await expect(gw.complete({ agentName: 'suno-researcher', model, request: { system: 's', user: 'u', schema } }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const usage = gw.getUsageSummary();
    expect(usage.totalRequests).toBe(2);
    expect(usage.totalInputTokens).toBe(20);
    expect(usage.byProvider.openrouter.errors).toBe(1);
    expect(db.listEvents({ limit: 50 }).filter((e) => e.eventType === 'model.usage')).toHaveLength(2);
  });

  it('9. JARVIS Core classifies, assembles context, authorizes tools, dispatches, and logs events', async () => {
    const { db, jarvis } = await createFixture();

    const wfRoute = await jarvis.handleDirective('xyp3rn> workflow retrieve-and-summarize', { query: 'portamento' });
    expect(wfRoute.classification.intent).toBe('workflow');
    expect(wfRoute.ok).toBe(true);
    expect(wfRoute.workflowResult?.status).toBe('success');
    expect(wfRoute.contextPackage).not.toBeNull();

    const agentRoute = await jarvis.handleDirective('agent suno-researcher what works for 808 glide');
    expect(agentRoute.classification.intent).toBe('agent');
    expect(agentRoute.selectedAgent?.name).toBe('suno-researcher');
    expect(agentRoute.authorizedTools).toEqual(expect.arrayContaining(['retrieve_context', 'write_evidence']));
    expect(agentRoute.agentRunResult?.status).toBe('success');

    for (const kind of ['jarvis.classified', 'jarvis.workflow.success', 'jarvis.agent.success']) {
      expect(db.listEvents({ eventType: kind, limit: 10 }).length).toBeGreaterThan(0);
    }

    // Approvals are explicit: a proposer cannot approve its own request
    const appr = jarvis.requestApproval({ itemType: 'knowledge_candidate', itemId: 'cand-1', proposer: 'suno-researcher', request: {} });
    expect(() => jarvis.decideApproval({ approvalId: appr.id, decision: 'approved', approver: 'suno-researcher', reason: 'self' })).toThrow(/self-approve/);
    expect(jarvis.decideApproval({ approvalId: appr.id, decision: 'approved', approver: 'blago', reason: 'ok' }).status).toBe('approved');
  });
});
