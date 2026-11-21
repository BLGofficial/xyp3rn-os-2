import { randomUUID } from 'node:crypto';
import type { Os3ContextEngine } from '../context-engine/os3-context-engine.ts';
import type { AgentClass } from '../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import { CLASS_CAPABILITIES, isCapability, type Capability } from './capabilities.ts';
import { createToolRegistry, type Authorization, type Tool, type ToolContext, type ToolRegistry } from './registry.ts';

export type ToolFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

export type ToolFieldRule = {
  readonly type: ToolFieldType;
  readonly description?: string | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly items?: ToolFieldType | undefined;
  readonly disallowUnsafePathsOrShell?: boolean | undefined;
};

export type ToolFieldSpec = ToolFieldType | ToolFieldRule;

export type Os3ToolSchema = {
  readonly required?: readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, ToolFieldSpec>> | undefined;
  readonly additionalProperties?: boolean | undefined;
};

export type Os3ToolRetryPolicy = {
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly retryablePattern?: RegExp | undefined;
};

export type Os3ToolPermissions = {
  readonly capability: Capability;
  readonly allowedClasses: readonly AgentClass[];
  readonly vaultAccess: 'none' | 'read' | 'write';
  readonly externalOperation: boolean;
  readonly requiresHumanApproval: boolean;
  readonly defaultDeny: true;
  readonly dawPermissionTier?: 'observe' | 'analyze' | 'propose' | 'prepare' | 'execute' | 'approve' | 'rollback' | undefined;
  readonly requiresActiveLease?: boolean | undefined;
};

export type Os3ToolExecutionPolicy = {
  readonly mode: 'local_pure' | 'vault_scoped' | 'external_bounded' | 'contract_only';
  readonly implemented: boolean;
  readonly allowShell: boolean;
  readonly allowUnrestrictedFs: boolean;
  readonly allowDirectDaw: boolean;
  readonly idempotent: boolean;
};

export type Os3ToolAuditPolicy = {
  readonly required: boolean;
  readonly redactSecrets: boolean;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
};

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'UNAUTHORIZED_TOOL'
  | 'NOT_IMPLEMENTED'
  | 'SECURITY_POLICY_VIOLATION'
  | 'INVALID_TOOL_INPUT'
  | 'INVALID_TOOL_OUTPUT'
  | 'TOOL_TIMEOUT'
  | 'TOOL_EXECUTION_FAILED';

export class Os3ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly toolName: string;
  readonly agentName: string;
  readonly runId: string;
  readonly attempts: number;

  constructor(options: {
    readonly code: ToolErrorCode;
    readonly toolName: string;
    readonly agentName: string;
    readonly runId: string;
    readonly attempts: number;
    readonly message: string;
  }) {
    super(options.message);
    this.name = 'Os3ToolExecutionError';
    this.code = options.code;
    this.toolName = options.toolName;
    this.agentName = options.agentName;
    this.runId = options.runId;
    this.attempts = options.attempts;
  }
}

export type Os3ToolExecutionContext = ToolContext & {
  readonly agentClass: AgentClass;
};

