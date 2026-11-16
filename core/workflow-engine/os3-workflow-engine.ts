import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Os3VaultAgentRegistry } from '../agent-registry/os3-agent-registry.ts';
import { createRunMemory, resolveBindings } from '../memory/memory.ts';
import type { Os3Orchestrator } from '../orchestrator/os3-orchestrator.ts';
import type { AgentRunRecord, ApprovalItemType, JobRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import { sha256Hex } from '../vault-engine/revision.ts';
import { topoOrder } from './spec.ts';

export type Os3WorkflowCondition = {
  readonly $from: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
  readonly exists?: boolean | undefined;
};

export type Os3WorkflowApprovalGate = {
  readonly itemType: ApprovalItemType;
  readonly reason?: string | undefined;
};

export type Os3WorkflowStepRetry = {
  readonly maxRetries: number;
  readonly backoffMs?: number | undefined;
};

export type Os3WorkflowStepSpec = {
  readonly id: string;
  readonly agent: string;
  readonly dependsOn: readonly string[];
  readonly tools?: readonly string[] | undefined;
  readonly input: unknown;
  readonly when?: Os3WorkflowCondition | undefined;
  readonly approvalGate?: Os3WorkflowApprovalGate | undefined;
  readonly retryPolicy?: Os3WorkflowStepRetry | undefined;
  readonly fallbackOutput?: Record<string, unknown> | undefined;
};

export type Os3WorkflowDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly requiredInput: readonly string[];
  readonly optionalInput: readonly string[];
  readonly steps: readonly Os3WorkflowStepSpec[];
  readonly output: unknown;
  readonly path: string;
  readonly sha256: string;
};

export type Os3WorkflowStepRunRecord = {
  readonly stepId: string;
  readonly agentName: string;
  readonly agentRunId: string | null;
  readonly status: 'success' | 'error' | 'skipped' | 'awaiting_approval';
  readonly attempts: number;
  readonly output?: unknown;
  readonly error?: string | undefined;
};

export type Os3WorkflowExecutionResult = {
  readonly workflowRunId: string;
  readonly workflowName: string;
  readonly status: 'success' | 'error' | 'awaiting_approval' | 'cancelled';
  readonly output?: unknown;
  readonly failedStep?: string | undefined;
  readonly awaitingStep?: string | undefined;
  readonly pendingApprovalId?: string | undefined;
  readonly error?: string | undefined;
  readonly skippedSteps: readonly string[];
  readonly steps: readonly Os3WorkflowStepRunRecord[];
};

const TOP_KEYS = new Set(['name', 'description', 'input', 'steps', 'output']);
const STEP_KEYS = new Set([
  'id',
  'agent',
  'dependsOn',
  'tools',
  'input',
  'when',
  'approvalGate',
  'retryPolicy',
  'fallbackOutput',
]);
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_ID_RE = /^[a-z][a-z0-9_-]*$/;

const extractFromRefs = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap(extractFromRefs);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && '$from' in o) return [String(o.$from)];
    return Object.values(o).flatMap(extractFromRefs);
  }
  return [];
};

const detectCycle = (steps: readonly Os3WorkflowStepSpec[]): string[] | undefined => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const s of steps) {
    const c = visit(s.id);
    if (c) return c.reverse();
  }
  return undefined;
};

/**
 * Validates and compiles an OS 3.0 Workflow YAML specification against the live Agent and Tool Registries.
 */
