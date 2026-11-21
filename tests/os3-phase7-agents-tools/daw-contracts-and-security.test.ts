import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Os3VaultAgentRegistry,
  parseOs3AgentFile,
} from '../../core/agent-registry/os3-agent-registry.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import {
  createOs3ToolRegistryWithDawContracts,
  DAW_TOOL_CATEGORIES,
  DAW_TOOL_CONTRACTS,
  validateDawToolContractCoverage,
} from '../../core/tool-registry/daw-tool-contracts.ts';
import {
  createOs3BuiltinToolRegistry,
  Os3ToolExecutionError,
  Os3ToolRegistry,
} from '../../core/tool-registry/os3-tool-registry.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 7 — DAW Tool Category Contracts, Agent Section/Lifecycle Validation & Deny-by-Default Security', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p7-ext-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    const toolRegistry = createOs3ToolRegistryWithDawContracts({ vault, db });
    const agentRegistry = new Os3VaultAgentRegistry({
      agentsDir: join(vaultRoot, '04_AGENTS'),
      toolRegistry,
    });

    return { dir, vaultRoot, db, vault, toolRegistry, agentRegistry };
  };

  it('1. declares complete contracts for all 9 DAW tool categories without implementing live DAW commands', async () => {
    const coverage = validateDawToolContractCoverage(DAW_TOOL_CONTRACTS);
    expect(coverage.ok).toBe(true);
    expect(coverage.missingCategories).toEqual([]);
    expect(coverage.violations).toEqual([]);
    expect(coverage.coveredCategories.length).toBe(DAW_TOOL_CATEGORIES.length);

    const { db, toolRegistry } = await createFixture();
    // 39 canonical active tools + 12 DAW contract-only tools
    expect(toolRegistry.listSpecs().length).toBe(51);

    for (const contract of DAW_TOOL_CONTRACTS) {
      const spec = toolRegistry.getSpec(contract.name);
      expect(spec).toBeDefined();
      expect(spec!.id).toMatch(/^daw-tool-/);
      expect(spec!.description.length).toBeGreaterThan(10);
      expect(spec!.permissions.defaultDeny).toBe(true);
      expect(spec!.executionPolicy.mode).toBe('contract_only');
      expect(spec!.executionPolicy.implemented).toBe(false);
      expect(spec!.executionPolicy.allowShell).toBe(false);
      expect(spec!.executionPolicy.allowUnrestrictedFs).toBe(false);
      expect(spec!.executionPolicy.allowDirectDaw).toBe(false);
      expect(spec!.timeoutMs).toBeGreaterThan(0);
      expect(spec!.retryPolicy.maxRetries).toBeGreaterThanOrEqual(0);
      expect(spec!.auditPolicy.required).toBe(true);
    }

    // Invoking any DAW command contract in Phase 07 must fail with NOT_IMPLEMENTED and emit an audit event
    await expect(
      toolRegistry.execute(
        { runId: 'run-daw-contract-1', agentName: 'tech-audio-tools', agentClass: 'Execution', log: () => undefined },
        'daw_execute_command_patch',
        { sessionId: 's1', preparedPatchId: 'p1', approvalId: 'a1', leaseId: 'l1' },
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'NOT_IMPLEMENTED',
    });

    await expect(
      toolRegistry.execute(
        { runId: 'run-daw-contract-2', agentName: 'suno-researcher', agentClass: 'Research', log: () => undefined },
        'daw_observe_transport',
        { sessionId: 's1' },
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'NOT_IMPLEMENTED',
    });

    // Unauthorized class asking for Execution-only DAW command patch gets denied BEFORE NOT_IMPLEMENTED
    await expect(
      toolRegistry.execute(
        { runId: 'run-daw-contract-3', agentName: 'suno-researcher', agentClass: 'Research', log: () => undefined },
        'daw_execute_command_patch',
        { sessionId: 's1', preparedPatchId: 'p1', approvalId: 'a1', leaseId: 'l1' },
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'UNAUTHORIZED_TOOL',
    });

    const events = db.listEvents({ limit: 10 }).filter((e) => e.eventType === 'tool.denied');
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('2. validates agent version, status, capability boundaries, and preserves procedure/constraints/escalation sections', async () => {
    const { vaultRoot, db, toolRegistry, agentRegistry } = await createFixture();

    // All 52 migrated agents expose explicit version, status, permissions, procedure, constraints & escalation
    const sample = agentRegistry.get('suno-researcher');
    expect(sample).toBeDefined();
    expect(sample!.version).toBe(1);
    expect(sample!.status).toBe('live');
    expect(sample!.permissions.denyByDefault).toBe(true);
    expect(sample!.permissions.capabilities).toContain('web.read');
    expect(sample!.procedure.length).toBeGreaterThan(0);
    expect(sample!.constraints.length).toBeGreaterThan(0);
    expect(sample!.escalation.length).toBeGreaterThan(0);
    expect(sample!.scope.length).toBeGreaterThan(0);

    // Custom OS3 agent with explicit ## Procedure, ## Constraints, ## Escalation & structured permissions
    const validCustom = parseOs3AgentFile(
      '/vault/04_AGENTS/daw-policy-auditor.md',
      `---
schema: xyp3rn.agent/v3
id: agent-daw-policy-auditor
name: daw-policy-auditor
class: Governance
domain: GOVERNANCE
version: 2
status: active
model: none
tools: [retrieve_context, log_message]
permissions:
  reads: "Read session state and audit ledgers read-only."
  writes: "Governance flags and escalation notices only."
  capabilities: [context.read, log.write, governance.flag]
---

# DAW Policy Auditor

## Role
Audits studio sessions against governance and edition policies.

## Contract
- **Inputs:** { "sessionId": string }
- **Outputs:** { "compliant": boolean }
- **Reads:** Context Engine & audit stream
- **Writes:** None directly

## Procedure
1. Read session state read-only.
2. Emit structured verdict and log entry.

## Constraints
- Never modify canonical files or invoke execution tools.

## Refuses
- Modifying Vault files or approving promotions.

## Escalation
- Route compliance violations to human operator approval queue.
`,
      { toolRegistry },
    );
    expect(validCustom.ok).toBe(true);
    if (validCustom.ok) {
      expect(validCustom.agent.version).toBe(2);
      expect(validCustom.agent.status).toBe('active');
      expect(validCustom.agent.procedure).toContain('Read session state read-only');
      expect(validCustom.agent.constraints).toContain('Never modify canonical files');
      expect(validCustom.agent.escalation).toContain('human operator approval queue');
      expect(validCustom.agent.permissions.capabilities).toContain('governance.flag');
    }

    // Reject invalid version, invalid status, and capability escalation in frontmatter
    const escalatedOrBad = parseOs3AgentFile(
      '/vault/04_AGENTS/bad-meta-agent.md',
      `---
schema: xyp3rn.agent/v3
id: agent-bad-meta-agent
name: bad-meta-agent
class: Research
domain: RESEARCH_INTELLIGENCE
version: 0
status: imaginary_status
model: none
tools: [retrieve_context]
capabilities: [canonical.write]
permissions:
  capabilities: [approval.decide]
---

## Role
Test role.
## Contract
- **Inputs:** a
- **Outputs:** b
- **Reads:** c
- **Writes:** d
## Refuses
Nothing.
`,
      { toolRegistry },
    );
    expect(escalatedOrBad.ok).toBe(false);
    if (!escalatedOrBad.ok) {
      expect(escalatedOrBad.errors.some((e) => e.includes('invalid version'))).toBe(true);
      expect(escalatedOrBad.errors.some((e) => e.includes('unknown status'))).toBe(true);
      expect(escalatedOrBad.errors.some((e) => e.includes('canonical.write'))).toBe(true);
      expect(escalatedOrBad.errors.some((e) => e.includes('approval.decide'))).toBe(true);
    }

    // Retired agent cannot execute test runs
    await writeFile(
      join(vaultRoot, '04_AGENTS', 'retired-helper.md'),
      `---
schema: xyp3rn.agent/v3
id: agent-retired-helper
name: retired-helper
class: Knowledge
domain: KNOWLEDGE
version: 1
status: retired
model: none
tools: [log_message]
---

## Role
Retired test agent.
## Contract
- **Inputs:** none
- **Outputs:** none
- **Reads:** none
- **Writes:** none
## Refuses
Execution while retired.
`,
      'utf8',
    );
    const retiredReg = new Os3VaultAgentRegistry({
      agentsDir: join(vaultRoot, '04_AGENTS'),
      toolRegistry,
    });
    expect(retiredReg.get('retired-helper')?.status).toBe('retired');
    await expect(retiredReg.executeTestRun('retired-helper', {}, db)).rejects.toThrow(/inactive.*retired/i);
  });

  it('3. enforces deny-by-default security, blocks unrestricted shell/FS/DAW tools, and validates strict schemas', async () => {
    const { vault, db } = await createFixture();
    const builtin = createOs3BuiltinToolRegistry({ vault, db });

    // Security violation: registering a tool enabling shell, unrestricted FS, or direct DAW access throws immediately
    expect(
      () =>
        new Os3ToolRegistry([
          {
            id: 'tool-bad-shell',
            name: 'bad_shell_exec',
            version: 1,
            capability: 'external.execute',
            description: 'Forbidden unrestricted shell',
            inputSchema: {},
            outputSchema: { required: ['ok'], properties: { ok: 'boolean' } },
            allowedClasses: ['Execution'],
            vaultAccess: 'none',
            externalOperation: true,
            executionPolicy: {
              mode: 'external_bounded',
              implemented: true,
              allowShell: true,
              allowUnrestrictedFs: false,
              allowDirectDaw: false,
              idempotent: false,
            },
            timeoutMs: 1_000,
            retryPolicy: { maxRetries: 0, backoffMs: 0 },
            auditRequired: true,
            handler: async () => ({ ok: true }),
          },
        ]),
    ).toThrow(/Security violation.*unrestricted shell/i);

    // Reject path traversal & unknown extra input fields on built-in Vault tools
    await expect(
      builtin.execute(
        { runId: 'r-sec-1', agentName: 'vault-curator', agentClass: 'Execution', log: () => undefined },
        'read_vault_file',
        { vaultPath: '../.env.local' },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_TOOL_INPUT',
    });

    await expect(
      builtin.execute(
        { runId: 'r-sec-2', agentName: 'vault-curator', agentClass: 'Execution', log: () => undefined },
        'retrieve_context',
        { query: 'mastering', unexpectedEvilField: true },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_TOOL_INPUT',
    });

    // Reject handler returning invalid output schema
    const strictOutputReg = new Os3ToolRegistry(
      [
        {
          id: 'tool-bad-output',
          name: 'bad_output_probe',
          version: 1,
          capability: 'log.write',
          description: 'Verifies output schema rejection',
          inputSchema: { properties: {}, additionalProperties: false },
          outputSchema: {
            required: ['ok', 'count'],
            properties: { ok: 'boolean', count: { type: 'number', minimum: 1 } },
            additionalProperties: false,
          },
          allowedClasses: ['Knowledge'],
          vaultAccess: 'none',
          externalOperation: false,
          timeoutMs: 500,
          retryPolicy: { maxRetries: 0, backoffMs: 0 },
          auditRequired: true,
          handler: async () => ({ ok: true, count: -5 }),
        },
      ],
      db,
    );

    await expect(
      strictOutputReg.execute(
        { runId: 'r-out-1', agentName: 'context-retriever', agentClass: 'Knowledge', log: () => undefined },
        'bad_output_probe',
        {},
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_TOOL_OUTPUT',
    });

    // Spec allowedClasses narrowing overrides broader class capability
    expect(strictOutputReg.authorize('Execution', 'bad_output_probe').allow).toBe(false);
    expect(strictOutputReg.authorize('Knowledge', 'bad_output_probe').allow).toBe(true);
  });
});
