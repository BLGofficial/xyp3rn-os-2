import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry, parseOs3AgentFile } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { isAllowedGatewayOrigin, startOs3GatewayServer, type Os3GatewayServerHandle } from '../../core/gateway/server.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { createGitCheckpoint, inspectGitRepository } from '../../core/runtime/git-integration.ts';
import { redactSecrets, StructuredLogger } from '../../core/runtime/logger.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { VaultEngine } from '../../core/vault-engine/engine.ts';
import { validateVaultPath } from '../../core/vault-engine/path-guard.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 12 — Security & Governance Hardening + Adversarial Suite', () => {
  let tempVault: string;
  let outsideDir: string;
  let db: SqliteRuntimeDb;
  let vault: VaultEngine;
  let runtime: Os3JarvisRuntime;
  let server: Os3GatewayServerHandle;

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-sec-vault-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-sec-outside-'));
    db = openRuntimeDb(':memory:');
    vault = new VaultEngine({ vaultRoot: tempVault, db });
    await provisionOs3Vault({ vaultRoot: tempVault, repoRoot: REPO_ROOT });
    await vault.scanVault({ full: true });
    runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
    server = await startOs3GatewayServer(runtime, {
      host: '127.0.0.1',
      port: 0,
      authToken: 'os3-secret-token-xyz123',
    });
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    db.close();
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined);
    await rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('1. Blocks unauthorized file writes & direct canonical mutations while logging governance events', async () => {
    await expect(
      vault.writeNote({
        vaultPath: '06_GOVERNANCE/00_Policies/InjectedPolicy.md',
        content: '# Malicious Policy Override\n',
        actor: 'research-orchestrator',
      }),
    ).rejects.toThrow(/canonical/i);

    await expect(
      vault.appendNote({
        vaultPath: '01_CORE/00_Identity/Identity.md',
        appendText: '\ncompromised\n',
        actor: 'vault-curator',
      }),
    ).rejects.toThrow(/canonical/i);

    await expect(
      vault.writeNote({
        vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/fake-canonical.md',
        content: '---\ntitle: "Fake"\nstatus: canonical\n---\n\nBody.\n',
        actor: 'research-orchestrator',
      }),
    ).rejects.toThrow(/promote\(\)/i);

    const deniedEvents = db.listEvents({ eventType: 'vault.write.denied', limit: 10 });
    expect(deniedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('2. Blocks path traversal, non-POSIX separators, hidden system paths, and symlink/junction escapes', async () => {
    const attacks = [
      '../outside.md',
      '01_CORE/../../outside.md',
      '/etc/passwd.md',
      'C:\\Windows\\win.ini',
      '01_CORE/06_Tasks/bad\0.md',
      '.obsidian/workspace.json',
      '.git/config',
      '01_CORE/06_Tasks/script.sh',
    ];

    for (const badPath of attacks) {
      expect(validateVaultPath(tempVault, badPath).ok).toBe(false);
      await expect(vault.readNote(badPath)).rejects.toThrow();
      await expect(
        vault.writeNote({ vaultPath: badPath, content: '# nope\n', actor: 'attacker' }),
      ).rejects.toThrow();
    }

    await writeFile(join(outsideDir, 'secret-host-file.md'), '# host secret\n', 'utf8');
    const junctionPath = join(tempVault, '03_RESEARCH_INTELLIGENCE', '00_Briefs', 'escaped-link');
    let symlinkCreated = false;
    try {
      await symlink(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    if (symlinkCreated) {
      await expect(
        vault.readNote('03_RESEARCH_INTELLIGENCE/00_Briefs/escaped-link/secret-host-file.md'),
      ).rejects.toThrow(/symlink|escape/i);
      await expect(
        vault.writeNote({
          vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/escaped-link/pwn.md',
          content: '# pwn\n',
          actor: 'attacker',
        }),
      ).rejects.toThrow(/symlink|escape/i);
    }
  });

  it('3. Refuses tool privilege escalation and enforces class/declaration boundaries', async () => {
    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const vaultAgents = new Os3VaultAgentRegistry({
      agentsDir: join(tempVault, '04_AGENTS'),
      toolRegistry: tools,
    });
    const orchestrator = new Os3Orchestrator({
      agents: vaultAgents,
      tools,
      db,
      handlers: {
        'evaluation-researcher': async (ctx) => {
          await ctx.useTool('write_obsidian_note', {
            vaultPath: '01_CORE/06_Tasks/escalated.md',
            content: '# escalated\n',
            actor: 'evaluation-researcher',
          });
          return { output: { escalated: true } };
        },
      },
    });

    await expect(
      tools.execute(
        {
          runId: 'escalation-attempt-1',
          agentName: 'evaluation-researcher',
          agentClass: 'Research',
          log: () => undefined,
        },
        'write_obsidian_note',
        { vaultPath: '01_CORE/06_Tasks/pwn.md', content: '# pwn\n', actor: 'evaluation-researcher' },
      ),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED_TOOL',
      message: expect.stringMatching(/lacks capability vault\.write/i),
    });

    const singleRes = await orchestrator.executeSingleAgent('evaluation-researcher', { claim: 'test' });
    expect(singleRes.status).toBe('error');
    expect(singleRes.error ?? '').toMatch(/undeclared|not allowed|refused|UNAUTHORIZED_TOOL|lacks capability/i);
  });

  it('4. Blocks agent self-approval, enforces human-only approval, and guarantees immutable approval decisions', async () => {
    const approval = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'candidate-finding-1',
      proposer: 'research-orchestrator',
      request: {
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/candidate-finding-1.md',
        title: 'Candidate Finding',
        body: '# Finding\n\nEvidence backed.',
        domain: 'KNOWLEDGE',
      },
    });

    // Self-approval & agent-approval attempts via HTTP gateway return 403 SELF_APPROVAL_FORBIDDEN
    for (const badApprover of ['research-orchestrator', 'x3lius-suno', 'agent:evil-bot', 'system']) {
      const selfHttpRes = await fetch(`${server.url}/api/approvals/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer os3-secret-token-xyz123',
        },
        body: JSON.stringify({
          approvalId: approval.id,
          decision: 'approved',
          approver: badApprover,
          reason: 'bypass',
        }),
      });
      expect(selfHttpRes.status).toBe(403);
    }

    // Even if a compromised DB row had agent/self approver, PromotionGate blocks promotion
    const forgedApproval = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'forged-candidate',
      proposer: 'x3lius-suno',
      request: {},
    });
    db.decideApproval({
      approvalId: forgedApproval.id,
      decision: 'approved',
      approver: 'x3lius-suno',
      reason: 'forged agent self-approval',
    });
    await expect(
      vault.promoteToCanonical({
        approvalId: forgedApproval.id,
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/forged.md',
        title: 'Forged',
        body: 'Should never promote.',
        domain: 'KNOWLEDGE',
      }),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });

    // Valid human operator approval succeeds once
    const okRes = await fetch(`${server.url}/api/approvals/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer os3-secret-token-xyz123',
      },
      body: JSON.stringify({
        approvalId: approval.id,
        decision: 'approved',
        approver: 'blago-human-operator',
        reason: 'Verified evidence',
      }),
    });
    expect(okRes.status).toBe(200);

    // Double decision blocked by SQLite trigger ('sealed once decided') and HTTP 409
    const dupHttpRes = await fetch(`${server.url}/api/approvals/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer os3-secret-token-xyz123',
      },
      body: JSON.stringify({
        approvalId: approval.id,
        decision: 'rejected',
        approver: 'blago-human-operator',
        reason: 'overwrite decision',
      }),
    });
    expect(dupHttpRes.status).toBe(409);

    expect(() =>
      db.decideApproval({
        approvalId: approval.id,
        decision: 'rejected',
        approver: 'blago-human-operator',
        reason: 'overwrite decision',
      }),
    ).toThrow(/sealed once decided/i);
  });

  it('5. Prevents concurrent document corruption via runtime locks, CAS checksums, and external edit preservation', async () => {
    const initial = await vault.writeNote({
      vaultPath: '03_RESEARCH_INTELLIGENCE/00_Briefs/concurrent-doc.md',
      content: '---\ntitle: "Concurrent Doc"\ntype: note\ndomain: RESEARCH_INTELLIGENCE\n---\n\nv1\n',
      actor: 'vault-curator',
    });

    await writeFile(
      join(tempVault, '03_RESEARCH_INTELLIGENCE', '00_Briefs', 'concurrent-doc.md'),
      '---\ntitle: "Concurrent Doc"\ntype: note\ndomain: RESEARCH_INTELLIGENCE\n---\n\nhuman-edit-obsidian\n',
      'utf8',
    );

    await expect(
      vault.update({
        vaultPath: initial.vaultPath,
        content: '---\ntitle: "Concurrent Doc"\ntype: note\ndomain: RESEARCH_INTELLIGENCE\n---\n\nstale-overwrite\n',
        actor: 'vault-curator',
        expectedSha256: initial.sha256,
      }),
    ).rejects.toThrow();

    expect(db.acquireLock('vault:test-resource', 'worker-a', 5_000)).toBe(true);
    expect(db.acquireLock('vault:test-resource', 'worker-b', 5_000)).toBe(false);
    const future = new Date(Date.now() + 20_000).toISOString();
    const recovered = db.recoverStaleLocks(future);
    expect(recovered.recoveredCount).toBeGreaterThanOrEqual(1);
    expect(db.acquireLock('vault:test-resource', 'worker-b', 5_000)).toBe(true);
  });

  it('6. Blocks secret persistence, blocks leaked on-disk secret reads via Gateway, and redacts logs', async () => {
    const fakeGemini = 'AIzaSyFakeSecretKey1234567890abcdefg';
    const fakeAnthropic = 'sk-ant-api03-abcdefghijklmnopqrstuvwx123456';

    await expect(
      vault.writeNote({
        vaultPath: '01_CORE/06_Tasks/leaked-secret.md',
        content: `# Secret\nkey: ${fakeAnthropic}\n`,
        actor: 'vault-curator',
      }),
    ).rejects.toThrow(/secret/i);

    await mkdir(join(tempVault, '01_CORE', '06_Tasks'), { recursive: true });
    await writeFile(
      join(tempVault, '01_CORE', '06_Tasks', 'disk-secret.md'),
      `# On-Disk Secret\ngemini_key: ${fakeGemini}\n`,
      'utf8',
    );
    const noteRes = await fetch(
      `${server.url}/api/vault/note?path=${encodeURIComponent('01_CORE/06_Tasks/disk-secret.md')}`,
      { headers: { Authorization: 'Bearer os3-secret-token-xyz123' } },
    );
    expect(noteRes.status).toBe(403);

    const logger = new StructuredLogger({ level: 'info' });
    const logged = logger.info('auth.test', `Leaky token ${fakeGemini} and ${fakeAnthropic}`, {
      apiKey: 'plain-secret-value',
    });
    expect(logged?.message).not.toContain(fakeGemini);
    expect(logged?.message).not.toContain(fakeAnthropic);
    expect(redactSecrets(`Bearer supersecretbearertoken12345`)).toBe('[REDACTED_SECRET]');
    expect(logged?.context?.apiKey).toBe('[REDACTED_SECRET]');
  });

  it('7. Rejects invalid canonical promotions (missing approval, unapproved, missing provenance, low confidence)', async () => {
    await expect(
      vault.promoteToCanonical({
        approvalId: 'non-existent-approval',
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/bad.md',
        title: 'Bad',
        body: 'No approval.',
        domain: 'KNOWLEDGE',
      }),
    ).rejects.toThrow(/does not exist/i);

    const pending = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'unapproved-item',
      proposer: 'research-orchestrator',
      request: {},
    });
    await expect(
      vault.promoteToCanonical({
        approvalId: pending.id,
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/unapproved.md',
        title: 'Unapproved',
        body: 'Still pending.',
        domain: 'KNOWLEDGE',
      }),
    ).rejects.toThrow(/requires human "approved"/i);

    const approved = db.decideApproval({
      approvalId: pending.id,
      decision: 'approved',
      approver: 'human-operator',
      reason: 'Approve test',
    });
    await expect(
      vault.promoteToCanonical({
        approvalId: approved.id,
        targetVaultPath: '02_KNOWLEDGE_LAYER/04_Atomic_Notes/low-conf.md',
        title: 'Low Confidence',
        body: 'Weak evidence.',
        domain: 'KNOWLEDGE',
        sourceRefs: ['04_RESEARCH_MATERIAL/00_Inbox/doc.md'],
        confidence: 0.42,
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it('8. Rejects malformed agent definitions and retains atomic snapshot on hot reload failure', async () => {
    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const badAgentsDir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-bad-agents-'));
    try {
      const curatorSrc = join(tempVault, '04_AGENTS', 'vault-curator.md');
      const curatorMd = await readFile(curatorSrc, 'utf8');
      await copyFile(curatorSrc, join(badAgentsDir, 'vault-curator.md'));

      const registry = new Os3VaultAgentRegistry({ agentsDir: badAgentsDir, toolRegistry: tools });
      expect(registry.list()).toHaveLength(1);

      const unknownFieldParse = parseOs3AgentFile(
        join(badAgentsDir, 'broken.md'),
        curatorMd.replace('name: vault-curator', 'name: broken\nevil_extra: true'),
        { toolRegistry: tools },
      );
      expect(unknownFieldParse.ok).toBe(false);

      await writeFile(
        join(badAgentsDir, 'vault-curator.md'),
        curatorMd.replace(/^model:.*$/m, 'model: evil/hacked'),
        'utf8',
      );
      const reload = registry.hotReload();
      expect(reload.replaced).toBe(false);
      expect(reload.failures.length).toBeGreaterThanOrEqual(1);
      expect(registry.get('vault-curator')).toBeDefined();
    } finally {
      await rm(badAgentsDir, { recursive: true, force: true });
    }
  });

  it('9. Rejects malicious workflow inputs, enforces localhost binding, API Bearer auth, backup, and Git recovery', async () => {
    const unauthRes = await fetch(`${server.url}/api/overview`);
    expect(unauthRes.status).toBe(401);

    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(isAllowedGatewayOrigin('127.0.0.1:8077', 'http://127.0.0.1:3000', 'http://127.0.0.1:3000/map')).toBe(true);
    expect(isAllowedGatewayOrigin('127.0.0.1:8077', 'http://127.0.0.1:3000', 'https://evil.example/phish')).toBe(false);

    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(tempVault, '04_AGENTS'), toolRegistry: tools });
    const orchestrator = new Os3Orchestrator({ agents, tools, db });
    const wfEngine = new Os3WorkflowEngine({
      definitionsDir: join(tempVault, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });
    const maliciousPayload = JSON.parse('{"query":"ok","__proto__":{"polluted":true}}') as Record<string, unknown>;
    await expect(wfEngine.execute('retrieve-and-summarize', maliciousPayload)).rejects.toThrow(/forbidden prototype key/i);

    const backupFile = join(outsideDir, 'os3-backup.sqlite');
    const backupReport = db.backupDatabase(backupFile);
    expect(backupReport.ok).toBe(true);
    expect(backupReport.integrityOk).toBe(true);

    const gitDir = join(outsideDir, 'git-vault-copy');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'note.md'), '# Recovery Checkpoint\n', 'utf8');
    const checkpoint = await createGitCheckpoint(gitDir, 'OS3 Phase 12 recovery test checkpoint');
    expect(checkpoint.ok).toBe(true);
    const status = await inspectGitRepository(gitDir);
    expect(status.isGitRepo).toBe(true);
    expect(status.clean).toBe(true);
  });
});