export const validateAndCompileOs3Workflow = (
  yamlSource: string,
  agentRegistry: Os3VaultAgentRegistry,
  toolRegistry?: Os3ToolRegistry,
  filePath = 'inline.workflow.yaml',
):
  | { readonly ok: true; readonly workflow: Os3WorkflowDefinition }
  | { readonly ok: false; readonly path: string; readonly errors: readonly string[] } => {
  let raw: unknown;
  try {
    raw = parseYaml(yamlSource);
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      errors: [`not valid YAML: ${(err as Error).message.split('\n')[0]}`],
    };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, path: filePath, errors: ['workflow spec must be a key/value mapping'] };
  }

  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const k of Object.keys(r)) {
    if (!TOP_KEYS.has(k)) errors.push(`unknown field: ${k}`);
  }
  if (typeof r.name !== 'string' || !KEBAB_RE.test(r.name)) {
    errors.push(`name must be kebab-case: ${String(r.name)}`);
  }
  if (typeof r.description !== 'string' || r.description.trim() === '') {
    errors.push('description is required');
  }

  const inputDecl = (r.input ?? { required: [] }) as { required?: unknown; optional?: unknown };
  const requiredInput = Array.isArray(inputDecl.required) ? inputDecl.required.map(String) : [];
  if (inputDecl.optional !== undefined && !Array.isArray(inputDecl.optional)) {
    errors.push('input.optional must be a list');
  }
  const optionalInput = Array.isArray(inputDecl.optional) ? inputDecl.optional.map(String) : [];
  for (const k of optionalInput) {
    if (requiredInput.includes(k)) errors.push(`input ${k} is both required and optional`);
  }
  const declaredInput = [...requiredInput, ...optionalInput];

  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    errors.push('steps must be a non-empty list');
    return { ok: false, path: filePath, errors };
  }

  const steps: Os3WorkflowStepSpec[] = [];
  const seenIds = new Set<string>();

  for (const [idx, sRaw] of (r.steps as unknown[]).entries()) {
    const st = (sRaw ?? {}) as Record<string, unknown>;
    const id = typeof st.id === 'string' ? st.id : `#${idx}`;

    for (const k of Object.keys(st)) {
      if (!STEP_KEYS.has(k)) errors.push(`step ${id}: unknown field: ${k}`);
    }
    if (typeof st.id !== 'string' || !STEP_ID_RE.test(st.id)) {
      errors.push(`step ${id}: id must match ${STEP_ID_RE}`);
    }
    if (seenIds.has(id)) {
      errors.push(`duplicate step id: ${id}`);
    }
    seenIds.add(id);

    const agentName = typeof st.agent === 'string' ? st.agent : '';
    const agentDef = agentName ? agentRegistry.get(agentName) : undefined;
    if (!agentName) {
      errors.push(`step ${id}: agent is required`);
    } else if (!agentDef) {
      errors.push(`step ${id}: unknown agent ${agentName}`);
    }

    let stepTools: readonly string[] | undefined;
    if (st.tools !== undefined) {
      if (!Array.isArray(st.tools)) {
        errors.push(`step ${id}: tools must be a list`);
      } else {
        stepTools = st.tools.map(String);
        if (agentDef) {
          for (const tName of stepTools) {
            if (!agentDef.tools.includes(tName)) {
              errors.push(`step ${id}: tool "${tName}" is not declared by agent "${agentDef.name}"`);
            } else if (toolRegistry) {
              const auth = toolRegistry.authorize(agentDef.class, tName);
              if (!auth.allow) {
                errors.push(`step ${id}: tool authorization failed for "${tName}": ${auth.reason}`);
              }
            }
          }
        }
      }
    }

    const dependsOnRaw = st.dependsOn === undefined ? [] : st.dependsOn;
    if (!Array.isArray(dependsOnRaw)) {
      errors.push(`step ${id}: dependsOn must be a list`);
    }

    steps.push({
      id,
      agent: agentName,
      dependsOn: Array.isArray(dependsOnRaw) ? dependsOnRaw.map(String) : [],
      tools: stepTools,
      input: st.input ?? {},
      when: st.when as Os3WorkflowCondition | undefined,
      approvalGate: st.approvalGate as Os3WorkflowApprovalGate | undefined,
      retryPolicy: st.retryPolicy as Os3WorkflowStepRetry | undefined,
      fallbackOutput: st.fallbackOutput as Record<string, unknown> | undefined,
    });
  }

  const allStepIds = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (!allStepIds.has(d)) errors.push(`step ${s.id}: dependsOn unknown step ${d}`);
    }
  }

  const cycle = detectCycle(steps);
  if (cycle) {
    errors.push(`cycle detected: ${cycle.join(' -> ')}`);
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  const ancestors = (id: string, acc = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (acc.has(d) || !byId.has(d)) continue;
      acc.add(d);
      ancestors(d, acc);
    }
    return acc;
  };

  const checkRef = (where: string, ref: string, upstream: Set<string> | 'all') => {
    const p = ref.split('.');
    if (p[0] === 'input' && p.length >= 2) {
      if (declaredInput.length > 0 && !declaredInput.includes(p[1]!)) {
        errors.push(`${where}: $from ${ref} is not a declared input`);
      }
    } else if (p[0] === 'steps' && p[2] === 'output' && p[1]) {
      if (!allStepIds.has(p[1])) {
        errors.push(`${where}: $from ${ref} references unknown step ${p[1]}`);
      } else if (upstream !== 'all' && !upstream.has(p[1])) {
        errors.push(`${where}: $from ${ref} references ${p[1]}, which is not an upstream dependency`);
      }
    } else {
      errors.push(`${where}: $from must start with "input." or "steps.<id>.output": ${ref}`);
    }
  };

  if (!cycle) {
    for (const s of steps) {
      const up = ancestors(s.id);
      for (const ref of extractFromRefs(s.input)) {
        checkRef(`step ${s.id}`, ref, up);
      }
      if (s.when) {
        checkRef(`step ${s.id} (when)`, s.when.$from, up);
      }
    }
    for (const ref of extractFromRefs(r.output)) {
      checkRef('output', ref, 'all');
    }
  }

  if (errors.length > 0) {
    return { ok: false, path: filePath, errors };
  }

  const lastStepId = topoOrder(steps).at(-1)!;
  const wfName = r.name as string;
  return {
    ok: true,
    workflow: {
      id: `wf-${wfName}`,
      name: wfName,
      description: r.description as string,
      requiredInput,
      optionalInput,
      steps,
      output: r.output ?? { $from: `steps.${lastStepId}.output` },
      path: filePath,
      sha256: sha256Hex(yamlSource),
    },
  };
};

