import { basename } from 'node:path';
import type postgres from 'postgres';
import type { AgentDefinition } from '../agent-registry/parse-agent-file.ts';
import type { AgentRegistry } from '../agent-registry/registry.ts';
import { quoteIdent, type Sql } from '../db/client.ts';
import type { ToolRegistry } from '../tool-registry/registry.ts';

/**
 * Single-agent dispatch (Phase 4D). Multi-agent chaining is Phase 5 — deliberately absent.
 *
 * Invariant: exactly one agent_runs row per call, opened as pending and always closed as
 * success or error. Failures are logged and returned, never thrown past the caller — the only
 * throw is when the run row itself can't be written (nothing left to log to).
 *
 * No retries. Retrying is a scope decision (idempotency of side-effecting Execution agents is
 * unsolved); flagged in docs/handoffs/PHASE-04D.md, not added.
 */

/** Default per-run timeout. 30s covers a single LLM call with headroom; override per dispatch. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const RUNTIME_ROLE = 'xyp_runtime';

export type RunLog = { readonly level: 'info' | 'warn' | 'error'; readonly message: string; readonly at: string };

export type AgentContext = {
  readonly runId: string;
  readonly agent: AgentDefinition;
  /** Aborted with reason `timeout after <n>ms` when the run times out. */
  readonly signal: AbortSignal;
  /** The only way a handler reaches a tool: declared-in-frontmatter check + authorization, every call. */
  readonly useTool: (name: string, args: unknown) => Promise<unknown>;
  readonly log: (level: RunLog['level'], message: string) => void;
};

export type AgentHandler = (ctx: AgentContext, input: unknown) => Promise<{ readonly output: unknown; readonly tokensUsed?: number }>;
/** Deterministic (`model: none`) agents, keyed by agent name. Checked in, typechecked. */
export type HandlerMap = Readonly<Record<string, AgentHandler>>;
/** Executes any LLM-backed agent from its definition (Phase 8: core/llm/runner.ts, provider keys read per call). */
export type LlmRunner = AgentHandler;

export type DispatchDeps = {
  readonly sql: Sql;
  readonly registry: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly handlers: HandlerMap;
  readonly llmRunner?: LlmRunner;
};

export type DispatchResult = {
  readonly runId: string;
  readonly status: 'success' | 'error';
  readonly output?: unknown;
  readonly error?: string;
  readonly latencyMs: number;
};

const asRuntime = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(RUNTIME_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/** Resolves why an agent isn't in the registry: invalid file (with reasons) vs. absent. */
const missingReason = (registry: AgentRegistry, name: string): string => {
  const failure = registry.validateAll().find((f) => basename(f.path) === `${name}.agent.md`);
  return failure
    ? `agent failed registry validation: ${failure.path}: ${failure.errors.join('; ')}`
    : `agent not in registry: ${name}`;
};

/**
 * Dispatches one agent: resolve → authorize every declared tool → execute with timeout → log.
 * @param deps - DB pool, registries, deterministic handlers, optional LLM runner
 * @param agentName - registry name
 * @param input - JSON input stored immutably on the run row
 * @param options - `timeoutMs` (default 30000); `workflowRunId` + `stepId` when run as a workflow step;
 *   `researchRunId` when run on behalf of a research run (Phase 6A)
 * @returns run id, final status, output or error, measured latency
 */
export const dispatch = async (
  deps: DispatchDeps,
  agentName: string,
  input: unknown,
  options: { readonly timeoutMs?: number; readonly workflowRunId?: string; readonly stepId?: string; readonly researchRunId?: string } = {},
): Promise<DispatchResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  const agent = deps.registry.get(agentName);
  const logs: RunLog[] = [];
  const log = (level: RunLog['level'], message: string) => logs.push({ level, message, at: new Date().toISOString() });

  const [opened] = await asRuntime(deps.sql, (tx) => tx<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input, workflow_run_id, step_id, research_run_id)
    values (${agentName}, ${agent?.class ?? null}, ${agent?.domain ?? null}, ${tx.json((input ?? null) as postgres.JSONValue)},
            ${options.workflowRunId ?? null}, ${options.stepId ?? null}, ${options.researchRunId ?? null})
    returning id`);
  const runId = opened!.id;
  const elapsed = () => Math.round(performance.now() - started);

  try {
    if (!agent) throw new Error(missingReason(deps.registry, agentName));

    // Every declared tool is authorized before anything executes; one denial halts the run.
    const denials = agent.tools
      .map((t) => ({ t, a: deps.tools.authorize(agent.class, t) }))
      .flatMap(({ t, a }) => (a.allow ? [] : [`${t}: ${a.reason}`]));
    if (denials.length > 0) throw new Error(`tool authorization denied: ${denials.join('; ')}`);

    const executor = agent.model === 'none' ? deps.handlers[agent.name] : deps.llmRunner;
    if (!executor) {
      throw new Error(
        agent.model === 'none'
          ? `no handler registered for deterministic agent ${agent.name}`
          : `LLM runner unavailable: no LLM runner configured (agent ${agent.name} uses model ${agent.model})`,
      );
    }

    const controller = new AbortController();
    const ctx: AgentContext = {
      runId,
      agent,
      signal: controller.signal,
      log,
      useTool: async (name, args) => {
        if (!agent.tools.includes(name)) throw new Error(`tool not declared by agent ${agent.name}: ${name}`);
        const a = deps.tools.authorize(agent.class, name);
        if (!a.allow) throw new Error(`tool authorization denied: ${name}: ${a.reason}`);
        return deps.tools.get(name)!.handler(
          { runId, agentName: agent.name, log, ...(options.researchRunId ? { researchRunId: options.researchRunId } : {}) },
          args,
        );
      },
    };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const reason = `timeout after ${timeoutMs}ms`;
        controller.abort(reason);
        reject(new Error(reason));
      }, timeoutMs);
    });
    let result: Awaited<ReturnType<AgentHandler>>;
    try {
      result = await Promise.race([executor(ctx, input), timeout]);
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = elapsed();
    const output = { result: result.output ?? null, logs };
    await asRuntime(deps.sql, (tx) => tx`
      update agent_runs
      set status = 'success', output = ${tx.json(output as postgres.JSONValue)}, tokens_used = ${result.tokensUsed ?? 0},
          latency_ms = ${latencyMs}, completed_at = clock_timestamp()
      where id = ${runId}`);
    return { runId, status: 'success', output: result.output, latencyMs };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const latencyMs = elapsed();
    await asRuntime(deps.sql, (tx) => tx`
      update agent_runs
      set status = 'error', error_detail = ${message}, output = ${tx.json({ logs } as postgres.JSONValue)},
          latency_ms = ${latencyMs}, completed_at = clock_timestamp()
      where id = ${runId}`);
    return { runId, status: 'error', error: message, latencyMs };
  }
};
