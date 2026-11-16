import type { Os3AgentDefinition, Os3VaultAgentRegistry } from '../agent-registry/os3-agent-registry.ts';
import {
  analyzeContextQuery,
  type Os3ContextEngine,
  type Os3ContextPackage,
} from '../context-engine/os3-context-engine.ts';
import type { Domain } from '../contracts/taxonomy.ts';
import type { Os3Orchestrator, Os3SingleRunResult } from '../orchestrator/os3-orchestrator.ts';
import type { ApprovalItemType, PendingApprovalRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import type {
  Os3WorkflowEngine,
  Os3WorkflowExecutionResult,
} from '../workflow-engine/os3-workflow-engine.ts';

export type JarvisRouteClassification = {
  readonly directive: string;
  readonly intent: 'workflow' | 'agent' | 'context' | 'approval' | 'status';
  readonly domain: Domain;
  readonly targetWorkflow: string | null;
  readonly targetAgent: string | null;
  readonly queryTerms: readonly string[];
};

export type JarvisExecutionResponse = {
  readonly ok: boolean;
  readonly classification: JarvisRouteClassification;
  readonly contextPackage: Os3ContextPackage | null;
  readonly selectedAgent: Os3AgentDefinition | null;
  readonly authorizedTools: readonly string[];
  readonly agentRunResult: Os3SingleRunResult | null;
  readonly workflowResult: Os3WorkflowExecutionResult | null;
  readonly approvalRecord: PendingApprovalRecord | null;
};

/**
 * OS 3.0 JARVIS Core — the top-level request classifier, intent router, context assembler,
 * tool authorizer, execution dispatcher, result validator, and approval coordinator.
 */
export class Os3JarvisCore {
  readonly #db: SqliteRuntimeDb;
  readonly #agents: Os3VaultAgentRegistry;
  readonly #tools: Os3ToolRegistry;
  readonly #contextEngine: Os3ContextEngine;
  readonly #orchestrator: Os3Orchestrator;
  readonly #workflows: Os3WorkflowEngine;

  constructor(options: {
    readonly db: SqliteRuntimeDb;
    readonly agents: Os3VaultAgentRegistry;
    readonly tools: Os3ToolRegistry;
    readonly contextEngine: Os3ContextEngine;
    readonly orchestrator: Os3Orchestrator;
    readonly workflows: Os3WorkflowEngine;
  }) {
    this.#db = options.db;
    this.#agents = options.agents;
    this.#tools = options.tools;
    this.#contextEngine = options.contextEngine;
    this.#orchestrator = options.orchestrator;
    this.#workflows = options.workflows;
  }

  /**
   * 1. Request classification & 2. Intent routing + 3. Agent/Workflow selection.
   */
  classifyRequest(directive: string): JarvisRouteClassification {
    const clean = directive.replace(/^xyp3rn>\s*/i, '').trim();
    const analysis = analyzeContextQuery(clean);
    const domain = (analysis.targetDomains[0] as Domain | undefined) ?? 'CORE';

    // Explicit workflow trigger: "workflow <name>" or matching workflow name
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
          queryTerms: analysis.normalizedTerms,
        };
      }
    }

    // Explicit agent trigger: "agent <name>" or matching agent name
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
          queryTerms: analysis.normalizedTerms,
        };
      }
    }

    // Domain-based default agent selection from the 52 validated agents
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
      queryTerms: analysis.normalizedTerms,
    };
  }

  /**
   * Dispatches a directive end-to-end:
   * Request classification -> Context assembly -> Agent selection -> Tool authorization ->
   * Execution dispatch -> Result validation -> Event logging.
   */
  async handleDirective(
    directive: string,
    payload: Record<string, unknown> = {},
    options: {
      readonly stepApprovals?: Readonly<Record<string, string>> | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<JarvisExecutionResponse> {
    const classification = this.classifyRequest(directive);

    // 4. Context assembly from Obsidian Vault
    const contextPackage = await this.#contextEngine.retrieveContext(classification.directive, {
      maxItems: 5,
      tokenBudget: 1_200,
    });

    this.#db.appendEvent({
      eventType: 'jarvis.classified',
      domain: classification.domain,
      actor: 'jarvis-core',
      payload: {
        directive: classification.directive,
        intent: classification.intent,
        targetWorkflow: classification.targetWorkflow,
        targetAgent: classification.targetAgent,
        contextItems: contextPackage.items.length,
      },
    });

    // Workflow execution route
    if (classification.intent === 'workflow' && classification.targetWorkflow) {
      const wfResult = await this.#workflows.execute(
        classification.targetWorkflow,
        {
          query: classification.directive,
          request: classification.directive,
          ...payload,
        },
        {
          stepApprovals: options.stepApprovals,
          signal: options.signal,
        },
      );

      this.#db.appendEvent({
        eventType: `jarvis.workflow.${wfResult.status}`,
        domain: classification.domain,
        actor: 'jarvis-core',
        payload: {
          workflowName: wfResult.workflowName,
          workflowRunId: wfResult.workflowRunId,
          status: wfResult.status,
        },
      });

      return {
        ok: wfResult.status === 'success' || wfResult.status === 'awaiting_approval',
        classification,
        contextPackage,
        selectedAgent: classification.targetAgent ? (this.#agents.get(classification.targetAgent) ?? null) : null,
        authorizedTools: [],
        agentRunResult: null,
        workflowResult: wfResult,
        approvalRecord: wfResult.pendingApprovalId
          ? this.#db.getApproval(wfResult.pendingApprovalId)
          : null,
      };
    }

    // Single-agent execution route
    const agent = classification.targetAgent ? (this.#agents.get(classification.targetAgent) ?? null) : null;
    if (!agent) {
      return {
        ok: false,
        classification,
        contextPackage,
        selectedAgent: null,
        authorizedTools: [],
        agentRunResult: null,
        workflowResult: null,
        approvalRecord: null,
      };
    }

    // 5. Tool authorization check
    const authorizedTools: string[] = [];
    for (const toolName of agent.tools) {
      const auth = this.#tools.authorize(agent.class, toolName);
      if (auth.allow) {
        authorizedTools.push(toolName);
      }
    }

    // 6. Execution dispatch & 7. Result validation
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
      { signal: options.signal },
    );

    this.#db.appendEvent({
      eventType: `jarvis.agent.${runResult.status}`,
      domain: agent.domain,
      actor: 'jarvis-core',
      payload: {
        agentName: agent.name,
        runId: runResult.runId,
        status: runResult.status,
        latencyMs: runResult.latencyMs,
      },
    });

    return {
      ok: runResult.status === 'success',
      classification,
      contextPackage,
      selectedAgent: agent,
      authorizedTools,
      agentRunResult: runResult,
      workflowResult: null,
      approvalRecord: null,
    };
  }

  /**
   * 8. Explicit Human Approval Handling (queue & decide).
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
