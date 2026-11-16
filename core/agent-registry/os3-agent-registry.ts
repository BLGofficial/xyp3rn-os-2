import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isAgentClass, isDomain, type AgentClass, type Domain } from '../contracts/taxonomy.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import { isCapability, type Capability } from '../tool-registry/capabilities.ts';
import type { Os3ToolRegistry } from '../tool-registry/os3-tool-registry.ts';
import type { ValidationFailure } from './registry.ts';

export const ALLOWED_OS3_AGENT_FRONTMATTER_FIELDS = [
  'schema',
  'id',
  'type',
  'title',
  'name',
  'class',
  'domain',
  'sector',
  'status',
  'version',
  'model',
  'tools',
  'capabilities',
  'responsibilities',
  'input_contract',
  'output_contract',
  'read_permissions',
  'write_permissions',
  'refusals',
  'tags',
  'source_sha256',
  'created_at',
  'updated_at',
] as const;

export type Os3AgentDefinition = {
  readonly id: string;
  readonly schema: 'xyp3rn.agent/v3';
  readonly name: string;
  readonly class: AgentClass;
  readonly domain: Domain;
  readonly model: string;
  readonly tools: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly responsibilities: string;
  readonly inputContract: string;
  readonly outputContract: string;
  readonly readPermissions: string;
  readonly writePermissions: string;
  readonly refusals: string;
  readonly role: string;
  readonly contract: string;
  readonly refuses: string;
  readonly sections: Readonly<Record<string, string>>;
  readonly path: string;
};

export type Os3AgentRegistrySnapshot = {
  readonly agents: readonly Os3AgentDefinition[];
  readonly failures: readonly ValidationFailure[];
  readonly skipped: readonly string[];
  readonly loadedAt: string;
};

export type HotReloadResult = {
  readonly replaced: boolean;
  readonly activeSnapshot: Os3AgentRegistrySnapshot;
  readonly candidateSnapshot: Os3AgentRegistrySnapshot;
  readonly failures: readonly ValidationFailure[];
};

const KEBAB_RE = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;
const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const VALID_MODEL_RE = /^(none|(openrouter|anthropic|groq):[a-zA-Z0-9._:/-]+)$/;
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ALLOWED_FIELD_SET = new Set<string>(ALLOWED_OS3_AGENT_FRONTMATTER_FIELDS);

const parseBodySections = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  const parts = body.split(/^## (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    out.set(parts[i]!.trim(), (parts[i + 1] ?? '').trim());
  }
  return out;
};

export const extractContractBullets = (contractSection: string): {
  readonly inputs: string;
  readonly outputs: string;
  readonly reads: string;
  readonly writes: string;
} => {
  const extract = (label: string): string => {
    const re = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im');
    const m = re.exec(contractSection);
    return m?.[1]?.trim() ?? contractSection;
  };
  return {
    inputs: extract('Inputs'),
    outputs: extract('Outputs'),
    reads: extract('Reads'),
    writes: extract('Writes'),
  };
};

/**
 * Parses and validates a single OS 3.0 Agent definition file from `04_AGENTS/`.
 */