/**
 * OS 3.0 Workflow Engine loading YAML definitions from `05_WORKFLOWS/DEFINITIONS/`
 * and executing topological DAGs with step dependencies, conditional steps, human approval gates,
 * retry policies, failure handling, and full SQLite execution history.
 */
const FORBIDDEN_INPUT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_WORKFLOW_INPUT_BYTES = 256 * 1024;

const assertSafeWorkflowInput = (val: unknown, depth = 0): void => {
  if (depth > 20) {
    throw new Error('Security violation: workflow input nesting exceeds maximum depth (20)');
  }
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) {
    for (const item of val) assertSafeWorkflowInput(item, depth + 1);
    return;
  }
  for (const key of Object.keys(val as Record<string, unknown>)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) {
      throw new Error(`Security violation: forbidden prototype key "${key}" in workflow input`);
    }
    assertSafeWorkflowInput((val as Record<string, unknown>)[key], depth + 1);
  }
};

export class Os3WorkflowEngine {
  readonly #definitionsDir: string;
  readonly #db: SqliteRuntimeDb;
  readonly #agents: Os3VaultAgentRegistry;
  readonly #tools: Os3ToolRegistry;
  readonly #orchestrator: Os3Orchestrator;
  readonly #workflows = new Map<string, Os3WorkflowDefinition>();
  readonly #failures: { readonly path: string; readonly errors: readonly string[] }[] = [];

  constructor(options: {
    readonly definitionsDir: string;
    readonly db: SqliteRuntimeDb;
    readonly agents: Os3VaultAgentRegistry;
    readonly tools: Os3ToolRegistry;
    readonly orchestrator: Os3Orchestrator;
  }) {
    this.#definitionsDir = resolve(options.definitionsDir);
    this.#db = options.db;
    this.#agents = options.agents;
    this.#tools = options.tools;
    this.#orchestrator = options.orchestrator;
    this.reloadDefinitions();
  }

  get definitionsDir(): string {
    return this.#definitionsDir;
  }

  get failures(): readonly { readonly path: string; readonly errors: readonly string[] }[] {
    return this.#failures;
  }

