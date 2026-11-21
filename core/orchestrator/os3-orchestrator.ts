import { randomUUID } from 'node:crypto';
import {
  INACTIVE_AGENT_STATUSES,
  type Os3AgentDefinition,
  type Os3VaultAgentRegistry,
} from '../agent-registry/os3-agent-registry.ts';
import type { Os3ModelGateway } from '../llm/os3-model-gateway.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import { topoOrder } from '../workflow-engine/spec.ts';

export type Os3StepCondition = {
  readonly field: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
  readonly exists?: boolean | undefined;
};

export type Os3AgentExecutionContext = {
  readonly runId: string;
  readonly correlationId: string;
  readonly agent: Os3AgentDefinition;
  readonly signal: AbortSignal;
  readonly useTool: (toolName: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  readonly modelGateway?: Os3ModelGateway | undefined;
};

export type Os3AgentHandler = (
  ctx: Os3AgentExecutionContext,
  input: Record<string, unknown>,
) => Promise<{
  readonly output: Record<string, unknown>;
  readonly tokensUsed?: number | undefined;
}>;

export type Os3SingleRunResult = {
  readonly runId: string;
  readonly correlationId: string;
  readonly agentName: string;
  readonly status: 'success' | 'error' | 'skipped' | 'cancelled';
  readonly output?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
  readonly tokensUsed: number;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly deduplicated?: boolean | undefined;
};

export type Os3StepSpec = {
  readonly stepId: string;
  readonly agentName: string;
  readonly dependsOn?: readonly string[] | undefined;
  readonly input:
    | Record<string, unknown>
    | ((prevOutputs: Readonly<Record<string, Record<string, unknown>>>) => Record<string, unknown>);
  readonly allowedTools?: readonly string[] | undefined;
  readonly condition?: Os3StepCondition | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryBackoffMs?: number | undefined;
  readonly fallbackOutput?: Record<string, unknown> | undefined;
};

export type Os3MultiStepRunResult = {
  readonly jobId: string;
  readonly correlationId: string;
  readonly status: 'success' | 'error' | 'cancelled';
  readonly stepResults: readonly ({ readonly stepId: string } & Os3SingleRunResult)[];
  readonly outputsByStep: Readonly<Record<string, Record<string, unknown>>>;
  readonly failedStep?: string | undefined;
  readonly skippedSteps: readonly string[];
  readonly error?: string | undefined;
  readonly deduplicated?: boolean | undefined;
};

/**
 * Maximum steps allowed in any single orchestration run to prevent uncontrolled autonomous loops.
 */
export const MAX_ORCHESTRATION_STEPS = 32;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const evaluateCondition = (
  cond: Os3StepCondition,
  data: Record<string, unknown>,
): boolean => {
  const parts = cond.field.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (cur !== null && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      cur = undefined;
      break;
    }
  }

  if (cond.exists !== undefined) {
    const exists = cur !== undefined && cur !== null;
    if (exists !== cond.exists) return false;
  }
  if ('equals' in cond && cond.equals !== undefined && cur !== cond.equals) {
    return false;
  }
  if ('notEquals' in cond && cond.notEquals !== undefined && cur === cond.notEquals) {
    return false;
  }
  return true;
};

const detectStepCycle = (steps: readonly Os3StepSpec[]): readonly string[] | null => {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cyc = visit(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const s of steps) {
    const cyc = visit(s.stepId);
    if (cyc) return cyc;
  }
  return null;
};

/**
 * OS 3.0 Task Orchestrator supporting single-agent, sequential, parallel multi-agent,
 * and dependency-graph (`executeDag`) execution with correlation IDs, idempotency deduplication,
 * retries with backoff, failure recovery, cancellation, and strict tool authorization.
 * Never permits uncontrolled autonomous loops (bounded by `MAX_ORCHESTRATION_STEPS`).
 */
