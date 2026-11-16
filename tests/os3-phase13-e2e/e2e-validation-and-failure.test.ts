import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import { Os3JarvisCore } from '../../core/gateway/os3-jarvis-core.ts';
import { Os3JarvisRuntime } from '../../core/gateway/jarvis-runtime.ts';
import { startOs3GatewayServer } from '../../core/gateway/server.ts';
import { Os3ModelGateway, Os3ModelGatewayError } from '../../core/llm/os3-model-gateway.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { VaultTransactionManager } from '../../core/vault-engine/transaction-manager.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';
import { Os3RecordsEngine } from '../../records/os3-records-engine.ts';
import { Os3ResearchEngine } from '../../research-intelligence/os3-research-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_REPO_ROOT = resolve(REPO_ROOT, '..', '..', 'building-agentic-systems', 'XYP3RNOS', 'UI-xyp3rn');

const collectFiles = async (dir: string, extRe: RegExp): Promise<string[]> => {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(abs, extRe)));
    } else if (extRe.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
};

describe('Phase 13 — OS3 End-to-End Validation, Data Parity, Failure Resilience & SQL Retirement', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createIsolatedFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p13-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    const sqlitePath = join(dir, 'runtime.sqlite');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });
    const db = openRuntimeDb(sqlitePath);
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    return { dir, vaultRoot, sqlitePath, db, vault };
  };

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1 & 2. Validates Data Parity (IDs, wikilinks, revisions, provenance, SHA-256, Rights/ISRC/UPC) and Full E2E Functional Flows without Postgres/Supabase', async () => {
    // Verify clean execution with zero Postgres/Supabase environment variables
    const prevDbUrl = process.env.XYP_DATABASE_URL;
    const prevSupa = process.env.SUPABASE_URL;
    delete process.env.XYP_DATABASE_URL;
    delete process.env.SUPABASE_URL;

    try {
      const { vault, db } = await createIsolatedFixture();
      const tools = createOs3BuiltinToolRegistry({ vault, db });
      const agents = new Os3VaultAgentRegistry({ agentsDir: join(vault.vaultRoot, '04_AGENTS'), toolRegistry: tools });
      expect(agents.list()).toHaveLength(52);
      expect(tools.listSpecs()).toHaveLength(39);

      const orchestrator = new Os3Orchestrator({
        agents,
        tools,
        db,
        handlers: {
          'context-retriever': async () => ({ output: { items: [{ id: 'src-1', title: 'Local Audio Doc' }] } }),
          'extractive-summarizer': async (_c, inp) => ({
            output: { summary: `Synthesized ${(inp.items as unknown[]).length} source(s)` },
          }),
        },
      });
      const workflows = new Os3WorkflowEngine({
        definitionsDir: join(vault.vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
        db,
        agents,
        tools,
        orchestrator,
      });
      expect(workflows.list().length).toBeGreaterThanOrEqual(7);

      // Workflow execution + Context Engine + JARVIS Core
      const contextEngine = new Os3ContextEngine({ vault, db });
      const jarvisCore = new Os3JarvisCore({ db, agents, tools, contextEngine, orchestrator, workflows });
      const jarvisExec = await jarvisCore.handleDirective('xyp3rn> workflow retrieve-and-summarize', {
        query: 'local audio synthesis',
      });
      expect(jarvisExec.ok).toBe(true);

      // Research chain: Project -> Question -> Run -> Source -> Evidence -> Finding -> Promotion Gate
      const research = new Os3ResearchEngine({ vault, db });
      await research.createProject({ slug: 'os3-e2e-proj', title: 'OS3 E2E Research' });
      const rq = await research.createQuestion({
        projectSlug: 'os3-e2e-proj',
        question: 'Does local Vault-first execution preserve provenance?',
        intendedUse: 'Phase 13 acceptance verification',
      });
      const rrun = await research.openResearchRun({
        questionPathOrId: rq.id,
        selectedSpecialists: ['evaluation-researcher', 'benchmark-scoring-methodology-researcher'],
      });
      const src = await research.registerSource({
        kind: 'doc',
        uri: 'https://suno.com/docs/os3-spec',
        title: 'OS3 Local Architecture Spec',
        sourceText: 'VaultEngine enforces SHA-256 checksums and provenance on all canonical promotions.',
      });
      const src2 = await research.registerSource({
        kind: 'doc',
        uri: 'https://github.com/BLGofficial/promotion-gate-spec',
        title: 'Promotion Gate Documentation Spec',
        sourceText: 'PromotionGate requires provenance, SHA-256 revision, and human approval before canonical promotion.',
      });
      const src3 = await research.registerSource({
        kind: 'doc',
        uri: 'https://arxiv.org/abs/2611.00001',
        title: 'Vault Audit Trail Spec',
        sourceText: 'Every canonical write records immutable SHA-256 checksums in runtime_events.',
      });
      const ev = await research.recordEvidence({
        sourceRef: src.vaultPath,
        specialist: 'evaluation-researcher',
        verbatimQuote: 'VaultEngine enforces SHA-256 checksums and provenance on all canonical promotions.',
        interpretation: 'Direct evidence of checksum and provenance enforcement.',
        claimTopic: 'vault.provenance',
        claimValue: 'sha256-provenance-preserved',
        modelTag: 'deterministic-verifier',
        confidence: 0.95,
        confidenceInputs: { obs: 10 },
        uncertaintyNote: 'Verified locally against VaultEngine specs.',
        researchRunId: rrun.id,
      });
      const ev2 = await research.recordEvidence({
        sourceRef: src2.vaultPath,
        specialist: 'benchmark-scoring-methodology-researcher',
        verbatimQuote: 'PromotionGate requires provenance, SHA-256 revision, and human approval before canonical promotion.',
        interpretation: 'Corroborating code verification of Promotion Gate provenance rules.',
        claimTopic: 'vault.provenance',
        claimValue: 'sha256-provenance-preserved',
        modelTag: 'deterministic-verifier',
        confidence: 0.95,
        confidenceInputs: { obs: 10 },
        uncertaintyNote: 'Corroborated directly from specification.',
        researchRunId: rrun.id,
      });
      const ev3 = await research.recordEvidence({
        sourceRef: src3.vaultPath,
        specialist: 'evaluation-researcher',
        verbatimQuote: 'Every canonical write records immutable SHA-256 checksums in runtime_events.',
        interpretation: 'Third corroborating audit specification.',
        claimTopic: 'vault.provenance',
        claimValue: 'sha256-provenance-preserved',
        modelTag: 'deterministic-verifier',
        confidence: 0.95,
        confidenceInputs: { obs: 10 },
        uncertaintyNote: 'Corroborated across three specs.',
        researchRunId: rrun.id,
      });
      const find = await research.recordFinding({
        evidenceIds: [ev.id, ev2.id, ev3.id],
        claimTopic: 'vault.provenance',
        claimValue: 'sha256-provenance-preserved',
        interpretation: 'Canonical promotion preserves SHA-256 checksums and source provenance.',
        uncertaintyNote: 'Corroborated across three specification sources.',
        modelTag: 'deterministic-verifier',
        researchRunId: rrun.id,
      });
      const apprRes = db.queueApproval({
        itemType: 'vault_promotion',
        itemId: find.id,
        proposer: 'research-orchestrator',
        request: { targetVaultPath: '02_KNOWLEDGE/CANONICAL/KNOW-Provenance.md' },
      });
      db.decideApproval({
        approvalId: apprRes.id,
        decision: 'approved',
        approver: 'blago-human',
        reason: 'Verified evidence quote and SHA-256',
      });
      const promoted = await research.promoteFindingToCanonical({
        findingPathOrId: find.vaultPath,
        approvalId: apprRes.id,
        targetSlug: 'know-provenance',
        title: 'Local Vault Preserves Provenance',
      });
      expect((await vault.read(promoted.vaultPath)).frontmatter.status).toBe('canonical');

      // Records & Music parity + Reconciliation + Relationships (wikilinks/backlinks)
      const records = new Os3RecordsEngine({ vault, db });
      await records.createSong({ id: 'song-e2e-1', title: 'E2E Signal', artist: 'X3LIUS', language: 'en' });
      const lyr = await records.createLyricVersion({
        songPathOrId: 'song-e2e-1',
        lineageId: 'lin-e2e-1',
        title: 'E2E Lyrics',
        language: 'en',
        sections: [{ label: 'Hook', lines: ['Zero Postgres in OS3 runtime'] }],
      });
      const lyrAppr = records.requestCreativeApproval({ artifactPathOrId: lyr.id, proposer: 'x3lius-lyrics' });
      await records.approveCreativeVersion({
        artifactPathOrId: lyr.id,
        approvalId: lyrAppr.id,
        approver: 'blago-human',
        reason: 'Creative sign-off',
      });
      const gen = await records.recordGenerationAttemptAndTake({
        songPathOrId: 'song-e2e-1',
        sunoModel: 'suno-v6',
        stylePrompt: 'dark electronic 132 bpm',
        promptText: 'Zero Postgres in OS3 runtime',
        lyricRef: lyr.vaultPath,
      });
      await records.createRelease({ id: 'rel-e2e-1', title: 'OS3 Release', artist: 'X3LIUS', kind: 'single' });
      await records.assignUpc({ releasePathOrId: 'rel-e2e-1', upc: '036000291452' });
      await records.registerTrack({
        id: 'trk-e2e-1',
        releasePathOrId: 'rel-e2e-1',
        position: 1,
        title: 'E2E Signal',
        takePathOrId: gen.takeId,
      });
      await records.assignIsrc({ trackPathOrId: 'trk-e2e-1', isrc: 'QZAB12600111' });
      await records.writeRightsSplits({
        trackPathOrId: 'trk-e2e-1',
        shares: [{ payee: 'X3LIUS', role: 'all_rights', percentage: 100 }],
      });
      const rc = records.runRightsCheck('rel-e2e-1');
      await records.transitionReleaseCalendar({
        releasePathOrId: 'rel-e2e-1',
        action: 'schedule',
        releaseDate: '2026-12-28',
        rightsCheckRunId: rc.runId,
        todayIso: '2026-11-16',
      });

      const reconciliation = records.reconcileLegacyExports({
        songs: [{ id: 'song-e2e-1', title: 'E2E Signal', artist: 'X3LIUS', language: 'en' }],
        lyricVersions: [{ lineageId: 'lin-e2e-1', version: 1, approved: true }],
        tracks: [{ id: 'trk-e2e-1', releaseId: 'rel-e2e-1', position: 1, title: 'E2E Signal', isrc: 'QZAB12600111' }],
        releases: [{ id: 'rel-e2e-1', title: 'OS3 Release', kind: 'single', upc: '036000291452', status: 'scheduled' }],
        splits: [{ trackId: 'trk-e2e-1', version: 1, sum: 100, hasUnassigned: false }],
        takes: [{ id: gen.takeId, sunoModel: 'suno-v6', promptText: 'Zero Postgres in OS3 runtime' }],
      });
      expect(reconciliation.ok).toBe(true);
      expect(reconciliation.discrepancies).toEqual([]);

      // Verify Vault backlinks + Gateway HTTP API surface end-to-end
      expect(vault.backlinks(src.vaultPath).length).toBeGreaterThanOrEqual(1);

      const runtime = new Os3JarvisRuntime({ vault, db, repoRoot: REPO_ROOT });
      const gw = await startOs3GatewayServer(runtime, { host: '127.0.0.1', port: 0 });
      try {
        for (const ep of ['/api/health', '/api/overview', '/api/vault/tree', '/api/vault/graph', '/api/agents', '/api/workflows', '/api/research', '/api/records', '/api/runs', '/api/events']) {
          const r = await fetch(`${gw.url}${ep}`);
          expect(r.status).toBe(200);
          const json = (await r.json()) as { ok: boolean };
          expect(json.ok).toBe(true);
        }
      } finally {
        await gw.close();
      }
    } finally {
      if (prevDbUrl !== undefined) process.env.XYP_DATABASE_URL = prevDbUrl;
      if (prevSupa !== undefined) process.env.SUPABASE_URL = prevSupa;
    }
  });

  it('3. Validates all 10 Failure Modes (restart, SQLite offline, Vault offline, corrupt index, interrupted write, agent/model failure, Obsidian conflict, invalid workflow, rejected approval)', async () => {
    const { dir, vaultRoot, sqlitePath, db, vault } = await createIsolatedFixture();

    // (1) Runtime restart recovery (locks + running jobs survive reopen and recover cleanly)
    db.acquireLock('vault:restart-lock', 'crashed-worker', 5_000);
    db.enqueueJob({ id: 'job-crashed-1', kind: 'workflow', name: 'crashed', startImmediately: true });
    db.close();
    const reopenedDb = openRuntimeDb(sqlitePath);
    openDbs.push(reopenedDb);
    const lockRec = reopenedDb.recoverStaleLocks(new Date(Date.now() + 30_000).toISOString());
    expect(lockRec.recoveredCount).toBeGreaterThanOrEqual(1);
    const recoveredJobs = reopenedDb.repositories.jobs.recoverStaleRunningJobs('gateway restart');
    expect(recoveredJobs.some((j) => j.id === 'job-crashed-1')).toBe(true);

    // Prepare Vault note for CAS & batch transaction tests before testing offline modes
    const reopenedVault = new VaultEngine({ vaultRoot, db: reopenedDb });
    const noteRes = await reopenedVault.write({
      vaultPath: '10_INBOX/FailureProbe.md',
      content: '---\ntitle: "Failure Probe"\n---\n\nv1\n',
      actor: 'operator',
    });

    // (2) Corrupt index recovery: ghost row in index_state fixed by scanVault({ full: true })
    reopenedDb.raw
      .prepare(
        `INSERT INTO index_state (vault_path, sector, file_ext, byte_size, mtime_ms, sha256, title, domain, doc_type, status, tags_json, wikilinks_json, frontmatter_json, indexed_at)
         VALUES ('10_INBOX/GhostCorrupt.md', '10_INBOX', '.md', 10, 0, 'badsha', 'Ghost', NULL, NULL, NULL, '[]', '[]', '{}', '2026-11-16T00:00:00Z')`,
      )
      .run();
    expect(reopenedDb.getIndexEntry('10_INBOX/GhostCorrupt.md')).not.toBeNull();
    await reopenedVault.scanVault({ full: true });
    expect(reopenedDb.getIndexEntry('10_INBOX/GhostCorrupt.md')).toBeNull();

    // (3) Interrupted write / failed atomic batch transaction rollback (no .tmp leftovers, original content intact)
    await mkdir(join(vaultRoot, '10_INBOX', 'DirBlockingFile.md'), { recursive: true });
    const txMgr = new VaultTransactionManager(reopenedDb, reopenedVault.versions);
    await expect(
      txMgr.executeAtomicBatch(
        [
          {
            vaultPath: '10_INBOX/FailureProbe.md',
            absPath: join(vaultRoot, '10_INBOX', 'FailureProbe.md'),
            content: 'CORRUPTED',
          },
          {
            vaultPath: '10_INBOX/DirBlockingFile.md',
            absPath: join(vaultRoot, '10_INBOX', 'DirBlockingFile.md'),
            content: 'Cannot write over directory',
          },
        ],
        'operator',
      ),
    ).rejects.toThrow();
    expect((await reopenedVault.read('10_INBOX/FailureProbe.md')).sha256).toBe(noteRes.sha256);

    // (4) Concurrent Obsidian edit detected & preserved (throws EXTERNAL_OBSIDIAN_EDIT, never clobbers)
    await writeFile(
      join(vaultRoot, '10_INBOX', 'FailureProbe.md'),
      '---\ntitle: "Failure Probe"\n---\n\nhuman-obsidian-edit\n',
      'utf8',
    );
    await expect(
      reopenedVault.update({
        vaultPath: '10_INBOX/FailureProbe.md',
        content: '---\ntitle: "Failure Probe"\n---\n\nstale-agent-overwrite\n',
        actor: 'agent-worker',
        expectedSha256: noteRes.sha256,
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_OBSIDIAN_EDIT' });
    expect((await reopenedVault.read('10_INBOX/FailureProbe.md')).body).toContain('human-obsidian-edit');

    // (5) Agent failure + (6) Invalid workflow
    const tools = createOs3BuiltinToolRegistry({ vault: reopenedVault, db: reopenedDb });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(vaultRoot, '04_AGENTS'), toolRegistry: tools });
    const failingOrch = new Os3Orchestrator({
      agents,
      tools,
      db: reopenedDb,
      handlers: {
        'context-retriever': async () => {
          throw new Error('Simulated agent crash');
        },
      },
    });
    const wfEngine = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db: reopenedDb,
      agents,
      tools,
      orchestrator: failingOrch,
    });
    const failedRun = await wfEngine.execute('retrieve-and-summarize', { query: 'test' });
    expect(failedRun.status).toBe('error');
    expect(failedRun.failedStep).toBe('retrieve');
    expect(failedRun.skippedSteps).toContain('summarize');
    await expect(wfEngine.execute('nonexistent-workflow', {})).rejects.toThrow(/not found|unknown workflow/i);

    // (7) Model provider failure
    const gateway = new Os3ModelGateway({
      env: {},
      db: reopenedDb,
      customAdapters: {
        openrouter: async () => {
          throw new Error('503 upstream provider timeout');
        },
      },
    });
    const probeSchema = {
      name: 'probe',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    } as const;
    await expect(
      gateway.complete({
        agentName: 'evaluation-researcher',
        model: 'openrouter:meta-llama/llama-3-8b-instruct',
        request: { system: 's', user: 'hello', schema: probeSchema },
      }),
    ).rejects.toBeInstanceOf(Os3ModelGatewayError);

    // (8) Failed / rejected human approval blocks canonical promotion
    const rejAppr = reopenedDb.queueApproval({
      itemType: 'vault_promotion',
      itemId: 'rejected-candidate',
      proposer: 'research-orchestrator',
      request: {},
    });
    reopenedDb.decideApproval({
      approvalId: rejAppr.id,
      decision: 'rejected',
      approver: 'blago-human',
      reason: 'Insufficient evidence',
    });
    await expect(
      reopenedVault.promote({
        approvalId: rejAppr.id,
        targetVaultPath: '02_KNOWLEDGE/CANONICAL/Rejected.md',
        title: 'Rejected',
        body: 'Should not promote.',
        domain: 'KNOWLEDGE',
        sourceRefs: ['02_KNOWLEDGE/SOURCES/SRC-1.md'],
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_ACTOR' });

    // (9) Vault temporarily unavailable + (10) SQLite unavailable
    const missingVault = new VaultEngine({ vaultRoot: join(dir, 'unmounted-vault'), db: reopenedDb });
    await expect(missingVault.read('10_INBOX/Any.md')).rejects.toMatchObject({ name: 'VaultNotFoundError' });

    const offlineRuntime = new Os3JarvisRuntime({ vault: reopenedVault, db: reopenedDb, repoRoot: REPO_ROOT });
    const gw = await startOs3GatewayServer(offlineRuntime, { host: '127.0.0.1', port: 0 });
    try {
      reopenedDb.close();
      expect(reopenedDb.isOpen).toBe(false);
      const healthRes = await fetch(`${gw.url}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { ok: boolean; sqliteOpen: boolean };
      expect(healthJson.ok).toBe(true);
      expect(healthJson.sqliteOpen).toBe(false);
      // Vault read/write remains functional directly even while SQLite is offline
      expect((await reopenedVault.read('10_INBOX/FailureProbe.md')).body).toContain('human-obsidian-edit');
    } finally {
      await gw.close();
    }
  });

  it('4 & 5. Verifies UI-xyp3rn has zero legacy Postgres/Supabase dependencies and OS3 default startup retires SQL while preserving migration scripts', async () => {
    // 1. Scan UI-xyp3rn source code for forbidden legacy SQL / Supabase references
    const uiFiles = [
      ...(await collectFiles(join(UI_REPO_ROOT, 'app'), /\.(ts|tsx)$/)),
      ...(await collectFiles(join(UI_REPO_ROOT, 'components'), /\.(ts|tsx)$/)),
      ...(await collectFiles(join(UI_REPO_ROOT, 'lib'), /\.(ts|tsx)$/)),
    ];
    expect(uiFiles.length).toBeGreaterThanOrEqual(15);

    for (const file of uiFiles) {
      const src = await readFile(file, 'utf8');
      expect(src).not.toMatch(/from\s+['"]postgres['"]|@supabase|XYP_DATABASE_URL|apps\/web\/server/i);
    }

    // 2. Verify package.json routes `start:os` -> `start-os3.ps1` and preserves `start:legacy-os2` + `supabase/migrations/`
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['start:os']).toContain('start-os3.ps1');
    expect(pkg.scripts['start:os3']).toContain('start-os3.ps1');
    expect(pkg.scripts['start:legacy-os2']).toContain('start-xyp3rn.ps1');

    const migrations = await readdir(join(REPO_ROOT, 'supabase', 'migrations'));
    expect(migrations.length).toBeGreaterThanOrEqual(20);
  });
});
