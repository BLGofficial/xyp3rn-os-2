import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import type { DawBrainDelegate } from '../../core/orchestrator/daw-delegation-contract.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3ToolRegistryWithDawContracts } from '../../core/tool-registry/daw-tool-contracts.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import {
  OS3_WORKFLOW_SCHEMA,
  Os3WorkflowEngine,
  validateAndCompileOs3Workflow,
} from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 8 Extensions — JARVIS Decomposition/DAW Delegation, Orchestrator DAG/Idempotency & Tool-Step Workflows', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const createFixture = async (dawDelegate?: DawBrainDelegate) => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p8-ext-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const tools = createOs3ToolRegistryWithDawContracts({ vault, db });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(vaultRoot, '04_AGENTS'), toolRegistry: tools });
    const orchestrator = new Os3Orchestrator({ db, agents, tools });
    const workflows = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });
    const contextEngine = new Os3ContextEngine({ vault, db });
    const jarvis = new Os3JarvisCore({
      db,
      agents,
      tools,
      contextEngine,
      orchestrator,
      workflows,
      dawDelegate,
    });
    return { dir, vaultRoot, db, vault, tools, agents, orchestrator, workflows, jarvis };
  };

  it('1. Orchestrator supports dependency-graph waves (executeDag), correlationIds, retry backoff & idempotency deduplication', async () => {
    const { db, orchestrator } = await createFixture();
    const callOrder: string[] = [];
    let flakyCount = 0;

    orchestrator.registerHandler('context-retriever', async (ctx, input) => {
      callOrder.push(`fetch:${ctx.correlationId}`);
      flakyCount += 1;
      if (flakyCount === 1) throw new Error('transient network blip');
      return { output: { fetched: input.topic ?? 'ok', corr: ctx.correlationId } };
    });
    orchestrator.registerHandler('extractive-summarizer', async (_ctx, input) => {
      callOrder.push('summarize');
      return { output: { merged: `${String(input.a)} + ${String(input.b)}` } };
    });

    // Reject cyclic or unknown DAG before launching
    await expect(
      orchestrator.executeDag('bad-dag', [
        { stepId: 'a', agentName: 'context-retriever', dependsOn: ['missing'], input: {} },
      ]),
    ).rejects.toThrow(/unknown step "missing"/i);

    const dagRes = await orchestrator.executeDag(
      'parallel-fanin-dag',
      [
        {
          stepId: 'branch-a',
          agentName: 'context-retriever',
          input: { topic: 'eq' },
          maxRetries: 1,
          retryBackoffMs: 5,
        },
        {
          stepId: 'branch-b',
          agentName: 'extractive-summarizer',
          input: { a: 'bass', b: 'sub' },
        },
        {
          stepId: 'combine',
          agentName: 'extractive-summarizer',
          dependsOn: ['branch-a', 'branch-b'],
          input: (prev) => ({
            a: prev['branch-a']?.fetched,
            b: prev['branch-b']?.merged,
          }),
        },
      ],
      {},
      { correlationId: 'corr-dag-001', idempotencyKey: 'dag-key-1' },
    );

    expect(dagRes.status).toBe('success');
    expect(dagRes.correlationId).toBe('corr-dag-001');
    expect(dagRes.outputsByStep.combine).toEqual({ merged: 'eq + bass + sub' });
    expect(flakyCount).toBe(2);

    // Repeat identical idempotent dispatch -> deduplicated without re-running handlers
    const dedupDag = await orchestrator.executeDag(
      'parallel-fanin-dag',
      [
        { stepId: 'branch-a', agentName: 'context-retriever', input: { topic: 'eq' } },
      ],
      {},
      { correlationId: 'corr-dag-002', idempotencyKey: 'dag-key-1' },
    );
    expect(dedupDag.deduplicated).toBe(true);
    expect(dedupDag.jobId).toBe(dagRes.jobId);
    expect(flakyCount).toBe(2);

    // Verify lifecycle events logged with correlationId
    const events = db.listEvents({ limit: 30 }).filter((e) => e.eventType.startsWith('orchestrator.task.'));
    expect(events.some((e) => e.eventType === 'orchestrator.task.started')).toBe(true);
    expect(events.some((e) => e.eventType === 'orchestrator.task.retrying')).toBe(true);
    expect(events.some((e) => e.eventType === 'orchestrator.task.completed')).toBe(true);
  });

  it('2. Workflow Engine compiles schema v3, loads canonical Vault workflows, invokes direct tool steps & aggregates results', async () => {
    const { vaultRoot, vault, agents, tools, workflows } = await createFixture();
    expect(OS3_WORKFLOW_SCHEMA.allowedStepKeys).toContain('tool');

    // Write a non-canonical staging note first so read_vault_file succeeds cleanly inside tool step
    await vault.write({
      vaultPath: '11_INBOX/wf-target.md',
      content: '---\nid: wf-target-note\ntitle: "Workflow Tool Target"\ndomain: CORE\nsector: 11_INBOX\nstatus: draft\nversion: 1\n---\n\nWorkflow tool step payload.\n',
      actor: 'vault-curator',
      reason: 'Seed Vault note for direct tool step',
    });

    const wfYaml = `id: wf-direct-tool-demo
version: 1
name: direct-tool-demo
description: Reads a Vault note via first-class tool invocation then logs result
input:
  required: [targetPath]
steps:
  - id: read_note
    agent: records-catalog-lookup
    tool: read_vault_file
    toolArgs:
      vaultPath:
        $from: input.targetPath
  - id: emit_log
    agent: health-check
    dependsOn: [read_note]
    tool: log_message
    toolArgs:
      message: "Verified workflow tool step execution"
      level: info
output:
  notePath:
    $from: steps.read_note.output.vaultPath
  logged:
    $from: steps.emit_log.output.logged
`;

    // Store as Markdown note inside 05_WORKFLOWS/ (canonical Vault document) and load via VaultEngine
    await writeFile(
      join(vaultRoot, '05_WORKFLOWS', 'direct-tool-demo.md'),
      `---\nschema: xyp3rn.workflow/v3\nid: wf-direct-tool-demo\nname: direct-tool-demo\ntitle: "Direct Tool Demo Workflow"\ndomain: CORE\nsector: 05_WORKFLOWS\nstatus: active\nversion: 1\n---\n\n\`\`\`yaml\n${wfYaml}\`\`\`\n`,
      'utf8',
    );

    const loaded = await workflows.loadFromVault(vault, '05_WORKFLOWS/direct-tool-demo.md');
    expect(loaded.name).toBe('direct-tool-demo');

    // Also verify invalid tool (unauthorized for agent) is rejected at compile time
    const badCompile = validateAndCompileOs3Workflow(
      wfYaml.replace('tool: read_vault_file', 'tool: write_splits'),
      agents,
      tools,
      'inline',
    );
    expect(badCompile.ok).toBe(false);

    const execRes = await workflows.execute(
      'direct-tool-demo',
      { targetPath: '11_INBOX/wf-target.md' },
      { correlationId: 'corr-wf-tool-1' },
    );
    expect(execRes.status).toBe('success');
    expect(execRes.correlationId).toBe('corr-wf-tool-1');
    expect(execRes.steps.map((s) => s.toolName)).toEqual(['read_vault_file', 'log_message']);
    expect(execRes.output).toEqual({
      notePath: '11_INBOX/wf-target.md',
      logged: 'Verified workflow tool step execution',
    });
    expect(execRes.aggregation.succeededSteps).toBe(2);
    expect(execRes.aggregation.totalAttempts).toBe(2);
  });

  it('3. JARVIS delegates cleanly to DAW Brain with plans, capabilities, evidence, vendor isolation & lease/approval gates', async () => {
    const delegatedRequests: unknown[] = [];
    const mockDelegate: DawBrainDelegate = {
      delegateName: 'test-daw-brain-delegate',
      executeDelegation: async (req) => {
        delegatedRequests.push(req);
        return {
          ok: true,
          correlationId: req.correlationId,
          action: req.action,
          sessionId: req.sessionId ?? 'sess-fl25',
          executionStatus: 'succeeded',
          stateTier: req.action === 'execute_patch' ? 'appliedModifications' : 'liveObserved',
          capabilityInfo: {
            capabilityId: req.action === 'execute_patch' ? 'daw.patch.execute' : 'daw.transport.read',
            dawToolContract: req.action === 'execute_patch' ? 'daw_execute_command_patch' : 'daw_observe_transport',
            requiredTier: req.action === 'execute_patch' ? 'execute' : 'observe',
            hostAdapterId: 'flstudio-2025-midi',
            hostVersion: '2025.2.0',
            supportStatus: 'SUPPORTED',
          },
          result: { playing: true, bpm: 140 },
          evidence: [
            {
              kind: 'observation',
              refId: 'obs-1',
              summary: 'Read-only transport snapshot returned by vendor-agnostic DAW delegate',
              timestamp: new Date().toISOString(),
            },
          ],
          approvalId: req.approvalId ?? null,
        };
      },
    };

    const { db, jarvis } = await createFixture(mockDelegate);
    db.upsertDawSession({
      id: 'sess-fl25',
      adapterId: 'flstudio-2025-midi',
      hostVersion: '2025.2.0',
      projectPath: 'D:/Projects/Demo.flp',
      status: 'connected',
    });

    // 1. Read-only DAW observation via JARVIS directive produces ExecutionPlan, DawContext & typed evidence
    const obsRes = await jarvis.handleDirective('xyp3rn> daw observe transport tempo', { sessionId: 'sess-fl25' });
    expect(obsRes.ok).toBe(true);
    expect(obsRes.classification.intent).toBe('daw');
    expect(obsRes.plan.decomposedTasks.map((t) => t.kind)).toContain('daw_delegation');
    expect(obsRes.dawContextPackage).not.toBeNull();
    expect(obsRes.dawResult?.executionStatus).toBe('succeeded');
    expect(obsRes.dawResult?.capabilityInfo.supportStatus).toBe('SUPPORTED');
    expect(obsRes.dawResult?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(obsRes.monitoring.correlationId).toBe(obsRes.correlationId);

    // 2. Vendor isolation: raw vendor DAW keys must be rejected by policy coordinator BEFORE touching delegate
    const priorDelegateCalls = delegatedRequests.length;
    const vendorViolation = await jarvis.delegateToDawBrain({
      correlationId: 'corr-vendor-reject',
      actor: 'tech-audio-tools',
      actorClass: 'Execution',
      action: 'observe',
      sessionId: 'sess-fl25',
      payload: { flStudioRawSysEx: [0xf0, 0x7e, 0xf7] },
    });
    expect(vendorViolation.ok).toBe(false);
    expect(vendorViolation.executionStatus).toBe('denied');
    expect(vendorViolation.error?.code).toBe('SECURITY_VENDOR_COUPLING_FORBIDDEN');
    expect(delegatedRequests.length).toBe(priorDelegateCalls);

    // 3. Mutating DAW execution denied without lease, then awaits approval cleanly, then succeeds once human approves
    const noLease = await jarvis.delegateToDawBrain({
      correlationId: 'corr-exec-nolease',
      actor: 'tech-audio-tools',
      actorClass: 'Execution',
      action: 'execute_patch',
      sessionId: 'sess-fl25',
      payload: { targetRef: 'mixer:insert:1', deltaDb: -1.5 },
    });
    expect(noLease.executionStatus).toBe('denied');
    expect(noLease.error?.code).toBe('DAW_LEASE_REQUIRED');

    const lease = db.grantDawLease({
      sessionId: 'sess-fl25',
      maxPermission: 'execute',
      grantedBy: 'blago-operator',
      allowedTargets: ['mixer:insert:1'],
      ttlMs: 60_000,
    });

    const awaitingApproval = await jarvis.delegateToDawBrain({
      correlationId: 'corr-exec-await',
      actor: 'tech-audio-tools',
      actorClass: 'Execution',
      action: 'execute_patch',
      sessionId: 'sess-fl25',
      leaseId: lease.id,
      payload: { targetRef: 'mixer:insert:1', deltaDb: -1.5 },
    });
    expect(awaitingApproval.executionStatus).toBe('awaiting_approval');
    expect(awaitingApproval.approvalId).toBeTruthy();
    expect(delegatedRequests.length).toBe(priorDelegateCalls);

    db.decideApproval({
      approvalId: awaitingApproval.approvalId!,
      decision: 'approved',
      approver: 'blago-operator',
      reason: 'Approved bounded mixer trim',
    });

    const approvedExec = await jarvis.delegateToDawBrain({
      correlationId: 'corr-exec-ok',
      actor: 'tech-audio-tools',
      actorClass: 'Execution',
      action: 'execute_patch',
      sessionId: 'sess-fl25',
      leaseId: lease.id,
      approvalId: awaitingApproval.approvalId!,
      payload: { targetRef: 'mixer:insert:1', deltaDb: -1.5 },
    });
    expect(approvedExec.ok).toBe(true);
    expect(approvedExec.executionStatus).toBe('succeeded');
    expect(approvedExec.stateTier).toBe('appliedModifications');
  });
});
