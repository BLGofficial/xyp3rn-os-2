import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Os3VaultAgentRegistry } from '../agent-registry/os3-agent-registry.ts';
import { createRunMemory, resolveBindings } from '../memory/memory.ts';
import type { Os3Orchestrator } from '../orchestrator/os3-orchestrator.ts';
import type { AgentRunRecord, ApprovalItemType, JobRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import { sha256Hex } from '../vault-engine/revision.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
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
  readonly tool?: string | undefined;
  readonly toolArgs?: unknown;
  readonly dependsOn: readonly string[];
  readonly tools?: readonly string[] | undefined;
  readonly input: unknown;
  readonly when?: Os3WorkflowCondition | undefined;
  readonly approvalGate?: Os3WorkflowApprovalGate | undefined;
  readonly retryPolicy?: Os3WorkflowStepRetry | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onError?: 'fail' | 'fallback' | 'continue' | undefined;
  readonly fallbackOutput?: Record<string, unknown> | undefined;
};

export type Os3WorkflowDefinition = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
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
  readonly toolName?: string | undefined;
  readonly agentRunId: string | null;
  readonly status: 'success' | 'error' | 'skipped' | 'awaiting_approval';
  readonly attempts: number;
  readonly output?: unknown;
  readonly error?: string | undefined;
};

export type Os3WorkflowAggregationSummary = {
  readonly correlationId: string;
  readonly totalSteps: number;
  readonly succeededSteps: number;
  readonly failedSteps: number;
  readonly skippedStepsCount: number;
  readonly awaitingApprovalSteps: number;
  readonly totalAttempts: number;
};

export type Os3WorkflowExecutionResult = {
  readonly workflowRunId: string;
  readonly workflowName: string;
  readonly correlationId: string;
  readonly status: 'success' | 'error' | 'awaiting_approval' | 'cancelled';
  readonly output?: unknown;
  readonly failedStep?: string | undefined;
  readonly awaitingStep?: string | undefined;
  readonly pendingApprovalId?: string | undefined;
  readonly error?: string | undefined;
  readonly skippedSteps: readonly string[];
  readonly steps: readonly Os3WorkflowStepRunRecord[];
  readonly aggregation: Os3WorkflowAggregationSummary;
};

/**
 * Formal OS 3.0 Workflow YAML Schema descriptor for Vault workflows (`05_WORKFLOWS/DEFINITIONS/*.workflow.yaml`).
 */
export const OS3_WORKFLOW_SCHEMA = {
  schemaVersion: 'xyp3rn.workflow-dsl/v3',
  allowedTopLevelKeys: ['id', 'version', 'name', 'description', 'input', 'steps', 'output'] as const,
  allowedStepKeys: [
    'id',
    'agent',
    'tool',
    'toolArgs',
    'dependsOn',
    'tools',
    'input',
    'when',
    'approvalGate',
    'retryPolicy',
    'timeoutMs',
    'onError',
    'fallbackOutput',
  ] as const,
  stepErrorPolicies: ['fail', 'fallback', 'continue'] as const,
} as const;

