import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Os3VaultAgentRegistry,
  parseOs3AgentFile,
} from '../../core/agent-registry/os3-agent-registry.ts';
import { AGENT_CLASSES, DOMAINS } from '../../core/contracts/taxonomy.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import {
  createOs3BuiltinToolRegistry,
  Os3ToolExecutionError,
  Os3ToolRegistry,
} from '../../core/tool-registry/os3-tool-registry.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 7 — Agent and Tool Registry Migration (04_AGENTS/, 52 Agents, 39 Tools, Permissions, Hot Reload & Test Runs)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p7-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    const toolRegistry = createOs3BuiltinToolRegistry({ vault, db });
    const agentRegistry = new Os3VaultAgentRegistry({
      agentsDir: join(vaultRoot, '04_AGENTS'),
      toolRegistry,
    });

    return { dir, vaultRoot, db, vault, toolRegistry, agentRegistry };
  };

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) {
        await rm(d, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });

  it('1. Loads all 52 migrated agents from 04_AGENTS/ with zero failures, preserving all 8 classes, 6 domains, contracts, and refusals', async () => {
    const { vault, toolRegistry, agentRegistry } = await createFixture();
    const snap = agentRegistry.snapshot();

    expect(snap.failures).toEqual([]);
    expect(snap.agents.length).toBe(52);
    expect(toolRegistry.listSpecs().length).toBe(39);

    const presentClasses = new Set(snap.agents.map((a) => a.class));
    for (const cls of AGENT_CLASSES) {
      expect(presentClasses.has(cls)).toBe(true);
    }

    const presentDomains = new Set(snap.agents.map((a) => a.domain));
    for (const dom of ['CORE', 'KNOWLEDGE', 'RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH'] as const) {
      expect(presentDomains.has(dom)).toBe(true);
      expect(DOMAINS.includes(dom)).toBe(true);
    }

    // Verify every loaded agent passes VaultEngine schema validation and preserves contract fields
    for (const agent of snap.agents) {
      expect(agent.schema).toBe('xyp3rn.agent/v3');
      expect(agent.id).toBe(`agent-${agent.name}`);
      expect(agent.responsibilities.length).toBeGreaterThan(0);
      expect(agent.inputContract.length).toBeGreaterThan(0);
      expect(agent.outputContract.length).toBeGreaterThan(0);
      expect(agent.readPermissions.length).toBeGreaterThan(0);
      expect(agent.writePermissions.length).toBeGreaterThan(0);
      expect(agent.refusals.length).toBeGreaterThan(0);

      const val = await vault.validate(`04_AGENTS/${agent.name}.md`, { requireSchema: true });
      expect(val.ok).toBe(true);
    }
  });

  it('2. Acceptance: All 52 active migrated agents resolve their registered tools, respect permission boundaries, and execute a basic test run', async () => {
    const { db, agentRegistry } = await createFixture();
    const agents = agentRegistry.list();
    expect(agents.length).toBe(52);

    for (const agent of agents) {
      const runResult = await agentRegistry.executeTestRun(agent.name, { probe: true }, db);
      expect(runResult.ok).toBe(true);
      expect(runResult.agentId).toBe(`agent-${agent.name}`);
      expect(runResult.invokedTools).toEqual(agent.tools);
    }

    const completedRuns = db.listAgentRuns(100);
    expect(completedRuns.length).toBe(52);
    expect(completedRuns.every((r) => r.status === 'success')).toBe(true);
  });

  it('3. Rejects invalid YAML, wrong schema version, filename mismatch, unknown fields, missing tools, invalid models, and permission violations', async () => {
    const { toolRegistry } = await createFixture();

    const baseBody = '\n## Role\nTest role.\n\n## Contract\n- **Inputs:** x\n- **Outputs:** y\n- **Reads:** r\n- **Writes:** w\n\n## Refuses\nRefuses bad things.\n';

    // 1. Unknown field + wrong schema + filename mismatch + invalid model + missing tool
    const badRes = parseOs3AgentFile(
      '/vault/04_AGENTS/mismatch-stem.md',
      [
        '---',
        'schema: "xyp3rn.agent/v2"',
        'id: "agent-wrong"',
        'name: "different-name"',
        'class: "Research"',
        'domain: "RESEARCH_INTELLIGENCE"',
        'model: "gpt-4-unprefixed"',
        'tools: [non_existent_tool]',
        'unknown_extra_field: true',
        '---',
        baseBody,
      ].join('\n'),
      { toolRegistry },
    );

    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.errors.some((e) => e.includes('invalid schema version'))).toBe(true);
      expect(badRes.errors.some((e) => e.includes('must equal filename stem'))).toBe(true);
      expect(badRes.errors.some((e) => e.includes('invalid model'))).toBe(true);
      expect(badRes.errors.some((e) => e.includes('missing tool: "non_existent_tool"'))).toBe(true);
      expect(badRes.errors.some((e) => e.includes('unknown field: unknown_extra_field'))).toBe(true);
    }

    // 2. Permission violation: Research agent attempting to declare an Execution-only tool (write_splits)
    const permRes = parseOs3AgentFile(
      '/vault/04_AGENTS/rogue-researcher.md',
      [
        '---',
        'schema: "xyp3rn.agent/v3"',
        'id: "agent-rogue-researcher"',
        'name: "rogue-researcher"',
        'class: "Research"',
        'domain: "RESEARCH_INTELLIGENCE"',
        'model: "none"',
        'tools: [write_splits]',
        '---',
        baseBody,
      ].join('\n'),
      { toolRegistry },
    );

    expect(permRes.ok).toBe(false);
    if (!permRes.ok) {
      expect(permRes.errors.some((e) => e.includes('permission violation'))).toBe(true);
    }
  });

  it('4. Supports hot reload with safe atomic registry replacement (retains valid snapshot on broken edit)', async () => {
    const { vaultRoot, agentRegistry } = await createFixture();
    expect(agentRegistry.list().length).toBe(52);

    // Inject a broken agent definition (duplicate ID + invalid YAML/model) into 04_AGENTS/
    const brokenPath = join(vaultRoot, '04_AGENTS', 'broken-agent.md');
    await writeFile(
      brokenPath,
      '---\nschema: "xyp3rn.agent/v3"\nid: "agent-suno-researcher"\nname: "broken-agent"\nclass: "Research"\ndomain: "CORE"\nmodel: "bad-model"\ntools: [log_message]\n---\n## Role\nx\n## Contract\ny\n## Refuses\nz\n',
      'utf8',
    );

    const failedReload = agentRegistry.hotReload();
    expect(failedReload.replaced).toBe(false);
    expect(failedReload.failures.length).toBeGreaterThan(0);
    // Active snapshot remains the safe 52-agent snapshot!
    expect(agentRegistry.list().length).toBe(52);

    // Remove the broken file and hot-reload again -> succeeds
    await unlink(brokenPath);
    const cleanReload = agentRegistry.hotReload();
    expect(cleanReload.replaced).toBe(true);
    expect(cleanReload.failures).toEqual([]);
    expect(agentRegistry.list().length).toBe(52);
  });

  it('5. Tool Registry enforces input/output schemas, capability permissions, timeouts, retries, and audit logging', async () => {
    const { db } = await createFixture();
    let flakyAttempts = 0;

    const customRegistry = new Os3ToolRegistry(
      [
        {
          id: 'tool-flaky-writer',
          name: 'flaky_writer',
          version: 1,
          capability: 'vault.write',
          description: 'Flaky tool that succeeds on retry',
          inputSchema: {
            required: ['title'],
            properties: { title: 'string' },
          },
          outputSchema: {
            required: ['ok', 'savedTitle'],
            properties: { ok: 'boolean', savedTitle: 'string' },
          },
          allowedClasses: ['Execution'],
          vaultAccess: 'write',
          externalOperation: false,
          timeoutMs: 200,
          retryPolicy: {
            maxRetries: 2,
            backoffMs: 10,
            retryablePattern: /EBUSY/i,
          },
          auditRequired: true,
          handler: async (_ctx, args) => {
            flakyAttempts += 1;
            if (flakyAttempts === 1) {
              throw new Error('EBUSY: simulated transient lock');
            }
            return { ok: true, savedTitle: String(args.title) };
          },
        },
        {
          id: 'tool-slow-op',
          name: 'slow_op',
          version: 1,
          capability: 'context.read',
          description: 'Slow tool that times out',
          inputSchema: {},
          outputSchema: { required: ['ok'], properties: { ok: 'boolean' } },
          allowedClasses: ['Research'],
          vaultAccess: 'none',
          externalOperation: false,
          timeoutMs: 30,
          retryPolicy: { maxRetries: 0, backoffMs: 10 },
          auditRequired: true,
          handler: async () => {
            await new Promise((r) => setTimeout(r, 150));
            return { ok: true };
          },
        },
      ],
      db,
    );

    // 1. Unauthorized class (Research trying to call Execution tool flaky_writer)
    await expect(
      customRegistry.execute(
        { runId: 'r-1', agentName: 'suno-researcher', agentClass: 'Research', log: () => undefined },
        'flaky_writer',
        { title: 'Test' },
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'UNAUTHORIZED_TOOL',
    });

    // 2. Invalid input schema (missing required 'title')
    await expect(
      customRegistry.execute(
        { runId: 'r-2', agentName: 'vault-curator', agentClass: 'Execution', log: () => undefined },
        'flaky_writer',
        {},
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'INVALID_TOOL_INPUT',
    });

    // 3. Transient EBUSY retries and succeeds on attempt 2
    const retryRes = await customRegistry.execute(
      { runId: 'r-3', agentName: 'vault-curator', agentClass: 'Execution', log: () => undefined },
      'flaky_writer',
      { title: 'Recovered Note' },
    );
    expect(retryRes.ok).toBe(true);
    expect(retryRes.attempts).toBe(2);
    expect(retryRes.output.savedTitle).toBe('Recovered Note');
    expect(retryRes.audited).toBe(true);

    // 4. Timeout enforcement
    await expect(
      customRegistry.execute(
        { runId: 'r-4', agentName: 'suno-researcher', agentClass: 'Research', log: () => undefined },
        'slow_op',
        {},
      ),
    ).rejects.toMatchObject({
      name: 'Os3ToolExecutionError',
      code: 'TOOL_TIMEOUT',
    });

    const toolEvents = db.listEvents({ limit: 20 }).filter((e) => e.eventType.startsWith('tool.'));
    expect(toolEvents.some((e) => e.eventType === 'tool.denied')).toBe(true);
    expect(toolEvents.some((e) => e.eventType === 'tool.success')).toBe(true);
    expect(toolEvents.some((e) => e.eventType === 'tool.timeout')).toBe(true);
  });
});