export const parseOs3AgentFile = (
  filePath: string,
  contents: string,
  options: {
    readonly toolRegistry?: Os3ToolRegistry | undefined;
    readonly requireV3Schema?: boolean | undefined;
  } = {},
): { readonly ok: true; readonly agent: Os3AgentDefinition } | { readonly ok: false; readonly path: string; readonly errors: readonly string[] } => {
  const fail = (errors: string[]) => ({ ok: false as const, path: filePath, errors });
  const m = FM_RE.exec(contents.startsWith('\uFEFF') ? contents.slice(1) : contents);
  if (!m) {
    return fail(['missing YAML frontmatter block']);
  }

  let fmRaw: unknown;
  try {
    fmRaw = parseYaml(m[1]!);
  } catch (err) {
    return fail([`frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}`]);
  }

  if (typeof fmRaw !== 'object' || fmRaw === null || Array.isArray(fmRaw)) {
    return fail(['frontmatter must be a key/value mapping']);
  }

  const f = fmRaw as Record<string, unknown>;
  const errors: string[] = [];

  for (const reqKey of ['name', 'class', 'domain', 'tools', 'model']) {
    if (!(reqKey in f)) {
      errors.push(`missing required field: ${reqKey}`);
    }
  }

  for (const key of Object.keys(f)) {
    if (!ALLOWED_FIELD_SET.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  const requireV3Schema = options.requireV3Schema ?? true;
  if (requireV3Schema) {
    if (f.schema !== 'xyp3rn.agent/v3') {
      errors.push(`invalid schema version: expected "xyp3rn.agent/v3", got "${String(f.schema ?? '(missing)')}"`);
    }
    if (typeof f.id !== 'string' || f.id.trim().length === 0) {
      errors.push('missing required field: id');
    }
  }

  const stem = basename(filePath).replace(/\.agent\.md$/, '').replace(/\.md$/, '');
  if ('name' in f) {
    if (typeof f.name !== 'string' || !KEBAB_RE.test(f.name)) {
      errors.push(`name must be kebab-case: ${String(f.name)}`);
    } else if (f.name !== stem) {
      errors.push(`name "${f.name}" must equal filename stem "${stem}"`);
    }
  }

  if ('class' in f && !isAgentClass(f.class)) {
    errors.push(`unknown class: ${String(f.class)}`);
  }
  if ('domain' in f && !isDomain(f.domain)) {
    errors.push(`unknown domain: ${String(f.domain)}`);
  }

  if ('model' in f) {
    if (typeof f.model !== 'string' || !VALID_MODEL_RE.test(f.model.trim())) {
      errors.push(`invalid model: "${String(f.model)}" (must be "none" or "<provider>:<model>")`);
    }
  }

  const validTools: string[] = [];
  if ('tools' in f) {
    if (!Array.isArray(f.tools)) {
      errors.push('tools must be a list');
    } else {
      for (const t of f.tools) {
        if (typeof t !== 'string' || !SNAKE_RE.test(t)) {
          errors.push(`tool name must be snake_case: ${String(t)}`);
        } else {
          validTools.push(t);
        }
      }
    }
  }

  // Tool resolution and permission boundary verification against ToolRegistry
  const derivedCapabilities = new Set<Capability>();
  if (options.toolRegistry && isAgentClass(f.class)) {
    for (const toolName of validTools) {
      const spec = options.toolRegistry.getSpec(toolName);
      if (!spec) {
        errors.push(`missing tool: "${toolName}" is not registered in ToolRegistry`);
        continue;
      }
      const auth = options.toolRegistry.authorize(f.class, toolName);
      if (!auth.allow) {
        errors.push(`permission violation: ${auth.reason}`);
      } else {
        derivedCapabilities.add(auth.capability);
      }
    }
  }

  if ('capabilities' in f && Array.isArray(f.capabilities)) {
    for (const c of f.capabilities) {
      if (!isCapability(c)) {
        errors.push(`unknown capability: ${String(c)}`);
      } else {
        derivedCapabilities.add(c);
      }
    }
  }

  const bodyMap = parseBodySections(contents.slice(m[0].length));
  for (const sec of ['Role', 'Contract', 'Refuses'] as const) {
    if (!bodyMap.has(sec)) {
      errors.push(`missing body section: ## ${sec}`);
    } else if (bodyMap.get(sec) === '') {
      errors.push(`empty body section: ## ${sec}`);
    }
  }

  if (errors.length > 0) {
    return fail(errors);
  }

  const roleText = bodyMap.get('Role')!;
  const contractText = bodyMap.get('Contract')!;
  const refusesText = bodyMap.get('Refuses')!;
  const bullets = extractContractBullets(contractText);
  const agentName = f.name as string;

  return {
    ok: true,
    agent: {
      id: typeof f.id === 'string' && f.id.trim() ? f.id.trim() : `agent-${agentName}`,
      schema: 'xyp3rn.agent/v3',
      name: agentName,
      class: f.class as AgentClass,
      domain: f.domain as Domain,
      model: (f.model as string).trim(),
      tools: validTools,
      capabilities: [...derivedCapabilities],
      responsibilities:
        typeof f.responsibilities === 'string' && f.responsibilities.trim()
          ? f.responsibilities.trim()
          : roleText,
      inputContract:
        typeof f.input_contract === 'string' && f.input_contract.trim()
          ? f.input_contract.trim()
          : bullets.inputs,
      outputContract:
        typeof f.output_contract === 'string' && f.output_contract.trim()
          ? f.output_contract.trim()
          : bullets.outputs,
      readPermissions:
        typeof f.read_permissions === 'string' && f.read_permissions.trim()
          ? f.read_permissions.trim()
          : bullets.reads,
      writePermissions:
        typeof f.write_permissions === 'string' && f.write_permissions.trim()
          ? f.write_permissions.trim()
          : bullets.writes,
      refusals:
        typeof f.refusals === 'string' && f.refusals.trim()
          ? f.refusals.trim()
          : refusesText,
      role: roleText,
      contract: contractText,
      refuses: refusesText,
      sections: Object.fromEntries(bodyMap),
      path: filePath,
    },
  };
};

/**
 * Loads all agent definitions from `<vaultRoot>/04_AGENTS/` (or a specified directory),
 * enforcing unique agent IDs, schema validation, tool resolution, and permission boundaries.
 */
export const loadOs3AgentsFromDir = (
  dir: string,
  options: {
    readonly toolRegistry?: Os3ToolRegistry | undefined;
    readonly requireV3Schema?: boolean | undefined;
  } = {},
): Os3AgentRegistrySnapshot => {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir).filter((f) => f.endsWith('.md')).sort();

  const agents: Os3AgentDefinition[] = [];
  const failures: ValidationFailure[] = [];
  const skipped: string[] = [];
  const seenIds = new Map<string, string>();
  const seenNames = new Map<string, string>();

  for (const file of entries) {
    const fullPath = join(absDir, file);
    if (file.startsWith('_')) {
      skipped.push(fullPath);
      continue;
    }

    const parsed = parseOs3AgentFile(fullPath, readFileSync(fullPath, 'utf8'), options);
    if (!parsed.ok) {
      failures.push({ path: parsed.path, errors: parsed.errors });
      continue;
    }

    const dupErrors: string[] = [];
    const prevIdPath = seenIds.get(parsed.agent.id);
    if (prevIdPath) {
      dupErrors.push(`duplicate agent id "${parsed.agent.id}" (already defined in ${basename(prevIdPath)})`);
    }
    const prevNamePath = seenNames.get(parsed.agent.name);
    if (prevNamePath) {
      dupErrors.push(`duplicate agent name "${parsed.agent.name}" (already defined in ${basename(prevNamePath)})`);
    }

    if (dupErrors.length > 0) {
      failures.push({ path: fullPath, errors: dupErrors });
      continue;
    }

    seenIds.set(parsed.agent.id, fullPath);
    seenNames.set(parsed.agent.name, fullPath);
    agents.push(parsed.agent);
  }

  return {
    agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    failures,
    skipped,
    loadedAt: new Date().toISOString(),
  };
};

/**
 * OS 3.0 Vault-backed Agent Registry (`04_AGENTS/`) with safe hot-reload replacement
 * and isolated agent test-run execution.
 */
export class Os3VaultAgentRegistry {
  readonly #agentsDir: string;
  readonly #toolRegistry: Os3ToolRegistry | undefined;
  readonly #requireV3Schema: boolean;
  #activeSnapshot: Os3AgentRegistrySnapshot;

  constructor(options: {
    readonly agentsDir: string;
    readonly toolRegistry?: Os3ToolRegistry | undefined;
    readonly requireV3Schema?: boolean | undefined;
  }) {
    this.#agentsDir = resolve(options.agentsDir);
    this.#toolRegistry = options.toolRegistry;
    this.#requireV3Schema = options.requireV3Schema ?? true;
    this.#activeSnapshot = loadOs3AgentsFromDir(this.#agentsDir, {
      toolRegistry: this.#toolRegistry,
      requireV3Schema: this.#requireV3Schema,
    });
  }

  get agentsDir(): string {
    return this.#agentsDir;
  }

  list(): readonly Os3AgentDefinition[] {
    return this.#activeSnapshot.agents;
  }

  get(nameOrId: string): Os3AgentDefinition | undefined {
    const clean = nameOrId.trim();
    return this.#activeSnapshot.agents.find((a) => a.name === clean || a.id === clean);
  }

  snapshot(): Os3AgentRegistrySnapshot {
    return this.#activeSnapshot;
  }

  /**
   * Hot-reloads `04_AGENTS/` with safe atomic replacement:
   * if any file in `04_AGENTS/` fails validation, the existing valid snapshot remains active!
   */
  hotReload(): HotReloadResult {
    const candidate = loadOs3AgentsFromDir(this.#agentsDir, {
      toolRegistry: this.#toolRegistry,
      requireV3Schema: this.#requireV3Schema,
    });

    if (candidate.failures.length === 0 && candidate.agents.length > 0) {
      this.#activeSnapshot = candidate;
      return {
        replaced: true,
        activeSnapshot: this.#activeSnapshot,
        candidateSnapshot: candidate,
        failures: [],
      };
    }

    return {
      replaced: false,
      activeSnapshot: this.#activeSnapshot,
      candidateSnapshot: candidate,
      failures: candidate.failures,
    };
  }

  /**
   * Executes a verified test run for an active migrated agent, invoking its declared tools
   * within its class permission boundaries and recording the run in `SqliteRuntimeDb`.
   */
  async executeTestRun(
    agentName: string,
    input: Record<string, unknown> = { probe: true },
    db?: SqliteRuntimeDb | null,
  ): Promise<{
    readonly ok: true;
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly agentClass: AgentClass;
    readonly domain: Domain;
    readonly invokedTools: readonly string[];
  }> {
    const agent = this.get(agentName);
    if (!agent) {
      throw new Error(`Agent not found in registry: "${agentName}"`);
    }
    if (!this.#toolRegistry) {
      throw new Error(`Cannot execute test run for "${agentName}": no ToolRegistry bound`);
    }

    const runRecord =
      db && db.isOpen
        ? db.startAgentRun({
            agentName: agent.name,
            class: agent.class,
            domain: agent.domain,
            model: agent.model,
            input,
          })
        : { id: `test-run-${agent.name}` };

    const startMs = Date.now();
    const invokedTools: string[] = [];

    try {
      for (const toolName of agent.tools) {
        await this.#toolRegistry.execute(
          {
            runId: runRecord.id,
            agentName: agent.name,
            agentClass: agent.class,
            log: () => undefined,
          },
          toolName,
          {},
        );
        invokedTools.push(toolName);
      }

      if (db && db.isOpen) {
        db.completeAgentRun(runRecord.id, {
          output: { verified: true, invokedTools },
          tokensUsed: 0,
          latencyMs: Date.now() - startMs,
          model: agent.model,
        });
      }

      return {
        ok: true,
        runId: runRecord.id,
        agentId: agent.id,
        agentName: agent.name,
        agentClass: agent.class,
        domain: agent.domain,
        invokedTools,
      };
    } catch (err) {
      if (db && db.isOpen) {
        db.failAgentRun(runRecord.id, {
          errorDetail: (err as Error).message,
          latencyMs: Date.now() - startMs,
        });
      }
      throw err;
    }
  }
}