const TOP_KEYS = new Set<string>(OS3_WORKFLOW_SCHEMA.allowedTopLevelKeys);
const STEP_KEYS = new Set<string>(OS3_WORKFLOW_SCHEMA.allowedStepKeys);
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_ID_RE = /^[a-z][a-z0-9_-]*$/;
const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  if (r.version !== undefined && (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1)) {
    errors.push(`invalid version: ${String(r.version)}`);
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

    let stepTool: string | undefined;
    if (st.tool !== undefined) {
      if (typeof st.tool !== 'string' || !SNAKE_RE.test(st.tool)) {
        errors.push(`step ${id}: tool must be snake_case`);
      } else {
        stepTool = st.tool;
        if (agentDef) {
          if (!agentDef.tools.includes(stepTool)) {
            errors.push(`step ${id}: tool "${stepTool}" is not declared by agent "${agentDef.name}"`);
          } else if (toolRegistry) {
            const auth = toolRegistry.authorize(agentDef.class, stepTool);
            if (!auth.allow) {
              errors.push(`step ${id}: tool authorization failed for "${stepTool}": ${auth.reason}`);
            }
          }
        }
      }
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

    if (
      st.onError !== undefined &&
      (typeof st.onError !== 'string' || !['fail', 'fallback', 'continue'].includes(st.onError))
    ) {
      errors.push(`step ${id}: onError must be fail|fallback|continue`);
    }

    if (st.timeoutMs !== undefined && (typeof st.timeoutMs !== 'number' || !Number.isFinite(st.timeoutMs) || st.timeoutMs <= 0)) {
      errors.push(`step ${id}: timeoutMs must be a positive number`);
    }

    const dependsOnRaw = st.dependsOn === undefined ? [] : st.dependsOn;
    if (!Array.isArray(dependsOnRaw)) {
      errors.push(`step ${id}: dependsOn must be a list`);
    }

    steps.push({
      id,
      agent: agentName,
      tool: stepTool,
      toolArgs: st.toolArgs,
      dependsOn: Array.isArray(dependsOnRaw) ? dependsOnRaw.map(String) : [],
      tools: stepTools,
      input: st.input ?? {},
      when: st.when as Os3WorkflowCondition | undefined,
      approvalGate: st.approvalGate as Os3WorkflowApprovalGate | undefined,
      retryPolicy: st.retryPolicy as Os3WorkflowStepRetry | undefined,
      timeoutMs: typeof st.timeoutMs === 'number' ? st.timeoutMs : undefined,
      onError: st.onError as 'fail' | 'fallback' | 'continue' | undefined,
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
      if (s.toolArgs !== undefined) {
        for (const ref of extractFromRefs(s.toolArgs)) {
          checkRef(`step ${s.id} (toolArgs)`, ref, up);
        }
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
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `wf-${wfName}`,
      name: wfName,
      version: typeof r.version === 'number' ? r.version : 1,
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

const buildAggregation = (
  correlationId: string,
  steps: readonly Os3WorkflowStepRunRecord[],
  skippedSteps: readonly string[],
): Os3WorkflowAggregationSummary => ({
  correlationId,
  totalSteps: steps.length + Math.max(0, skippedSteps.length - steps.filter((s) => s.status === 'skipped').length),
  succeededSteps: steps.filter((s) => s.status === 'success').length,
  failedSteps: steps.filter((s) => s.status === 'error').length,
  skippedStepsCount: skippedSteps.length,
  awaitingApprovalSteps: steps.filter((s) => s.status === 'awaiting_approval').length,
  totalAttempts: steps.reduce((acc, s) => acc + s.attempts, 0),
});

/**
 * OS 3.0 Workflow Engine loading canonical YAML definitions from `05_WORKFLOWS/DEFINITIONS/`
 * (or directly via `VaultEngine`) and executing topological DAGs with step dependencies,
 * conditional steps, direct agent/tool step invocation, human approval gates, retries,
 * failure recovery, correlation IDs, and SQLite execution history.
 */
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

  /**
   * Loads and compiles a canonical workflow directly through `VaultEngine` (`.workflow.yaml`
   * or Markdown `05_WORKFLOWS/*.md` containing a fenced `yaml` workflow definition block).
   */
  async loadFromVault(
    vault: VaultEngine,
    vaultPath: string,
    actor = 'workflow-engine',
  ): Promise<Os3WorkflowDefinition> {
    const doc = await vault.read(vaultPath, actor);
    let yamlSource = doc.rawContent;
    if (vaultPath.toLowerCase().endsWith('.md')) {
      const match = /```yaml\r?\n([\s\S]*?)\r?\n```/i.exec(doc.body);
      if (!match?.[1]) {
        throw new Error(`Vault workflow note "${vaultPath}" does not contain a fenced \`\`\`yaml workflow block`);
      }
      yamlSource = match[1];
    }
    const compiled = validateAndCompileOs3Workflow(yamlSource, this.#agents, this.#tools, vaultPath);
    if (!compiled.ok) {
      throw new Error(`Workflow compilation failed for "${vaultPath}": ${compiled.errors.join('; ')}`);
    }
    this.#workflows.set(compiled.workflow.name, compiled.workflow);
    return compiled.workflow;
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

  async #executeDirectToolStep(params: {
    readonly jobId: string;
    readonly step: Os3WorkflowStepSpec;
    readonly correlationId: string;
    readonly args: Record<string, unknown>;
  }): Promise<Os3WorkflowStepRunRecord> {
    const agent = this.#agents.get(params.step.agent);
    if (!agent) {
      return {
        stepId: params.step.id,
        agentName: params.step.agent,
        toolName: params.step.tool,
        agentRunId: null,
        status: 'error',
        attempts: 0,
        error: `Agent not found: "${params.step.agent}"`,
      };
    }

    const startMs = Date.now();
    const runRow = this.#db.startAgentRun({
      agentName: agent.name,
      class: agent.class,
      domain: agent.domain,
      model: agent.model,
      input: { tool: params.step.tool, args: params.args, _correlationId: params.correlationId },
      jobId: params.jobId,
      stepId: params.step.id,
    });

    const maxAttempts = Math.max(1, (params.step.retryPolicy?.maxRetries ?? 0) + 1);
    const backoffMs = Math.max(0, params.step.retryPolicy?.backoffMs ?? 0);
    let attempts = 0;
    let lastError = 'Tool step execution failed';

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const res = await this.#tools.execute(
          {
            runId: runRow.id,
            agentName: agent.name,
            agentClass: agent.class,
            log: () => undefined,
          },
          params.step.tool!,
          params.args,
        );
        this.#db.completeAgentRun(runRow.id, {
          output: res.output,
          tokensUsed: 0,
          latencyMs: Date.now() - startMs,
          model: agent.model,
        });
        return {
          stepId: params.step.id,
          agentName: agent.name,
          toolName: params.step.tool,
          agentRunId: runRow.id,
          status: 'success',
          attempts,
          output: res.output,
        };
      } catch (err) {
        lastError = (err as Error).message;
        if (attempts < maxAttempts && backoffMs > 0) {
          await sleep(backoffMs * attempts);
        }
      }
    }

    if (params.step.fallbackOutput) {
      const recovered = { ...params.step.fallbackOutput, recoveredFromError: lastError };
      this.#db.completeAgentRun(runRow.id, {
        output: recovered,
        tokensUsed: 0,
        latencyMs: Date.now() - startMs,
        model: agent.model,
      });
      return {
        stepId: params.step.id,
        agentName: agent.name,
        toolName: params.step.tool,
        agentRunId: runRow.id,
        status: 'success',
        attempts,
        output: recovered,
      };
    }

    this.#db.failAgentRun(runRow.id, {
      errorDetail: lastError,
      tokensUsed: 0,
      latencyMs: Date.now() - startMs,
    });
    return {
      stepId: params.step.id,
      agentName: agent.name,
      toolName: params.step.tool,
      agentRunId: runRow.id,
      status: 'error',
      attempts,
      error: lastError,
    };
  }

  async execute(
    workflowOrName: string | Os3WorkflowDefinition,
    input: Readonly<Record<string, unknown>>,
    options: {
      readonly correlationId?: string | undefined;
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

    const correlationId = options.correlationId ?? `corr-${randomUUID()}`;
    const job = this.#db.enqueueJob({
      kind: 'workflow',
      name: wf.name,
      specSha256: wf.sha256,
      input: { ...input, _correlationId: correlationId },
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
        correlationId,
        status: 'error',
        failedStep,
        error: errorMsg,
        skippedSteps: allSkipped,
        steps: stepRecords,
        aggregation: buildAggregation(correlationId, stepRecords, allSkipped),
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
          correlationId,
          status: 'cancelled',
          error: 'Workflow cancelled via AbortSignal',
          skippedSteps,
          steps: stepRecords,
          aggregation: buildAggregation(correlationId, stepRecords, skippedSteps),
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
            toolName: step.tool,
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
              correlationId,
              stepId,
              reason: step.approvalGate.reason ?? `Human approval required for step "${stepId}"`,
            },
          });

          stepRecords.push({
            stepId,
            agentName: step.agent,
            toolName: step.tool,
            agentRunId: null,
            status: 'awaiting_approval',
            attempts: 0,
          });

          return {
            workflowRunId: job.id,
            workflowName: wf.name,
            correlationId,
            status: 'awaiting_approval',
            awaitingStep: stepId,
            pendingApprovalId: pending.id,
            skippedSteps,
            steps: stepRecords,
            aggregation: buildAggregation(correlationId, stepRecords, skippedSteps),
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

      // 3. Resolve input/toolArgs bindings
      let resolvedStepInput: unknown;
      try {
        resolvedStepInput = resolveBindings(step.toolArgs !== undefined ? step.toolArgs : step.input, memory);
      } catch (err) {
        return failWorkflow(stepId, `input binding failed: ${(err as Error).message}`);
      }

      const inputRecord =
        resolvedStepInput !== null && typeof resolvedStepInput === 'object' && !Array.isArray(resolvedStepInput)
          ? (resolvedStepInput as Record<string, unknown>)
          : { value: resolvedStepInput };

      // 4. Direct tool step invocation OR orchestrated agent step execution
      let stepRec: Os3WorkflowStepRunRecord;
      if (step.tool) {
        stepRec = await this.#executeDirectToolStep({
          jobId: job.id,
          step,
          correlationId,
          args: inputRecord,
        });
      } else {
        const runRes = await this.#orchestrator.executeSingleAgent(step.agent, inputRecord, {
          correlationId,
          jobId: job.id,
          stepId,
          allowedTools: step.tools,
          timeoutMs: step.timeoutMs ?? options.timeoutMs,
          maxRetries: step.retryPolicy?.maxRetries,
          retryBackoffMs: step.retryPolicy?.backoffMs,
          fallbackOutput: step.fallbackOutput,
          signal: options.signal,
        });
        stepRec = {
          stepId,
          agentName: step.agent,
          agentRunId: runRes.runId,
          status: runRes.status === 'success' ? 'success' : 'error',
          attempts: runRes.attempts,
          output: runRes.output,
          error: runRes.error,
        };
      }

      stepRecords.push(stepRec);

      if (stepRec.status !== 'success') {
        if (step.onError === 'continue') {
          memory.remember(stepId, { ok: false, error: stepRec.error ?? 'step error continued' });
          continue;
        }
        return failWorkflow(stepId, stepRec.error ?? 'step execution failed');
      }

      memory.remember(stepId, stepRec.output);
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
      correlationId,
      status: 'success',
      output: finalOutput,
      skippedSteps,
      steps: stepRecords,
      aggregation: buildAggregation(correlationId, stepRecords, skippedSteps),
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