  reloadDefinitions(): {
    readonly loaded: readonly Os3WorkflowDefinition[];
    readonly failures: readonly { readonly path: string; readonly errors: readonly string[] }[];
  } {
    this.#workflows.clear();
    this.#failures.length = 0;

    const files = readdirSync(this.#definitionsDir)
      .filter((f) => f.endsWith('.workflow.yaml') || f.endsWith('.yaml'))
      .sort();

    for (const file of files) {
      const fullPath = join(this.#definitionsDir, file);
      const rawYaml = readFileSync(fullPath, 'utf8');
      const compiled = validateAndCompileOs3Workflow(
        rawYaml,
        this.#agents,
        this.#tools,
        fullPath,
      );
      if (compiled.ok) {
        this.#workflows.set(compiled.workflow.name, compiled.workflow);
        const fileStem = file.replace(/\.workflow\.yaml$/, '').replace(/\.yaml$/, '');
        if (fileStem !== compiled.workflow.name) {
          // Also index by file stem (e.g., "write-lyrics" -> "x3lius-write-lyrics")
          this.#workflows.set(fileStem, compiled.workflow);
        }
      } else {
        this.#failures.push({ path: compiled.path, errors: compiled.errors });
      }
    }

    return {
      loaded: this.list(),
      failures: [...this.#failures],
    };
  }

  list(): readonly Os3WorkflowDefinition[] {
    const unique = new Map<string, Os3WorkflowDefinition>();
    for (const wf of this.#workflows.values()) {
      unique.set(wf.name, wf);
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(nameOrStem: string): Os3WorkflowDefinition | undefined {
    return this.#workflows.get(nameOrStem.trim());
  }

  async execute(
    workflowOrName: string | Os3WorkflowDefinition,
    input: Readonly<Record<string, unknown>>,
    options: {
      readonly timeoutMs?: number | undefined;
      readonly stepApprovals?: Readonly<Record<string, string>> | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<Os3WorkflowExecutionResult> {
    const wf =
      typeof workflowOrName === 'string' ? this.get(workflowOrName) : workflowOrName;
    if (!wf) {
      throw new Error(`Workflow not found in Os3WorkflowEngine: "${String(workflowOrName)}"`);
    }

    assertSafeWorkflowInput(input);
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_WORKFLOW_INPUT_BYTES) {
      throw new Error(`Security violation: workflow input exceeds ${MAX_WORKFLOW_INPUT_BYTES} byte limit`);
    }

    const job = this.#db.enqueueJob({
      kind: 'workflow',
      name: wf.name,
      specSha256: wf.sha256,
      input,
      startImmediately: true,
    });

    const order = topoOrder(wf.steps);
    const stepRecords: Os3WorkflowStepRunRecord[] = [];
    const skippedSteps: string[] = [];

    const failWorkflow = (failedStep: string, errorMsg: string): Os3WorkflowExecutionResult => {
      const doneOrSkipped = new Set([
        ...stepRecords.map((s) => s.stepId),
        ...skippedSteps,
      ]);
      const notRun = order.filter((id) => id !== failedStep && !doneOrSkipped.has(id));
      const allSkipped = [...skippedSteps, ...notRun];

      this.#db.failJob(job.id, errorMsg, failedStep);
      return {
        workflowRunId: job.id,
        workflowName: wf.name,
        status: 'error',
        failedStep,
        error: errorMsg,
        skippedSteps: allSkipped,
        steps: stepRecords,
      };
    };

    const missingInputs = wf.requiredInput.filter((k) => !(k in input));
    if (missingInputs.length > 0) {
      return failWorkflow('(input)', `missing required input: ${missingInputs.join(', ')}`);
    }

    const memory = createRunMemory({
      ...Object.fromEntries(
        wf.optionalInput.filter((k) => !(k in input)).map((k) => [k, null]),
      ),
      ...input,
    });

    for (const stepId of order) {
      if (options.signal?.aborted) {
        this.#db.cancelJob(job.id, 'Workflow cancelled via AbortSignal');
        return {
          workflowRunId: job.id,
          workflowName: wf.name,
          status: 'cancelled',
          error: 'Workflow cancelled via AbortSignal',
          skippedSteps,
          steps: stepRecords,
        };
      }

      const step = wf.steps.find((s) => s.id === stepId)!;

      // 1. Evaluate conditional step (`when`)
      if (step.when) {
        let condVal: unknown;
        try {
          condVal = resolveBindings({ $from: step.when.$from }, memory);
        } catch {
          condVal = undefined;
        }
        let condPass = true;
        if (step.when.exists !== undefined) {
          condPass = (condVal !== undefined && condVal !== null) === step.when.exists;
        }
        if (condPass && 'equals' in step.when && step.when.equals !== undefined) {
          condPass = condVal === step.when.equals;
        }
        if (condPass && 'notEquals' in step.when && step.when.notEquals !== undefined) {
          condPass = condVal !== step.when.notEquals;
        }

        if (!condPass) {
          skippedSteps.push(stepId);
          memory.remember(stepId, { skipped: true });
          stepRecords.push({
            stepId,
            agentName: step.agent,
            agentRunId: null,
            status: 'skipped',
            attempts: 0,
            output: { skipped: true },
          });
          continue;
        }
      }

      // 2. Evaluate human approval gate (`approvalGate`)
      if (step.approvalGate) {
        const approvalId = options.stepApprovals?.[stepId];
        if (!approvalId) {
          const pending = this.#db.queueApproval({
            itemType: step.approvalGate.itemType,
            itemId: `${wf.name}:${job.id}:${stepId}`,
            proposer: step.agent,
            request: {
              workflowName: wf.name,
              workflowRunId: job.id,
              stepId,
              reason: step.approvalGate.reason ?? `Human approval required for step "${stepId}"`,
            },
          });

          stepRecords.push({
            stepId,
            agentName: step.agent,
            agentRunId: null,
            status: 'awaiting_approval',
            attempts: 0,
          });

          return {
            workflowRunId: job.id,
            workflowName: wf.name,
            status: 'awaiting_approval',
            awaitingStep: stepId,
            pendingApprovalId: pending.id,
            skippedSteps,
            steps: stepRecords,
          };
        }

        const approvalRecord = this.#db.getApproval(approvalId);
        if (!approvalRecord || approvalRecord.status !== 'approved') {
          return failWorkflow(
            stepId,
            `Approval gate rejected at step "${stepId}": approval "${approvalId}" has status "${approvalRecord?.status ?? 'missing'}"`,
          );
        }
        if (
          !approvalRecord.approver ||
          approvalRecord.approver.toLowerCase() === approvalRecord.proposer.toLowerCase()
        ) {
          return failWorkflow(
            stepId,
            `Approval gate security violation at step "${stepId}": self-approval is forbidden`,
          );
        }
      }

      // 3. Resolve input bindings
      let resolvedStepInput: unknown;
      try {
        resolvedStepInput = resolveBindings(step.input, memory);
      } catch (err) {
        return failWorkflow(stepId, `input binding failed: ${(err as Error).message}`);
      }

      const inputRecord =
        resolvedStepInput !== null && typeof resolvedStepInput === 'object' && !Array.isArray(resolvedStepInput)
          ? (resolvedStepInput as Record<string, unknown>)
          : { value: resolvedStepInput };

      // 4. Dispatch step through Os3Orchestrator
      const runRes = await this.#orchestrator.executeSingleAgent(step.agent, inputRecord, {
        jobId: job.id,
        stepId,
        allowedTools: step.tools,
        timeoutMs: options.timeoutMs,
        maxRetries: step.retryPolicy?.maxRetries,
        fallbackOutput: step.fallbackOutput,
        signal: options.signal,
      });

      stepRecords.push({
        stepId,
        agentName: step.agent,
        agentRunId: runRes.runId,
        status: runRes.status === 'success' ? 'success' : 'error',
        attempts: runRes.attempts,
        output: runRes.output,
        error: runRes.error,
      });

      if (runRes.status !== 'success') {
        return failWorkflow(stepId, runRes.error ?? 'step execution failed');
      }

      memory.remember(stepId, runRes.output);
    }

    let finalOutput: unknown;
    try {
      finalOutput = resolveBindings(wf.output, memory);
    } catch (err) {
      return failWorkflow('(output)', `output binding failed: ${(err as Error).message}`);
    }

    this.#db.completeJob(job.id, finalOutput, skippedSteps);
    return {
      workflowRunId: job.id,
      workflowName: wf.name,
      status: 'success',
      output: finalOutput,
      skippedSteps,
      steps: stepRecords,
    };
  }

  getExecutionHistory(workflowName?: string, limit = 25): ReadonlyArray<{
    readonly job: JobRecord;
    readonly stepRuns: readonly AgentRunRecord[];
  }> {
    const allJobs = this.#db
      .listJobs(limit * 2)
      .filter((j) => j.kind === 'workflow' && (!workflowName || j.name === workflowName))
      .slice(0, limit);

    return allJobs.map((job) => ({
      job,
      stepRuns: this.#db.listAgentRunsByJob(job.id),
    }));
  }
}
