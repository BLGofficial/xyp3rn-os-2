import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import type { AgentRegistry } from '../agent-registry/registry.ts';
import { quoteIdent } from '../db/client.ts';
import { createRunMemory, resolveBindings } from '../memory/memory.ts';
import { dispatch, RUNTIME_ROLE, type DispatchDeps } from '../orchestrator/dispatch.ts';
import { parseWorkflowSpec, topoOrder, type WorkflowSpec } from './spec.ts';

/**
 * Workflow Engine (Phase 5). Executes a validated spec step by step through the Phase 4
 * dispatcher: one agent_runs row per executed step, linked by workflow_run_id + step_id.
 * Any step failure fails the whole run — status error, the failing step named, every step that
 * never ran listed — and is reported on stderr. There is no partial success.
 *
 * Steps run sequentially in topological order. Independent branches could run in parallel;
 * not done yet because nothing needs it and sequential runs are easier to audit (flagged).
 */

export type EngineDeps = DispatchDeps;

export type LoadedWorkflow = WorkflowSpec & { readonly path: string; readonly sha256: string };

export type WorkflowResult = {
  readonly workflowRunId: string;
  readonly status: 'success' | 'error';
  readonly output?: unknown;
  readonly failedStep?: string;
  readonly error?: string;
  readonly skippedSteps: readonly string[];
  readonly steps: ReadonlyArray<{ readonly stepId: string; readonly agentRunId: string; readonly status: 'success' | 'error' }>;
};

/**
 * Reads and validates a spec file against the live Agent Registry.
 * @param path - *.workflow.yaml
 * @param registry - agents the spec may reference
 * @returns the spec plus its path and content hash (recorded on every run)
 * @throws Error listing every validation problem
 */
export const loadWorkflow = (path: string, registry: AgentRegistry): LoadedWorkflow => {
  const source = readFileSync(path, 'utf8');
  const r = parseWorkflowSpec(source, new Set(registry.list().map((a) => a.name)));
  if (!r.ok) throw new Error(`invalid workflow ${path}:\n- ${r.errors.join('\n- ')}`);
  return { ...r.spec, path, sha256: createHash('sha256').update(source).digest('hex') };
};

const asRuntime = <T>(deps: EngineDeps, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  deps.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(RUNTIME_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * Runs a workflow to completion or first failure.
 * @param deps - dispatcher dependencies (DB, registries, handlers)
 * @param wf - loaded spec
 * @param input - workflow input (must carry every required key)
 * @param options - per-step `timeoutMs`; `log` receives the loud failure line (default stderr)
 * @returns run id, status, output or the failing step + reason, skipped steps, per-step run ids
 */
export const runWorkflow = async (
  deps: EngineDeps,
  wf: LoadedWorkflow,
  input: Readonly<Record<string, unknown>>,
  options: { readonly timeoutMs?: number; readonly log?: (line: string) => void } = {},
): Promise<WorkflowResult> => {
  const log = options.log ?? ((line: string) => console.error(line));
  const spec = { name: wf.name, description: wf.description, requiredInput: wf.requiredInput, steps: wf.steps, output: wf.output };
  const [opened] = await asRuntime(deps, (tx) => tx<{ id: string }[]>`
    insert into workflow_runs (workflow_name, spec_sha256, spec, input)
    values (${wf.name}, ${wf.sha256}, ${tx.json(spec as postgres.JSONValue)}, ${tx.json(input as postgres.JSONValue)})
    returning id`);
  const workflowRunId = opened!.id;
  const order = topoOrder(wf.steps);
  const steps: { stepId: string; agentRunId: string; status: 'success' | 'error' }[] = [];

  const fail = async (failedStep: string, error: string): Promise<WorkflowResult> => {
    const done = new Set(steps.map((s) => s.stepId));
    const skippedSteps = order.filter((id) => id !== failedStep && !done.has(id));
    await asRuntime(deps, (tx) => tx`
      update workflow_runs
      set status = 'error', failed_step = ${failedStep}, error_detail = ${error}, skipped_steps = ${skippedSteps},
          output = ${tx.json({ steps } as postgres.JSONValue)}, completed_at = clock_timestamp()
      where id = ${workflowRunId}`);
    log(`[workflow] ${wf.name} FAILED at step ${failedStep}: ${error} (run ${workflowRunId}; not run: ${skippedSteps.join(', ') || 'none'})`);
    return { workflowRunId, status: 'error', failedStep, error, skippedSteps, steps };
  };

  const missing = wf.requiredInput.filter((k) => !(k in input));
  if (missing.length > 0) return fail('(input)', `missing required input: ${missing.join(', ')}`);

  const memory = createRunMemory(input);
  for (const stepId of order) {
    const step = wf.steps.find((s) => s.id === stepId)!;
    let stepInput: unknown;
    try {
      stepInput = resolveBindings(step.input, memory);
    } catch (e) {
      return fail(stepId, `input binding failed: ${(e as Error).message}`);
    }
    const r = await dispatch(deps, step.agent, stepInput, {
      workflowRunId,
      stepId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    steps.push({ stepId, agentRunId: r.runId, status: r.status });
    if (r.status === 'error') return fail(stepId, r.error ?? 'step failed');
    memory.remember(stepId, r.output);
  }

  let output: unknown;
  try {
    output = resolveBindings(wf.output, memory);
  } catch (e) {
    return fail('(output)', `output binding failed: ${(e as Error).message}`);
  }
  await asRuntime(deps, (tx) => tx`
    update workflow_runs set status = 'success', output = ${tx.json(output as postgres.JSONValue)}, completed_at = clock_timestamp()
    where id = ${workflowRunId}`);
  return { workflowRunId, status: 'success', output, skippedSteps: [], steps };
};