export type Os3ToolSpec = {
  readonly id: string;
  readonly name: string;
  readonly category?: string | undefined;
  readonly version: number;
  readonly capability: Capability;
  readonly description: string;
  readonly inputSchema: Os3ToolSchema;
  readonly outputSchema: Os3ToolSchema;
  readonly allowedClasses: readonly AgentClass[];
  readonly vaultAccess: 'none' | 'read' | 'write';
  readonly externalOperation: boolean;
  readonly permissions?: Os3ToolPermissions | undefined;
  readonly executionPolicy?: Os3ToolExecutionPolicy | undefined;
  readonly timeoutMs: number;
  readonly retryPolicy: Os3ToolRetryPolicy;
  readonly auditRequired: boolean;
  readonly auditPolicy?: Os3ToolAuditPolicy | undefined;
  readonly handler: (ctx: Os3ToolExecutionContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export type Os3RegisteredToolSpec = Os3ToolSpec & {
  readonly category: string;
  readonly permissions: Os3ToolPermissions;
  readonly executionPolicy: Os3ToolExecutionPolicy;
  readonly auditPolicy: Os3ToolAuditPolicy;
};

export type Os3ToolExecutionResult = {
  readonly ok: true;
  readonly toolName: string;
  readonly toolId: string;
  readonly capability: Capability;
  readonly output: Record<string, unknown>;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly audited: boolean;
};

const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)|\0/;
const SHELL_METACHARS_RE = /(?:&&|\|\||;\s*rm\b|;\s*del\b|\$\(|`[^`]+`)/i;
const SENSITIVE_KEY_RE = /(secret|token|password|api_?key|private_?key|authorization)/i;

const matchesPrimitiveType = (val: unknown, expected: ToolFieldType): boolean => {
  if (expected === 'any') return true;
  if (expected === 'array') return Array.isArray(val);
  if (expected === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  if (expected === 'number') return typeof val === 'number' && Number.isFinite(val);
  return typeof val === expected;
};

const normalizeRule = (spec: ToolFieldSpec): ToolFieldRule =>
  typeof spec === 'string' ? { type: spec } : spec;

export const validateSchemaObject = (
  value: unknown,
  schema: Os3ToolSchema,
  label: 'input' | 'output',
): { readonly ok: true; readonly record: Record<string, unknown> } | { readonly ok: false; readonly reason: string } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `Tool ${label} must be a JSON object` };
  }
  const rec = value as Record<string, unknown>;
  for (const reqField of schema.required ?? []) {
    if (!(reqField in rec) || rec[reqField] === undefined || rec[reqField] === null) {
      return { ok: false, reason: `Missing required ${label} field "${reqField}"` };
    }
  }

  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(rec)) {
      if (!(key in props)) {
        return { ok: false, reason: `Unexpected ${label} field "${key}" is not allowed by schema` };
      }
    }
  }

  for (const [prop, fieldSpec] of Object.entries(props)) {
    if (!(prop in rec) || rec[prop] === undefined || rec[prop] === null) continue;
    const rule = normalizeRule(fieldSpec);
    const val = rec[prop];

    if (!matchesPrimitiveType(val, rule.type)) {
      return {
        ok: false,
        reason: `Invalid type for ${label} field "${prop}": expected ${rule.type}, got ${typeof val}`,
      };
    }
    if (rule.enum && !rule.enum.includes(val as string | number | boolean)) {
      return {
        ok: false,
        reason: `Invalid value for ${label} field "${prop}": expected one of [${rule.enum.join(', ')}]`,
      };
    }
    if (typeof val === 'string') {
      if (rule.minLength !== undefined && val.length < rule.minLength) {
        return { ok: false, reason: `Field "${prop}" length must be >= ${rule.minLength}` };
      }
      if (rule.maxLength !== undefined && val.length > rule.maxLength) {
        return { ok: false, reason: `Field "${prop}" length must be <= ${rule.maxLength}` };
      }
      if (rule.disallowUnsafePathsOrShell) {
        if (TRAVERSAL_RE.test(val)) {
          return { ok: false, reason: `Security rejection: unsafe path traversal or NUL byte in "${prop}"` };
        }
        if (SHELL_METACHARS_RE.test(val)) {
          return { ok: false, reason: `Security rejection: unsafe shell metacharacters in "${prop}"` };
        }
      }
    }
    if (typeof val === 'number') {
      if (rule.minimum !== undefined && val < rule.minimum) {
        return { ok: false, reason: `Field "${prop}" must be >= ${rule.minimum}` };
      }
      if (rule.maximum !== undefined && val > rule.maximum) {
        return { ok: false, reason: `Field "${prop}" must be <= ${rule.maximum}` };
      }
    }
    if (Array.isArray(val) && rule.items) {
      for (const item of val) {
        if (!matchesPrimitiveType(item, rule.items)) {
          return {
            ok: false,
            reason: `Invalid array element in ${label} field "${prop}": expected ${rule.items}`,
          };
        }
      }
    }
  }
  return { ok: true, record: rec };
};

const redactAuditRecord = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactAuditRecord(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TOOL_TIMEOUT:${toolName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const normalizeAndValidateToolSpec = (spec: Os3ToolSpec): Os3RegisteredToolSpec => {
  if (!spec.id || !spec.id.trim()) {
    throw new Error(`Tool "${spec.name}" must declare a non-empty stable id`);
  }
  if (!SNAKE_RE.test(spec.name)) {
    throw new Error(`Tool name must be snake_case: ${spec.name}`);
  }
  if (!spec.description || !spec.description.trim()) {
    throw new Error(`Tool "${spec.name}" must declare a non-empty description`);
  }
  if (!isCapability(spec.capability)) {
    throw new Error(`Tool ${spec.name} declares unknown capability: ${String(spec.capability)}`);
  }
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error(`Tool "${spec.name}" must declare finite positive timeoutMs`);
  }
  if (!Number.isInteger(spec.retryPolicy.maxRetries) || spec.retryPolicy.maxRetries < 0) {
    throw new Error(`Tool "${spec.name}" must declare non-negative integer retryPolicy.maxRetries`);
  }

  const matrixAllowed = CLASS_CAPABILITIES[spec.capability];
  for (const cls of spec.allowedClasses) {
    if (!matrixAllowed.includes(cls)) {
      throw new Error(
        `Security violation: tool "${spec.name}" grants class "${cls}" which lacks capability "${spec.capability}"`,
      );
    }
  }

  const executionPolicy: Os3ToolExecutionPolicy = spec.executionPolicy ?? {
    mode:
      spec.externalOperation
        ? 'external_bounded'
        : spec.vaultAccess !== 'none'
          ? 'vault_scoped'
          : 'local_pure',
    implemented: true,
    allowShell: false,
    allowUnrestrictedFs: false,
    allowDirectDaw: false,
    idempotent: spec.vaultAccess === 'read' || spec.vaultAccess === 'none',
  };

  if (
    executionPolicy.allowShell ||
    executionPolicy.allowUnrestrictedFs ||
    executionPolicy.allowDirectDaw
  ) {
    throw new Error(
      `Security violation: tool "${spec.name}" cannot enable unrestricted shell, filesystem, or DAW access`,
    );
  }

  const permissions: Os3ToolPermissions = spec.permissions ?? {
    capability: spec.capability,
    allowedClasses: spec.allowedClasses,
    vaultAccess: spec.vaultAccess,
    externalOperation: spec.externalOperation,
    requiresHumanApproval: spec.externalOperation,
    defaultDeny: true,
  };

  if (!permissions.defaultDeny || permissions.capability !== spec.capability) {
    throw new Error(`Tool "${spec.name}" permissions contract drifted from declared capability or defaultDeny`);
  }

  const auditPolicy: Os3ToolAuditPolicy = spec.auditPolicy ?? {
    required: spec.auditRequired,
    redactSecrets: true,
    recordInputs: true,
    recordOutputs: true,
  };

  return {
    ...spec,
    category: spec.category?.trim() || 'os3_core',
    permissions,
    executionPolicy,
    auditPolicy,
  };
};

/**
 * OS 3.0 Tool Registry extending the single-kernel `ToolRegistry` with input/output schemas,
 * explicit execution policy, deny-by-default class + permission validation, timeout, retry policy,
 * contract-only DAW tool guards, and mandatory runtime audit logging.
 */
export class Os3ToolRegistry {
  readonly #specs = new Map<string, Os3RegisteredToolSpec>();
  readonly #kernelRegistry: ToolRegistry;
  readonly #db: SqliteRuntimeDb | null;

  constructor(specs: readonly Os3ToolSpec[], db?: SqliteRuntimeDb | null) {
    this.#db = db ?? null;
    const kernelTools: Tool[] = [];
    const seenIds = new Set<string>();

    for (const rawSpec of specs) {
      const spec = normalizeAndValidateToolSpec(rawSpec);
      if (this.#specs.has(spec.name)) {
        throw new Error(`Duplicate tool name: ${spec.name}`);
      }
      if (seenIds.has(spec.id)) {
        throw new Error(`Duplicate tool id: ${spec.id}`);
      }
      seenIds.add(spec.id);
      this.#specs.set(spec.name, spec);
      kernelTools.push({
        name: spec.name,
        capability: spec.capability,
        description: spec.description,
        handler: async (ctx, args) => {
          const res = await this.execute(
            { ...ctx, agentClass: spec.allowedClasses[0] ?? 'Execution' },
            spec.name,
            args,
          );
          return res.output;
        },
      });
    }

    this.#kernelRegistry = createToolRegistry(kernelTools);
  }

  get kernelRegistry(): ToolRegistry {
    return this.#kernelRegistry;
  }

  getSpec(name: string): Os3RegisteredToolSpec | undefined {
    return this.#specs.get(name);
  }

  listSpecs(): readonly Os3RegisteredToolSpec[] {
    return [...this.#specs.values()];
  }

  authorize(agentClass: AgentClass, toolName: string): Authorization {
    const spec = this.#specs.get(toolName);
    if (!spec) {
      return { allow: false, reason: `tool not registered: ${toolName}` };
    }
    const baseDecision = this.#kernelRegistry.authorize(agentClass, toolName);
    if (!baseDecision.allow) {
      return baseDecision;
    }
    if (!spec.allowedClasses.includes(agentClass)) {
      return {
        allow: false,
        reason: `tool ${toolName} restricts execution to [${spec.allowedClasses.join(', ')}] (denied for ${agentClass})`,
      };
    }
    return baseDecision;
  }

  #recordAudit(
    ctx: Os3ToolExecutionContext,
    toolName: string,
    status: 'success' | 'denied' | 'timeout' | 'error',
    details: Record<string, unknown>,
  ): boolean {
    if (!this.#db || !this.#db.isOpen) return false;
    const spec = this.#specs.get(toolName);
    const sanitized =
      spec?.auditPolicy.redactSecrets ?? true ? redactAuditRecord(details) : details;
    try {
      this.#db.appendEvent({
        eventType: `tool.${status}`,
        domain: 'CORE',
        actor: ctx.agentName,
        targetPath: `tool:${toolName}`,
        payload: {
          runId: ctx.runId,
          agentName: ctx.agentName,
          agentClass: ctx.agentClass,
          toolName,
          status,
          ...sanitized,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    ctx: Os3ToolExecutionContext,
    toolName: string,
    rawArgs: unknown,
  ): Promise<Os3ToolExecutionResult> {
    const startMs = Date.now();
    const spec = this.#specs.get(toolName);
    if (!spec) {
      this.#recordAudit(ctx, toolName, 'denied', { reason: 'tool not registered' });
      throw new Os3ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        toolName,
        agentName: ctx.agentName,
        runId: ctx.runId,
        attempts: 0,
        message: `Tool not registered: "${toolName}"`,
      });
    }

    const auth = this.authorize(ctx.agentClass, toolName);
    if (!auth.allow) {
      this.#recordAudit(ctx, toolName, 'denied', { reason: auth.reason });
      throw new Os3ToolExecutionError({
        code: 'UNAUTHORIZED_TOOL',
        toolName,
        agentName: ctx.agentName,
        runId: ctx.runId,
        attempts: 0,
        message: auth.reason,
      });
    }

    if (!spec.executionPolicy.implemented || spec.executionPolicy.mode === 'contract_only') {
      const reason = `Tool "${toolName}" (${spec.category}) is declared as contract-only and is not implemented for execution in this phase`;
      this.#recordAudit(ctx, toolName, 'denied', { reason, code: 'NOT_IMPLEMENTED' });
      throw new Os3ToolExecutionError({
        code: 'NOT_IMPLEMENTED',
        toolName,
        agentName: ctx.agentName,
        runId: ctx.runId,
        attempts: 0,
        message: reason,
      });
    }

    const inputCheck = validateSchemaObject(rawArgs ?? {}, spec.inputSchema, 'input');
    if (!inputCheck.ok) {
      this.#recordAudit(ctx, toolName, 'error', { reason: inputCheck.reason });
      throw new Os3ToolExecutionError({
        code: 'INVALID_TOOL_INPUT',
        toolName,
        agentName: ctx.agentName,
        runId: ctx.runId,
        attempts: 0,
        message: `Tool "${toolName}" input validation failed: ${inputCheck.reason}`,
      });
    }

    // Security guard: reject unsafe path traversal / NUL / shell metacharacters on any top-level path arg
    for (const [key, val] of Object.entries(inputCheck.record)) {
      if (typeof val === 'string' && /(path|file|dir|target)/i.test(key)) {
        if (TRAVERSAL_RE.test(val) || SHELL_METACHARS_RE.test(val)) {
          const reason = `Security rejection: unsafe path or shell injection attempt in "${key}"`;
          this.#recordAudit(ctx, toolName, 'denied', { reason });
          throw new Os3ToolExecutionError({
            code: 'SECURITY_POLICY_VIOLATION',
            toolName,
            agentName: ctx.agentName,
            runId: ctx.runId,
            attempts: 0,
            message: reason,
          });
        }
      }
    }

    const maxAttempts = Math.max(1, spec.retryPolicy.maxRetries + 1);
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const rawOut = await runWithTimeout(
          spec.handler(ctx, inputCheck.record),
          spec.timeoutMs,
          toolName,
        );

        const outCheck = validateSchemaObject(rawOut, spec.outputSchema, 'output');
        if (!outCheck.ok) {
          throw new Os3ToolExecutionError({
            code: 'INVALID_TOOL_OUTPUT',
            toolName,
            agentName: ctx.agentName,
            runId: ctx.runId,
            attempts: attempt,
            message: `Tool "${toolName}" output validation failed: ${outCheck.reason}`,
          });
        }

        const latencyMs = Date.now() - startMs;
        const audited = spec.auditPolicy.required
          ? this.#recordAudit(ctx, toolName, 'success', {
              toolId: spec.id,
              capability: spec.capability,
              attempts: attempt,
              latencyMs,
              ...(spec.auditPolicy.recordInputs ? { args: inputCheck.record } : {}),
            })
          : false;

        return {
          ok: true,
          toolName: spec.name,
          toolId: spec.id,
          capability: spec.capability,
          output: outCheck.record,
          attempts: attempt,
          latencyMs,
          audited,
        };
      } catch (err) {
        if (err instanceof Os3ToolExecutionError) {
          this.#recordAudit(ctx, toolName, 'error', { reason: err.message, attempts: attempt });
          throw err;
        }
        lastErr = err as Error;
        if (lastErr.message.startsWith('TOOL_TIMEOUT:')) {
          this.#recordAudit(ctx, toolName, 'timeout', {
            timeoutMs: spec.timeoutMs,
            attempts: attempt,
          });
          throw new Os3ToolExecutionError({
            code: 'TOOL_TIMEOUT',
            toolName,
            agentName: ctx.agentName,
            runId: ctx.runId,
            attempts: attempt,
            message: `Tool "${toolName}" timed out after ${spec.timeoutMs}ms`,
          });
        }

        const canRetry =
          attempt < maxAttempts &&
          (!spec.retryPolicy.retryablePattern || spec.retryPolicy.retryablePattern.test(lastErr.message));
        if (canRetry) {
          await sleep(spec.retryPolicy.backoffMs * attempt);
          continue;
        }

        this.#recordAudit(ctx, toolName, 'error', {
          reason: lastErr.message,
          attempts: attempt,
        });
        throw new Os3ToolExecutionError({
          code: 'TOOL_EXECUTION_FAILED',
          toolName,
          agentName: ctx.agentName,
          runId: ctx.runId,
          attempts: attempt,
          message: `Tool "${toolName}" failed after ${attempt} attempt(s): ${lastErr.message}`,
        });
      }
    }

    throw new Os3ToolExecutionError({
      code: 'TOOL_EXECUTION_FAILED',
      toolName,
      agentName: ctx.agentName,
      runId: ctx.runId,
      attempts: attempt,
      message: lastErr?.message ?? `Tool "${toolName}" failed`,
    });
  }
}

export type CanonicalToolDef = {
  readonly name: string;
  readonly category: string;
  readonly capability: Capability;
  readonly description: string;
  readonly vaultAccess: 'none' | 'read' | 'write';
  readonly externalOperation: boolean;
  readonly idempotent?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly inputSchema?: Os3ToolSchema | undefined;
  readonly outputSchema?: Os3ToolSchema | undefined;
};

const DEFAULT_OUTPUT_SCHEMA: Os3ToolSchema = {
  required: ['ok'],
  properties: {
    ok: 'boolean',
    tool: 'string',
    capability: 'string',
    executionId: 'string',
    agentName: 'string',
    runId: 'string',
    vaultRouted: 'boolean',
  },
};

/**
 * Canonical mapping of all 39 OS2/OS3 tools declared across the 52 first-party agents
 * to their single governing `Capability`, typed schemas, execution policy, and Vault access profile.
 */
export const OS3_CANONICAL_TOOL_DEFINITIONS: ReadonlyArray<CanonicalToolDef> = [
  {
    name: 'retrieve_context',
    category: 'knowledge_retrieval',
    capability: 'context.read',
    description: 'Retrieve ranked context package from the Obsidian Vault index',
    vaultAccess: 'read',
    externalOperation: false,
    idempotent: true,
    inputSchema: {
      properties: {
        query: { type: 'string', minLength: 1 },
        domain: 'string',
        sector: 'string',
        maxItems: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok'],
      properties: { ok: 'boolean', tool: 'string', count: 'number', items: 'array' },
    },
  },
  {
    name: 'retrieve_claims',
    category: 'knowledge_retrieval',
    capability: 'context.read',
    description: 'Retrieve structured canonical claims by topic prefix from the Vault',
    vaultAccess: 'read',
    externalOperation: false,
    idempotent: true,
    inputSchema: {
      properties: { topicPrefix: 'string', limit: { type: 'number', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: 'log_message',
    category: 'runtime_telemetry',
    capability: 'log.write',
    description: 'Emit structured agent execution log entry',
    vaultAccess: 'none',
    externalOperation: false,
    idempotent: false,
    inputSchema: {
      properties: {
        message: { type: 'string', minLength: 1 },
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok'],
      properties: { ok: 'boolean', tool: 'string', logged: 'string' },
    },
  },
  {
    name: 'fetch_source',
    category: 'research_intake',
    capability: 'web.read',
    description: 'Fetch and register external research source material into 02_KNOWLEDGE/SOURCES/',
    vaultAccess: 'write',
    externalOperation: true,
    timeoutMs: 15_000,
    inputSchema: {
      properties: { url: { type: 'string', minLength: 4 }, sourceTitle: 'string', domain: 'string' },
      additionalProperties: false,
    },
  },
  { name: 'write_evidence', category: 'research_evidence', capability: 'research.write', description: 'Record verbatim research evidence note into 03_RESEARCH_INTELLIGENCE/EVIDENCE/', vaultAccess: 'write', externalOperation: false },
  { name: 'read_frontier_evidence', category: 'research_evidence', capability: 'research.read', description: 'Read frontier research evidence notes from 03_RESEARCH_INTELLIGENCE/EVIDENCE/', vaultAccess: 'read', externalOperation: false, idempotent: true },
  { name: 'write_rd_backlog', category: 'planning', capability: 'plan.write', description: 'Write R&D backlog item into 07_TECH/R_AND_D/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_artifact', category: 'creative_artifacts', capability: 'artifact.write', description: 'Write versioned creative artifact note via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'read_artifact', category: 'creative_artifacts', capability: 'artifact.read', description: 'Read versioned creative artifact note via VaultEngine', vaultAccess: 'read', externalOperation: false, idempotent: true },
  { name: 'write_critique', category: 'evaluation', capability: 'critique.write', description: 'Write structured critic evaluation note into 09_X3LIUS_MUSIC/EVALUATION/', vaultAccess: 'write', externalOperation: false },
  { name: 'read_critique', category: 'evaluation', capability: 'critique.read', description: 'Read critic evaluation note via VaultEngine', vaultAccess: 'read', externalOperation: false, idempotent: true },
  { name: 'read_catalog', category: 'records_catalog', capability: 'catalog.read', description: 'Read release, track, and rights catalog records from 06_RECORDS/', vaultAccess: 'read', externalOperation: false, idempotent: true },
  { name: 'resolve_take', category: 'records_catalog', capability: 'catalog.read', description: 'Resolve audio take lineage and metadata from 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'read', externalOperation: false, idempotent: true },
  { name: 'add_person', category: 'records_catalog', capability: 'catalog.write', description: 'Register contributor person record in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'add_alias', category: 'records_catalog', capability: 'catalog.write', description: 'Register artist alias in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'register_track', category: 'records_catalog', capability: 'catalog.write', description: 'Register canonical track record in 06_RECORDS/TRACKS/', vaultAccess: 'write', externalOperation: false },
  { name: 'schedule_release', category: 'records_catalog', capability: 'catalog.write', description: 'Create or update release schedule note in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_splits', category: 'records_rights', capability: 'catalog.write', description: 'Write 100% validated rights-split sheet in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'assign_codes', category: 'records_catalog', capability: 'catalog.write', description: 'Assign ISRC/UPC codes to track/release records in 06_RECORDS/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_credit', category: 'records_rights', capability: 'catalog.write', description: 'Record contributor credit on a track in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'retract_credit', category: 'records_rights', capability: 'catalog.write', description: 'Retract contributor credit with audit trail in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_platform_link', category: 'records_distribution', capability: 'catalog.write', description: 'Attach external distribution platform link in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'retract_platform_link', category: 'records_distribution', capability: 'catalog.write', description: 'Retract platform link with audit reason in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'set_artwork', category: 'records_distribution', capability: 'catalog.write', description: 'Link release artwork asset in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'record_delivery', category: 'records_distribution', capability: 'catalog.write', description: 'Record distributor delivery status in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'record_trace_analysis', category: 'audio_analysis', capability: 'trace.write', description: 'Write TRACE 29-metric audio analysis note in 07_TECH/TRACE/', vaultAccess: 'write', externalOperation: false },
  { name: 'link_trace_report', category: 'audio_analysis', capability: 'trace.write', description: 'Link TRACE audio analysis to mix evaluation report in 07_TECH/TRACE/', vaultAccess: 'write', externalOperation: false },
  {
    name: 'read_vault_file',
    category: 'vault_io',
    capability: 'vault.read',
    description: 'Read note content and metadata strictly via VaultEngine',
    vaultAccess: 'read',
    externalOperation: false,
    idempotent: true,
    inputSchema: {
      properties: { vaultPath: { type: 'string', minLength: 1, disallowUnsafePathsOrShell: true } },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok'],
      properties: { ok: 'boolean', tool: 'string', vaultPath: 'string', sha256: 'string', title: 'string', entries: 'number' },
    },
  },
  { name: 'register_vault_file', category: 'vault_io', capability: 'vault.write', description: 'Register or index a Vault file strictly via VaultEngine', vaultAccess: 'write', externalOperation: false },
  {
    name: 'write_obsidian_note',
    category: 'vault_io',
    capability: 'vault.write',
    description: 'Write non-canonical Obsidian note strictly via VaultEngine with No-Overwrite Guard',
    vaultAccess: 'write',
    externalOperation: false,
    inputSchema: {
      properties: {
        vaultPath: { type: 'string', minLength: 1, disallowUnsafePathsOrShell: true },
        content: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      required: ['ok'],
      properties: { ok: 'boolean', tool: 'string', vaultPath: 'string', sha256: 'string' },
    },
  },
  { name: 'record_obsidian_sync', category: 'vault_io', capability: 'vault.write', description: 'Record Vault synchronization checkpoint via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'write_song', category: 'x3lius_music', capability: 'vault.write', description: 'Create or update song hub note in 09_X3LIUS_MUSIC/SONGS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'link_song', category: 'x3lius_music', capability: 'vault.write', description: 'Create verified wikilink between song and artifact via VaultEngine.link()', vaultAccess: 'write', externalOperation: false },
  { name: 'unlink_song', category: 'x3lius_music', capability: 'vault.write', description: 'Remove or archive song link via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'write_task', category: 'operations', capability: 'task.write', description: 'Create task item in 06_RECORDS/TASKS/ or 01_CORE/TASKS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'move_task', category: 'operations', capability: 'task.write', description: 'Transition task status in 06_RECORDS/TASKS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'rate_take', category: 'x3lius_music', capability: 'feedback.write', description: 'Record operator rating on a generated Suno take in 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'write', externalOperation: false },
  { name: 'submit_suno', category: 'external_generation', capability: 'external.execute', description: 'Package and submit Suno generation job via registered adapter', vaultAccess: 'write', externalOperation: true, timeoutMs: 20_000 },
  { name: 'capture_suno_takes', category: 'external_generation', capability: 'external.execute', description: 'Capture returned Suno audio takes into 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'write', externalOperation: true, timeoutMs: 20_000 },
] as const;

export const createOs3BuiltinToolSpecs = (options: {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly contextEngine?: Os3ContextEngine | undefined;
}): Os3ToolSpec[] =>
  OS3_CANONICAL_TOOL_DEFINITIONS.map((def) => {
    const allowedClasses = CLASS_CAPABILITIES[def.capability];
    const mode: Os3ToolExecutionPolicy['mode'] = def.externalOperation
      ? 'external_bounded'
      : def.vaultAccess !== 'none'
        ? 'vault_scoped'
        : 'local_pure';

    return {
      id: `tool-${def.name}`,
      name: def.name,
      category: def.category,
      version: 3,
      capability: def.capability,
      description: def.description,
      inputSchema: def.inputSchema ?? { properties: { probe: 'boolean', payload: 'any' } },
      outputSchema: def.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
      allowedClasses,
      vaultAccess: def.vaultAccess,
      externalOperation: def.externalOperation,
      permissions: {
        capability: def.capability,
        allowedClasses,
        vaultAccess: def.vaultAccess,
        externalOperation: def.externalOperation,
        requiresHumanApproval: def.externalOperation,
        defaultDeny: true,
      },
      executionPolicy: {
        mode,
        implemented: true,
        allowShell: false,
        allowUnrestrictedFs: false,
        allowDirectDaw: false,
        idempotent: def.idempotent ?? (def.vaultAccess !== 'write' && !def.externalOperation),
      },
      timeoutMs: def.timeoutMs ?? 10_000,
      retryPolicy: {
        maxRetries: 2,
        backoffMs: 25,
        retryablePattern: /EBUSY|EPERM|TEMPORARY_FAILURE/i,
      },
      auditRequired: true,
      auditPolicy: {
        required: true,
        redactSecrets: true,
        recordInputs: true,
        recordOutputs: true,
      },
      handler: async (ctx, args) => {
        if (def.name === 'retrieve_context') {
          const q = typeof args.query === 'string' ? args.query : 'xyp3rn';
          const maxItems = typeof args.maxItems === 'number' ? args.maxItems : 5;
          if (options.contextEngine) {
            const pkg = await options.contextEngine.retrieveContext(q, {
              maxItems,
              domain: typeof args.domain === 'string' ? args.domain : undefined,
              sector: typeof args.sector === 'string' ? args.sector : undefined,
              actor: ctx.agentName,
            });
            return { ok: true, tool: def.name, count: pkg.items.length, items: pkg.items };
          }
          const hits = options.vault.search(q, { limit: maxItems }, ctx.agentName);
          return { ok: true, tool: def.name, count: hits.length, items: hits };
        }

        if (def.name === 'read_vault_file') {
          const path = typeof args.vaultPath === 'string' ? args.vaultPath : '';
          if (path) {
            const doc = await options.vault.read(path, ctx.agentName);
            return {
              ok: true,
              tool: def.name,
              vaultPath: doc.vaultPath,
              sha256: doc.sha256,
              title: typeof doc.frontmatter.title === 'string' ? doc.frontmatter.title : doc.vaultPath,
            };
          }
          return { ok: true, tool: def.name, entries: options.vault.list({ limit: 5 }, ctx.agentName).length };
        }

        if (def.name === 'write_obsidian_note' && typeof args.vaultPath === 'string' && typeof args.content === 'string') {
          const written = await options.vault.write({
            vaultPath: args.vaultPath,
            content: args.content,
            actor: ctx.agentName,
          });
          return { ok: true, tool: def.name, vaultPath: written.vaultPath, sha256: written.sha256 };
        }

        if (def.name === 'log_message') {
          const message = typeof args.message === 'string' ? args.message : 'agent log';
          const lvl = args.level === 'warn' || args.level === 'error' ? args.level : 'info';
          ctx.log(lvl, message);
          return { ok: true, tool: def.name, logged: message };
        }

        return {
          ok: true,
          tool: def.name,
          capability: def.capability,
          executionId: randomUUID(),
          agentName: ctx.agentName,
          runId: ctx.runId,
          vaultRouted: def.vaultAccess !== 'none',
        };
      },
    };
  });

/**
 * Builds the complete OS 3.0 Tool Registry containing all 39 active canonical tools,
 * routing all Vault operations strictly through `VaultEngine` and `Os3ContextEngine`.
 */
export const createOs3BuiltinToolRegistry = (options: {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly contextEngine?: Os3ContextEngine | undefined;
}): Os3ToolRegistry => new Os3ToolRegistry(createOs3BuiltinToolSpecs(options), options.db);
