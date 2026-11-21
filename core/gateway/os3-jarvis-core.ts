import { randomUUID } from 'node:crypto';
import type { Os3AgentDefinition, Os3VaultAgentRegistry } from '../agent-registry/os3-agent-registry.ts';
import {
  analyzeContextQuery,
  type DawContextPackage,
  type Os3ContextEngine,
  type Os3ContextPackage,
} from '../context-engine/os3-context-engine.ts';
import type { AgentClass, Domain } from '../contracts/taxonomy.ts';
import {
  DawDelegationCoordinator,
  type DawBrainDelegate,
  type DawDelegationAction,
  type DawDelegationRequest,
  type DawDelegationResult,
} from '../orchestrator/daw-delegation-contract.ts';
import type { Os3Orchestrator, Os3SingleRunResult } from '../orchestrator/os3-orchestrator.ts';
import type { ApprovalItemType, PendingApprovalRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import type {
  Os3WorkflowEngine,
  Os3WorkflowExecutionResult,
} from '../workflow-engine/os3-workflow-engine.ts';

export type JarvisIntent = 'workflow' | 'agent' | 'context' | 'approval' | 'daw' | 'status';

export type JarvisRouteClassification = {
  readonly directive: string;
  readonly intent: JarvisIntent;
  readonly domain: Domain;
  readonly targetWorkflow: string | null;
  readonly targetAgent: string | null;
  readonly dawAction: DawDelegationAction | null;
  readonly queryTerms: readonly string[];
};

export type JarvisDecomposedTask = {
  readonly taskId: string;
  readonly kind:
    | 'context_retrieval'
    | 'permission_verification'
    | 'workflow_execution'
    | 'agent_execution'
    | 'daw_delegation'
    | 'result_aggregation'
    | 'human_escalation';
  readonly target: string;
  readonly dependsOn: readonly string[];
  readonly status: 'planned' | 'completed' | 'skipped' | 'awaiting_approval' | 'failed';
};

export type JarvisExecutionPlan = {
  readonly correlationId: string;
  readonly directive: string;
  readonly intent: JarvisIntent;
  readonly domain: Domain;
  readonly decomposedTasks: readonly JarvisDecomposedTask[];
  readonly permissionVerdict: {
    readonly allowed: boolean;
    readonly actorClass: AgentClass;
    readonly authorizedTools: readonly string[];
    readonly deniedTools: readonly string[];
    readonly requiresHumanApproval: boolean;
    readonly reason: string;
  };
};

export type JarvisMonitoringTelemetry = {
  readonly correlationId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly eventsLogged: number;
};

export type JarvisExecutionResponse = {
  readonly ok: boolean;
  readonly correlationId: string;
  readonly classification: JarvisRouteClassification;
  readonly plan: JarvisExecutionPlan;
  readonly contextPackage: Os3ContextPackage | null;
  readonly dawContextPackage: DawContextPackage | null;
  readonly selectedAgent: Os3AgentDefinition | null;
  readonly authorizedTools: readonly string[];
  readonly agentRunResult: Os3SingleRunResult | null;
  readonly workflowResult: Os3WorkflowExecutionResult | null;
  readonly dawResult: DawDelegationResult | null;
  readonly approvalRecord: PendingApprovalRecord | null;
  readonly aggregatedSummary: Readonly<Record<string, unknown>>;
  readonly monitoring: JarvisMonitoringTelemetry;
};

const DAW_ACTION_PHRASES: ReadonlyArray<{ readonly re: RegExp; readonly action: DawDelegationAction }> = [
  { re: /\b(rollback|revert|undo)\b/i, action: 'rollback_patch' },
  { re: /\b(execute|apply)\s+(patch|command|gain|eq|fader|param)\b/i, action: 'execute_patch' },
  { re: /\b(prepare|stage)\s+(patch|command)\b/i, action: 'prepare_patch' },
  { re: /\b(propose|suggest)\s+(patch|eq|mix)\b/i, action: 'propose_patch' },
  { re: /\b(validate|check)\s+(project|flp|rpp)\b/i, action: 'validate_project' },
  { re: /\b(analyze|audio|lufs|loudness|trace)\b/i, action: 'analyze_audio' },
  { re: /\b(param|parameters|knob)\b/i, action: 'inspect_parameters' },
  { re: /\b(plugin|plugins|vst|vst3)\b/i, action: 'discover_plugins' },
  { re: /\b(routing|bus|send|sidechain)\b/i, action: 'inspect_routing' },
  { re: /\b(track|tracks|mixer|fader)\b/i, action: 'inspect_tracks' },
  { re: /\b(session|saved|unsaved)\b/i, action: 'inspect_session' },
];

const inferDawAction = (cleanDirective: string): DawDelegationAction => {
  for (const entry of DAW_ACTION_PHRASES) {
    if (entry.re.test(cleanDirective)) return entry.action;
  }
  return 'observe';
};

/**
 * OS 3.0 JARVIS Core — the top-level request interpreter, intent classifier,
 * task decomposer, context retriever, agent/workflow selector, permission verifier,
 * execution planner/dispatcher, monitor, aggregator, human escalator, and
 * vendor-agnostic DAW Brain delegator.
 */
export class Os3JarvisCore {
  readonly #db: SqliteRuntimeDb;
  readonly #agents: Os3VaultAgentRegistry;
  readonly #tools: Os3ToolRegistry;
  readonly #contextEngine: Os3ContextEngine;
  readonly #orchestrator: Os3Orchestrator;
  readonly #workflows: Os3WorkflowEngine;
  readonly #dawCoordinator: DawDelegationCoordinator;

  constructor(options: {
    readonly db: SqliteRuntimeDb;
    readonly agents: Os3VaultAgentRegistry;
    readonly tools: Os3ToolRegistry;
    readonly contextEngine: Os3ContextEngine;
    readonly orchestrator: Os3Orchestrator;
    readonly workflows: Os3WorkflowEngine;
    readonly dawDelegate?: DawBrainDelegate | undefined;
  }) {
    this.#db = options.db;
    this.#agents = options.agents;
    this.#tools = options.tools;
    this.#contextEngine = options.contextEngine;
    this.#orchestrator = options.orchestrator;
    this.#workflows = options.workflows;
    this.#dawCoordinator = new DawDelegationCoordinator({
      db: this.#db,
      tools: this.#tools,
      delegate: options.dawDelegate,
    });
  }

  /**
   * 1. Request interpretation & 2. Intent classification + Agent/Workflow/DAW selection.
   */
  classifyRequest(directive: string): JarvisRouteClassification {
    const clean = directive.replace(/^xyp3rn>\s*/i, '').trim();
    const analysis = analyzeContextQuery(clean);
    const domain = (analysis.targetDomains[0] as Domain | undefined) ?? 'CORE';

    // Explicit workflow trigger: "workflow <name>"
    const wfMatch = /^workflow\s+([a-z0-9-]+)(?:\s+(.*))?$/i.exec(clean);
    if (wfMatch?.[1]) {
      const wf = this.#workflows.get(wfMatch[1]);
      if (wf) {
        return {
          directive: clean,
          intent: 'workflow',
          domain,
          targetWorkflow: wf.name,
          targetAgent: wf.steps[0]?.agent ?? null,
          dawAction: null,
          queryTerms: analysis.normalizedTerms,
        };
      }
    }

    // Explicit agent trigger: "agent <name>"
    const agentMatch = /^agent\s+([a-zA-Z0-9-]+)(?:\s+(.*))?$/i.exec(clean);
    if (agentMatch?.[1]) {
      const agent = this.#agents.get(agentMatch[1]);
      if (agent) {
        return {
          directive: clean,
          intent: 'agent',
          domain: agent.domain,
          targetWorkflow: null,
          targetAgent: agent.name,
          dawAction: null,
          queryTerms: analysis.normalizedTerms,
        };
      }
    }

    // Explicit DAW delegation trigger: "daw <action/query>" or FL Studio/REAPER studio directive
    if (/^(?:daw\b|fl\s*studio\b|reaper\b)/i.test(clean)) {
      const dawAction = inferDawAction(clean);
      const isMutating = dawAction === 'prepare_patch' || dawAction === 'execute_patch' || dawAction === 'rollback_patch';
      const preferredAgent = this.#agents.get(isMutating ? 'tech-audio-tools' : 'context-retriever') ?? this.#agents.list()[0];
      return {
        directive: clean,
        intent: 'daw',
        domain: 'TECH',
        targetWorkflow: null,
        targetAgent: preferredAgent?.name ?? null,
        dawAction,
        queryTerms: analysis.normalizedTerms,
      };
    }

    // Explicit status / context lookup trigger
    if (/^(?:status|health)\b/i.test(clean)) {
      return {
        directive: clean,
        intent: 'status',
        domain: 'CORE',
        targetWorkflow: null,
        targetAgent: 'health-check',
        dawAction: null,
        queryTerms: analysis.normalizedTerms,
      };
    }

    if (/^(?:context|lookup|search)\b/i.test(clean)) {
      return {
        directive: clean,
        intent: 'context',
        domain,
        targetWorkflow: null,
        targetAgent: 'context-retriever',
        dawAction: null,
        queryTerms: analysis.normalizedTerms,
      };
    }

    // Domain-based default agent selection from validated agents
    let defaultAgentName = 'context-retriever';
    if (domain === 'RESEARCH_INTELLIGENCE') defaultAgentName = 'suno-researcher';
    else if (domain === 'RECORDS') defaultAgentName = 'x3lius-lyrics';
    else if (domain === 'TECH') defaultAgentName = 'tech-audio-tools';
    else if (domain === 'GOVERNANCE') defaultAgentName = 'rights-conflict';

    const selected = this.#agents.get(defaultAgentName) ?? this.#agents.list()[0];

    return {
      directive: clean,
      intent: 'agent',
      domain: selected?.domain ?? domain,
      targetWorkflow: null,
      targetAgent: selected?.name ?? null,
      dawAction: null,
      queryTerms: analysis.normalizedTerms,
    };
  }

  /**
   * 3. Task decomposition, permission verification, and execution planning.
   */
  decomposeAndPlan(
    classification: JarvisRouteClassification,
    correlationId = `corr-${randomUUID()}`,
  ): JarvisExecutionPlan {
    const selectedAgent = classification.targetAgent
      ? (this.#agents.get(classification.targetAgent) ?? null)
      : null;

    const actorClass: AgentClass = selectedAgent?.class ?? 'Knowledge';
    const authorizedTools: string[] = [];
    const deniedTools: string[] = [];

    if (selectedAgent) {
      for (const toolName of selectedAgent.tools) {
        const auth = this.#tools.authorize(selectedAgent.class, toolName);
        if (auth.allow) authorizedTools.push(toolName);
        else deniedTools.push(toolName);
      }
    }

    const wfDef =
      classification.intent === 'workflow' && classification.targetWorkflow
        ? this.#workflows.get(classification.targetWorkflow)
        : undefined;
    const requiresHumanApproval =
      Boolean(wfDef?.steps.some((s) => Boolean(s.approvalGate))) ||
      classification.dawAction === 'execute_patch' ||
      classification.dawAction === 'rollback_patch';

    const tasks: JarvisDecomposedTask[] = [
      {
        taskId: 'task-context',
        kind: 'context_retrieval',
        target: classification.directive,
        dependsOn: [],
        status: 'planned',
      },
      {
        taskId: 'task-permissions',
        kind: 'permission_verification',
        target: selectedAgent?.name ?? classification.intent,
        dependsOn: ['task-context'],
        status: 'planned',
      },
    ];

    let dispatchTaskId = 'task-permissions';
    if (classification.intent === 'workflow' && classification.targetWorkflow) {
      dispatchTaskId = 'task-workflow';
      tasks.push({
        taskId: dispatchTaskId,
        kind: 'workflow_execution',
        target: classification.targetWorkflow,
        dependsOn: ['task-permissions'],
        status: 'planned',
      });
    } else if (classification.intent === 'daw' && classification.dawAction) {
      dispatchTaskId = 'task-daw';
      tasks.push({
        taskId: dispatchTaskId,
        kind: 'daw_delegation',
        target: classification.dawAction,
        dependsOn: ['task-permissions'],
        status: 'planned',
      });
    } else if (selectedAgent) {
      dispatchTaskId = 'task-agent';
      tasks.push({
        taskId: dispatchTaskId,
        kind: 'agent_execution',
        target: selectedAgent.name,
        dependsOn: ['task-permissions'],
        status: 'planned',
      });
    }

    if (requiresHumanApproval) {
      tasks.push({
        taskId: 'task-escalation',
        kind: 'human_escalation',
        target: 'pending_approvals',
        dependsOn: [dispatchTaskId],
        status: 'planned',
      });
    }

    tasks.push({
      taskId: 'task-aggregate',
      kind: 'result_aggregation',
      target: correlationId,
      dependsOn: [requiresHumanApproval ? 'task-escalation' : dispatchTaskId],
      status: 'planned',
    });

    const allowed =
      classification.intent === 'workflow'
        ? Boolean(wfDef)
        : classification.intent === 'daw'
          ? Boolean(classification.dawAction)
          : classification.intent === 'context'
            ? true
            : Boolean(selectedAgent) && deniedTools.length === 0;

    return {
      correlationId,
      directive: classification.directive,
      intent: classification.intent,
      domain: classification.domain,
      decomposedTasks: tasks,
      permissionVerdict: {
        allowed,
        actorClass,
        authorizedTools,
        deniedTools,
        requiresHumanApproval,
        reason: allowed
          ? 'Pre-flight permission verification passed'
          : deniedTools.length > 0
            ? `Denied unauthorized tools: ${deniedTools.join(', ')}`
            : 'Target agent or workflow unavailable',
      },
    };
  }

  /**
   * Dedicated DAW delegation entry point routing strictly through `DawDelegationCoordinator`.
   */
  async delegateToDawBrain(req: DawDelegationRequest): Promise<DawDelegationResult> {
    return this.#dawCoordinator.delegate(req);
  }

  /**
   * Dispatches a directive end-to-end:
   * Classification -> Context Retrieval -> Permission Verification & Planning ->
   * Dispatch (Workflow / Agent / DAW Brain Delegate) -> Monitoring -> Escalation -> Result Aggregation.
   */
  async handleDirective(
    directive: string,
    payload: Record<string, unknown> = {},
    options: {
      readonly correlationId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly stepApprovals?: Readonly<Record<string, string>> | undefined;
      readonly sessionId?: string | undefined;
      readonly approvalId?: string | undefined;
      readonly leaseId?: string | undefined;
      readonly actor?: string | undefined;
      readonly actorClass?: AgentClass | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<JarvisExecutionResponse> {
    const startMs = Date.now();
    const startedAt = new Date(startMs).toISOString();
    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;
    let eventsLogged = 0;

    const classification = this.classifyRequest(directive);
    const initialPlan = this.decomposeAndPlan(classification, correlationId);
    const taskStatus = new Map<string, JarvisDecomposedTask['status']>(
      initialPlan.decomposedTasks.map((t) => [t.taskId, t.status]),
    );

    const finalizePlan = (): JarvisExecutionPlan => ({
      ...initialPlan,
      decomposedTasks: initialPlan.decomposedTasks.map((t) => ({
        ...t,
        status: taskStatus.get(t.taskId) ?? t.status,
      })),
    });

    const recordEvent = (eventType: string, domain: Domain, eventPayload: Record<string, unknown>): void => {
      this.#db.appendEvent({
        eventType,
        domain,
        actor: 'jarvis-core',
        payload: { correlationId, ...eventPayload },
      });
      eventsLogged += 1;
    };

    // 4. Context assembly from Obsidian Vault (+ DAW Context for DAW directives)
    const contextPackage = await this.#contextEngine.retrieveContext(classification.directive, {
      maxItems: 5,
      tokenBudget: 1_200,
    });
    const dawContextPackage =
      classification.intent === 'daw'
        ? await this.#contextEngine.retrieveDawContext({
            query: classification.directive,
            sessionId: options.sessionId ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined),
            tokenBudget: 1_500,
          })
        : null;
    taskStatus.set('task-context', 'completed');
    taskStatus.set('task-permissions', initialPlan.permissionVerdict.allowed ? 'completed' : 'failed');

    recordEvent('jarvis.classified', classification.domain, {
      directive: classification.directive,
      intent: classification.intent,
      targetWorkflow: classification.targetWorkflow,
      targetAgent: classification.targetAgent,
      dawAction: classification.dawAction,
      contextItems: contextPackage.items.length,
    });

    const makeTelemetry = (): JarvisMonitoringTelemetry => {
      const endMs = Date.now();
      return {
        correlationId,
        startedAt,
        completedAt: new Date(endMs).toISOString(),
        durationMs: endMs - startMs,
        eventsLogged,
      };
    };

    // Route A: DAW Brain Delegation Contract (vendor-independent)
    if (classification.intent === 'daw' && classification.dawAction) {
      const agent = classification.targetAgent ? (this.#agents.get(classification.targetAgent) ?? null) : null;
      const actor = options.actor ?? agent?.name ?? 'jarvis-core';
      const actorClass: AgentClass = options.actorClass ?? agent?.class ?? 'Knowledge';

      const dawResult = await this.#dawCoordinator.delegate({
        correlationId,
        actor,
        actorClass,
        action: classification.dawAction,
        sessionId: options.sessionId ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined),
        approvalId: options.approvalId ?? (typeof payload.approvalId === 'string' ? payload.approvalId : undefined),
        leaseId: options.leaseId ?? (typeof payload.leaseId === 'string' ? payload.leaseId : undefined),
        payload,
        context: dawContextPackage ?? undefined,
      });

      const approvalRecord = dawResult.approvalId ? this.#db.getApproval(dawResult.approvalId) : null;
      taskStatus.set(
        'task-daw',
        dawResult.executionStatus === 'succeeded'
          ? 'completed'
          : dawResult.executionStatus === 'awaiting_approval'
            ? 'awaiting_approval'
            : 'failed',
      );
      if (taskStatus.has('task-escalation')) {
        taskStatus.set('task-escalation', dawResult.executionStatus === 'awaiting_approval' ? 'awaiting_approval' : dawResult.ok ? 'completed' : 'failed');
      }
      taskStatus.set('task-aggregate', 'completed');

      return {
        ok: dawResult.ok,
        correlationId,
        classification,
        plan: finalizePlan(),
        contextPackage,
        dawContextPackage,
        selectedAgent: agent,
        authorizedTools: initialPlan.permissionVerdict.authorizedTools,
        agentRunResult: null,
        workflowResult: null,
        dawResult,
        approvalRecord,
        aggregatedSummary: {
          mode: 'daw_delegation',
          action: dawResult.action,
          executionStatus: dawResult.executionStatus,
          stateTier: dawResult.stateTier,
          supportStatus: dawResult.capabilityInfo.supportStatus,
          evidenceCount: dawResult.evidence.length,
        },
        monitoring: makeTelemetry(),
      };
    }

    // Route B: Canonical Vault Workflow Execution
    if (classification.intent === 'workflow' && classification.targetWorkflow) {
      const wfResult = await this.#workflows.execute(
        classification.targetWorkflow,
        {
          query: classification.directive,
          request: classification.directive,
          ...payload,
        },
        {
          correlationId,
          stepApprovals: options.stepApprovals,
          signal: options.signal,
        },
      );

      recordEvent(`jarvis.workflow.${wfResult.status}`, classification.domain, {
        workflowName: wfResult.workflowName,
        workflowRunId: wfResult.workflowRunId,
        status: wfResult.status,
      });

      taskStatus.set(
        'task-workflow',
        wfResult.status === 'success'
          ? 'completed'
          : wfResult.status === 'awaiting_approval'
            ? 'awaiting_approval'
            : 'failed',
      );
      if (taskStatus.has('task-escalation')) {
        taskStatus.set('task-escalation', wfResult.status === 'awaiting_approval' ? 'awaiting_approval' : 'completed');
      }
      taskStatus.set('task-aggregate', 'completed');

      const approvalRecord = wfResult.pendingApprovalId
        ? this.#db.getApproval(wfResult.pendingApprovalId)
        : null;

      return {
        ok: wfResult.status === 'success' || wfResult.status === 'awaiting_approval',
        correlationId,
        classification,
        plan: finalizePlan(),
        contextPackage,
        dawContextPackage: null,
        selectedAgent: classification.targetAgent ? (this.#agents.get(classification.targetAgent) ?? null) : null,
        authorizedTools: initialPlan.permissionVerdict.authorizedTools,
        agentRunResult: null,
        workflowResult: wfResult,
        dawResult: null,
        approvalRecord,
        aggregatedSummary: {
          mode: 'workflow',
          workflowName: wfResult.workflowName,
          status: wfResult.status,
          ...wfResult.aggregation,
          output: wfResult.output ?? null,
        },
        monitoring: makeTelemetry(),
      };
    }

    // Route C: Direct Context Retrieval Only
    if (classification.intent === 'context') {
      taskStatus.set('task-aggregate', 'completed');
      return {
        ok: true,
        correlationId,
        classification,
        plan: finalizePlan(),
        contextPackage,
        dawContextPackage: null,
        selectedAgent: this.#agents.get('context-retriever') ?? null,
        authorizedTools: initialPlan.permissionVerdict.authorizedTools,
        agentRunResult: null,
        workflowResult: null,
        dawResult: null,
        approvalRecord: null,
        aggregatedSummary: {
          mode: 'context',
          itemCount: contextPackage.items.length,
          totalTokens: contextPackage.totalTokens,
        },
        monitoring: makeTelemetry(),
      };
    }

    // Route D: Single-Agent Execution
    const agent = classification.targetAgent ? (this.#agents.get(classification.targetAgent) ?? null) : null;
    if (!agent) {
      taskStatus.set('task-aggregate', 'failed');
      return {
        ok: false,
        correlationId,
        classification,
        plan: finalizePlan(),
        contextPackage,
        dawContextPackage: null,
        selectedAgent: null,
        authorizedTools: [],
        agentRunResult: null,
        workflowResult: null,
        dawResult: null,
        approvalRecord: null,
        aggregatedSummary: { mode: 'agent', error: 'No target agent resolved' },
        monitoring: makeTelemetry(),
      };
    }

    const runResult = await this.#orchestrator.executeSingleAgent(
      agent.name,
      {
        directive: classification.directive,
        contextItems: contextPackage.items.map((i) => ({
          entityId: i.entityId,
          filePath: i.filePath,
          checksum: i.checksum,
        })),
        ...payload,
      },
      {
        correlationId,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );

    recordEvent(`jarvis.agent.${runResult.status}`, agent.domain, {
      agentName: agent.name,
      runId: runResult.runId,
      status: runResult.status,
      latencyMs: runResult.latencyMs,
    });

    taskStatus.set('task-agent', runResult.status === 'success' ? 'completed' : 'failed');
    taskStatus.set('task-aggregate', 'completed');

    return {
      ok: runResult.status === 'success',
      correlationId,
      classification,
      plan: finalizePlan(),
      contextPackage,
      dawContextPackage: null,
      selectedAgent: agent,
      authorizedTools: initialPlan.permissionVerdict.authorizedTools,
      agentRunResult: runResult,
      workflowResult: null,
      dawResult: null,
      approvalRecord: null,
      aggregatedSummary: {
        mode: 'agent',
        agentName: agent.name,
        runId: runResult.runId,
        status: runResult.status,
        deduplicated: runResult.deduplicated ?? false,
        output: runResult.output ?? null,
      },
      monitoring: makeTelemetry(),
    };
  }

  /**
   * 8. Explicit Human Approval Handling (queue & decide — blocks agent self-approval).
   */
  requestApproval(input: {
    readonly itemType: ApprovalItemType;
    readonly itemId: string;
    readonly proposer: string;
    readonly request: Record<string, unknown>;
  }): PendingApprovalRecord {
    return this.#db.queueApproval(input);
  }

  decideApproval(input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason: string;
  }): PendingApprovalRecord {
    const existing = this.#db.getApproval(input.approvalId);
    if (!existing) {
      throw new Error(`Approval "${input.approvalId}" not found`);
    }
    if (input.approver.trim().toLowerCase() === existing.proposer.trim().toLowerCase()) {
      throw new Error(
        `Security violation: proposer "${existing.proposer}" cannot self-approve "${input.approvalId}"`,
      );
    }
    return this.#db.decideApproval(input);
  }
}
