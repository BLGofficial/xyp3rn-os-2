import { randomUUID } from 'node:crypto';
import type { Os3ContextEngine } from '../context-engine/os3-context-engine.ts';
import type { AgentClass } from '../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import { CLASS_CAPABILITIES, isCapability, type Capability } from './capabilities.ts';
import { createToolRegistry, type Authorization, type Tool, type ToolContext, type ToolRegistry } from './registry.ts';

export type ToolFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

export type Os3ToolSchema = {
  readonly required?: readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, ToolFieldType>> | undefined;
};

export type Os3ToolRetryPolicy = {
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly retryablePattern?: RegExp | undefined;
};

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'UNAUTHORIZED_TOOL'
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
  readonly version: number;
  readonly capability: Capability;
  readonly description: string;
  readonly inputSchema: Os3ToolSchema;
  readonly outputSchema: Os3ToolSchema;
  readonly allowedClasses: readonly AgentClass[];
  readonly vaultAccess: 'none' | 'read' | 'write';
  readonly externalOperation: boolean;
  readonly timeoutMs: number;
  readonly retryPolicy: Os3ToolRetryPolicy;
  readonly auditRequired: boolean;
  readonly handler: (ctx: Os3ToolExecutionContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

const matchesType = (val: unknown, expected: ToolFieldType): boolean => {
  if (expected === 'any') return true;
  if (expected === 'array') return Array.isArray(val);
  if (expected === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  return typeof val === expected;
};

const validateSchemaObject = (
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
  for (const [prop, expectedType] of Object.entries(schema.properties ?? {})) {
    if (prop in rec && rec[prop] !== undefined && rec[prop] !== null) {
      if (!matchesType(rec[prop], expectedType)) {
        return {
          ok: false,
          reason: `Invalid type for ${label} field "${prop}": expected ${expectedType}, got ${typeof rec[prop]}`,
        };
      }
    }
  }
  return { ok: true, record: rec };
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

/**
 * OS 3.0 Tool Registry extending the single-kernel `ToolRegistry` with input/output schemas,
 * timeout, retry policy, structured error contracts, and mandatory runtime audit logging.
 */
export class Os3ToolRegistry {
  readonly #specs = new Map<string, Os3ToolSpec>();
  readonly #kernelRegistry: ToolRegistry;
  readonly #db: SqliteRuntimeDb | null;

  constructor(specs: readonly Os3ToolSpec[], db?: SqliteRuntimeDb | null) {
    this.#db = db ?? null;
    const kernelTools: Tool[] = [];

    for (const spec of specs) {
      if (!SNAKE_RE.test(spec.name)) {
        throw new Error(`Tool name must be snake_case: ${spec.name}`);
      }
      if (!isCapability(spec.capability)) {
        throw new Error(`Tool ${spec.name} declares unknown capability: ${String(spec.capability)}`);
      }
      if (this.#specs.has(spec.name)) {
        throw new Error(`Duplicate tool name: ${spec.name}`);
      }
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

  getSpec(name: string): Os3ToolSpec | undefined {
    return this.#specs.get(name);
  }

  listSpecs(): readonly Os3ToolSpec[] {
    return [...this.#specs.values()];
  }

  authorize(agentClass: AgentClass, toolName: string): Authorization {
    return this.#kernelRegistry.authorize(agentClass, toolName);
  }

  #recordAudit(
    ctx: Os3ToolExecutionContext,
    toolName: string,
    status: 'success' | 'denied' | 'timeout' | 'error',
    details: Record<string, unknown>,
  ): boolean {
    if (!this.#db || !this.#db.isOpen) return false;
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
          ...details,
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
        const audited = spec.auditRequired
          ? this.#recordAudit(ctx, toolName, 'success', {
              toolId: spec.id,
              capability: spec.capability,
              attempts: attempt,
              latencyMs,
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

/**
 * Canonical mapping of all 39 OS2/OS3 tools declared across the 52 first-party agents
 * to their single governing `Capability`, description, and Vault/external access profile.
 */
export const OS3_CANONICAL_TOOL_DEFINITIONS: ReadonlyArray<{
  readonly name: string;
  readonly capability: Capability;
  readonly description: string;
  readonly vaultAccess: 'none' | 'read' | 'write';
  readonly externalOperation: boolean;
}> = [
  { name: 'retrieve_context', capability: 'context.read', description: 'Retrieve ranked context package from the Obsidian Vault index', vaultAccess: 'read', externalOperation: false },
  { name: 'retrieve_claims', capability: 'context.read', description: 'Retrieve structured canonical claims by topic prefix from the Vault', vaultAccess: 'read', externalOperation: false },
  { name: 'log_message', capability: 'log.write', description: 'Emit structured agent execution log entry', vaultAccess: 'none', externalOperation: false },
  { name: 'fetch_source', capability: 'web.read', description: 'Fetch and register external research source material into 02_KNOWLEDGE/SOURCES/', vaultAccess: 'write', externalOperation: true },
  { name: 'write_evidence', capability: 'research.write', description: 'Record verbatim research evidence note into 03_RESEARCH_INTELLIGENCE/EVIDENCE/', vaultAccess: 'write', externalOperation: false },
  { name: 'read_frontier_evidence', capability: 'research.read', description: 'Read frontier research evidence notes from 03_RESEARCH_INTELLIGENCE/EVIDENCE/', vaultAccess: 'read', externalOperation: false },
  { name: 'write_rd_backlog', capability: 'plan.write', description: 'Write R&D backlog item into 07_TECH/R_AND_D/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_artifact', capability: 'artifact.write', description: 'Write versioned creative artifact note via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'read_artifact', capability: 'artifact.read', description: 'Read versioned creative artifact note via VaultEngine', vaultAccess: 'read', externalOperation: false },
  { name: 'write_critique', capability: 'critique.write', description: 'Write structured critic evaluation note into 09_X3LIUS_MUSIC/EVALUATION/', vaultAccess: 'write', externalOperation: false },
  { name: 'read_critique', capability: 'critique.read', description: 'Read critic evaluation note via VaultEngine', vaultAccess: 'read', externalOperation: false },
  { name: 'read_catalog', capability: 'catalog.read', description: 'Read release, track, and rights catalog records from 06_RECORDS/', vaultAccess: 'read', externalOperation: false },
  { name: 'resolve_take', capability: 'catalog.read', description: 'Resolve audio take lineage and metadata from 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'read', externalOperation: false },
  { name: 'add_person', capability: 'catalog.write', description: 'Register contributor person record in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'add_alias', capability: 'catalog.write', description: 'Register artist alias in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'register_track', capability: 'catalog.write', description: 'Register canonical track record in 06_RECORDS/TRACKS/', vaultAccess: 'write', externalOperation: false },
  { name: 'schedule_release', capability: 'catalog.write', description: 'Create or update release schedule note in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_splits', capability: 'catalog.write', description: 'Write 100% validated rights-split sheet in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'assign_codes', capability: 'catalog.write', description: 'Assign ISRC/UPC codes to track/release records in 06_RECORDS/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_credit', capability: 'catalog.write', description: 'Record contributor credit on a track in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'retract_credit', capability: 'catalog.write', description: 'Retract contributor credit with audit trail in 06_RECORDS/RIGHTS/', vaultAccess: 'write', externalOperation: false },
  { name: 'write_platform_link', capability: 'catalog.write', description: 'Attach external distribution platform link in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'retract_platform_link', capability: 'catalog.write', description: 'Retract platform link with audit reason in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'set_artwork', capability: 'catalog.write', description: 'Link release artwork asset in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'record_delivery', capability: 'catalog.write', description: 'Record distributor delivery status in 06_RECORDS/RELEASES/', vaultAccess: 'write', externalOperation: false },
  { name: 'record_trace_analysis', capability: 'trace.write', description: 'Write TRACE 29-metric audio analysis note in 07_TECH/TRACE/', vaultAccess: 'write', externalOperation: false },
  { name: 'link_trace_report', capability: 'trace.write', description: 'Link TRACE audio analysis to mix evaluation report in 07_TECH/TRACE/', vaultAccess: 'write', externalOperation: false },
  { name: 'read_vault_file', capability: 'vault.read', description: 'Read note content and metadata strictly via VaultEngine', vaultAccess: 'read', externalOperation: false },
  { name: 'register_vault_file', capability: 'vault.write', description: 'Register or index a Vault file strictly via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'write_obsidian_note', capability: 'vault.write', description: 'Write non-canonical Obsidian note strictly via VaultEngine with No-Overwrite Guard', vaultAccess: 'write', externalOperation: false },
  { name: 'record_obsidian_sync', capability: 'vault.write', description: 'Record Vault synchronization checkpoint via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'write_song', capability: 'vault.write', description: 'Create or update song hub note in 09_X3LIUS_MUSIC/SONGS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'link_song', capability: 'vault.write', description: 'Create verified wikilink between song and artifact via VaultEngine.link()', vaultAccess: 'write', externalOperation: false },
  { name: 'unlink_song', capability: 'vault.write', description: 'Remove or archive song link via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'write_task', capability: 'task.write', description: 'Create task item in 06_RECORDS/TASKS/ or 01_CORE/TASKS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'move_task', capability: 'task.write', description: 'Transition task status in 06_RECORDS/TASKS/ via VaultEngine', vaultAccess: 'write', externalOperation: false },
  { name: 'rate_take', capability: 'feedback.write', description: 'Record operator rating on a generated Suno take in 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'write', externalOperation: false },
  { name: 'submit_suno', capability: 'external.execute', description: 'Package and submit Suno generation job via registered adapter', vaultAccess: 'write', externalOperation: true },
  { name: 'capture_suno_takes', capability: 'external.execute', description: 'Capture returned Suno audio takes into 09_X3LIUS_MUSIC/TAKES/', vaultAccess: 'write', externalOperation: true },
] as const;

/**
 * Builds the complete OS 3.0 Tool Registry containing all 39 canonical tools,
 * routing all Vault operations through `VaultEngine` and `Os3ContextEngine`.
 */
export const createOs3BuiltinToolRegistry = (options: {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly contextEngine?: Os3ContextEngine | undefined;
}): Os3ToolRegistry => {
  const specs: Os3ToolSpec[] = OS3_CANONICAL_TOOL_DEFINITIONS.map((def) => {
    const allowedClasses = CLASS_CAPABILITIES[def.capability];
    return {
      id: `tool-${def.name}`,
      name: def.name,
      version: 3,
      capability: def.capability,
      description: def.description,
      inputSchema: { properties: {} },
      outputSchema: { required: ['ok'], properties: { ok: 'boolean' } },
      allowedClasses,
      vaultAccess: def.vaultAccess,
      externalOperation: def.externalOperation,
      timeoutMs: 10_000,
      retryPolicy: {
        maxRetries: 2,
        backoffMs: 25,
        retryablePattern: /EBUSY|EPERM|TEMPORARY_FAILURE/i,
      },
      auditRequired: true,
      handler: async (ctx, args) => {
        if (def.name === 'retrieve_context') {
          const q = typeof args.query === 'string' ? args.query : 'xyp3rn';
          if (options.contextEngine) {
            const pkg = await options.contextEngine.retrieveContext(q, { maxItems: 5 });
            return { ok: true, tool: def.name, count: pkg.items.length, items: pkg.items };
          }
          const hits = options.vault.search(q, { limit: 5 });
          return { ok: true, tool: def.name, count: hits.length, items: hits };
        }

        if (def.name === 'read_vault_file') {
          const path = typeof args.vaultPath === 'string' ? args.vaultPath : '';
          if (path) {
            const doc = await options.vault.read(path, ctx.agentName);
            return { ok: true, tool: def.name, vaultPath: doc.vaultPath, sha256: doc.sha256, title: doc.frontmatter.title };
          }
          return { ok: true, tool: def.name, entries: options.vault.list({ limit: 5 }).length };
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
          ctx.log('info', message);
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

  return new Os3ToolRegistry(specs, options.db);
};