export class Os3Orchestrator {
  readonly #db: SqliteRuntimeDb;
  readonly #agents: Os3VaultAgentRegistry;
  readonly #tools: Os3ToolRegistry;
  readonly #modelGateway: Os3ModelGateway | undefined;
  readonly #handlers: Map<string, Os3AgentHandler>;
  readonly #idempotentSingle = new Map<string, Os3SingleRunResult>();
  readonly #idempotentJobs = new Map<string, Os3MultiStepRunResult>();

  constructor(options: {
    readonly db: SqliteRuntimeDb;
    readonly agents: Os3VaultAgentRegistry;
    readonly tools: Os3ToolRegistry;
    readonly modelGateway?: Os3ModelGateway | undefined;
    readonly handlers?: Readonly<Record<string, Os3AgentHandler>> | undefined;
  }) {
    this.#db = options.db;
    this.#agents = options.agents;
    this.#tools = options.tools;
    this.#modelGateway = options.modelGateway;
    this.#handlers = new Map(Object.entries(options.handlers ?? {}));
  }

  registerHandler(agentName: string, handler: Os3AgentHandler): void {
    this.#handlers.set(agentName, handler);
  }

  #emitLifecycle(
    eventType: string,
    domain: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.#db.isOpen) return;
    try {
      this.#db.appendEvent({
        eventType,
        domain,
        actor,
        payload,
      });
    } catch {
      // Do not fail orchestration when audit sink is closing
    }
  }

  /**
   * Executes a single agent with correlation ID, optional idempotency deduplication,
   * tool authorization pre-check, timeout, retry/backoff recovery, cancellation support,
   * and immutable `agent_runs` tracking.
   */
  async executeSingleAgent(
    agentName: string,
    input: Record<string, unknown>,
    options: {
      readonly correlationId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly jobId?: string | undefined;
      readonly stepId?: string | undefined;
      readonly allowedTools?: readonly string[] | undefined;
      readonly timeoutMs?: number | undefined;
      readonly maxRetries?: number | undefined;
      readonly retryBackoffMs?: number | undefined;
      readonly fallbackOutput?: Record<string, unknown> | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<Os3SingleRunResult> {
    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;

    if (options.idempotencyKey) {
      const idemKey = `single:${agentName}:${options.idempotencyKey}`;
      const existing = this.#idempotentSingle.get(idemKey);
      if (existing) {
        this.#emitLifecycle('orchestrator.task.deduplicated', 'CORE', agentName, {
          correlationId,
          idempotencyKey: options.idempotencyKey,
          originalRunId: existing.runId,
        });
        return { ...existing, deduplicated: true };
      }
    }

    const startMs = Date.now();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxAttempts = Math.max(1, (options.maxRetries ?? 0) + 1);
    const backoffMs = Math.max(0, options.retryBackoffMs ?? 0);
    const agent = this.#agents.get(agentName);

    const runRow = this.#db.startAgentRun({
      agentName,
      class: agent?.class ?? null,
      domain: agent?.domain ?? null,
      model: agent?.model ?? null,
      input: { ...input, _correlationId: correlationId },
      jobId: options.jobId ?? null,
      stepId: options.stepId ?? null,
    });

    this.#emitLifecycle('orchestrator.task.started', agent?.domain ?? 'CORE', agentName, {
      runId: runRow.id,
      correlationId,
      jobId: options.jobId ?? null,
      stepId: options.stepId ?? null,
    });

    const failRun = (message: string, attempts: number, cancelled = false): Os3SingleRunResult => {
      const latencyMs = Date.now() - startMs;
      this.#db.failAgentRun(runRow.id, {
        errorDetail: message,
        tokensUsed: 0,
        latencyMs,
      });
      this.#emitLifecycle(
        cancelled ? 'orchestrator.task.cancelled' : 'orchestrator.task.failed',
        agent?.domain ?? 'CORE',
        agentName,
        { runId: runRow.id, correlationId, attempts, error: message },
      );
      return {
        runId: runRow.id,
        correlationId,
        agentName,
        status: cancelled ? 'cancelled' : 'error',
        error: message,
        tokensUsed: 0,
        attempts,
        latencyMs,
      };
    };

    if (options.signal?.aborted) {
      return failRun('Execution cancelled before start', 0, true);
    }

    if (!agent) {
      return failRun(`Agent not found in Os3VaultAgentRegistry: "${agentName}"`, 0);
    }

    if (INACTIVE_AGENT_STATUSES.has(agent.status)) {
      return failRun(`Agent "${agent.name}" is inactive (status="${agent.status}") and cannot run`, 0);
    }

    // 1. Pre-flight authorization check for all declared (and step-assigned) tools
    const effectiveTools = options.allowedTools ?? agent.tools;
    for (const toolName of effectiveTools) {
      if (!agent.tools.includes(toolName)) {
        return failRun(
          `Tool "${toolName}" is not declared in frontmatter of agent "${agent.name}"`,
          0,
        );
      }
      const auth = this.#tools.authorize(agent.class, toolName);
      if (!auth.allow) {
        return failRun(`Tool authorization denied for "${toolName}": ${auth.reason}`, 0);
      }
    }

    const customHandler = this.#handlers.get(agent.name);
    const defaultHandler: Os3AgentHandler = async (ctx, reqInput) => {
      let totalTokens = 0;
      if (agent.model !== 'none' && ctx.modelGateway) {
        const llmRes = await ctx.modelGateway.complete({
          agentName: agent.name,
          model: agent.model,
          request: {
            system: `Agent: ${agent.name} (${agent.class} / ${agent.domain})\nRole: ${agent.responsibilities}`,
            user: JSON.stringify(reqInput),
            schema: {
              name: `${agent.name}_response`,
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
                required: ['ok', 'summary'],
                additionalProperties: false,
              },
            },
            signal: ctx.signal,
          },
        });
        totalTokens += llmRes.usage.inputTokens + llmRes.usage.outputTokens;
        return {
          output: (llmRes.json as Record<string, unknown>) ?? { ok: true, text: llmRes.text },
          tokensUsed: totalTokens,
        };
      }

      if (effectiveTools.includes('log_message')) {
        await ctx.useTool('log_message', { message: `Executed ${agent.name} (${ctx.correlationId})` });
      }
      return {
        output: {
          ok: true,
          agent: agent.name,
          domain: agent.domain,
          class: agent.class,
          correlationId: ctx.correlationId,
          receivedInput: reqInput,
        },
        tokensUsed: 0,
      };
    };

    const handler = customHandler ?? defaultHandler;
    let attempt = 0;
    let lastError = 'Unknown execution failure';

    while (attempt < maxAttempts) {
      attempt += 1;
      const controller = new AbortController();
      const onParentAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
      options.signal?.addEventListener('abort', onParentAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(`timeout after ${timeoutMs}ms`);
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const ctx: Os3AgentExecutionContext = {
        runId: runRow.id,
        correlationId,
        agent,
        signal: controller.signal,
        modelGateway: this.#modelGateway,
        log: (level, message) => {
          this.#db.appendEvent({
            eventType: `agent.log.${level}`,
            domain: agent.domain,
            actor: agent.name,
            payload: { runId: runRow.id, correlationId, message },
          });
        },
        useTool: async (toolName, args = {}) => {
          if (controller.signal.aborted) {
            throw new Error('Execution aborted');
          }
          if (!effectiveTools.includes(toolName)) {
            throw new Error(
              `Security violation: agent "${agent.name}" attempted to invoke undeclared/unassigned tool "${toolName}"`,
            );
          }
          const res = await this.#tools.execute(
            {
              runId: runRow.id,
              agentName: agent.name,
              agentClass: agent.class,
              log: () => undefined,
            },
            toolName,
            args,
          );
          return res.output;
        },
      };

      try {
        const res = await Promise.race([handler(ctx, input), timeoutPromise]);
        const latencyMs = Date.now() - startMs;
        const tokensUsed = res.tokensUsed ?? 0;

        this.#db.completeAgentRun(runRow.id, {
          output: res.output,
          tokensUsed,
          latencyMs,
          model: agent.model,
        });

        this.#emitLifecycle('orchestrator.task.completed', agent.domain, agent.name, {
          runId: runRow.id,
          correlationId,
          attempts: attempt,
          latencyMs,
        });

        const successResult: Os3SingleRunResult = {
          runId: runRow.id,
          correlationId,
          agentName: agent.name,
          status: 'success',
          output: res.output,
          tokensUsed,
          attempts: attempt,
          latencyMs,
        };
        if (options.idempotencyKey) {
          this.#idempotentSingle.set(`single:${agentName}:${options.idempotencyKey}`, successResult);
        }
        return successResult;
      } catch (err) {
        lastError = (err as Error).message;
        if (options.signal?.aborted) {
          return failRun(`Cancelled: ${lastError}`, attempt, true);
        }
        if (attempt < maxAttempts) {
          this.#emitLifecycle('orchestrator.task.retrying', agent.domain, agent.name, {
            runId: runRow.id,
            correlationId,
            attempt,
            maxAttempts,
            error: lastError,
          });
          if (backoffMs > 0) {
            await sleep(backoffMs * attempt);
          }
          continue;
        }
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onParentAbort);
      }
    }

    // Failure recovery via fallbackOutput if configured on the step
    if (options.fallbackOutput) {
      const latencyMs = Date.now() - startMs;
      const recoveredOut = {
        ...options.fallbackOutput,
        recoveredFromError: lastError,
      };
      this.#db.completeAgentRun(runRow.id, {
        output: recoveredOut,
        tokensUsed: 0,
        latencyMs,
        model: agent.model,
      });
      this.#emitLifecycle('orchestrator.task.recovered', agent.domain, agent.name, {
        runId: runRow.id,
        correlationId,
        attempts: attempt,
        recoveredFromError: lastError,
      });
      const recoveredResult: Os3SingleRunResult = {
        runId: runRow.id,
        correlationId,
        agentName: agent.name,
        status: 'success',
        output: recoveredOut,
        tokensUsed: 0,
        attempts: attempt,
        latencyMs,
      };
      if (options.idempotencyKey) {
        this.#idempotentSingle.set(`single:${agentName}:${options.idempotencyKey}`, recoveredResult);
      }
      return recoveredResult;
    }

    return failRun(lastError, attempt);
  }

  /**
   * Executes a bounded sequence of agent steps with conditional branching (`condition`),
   * failure recovery (`maxRetries`, `fallbackOutput`), idempotency, correlationId, and cancellation (`signal`).
   */
  async executeSequential(
    name: string,
    steps: readonly Os3StepSpec[],
    initialInput: Record<string, unknown> = {},
    options: {
      readonly correlationId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<Os3MultiStepRunResult> {
    if (steps.length > MAX_ORCHESTRATION_STEPS) {
      throw new Error(
        `Orchestration safety guard: step count (${steps.length}) exceeds MAX_ORCHESTRATION_STEPS (${MAX_ORCHESTRATION_STEPS}). Uncontrolled loops are forbidden.`,
      );
    }

    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;
    if (options.idempotencyKey) {
      const existing = this.#idempotentJobs.get(`seq:${name}:${options.idempotencyKey}`);
      if (existing) {
        return { ...existing, deduplicated: true };
      }
    }

    const job = this.#db.enqueueJob({
      kind: 'workflow',
      name,
      input: { ...initialInput, _correlationId: correlationId },
      startImmediately: true,
    });

    const stepResults: ({ readonly stepId: string } & Os3SingleRunResult)[] = [];
    const outputsByStep: Record<string, Record<string, unknown>> = {
      input: initialInput,
    };
    const skippedSteps: string[] = [];

    for (const step of steps) {
      if (options.signal?.aborted) {
        const remaining = steps
          .slice(stepResults.length + skippedSteps.length)
          .map((s) => s.stepId);
        this.#db.cancelJob(job.id, 'Cancelled via AbortSignal');
        return {
          jobId: job.id,
          correlationId,
          status: 'cancelled',
          stepResults,
          outputsByStep,
          skippedSteps: [...skippedSteps, ...remaining],
          error: 'Cancelled via AbortSignal',
        };
      }

      if (step.condition && !evaluateCondition(step.condition, outputsByStep)) {
        skippedSteps.push(step.stepId);
        stepResults.push({
          stepId: step.stepId,
          runId: `skipped-${step.stepId}`,
          correlationId,
          agentName: step.agentName,
          status: 'skipped',
          tokensUsed: 0,
          attempts: 0,
          latencyMs: 0,
        });
        continue;
      }

      const resolvedInput =
        typeof step.input === 'function' ? step.input(outputsByStep) : step.input;

      const res = await this.executeSingleAgent(step.agentName, resolvedInput, {
        correlationId,
        jobId: job.id,
        stepId: step.stepId,
        allowedTools: step.allowedTools,
        timeoutMs: step.timeoutMs,
        maxRetries: step.maxRetries,
        retryBackoffMs: step.retryBackoffMs,
        fallbackOutput: step.fallbackOutput,
        signal: options.signal,
      });

      stepResults.push({ stepId: step.stepId, ...res });

      if (res.status === 'cancelled') {
        this.#db.cancelJob(job.id, res.error ?? 'Cancelled');
        return {
          jobId: job.id,
          correlationId,
          status: 'cancelled',
          stepResults,
          outputsByStep,
          skippedSteps,
          error: res.error,
        };
      }

      if (res.status === 'error') {
        const doneOrSkipped = new Set([
          ...stepResults.map((s) => s.stepId),
          ...skippedSteps,
        ]);
        const notRun = steps.filter((s) => !doneOrSkipped.has(s.stepId)).map((s) => s.stepId);
        const allSkipped = [...skippedSteps, ...notRun];
        this.#db.failJob(job.id, res.error ?? 'Step failed', step.stepId);
        return {
          jobId: job.id,
          correlationId,
          status: 'error',
          stepResults,
          outputsByStep,
          failedStep: step.stepId,
          skippedSteps: allSkipped,
          error: res.error,
        };
      }

      outputsByStep[step.stepId] = res.output ?? {};
    }

    this.#db.completeJob(job.id, outputsByStep, skippedSteps);
    const out: Os3MultiStepRunResult = {
      jobId: job.id,
      correlationId,
      status: 'success',
      stepResults,
      outputsByStep,
      skippedSteps,
    };
    if (options.idempotencyKey) {
      this.#idempotentJobs.set(`seq:${name}:${options.idempotencyKey}`, out);
    }
    return out;
  }

  /**
   * Executes multiple independent agent steps concurrently (bounded by `MAX_ORCHESTRATION_STEPS`).
   */
  async executeMultiAgent(
    name: string,
    steps: readonly Os3StepSpec[],
    options: {
      readonly correlationId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<Os3MultiStepRunResult> {
    if (steps.length > MAX_ORCHESTRATION_STEPS) {
      throw new Error(
        `Orchestration safety guard: step count (${steps.length}) exceeds MAX_ORCHESTRATION_STEPS (${MAX_ORCHESTRATION_STEPS}).`,
      );
    }

    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;
    if (options.idempotencyKey) {
      const existing = this.#idempotentJobs.get(`multi:${name}:${options.idempotencyKey}`);
      if (existing) {
        return { ...existing, deduplicated: true };
      }
    }

    const job = this.#db.enqueueJob({
      kind: 'workflow',
      name,
      input: { parallelCount: steps.length, _correlationId: correlationId },
      startImmediately: true,
    });

    const results = await Promise.all(
      steps.map(async (step) => {
        const resolvedInput = typeof step.input === 'function' ? step.input({}) : step.input;
        const r = await this.executeSingleAgent(step.agentName, resolvedInput, {
          correlationId,
          jobId: job.id,
          stepId: step.stepId,
          allowedTools: step.allowedTools,
          timeoutMs: step.timeoutMs,
          maxRetries: step.maxRetries,
          retryBackoffMs: step.retryBackoffMs,
          fallbackOutput: step.fallbackOutput,
          signal: options.signal,
        });
        return { stepId: step.stepId, ...r };
      }),
    );

    const outputsByStep: Record<string, Record<string, unknown>> = {};
    for (const r of results) {
      if (r.output) outputsByStep[r.stepId] = r.output;
    }

    const firstFailed = results.find((r) => r.status === 'error');
    if (firstFailed) {
      this.#db.failJob(job.id, firstFailed.error ?? 'Parallel step failed', firstFailed.stepId);
      return {
        jobId: job.id,
        correlationId,
        status: 'error',
        stepResults: results,
        outputsByStep,
        failedStep: firstFailed.stepId,
        skippedSteps: [],
        error: firstFailed.error,
      };
    }

    this.#db.completeJob(job.id, outputsByStep, []);
    const out: Os3MultiStepRunResult = {
      jobId: job.id,
      correlationId,
      status: 'success',
      stepResults: results,
      outputsByStep,
      skippedSteps: [],
    };
    if (options.idempotencyKey) {
      this.#idempotentJobs.set(`multi:${name}:${options.idempotencyKey}`, out);
    }
    return out;
  }

  /**
   * Executes a dependency graph (`dependsOn`) across agent steps:
   * - validates unknown dependencies and rejects cycles before running,
   * - dispatches ready dependency waves concurrently,
   * - supports conditional skipping, retries, fallback recovery, idempotency, cancellation, and correlation IDs.
   */
  async executeDag(
    name: string,
    steps: readonly Os3StepSpec[],
    initialInput: Record<string, unknown> = {},
    options: {
      readonly correlationId?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<Os3MultiStepRunResult> {
    if (steps.length > MAX_ORCHESTRATION_STEPS) {
      throw new Error(
        `Orchestration safety guard: step count (${steps.length}) exceeds MAX_ORCHESTRATION_STEPS (${MAX_ORCHESTRATION_STEPS}).`,
      );
    }

    const stepIds = new Set(steps.map((s) => s.stepId));
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepIds.has(dep)) {
          throw new Error(`DAG validation failed: step "${step.stepId}" depends on unknown step "${dep}"`);
        }
      }
    }
    const cycle = detectStepCycle(steps);
    if (cycle) {
      throw new Error(`DAG cycle detected: ${cycle.join(' -> ')}`);
    }

    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;
    if (options.idempotencyKey) {
      const existing = this.#idempotentJobs.get(`dag:${name}:${options.idempotencyKey}`);
      if (existing) {
        return { ...existing, deduplicated: true };
      }
    }

    const job = this.#db.enqueueJob({
      kind: 'workflow',
      name,
      input: { ...initialInput, _correlationId: correlationId, _mode: 'dag' },
      startImmediately: true,
    });

    const order = topoOrder(steps.map((s) => ({ id: s.stepId, dependsOn: [...(s.dependsOn ?? [])] })));
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    const completed = new Set<string>();
    const skippedSet = new Set<string>();
    const stepResults: ({ readonly stepId: string } & Os3SingleRunResult)[] = [];
    const outputsByStep: Record<string, Record<string, unknown>> = { input: initialInput };
    const skippedSteps: string[] = [];

    while (completed.size + skippedSet.size < steps.length) {
      if (options.signal?.aborted) {
        const remaining = order.filter((id) => !completed.has(id) && !skippedSet.has(id));
        this.#db.cancelJob(job.id, 'DAG cancelled via AbortSignal');
        return {
          jobId: job.id,
          correlationId,
          status: 'cancelled',
          stepResults,
          outputsByStep,
          skippedSteps: [...skippedSteps, ...remaining],
          error: 'DAG cancelled via AbortSignal',
        };
      }

      const ready = order
        .filter((id) => !completed.has(id) && !skippedSet.has(id))
        .filter((id) => {
          const deps = byId.get(id)!.dependsOn ?? [];
          return deps.every((d) => completed.has(d) || skippedSet.has(d));
        })
        .map((id) => byId.get(id)!);

      if (ready.length === 0) break;

      const waveOutcomes = await Promise.all(
        ready.map(async (step) => {
          const blockedBySkipped = (step.dependsOn ?? []).some((d) => skippedSet.has(d));
          if (blockedBySkipped || (step.condition && !evaluateCondition(step.condition, outputsByStep))) {
            return {
              kind: 'skipped' as const,
              step,
            };
          }
          const resolvedInput = typeof step.input === 'function' ? step.input(outputsByStep) : step.input;
          const runRes = await this.executeSingleAgent(step.agentName, resolvedInput, {
            correlationId,
            jobId: job.id,
            stepId: step.stepId,
            allowedTools: step.allowedTools,
            timeoutMs: step.timeoutMs,
            maxRetries: step.maxRetries,
            retryBackoffMs: step.retryBackoffMs,
            fallbackOutput: step.fallbackOutput,
            signal: options.signal,
          });
          return {
            kind: 'executed' as const,
            step,
            runRes,
          };
        }),
      );

      for (const outcome of waveOutcomes) {
        if (outcome.kind === 'skipped') {
          skippedSet.add(outcome.step.stepId);
          skippedSteps.push(outcome.step.stepId);
          stepResults.push({
            stepId: outcome.step.stepId,
            runId: `skipped-${outcome.step.stepId}`,
            correlationId,
            agentName: outcome.step.agentName,
            status: 'skipped',
            tokensUsed: 0,
            attempts: 0,
            latencyMs: 0,
          });
          continue;
        }

        const { step, runRes } = outcome;
        stepResults.push({ stepId: step.stepId, ...runRes });

        if (runRes.status === 'cancelled') {
          const remaining = order.filter((id) => !completed.has(id) && !skippedSet.has(id) && id !== step.stepId);
          this.#db.cancelJob(job.id, runRes.error ?? 'Cancelled');
          return {
            jobId: job.id,
            correlationId,
            status: 'cancelled',
            stepResults,
            outputsByStep,
            skippedSteps: [...skippedSteps, ...remaining],
            error: runRes.error,
          };
        }

        if (runRes.status === 'error') {
          const done = new Set(stepResults.map((r) => r.stepId));
          const notRun = order.filter((id) => !done.has(id));
          const allSkipped = [...skippedSteps, ...notRun];
          this.#db.failJob(job.id, runRes.error ?? 'DAG step failed', step.stepId);
          return {
            jobId: job.id,
            correlationId,
            status: 'error',
            stepResults,
            outputsByStep,
            failedStep: step.stepId,
            skippedSteps: allSkipped,
            error: runRes.error,
          };
        }

        completed.add(step.stepId);
        outputsByStep[step.stepId] = runRes.output ?? {};
      }
    }

    this.#db.completeJob(job.id, outputsByStep, skippedSteps);
    const out: Os3MultiStepRunResult = {
      jobId: job.id,
      correlationId,
      status: 'success',
      stepResults,
      outputsByStep,
      skippedSteps,
    };
    if (options.idempotencyKey) {
      this.#idempotentJobs.set(`dag:${name}:${options.idempotencyKey}`, out);
    }
    return out;
  }
}
