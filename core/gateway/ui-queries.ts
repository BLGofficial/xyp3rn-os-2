import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentRunRecord, IndexEntryRecord, JobRecord } from '../sqlite/client.ts';
import type { DawGatewayController } from './daw-gateway.ts';
import type { Os3JarvisRuntime } from './jarvis-runtime.ts';

const SECTORS = [
  '01_CORE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_RESEARCH_MATERIAL',
  '05_XYP3RN_RECORDS',
  '06_GOVERNANCE',
] as const;

const ALL_OS3_SECTORS = [
  '00_SYSTEM',
  '01_CORE',
  '02_KNOWLEDGE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_AGENTS',
  '04_RESEARCH_MATERIAL',
  '05_WORKFLOWS',
  '05_XYP3RN_RECORDS',
  '06_RECORDS',
  '06_GOVERNANCE',
  '07_TECH',
  '08_GOVERNANCE',
  '09_X3LIUS_MUSIC',
  '10_DAW_BRAIN',
  '11_INBOX',
  '12_ARCHIVE',
] as const;

export type WorkflowSummary = {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly requiredInputs: readonly string[];
  readonly stepCount: number;
  readonly steps: readonly {
    readonly id: string;
    readonly agent: string;
    readonly dependsOn: readonly string[];
  }[];
  readonly lastJob: JobRecord | null;
};

const loadWorkflowSummariesFromDir = async (
  dirPath: string,
  sourcePrefix: string,
): Promise<Omit<WorkflowSummary, 'lastJob'>[]> => {
  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return [];

  const files = (await readdir(dirPath))
    .filter((name) => name.endsWith('.workflow.yaml'))
    .sort();

  const out: Omit<WorkflowSummary, 'lastJob'>[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(dirPath, file), 'utf8');
      const parsed = parseYaml(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') continue;
      const name = typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : file.replace(/\.workflow\.yaml$/, '');
      const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
      const inputObj = parsed.input && typeof parsed.input === 'object'
        ? (parsed.input as Record<string, unknown>)
        : null;
      const requiredInputs = Array.isArray(inputObj?.required)
        ? inputObj.required.filter((item): item is string => typeof item === 'string')
        : [];
      const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const steps = rawSteps
        .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
        .map((step) => ({
          id: typeof step.id === 'string' ? step.id : 'step',
          agent: typeof step.agent === 'string' ? step.agent : 'unknown',
          dependsOn: Array.isArray(step.dependsOn)
            ? step.dependsOn.filter((d): d is string => typeof d === 'string')
            : [],
        }));

      out.push({
        name,
        description,
        sourcePath: `${sourcePrefix}/${file}`,
        requiredInputs,
        stepCount: steps.length,
        steps,
      });
    } catch {
      // Skip malformed workflow definition files rather than breaking gateway overview.
    }
  }
  return out;
};

export const listWorkflowSummaries = async (runtime: Os3JarvisRuntime): Promise<WorkflowSummary[]> => {
  const candidateDirs: readonly { readonly dir: string; readonly prefix: string }[] = [
    { dir: join(runtime.vault.vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'), prefix: '05_WORKFLOWS/DEFINITIONS' },
    { dir: join(runtime.repoRoot, 'core', 'workflows'), prefix: 'core/workflows' },
    { dir: join(runtime.repoRoot, 'tech', 'workflows'), prefix: 'tech/workflows' },
    { dir: join(runtime.repoRoot, 'records', 'workflows'), prefix: 'records/workflows' },
    { dir: join(runtime.repoRoot, 'records', 'x3lius'), prefix: 'records/x3lius' },
  ];

  const seen = new Map<string, Omit<WorkflowSummary, 'lastJob'>>();
  for (const candidate of candidateDirs) {
    const defs = await loadWorkflowSummariesFromDir(candidate.dir, candidate.prefix);
    for (const def of defs) {
      if (!seen.has(def.name)) {
        seen.set(def.name, def);
      }
    }
  }

  const jobs = runtime.db.listJobs(100);
  return [...seen.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => {
      const stem = def.sourcePath.split('/').at(-1)?.replace(/\.workflow\.yaml$/, '') ?? def.name;
      const lastJob =
        jobs.find((j) => j.name === def.name || j.name === stem) ?? null;
      return { ...def, lastJob };
    });
};

export const buildAgentsSnapshot = (runtime: Os3JarvisRuntime) => {
  const snap = runtime.agents.snapshot();
  const recentRuns = runtime.db.listAgentRuns(150);
  const latestRunByAgent = new Map<string, AgentRunRecord>();
  for (const run of recentRuns) {
    if (!latestRunByAgent.has(run.agentName)) {
      latestRunByAgent.set(run.agentName, run);
    }
  }

  const byClass: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const agents = snap.agents.map((agent) => {
    byClass[agent.class] = (byClass[agent.class] ?? 0) + 1;
    byDomain[agent.domain] = (byDomain[agent.domain] ?? 0) + 1;
    return {
      name: agent.name,
      class: agent.class,
      domain: agent.domain,
      model: agent.model,
      tools: agent.tools,
      role: agent.role,
      contract: agent.contract,
      refuses: agent.refuses,
      path: agent.path,
      lastRun: latestRunByAgent.get(agent.name) ?? null,
    };
  });

  return {
    total: agents.length,
    failures: snap.failures,
    skippedCount: snap.skipped.length,
    byClass,
    byDomain,
    agents,
  };
};

export const buildSystemOverview = async (runtime: Os3JarvisRuntime) => {
  const indexStats = runtime.db.getIndexStats();
  const agentSnapshot = buildAgentsSnapshot(runtime);
  const workflows = await listWorkflowSummaries(runtime);
  const pendingApprovalsList = runtime.db.listApprovals('pending');
  const allApprovals = runtime.db.listApprovals();
  const recentJobs = runtime.db.listJobs(20);
  const recentAgentRuns = runtime.db.listAgentRuns(20);
  const recentEvents = runtime.db.listEvents({ limit: 25 });
  const activeLocks = runtime.db.listLocks();
  const integrity = runtime.db.checkIntegrity();

  return {
    ok: true,
    service: 'xyp3rn-os3-gateway',
    vaultRoot: runtime.vault.vaultRoot,
    sqliteOpen: runtime.db.isOpen,
    integrityOk: integrity.ok,
    schemaVersion: integrity.schemaVersion,
    indexStats,
    agents: {
      total: agentSnapshot.total,
      failuresCount: agentSnapshot.failures.length,
      byClass: agentSnapshot.byClass,
      byDomain: agentSnapshot.byDomain,
    },
    workflows: {
      total: workflows.length,
      names: workflows.map((w) => w.name),
    },
    runtime: {
      activeLocks: activeLocks.length,
      pendingApprovals: pendingApprovalsList.length,
      totalApprovals: allApprovals.length,
      recentRunsCount: recentAgentRuns.length,
      recentJobsCount: recentJobs.length,
      recentEventsCount: recentEvents.length,
    },
    pendingApprovalsList,
    recentJobs,
    recentAgentRuns,
    recentEvents,
  };
};

const folderOfVaultPath = (vaultPath: string): string => {
  const parts = vaultPath.split('/');
  if (parts.length <= 2) return parts[1] ?? parts[0] ?? 'root';
  return parts.slice(1, parts.length - 1).join('/');
};

export const buildVaultTree = (
  runtime: Os3JarvisRuntime,
  options: { readonly sector?: string | undefined; readonly limit?: number | undefined } = {},
) => {
  const limitPerSector = Math.min(500, Math.max(20, options.limit ?? 200));
  const stats = runtime.db.getIndexStats();
  const knownSet = new Set<string>([...ALL_OS3_SECTORS, ...Object.keys(stats.bySector)]);
  const targetSectors = options.sector && knownSet.has(options.sector)
    ? [options.sector]
    : [...knownSet].filter(
        (sec) => (SECTORS as readonly string[]).includes(sec) || (stats.bySector[sec] ?? 0) > 0,
      );

  const sectors = targetSectors.map((sector) => {
    const entries = runtime.db.listIndexEntries(sector, limitPerSector);
    const foldersMap = new Map<string, IndexEntryRecord[]>();
    for (const entry of entries) {
      const folder = folderOfVaultPath(entry.vaultPath);
      const list = foldersMap.get(folder) ?? [];
      list.push(entry);
      foldersMap.set(folder, list);
    }
    const folders = [...foldersMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, notes]) => ({
        folder,
        count: notes.length,
        notes: notes.map((n) => ({
          vaultPath: n.vaultPath,
          title: n.title,
          domain: n.domain,
          docType: n.docType,
          status: n.status,
          tags: n.tags,
          sha256: n.sha256,
          wikilinksCount: n.wikilinks.length,
        })),
      }));

    return {
      sector,
      totalIndexed: stats.bySector[sector] ?? entries.length,
      returnedCount: entries.length,
      folders,
    };
  });

  return {
    ok: true,
    totalFiles: stats.totalFiles,
    bySector: stats.bySector,
    sectors,
  };
};

const normalizeLinkTarget = (rawTarget: string): string =>
  rawTarget.trim().replace(/^\/+|\/+$/g, '').toLowerCase();

export const buildKnowledgeGraph = (
  runtime: Os3JarvisRuntime,
  options: { readonly sector?: string | undefined; readonly limit?: number | undefined } = {},
) => {
  const limit = Math.min(350, Math.max(20, options.limit ?? 160));
  const stats = runtime.db.getIndexStats();
  const sectorKeys = [...new Set<string>([...SECTORS, ...Object.keys(stats.bySector)])];
  const entries = options.sector
    ? runtime.db.listIndexEntries(options.sector, limit)
    : sectorKeys.flatMap((sec) =>
        runtime.db.listIndexEntries(sec, Math.max(15, Math.floor(limit / Math.max(1, sectorKeys.length)))),
      );

  const byExactPath = new Map<string, IndexEntryRecord>();
  const byStem = new Map<string, IndexEntryRecord>();
  for (const entry of entries) {
    byExactPath.set(entry.vaultPath.toLowerCase(), entry);
    byExactPath.set(entry.vaultPath.replace(/\.md$/i, '').toLowerCase(), entry);
    const fileStem = entry.vaultPath.split('/').at(-1)?.replace(/\.md$/i, '').toLowerCase() ?? '';
    if (fileStem && !byStem.has(fileStem)) {
      byStem.set(fileStem, entry);
    }
    if (entry.title && !byStem.has(entry.title.toLowerCase())) {
      byStem.set(entry.title.toLowerCase(), entry);
    }
  }

  const edgeKeys = new Set<string>();
  const edges: Array<{ readonly source: string; readonly target: string; readonly rawTarget: string }> = [];
  const degree = new Map<string, number>();

  for (const entry of entries) {
    for (const link of entry.wikilinks) {
      const normalized = normalizeLinkTarget(link.target);
      if (!normalized) continue;
      const targetEntry =
        byExactPath.get(normalized) ??
        byExactPath.get(`${normalized}.md`) ??
        byStem.get(normalized.split('/').at(-1) ?? normalized);
      if (!targetEntry || targetEntry.vaultPath === entry.vaultPath) continue;
      const key = `${entry.vaultPath}->${targetEntry.vaultPath}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        source: entry.vaultPath,
        target: targetEntry.vaultPath,
        rawTarget: link.target,
      });
      degree.set(entry.vaultPath, (degree.get(entry.vaultPath) ?? 0) + 1);
      degree.set(targetEntry.vaultPath, (degree.get(targetEntry.vaultPath) ?? 0) + 1);
    }
  }

  const nodes = entries.map((entry) => ({
    id: entry.vaultPath,
    title: entry.title,
    sector: entry.sector,
    domain: entry.domain,
    docType: entry.docType,
    status: entry.status,
    degree: degree.get(entry.vaultPath) ?? 0,
  }));

  return {
    ok: true,
    sector: options.sector ?? null,
    totalIndexed: stats.totalFiles,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };
};

const summarizeEntry = (n: IndexEntryRecord) => ({
  vaultPath: n.vaultPath,
  title: n.title,
  docType: n.docType,
  status: n.status,
  tags: n.tags,
  sha256: n.sha256,
  wikilinksCount: n.wikilinks.length,
  frontmatter: n.frontmatter,
});

export const buildResearchOverview = (runtime: Os3JarvisRuntime) => {
  const intel = runtime.db.listIndexEntries('03_RESEARCH_INTELLIGENCE', 400);
  const material = runtime.db.listIndexEntries('04_RESEARCH_MATERIAL', 200);
  const researchAgents = runtime.agents
    .list()
    .filter((a) => a.class === 'Research' || a.domain === 'RESEARCH_INTELLIGENCE');
  const recentRuns = runtime.db
    .listAgentRuns(100)
    .filter((r) => researchAgents.some((a) => a.name === r.agentName) || r.agentName.includes('research'));

  const pickBy = (list: readonly IndexEntryRecord[], matcher: (e: IndexEntryRecord) => boolean) =>
    list.filter(matcher).map(summarizeEntry);

  const projects = pickBy(intel, (e) => e.docType === 'research_project' || e.vaultPath.includes('/Projects/'));
  const questions = pickBy(intel, (e) => e.docType === 'research_question' || e.vaultPath.includes('/Questions/'));
  const sources = pickBy([...intel, ...material], (e) => e.docType === 'source' || e.sector === '04_RESEARCH_MATERIAL');
  const evidence = pickBy(intel, (e) => e.docType === 'evidence' || e.vaultPath.includes('/Evidence/'));
  const findings = pickBy(intel, (e) => e.docType === 'finding' || e.vaultPath.includes('/Findings/'));
  const contradictions = pickBy(intel, (e) => e.docType === 'contradiction' || e.vaultPath.includes('/Contradictions/'));
  const experiments = pickBy(intel, (e) => e.docType === 'experiment' || e.vaultPath.includes('/Experiments/'));
  const briefs = pickBy(intel, (e) => e.docType === 'research_brief' || e.vaultPath.includes('/00_Briefs/') || e.vaultPath.includes('/05_Syntheses/'));

  return {
    ok: true,
    counts: {
      totalIntelligenceFiles: intel.length,
      totalMaterialFiles: material.length,
      projects: projects.length,
      questions: questions.length,
      sources: sources.length,
      evidence: evidence.length,
      findings: findings.length,
      contradictions: contradictions.length,
      experiments: experiments.length,
      briefs: briefs.length,
      specialists: researchAgents.length,
    },
    projects: projects.slice(0, 30),
    questions: questions.slice(0, 30),
    sources: sources.slice(0, 30),
    evidence: evidence.slice(0, 30),
    findings: findings.slice(0, 30),
    contradictions: contradictions.slice(0, 30),
    experiments: experiments.slice(0, 30),
    briefs: briefs.slice(0, 30),
    recentRuns: recentRuns.slice(0, 20),
  };
};

export const buildRecordsOverview = (runtime: Os3JarvisRuntime) => {
  const legacyRecords = runtime.db.listIndexEntries('05_XYP3RN_RECORDS', 400);
  const os3Records = runtime.db.listIndexEntries('06_RECORDS', 400);
  const x3liusEntries = runtime.db.listIndexEntries('09_X3LIUS_MUSIC', 400);
  const seenPaths = new Set<string>();
  const entries = [...legacyRecords, ...os3Records, ...x3liusEntries].filter((entry) => {
    if (seenPaths.has(entry.vaultPath)) return false;
    seenPaths.add(entry.vaultPath);
    return true;
  });
  const recordAgents = runtime.agents
    .list()
    .filter((a) => a.domain === 'RECORDS' || a.name.startsWith('x3lius-') || a.name.startsWith('records-'));
  const recentRuns = runtime.db
    .listAgentRuns(100)
    .filter((r) => recordAgents.some((a) => a.name === r.agentName) || r.agentName.startsWith('x3lius-'));

  const pickBy = (matcher: (e: IndexEntryRecord) => boolean) =>
    entries.filter(matcher).map(summarizeEntry);

  const songs = pickBy((e) => e.docType === 'song' || e.vaultPath.includes('/00_Songs/') || e.vaultPath.includes('/SONGS/'));
  const lyrics = pickBy((e) => e.docType === 'lyric_version' || e.docType === 'lyric' || e.vaultPath.includes('/01_Lyrics/') || e.vaultPath.includes('/LYRICS/'));
  const vocalDna = pickBy((e) => e.docType === 'vocal_dna' || e.vaultPath.includes('/02_Vocal_DNA/') || e.vaultPath.includes('/VOCAL_DNA/'));
  const sunoPrompts = pickBy((e) => e.docType === 'suno_package' || e.docType === 'audio-extracted-prompt' || e.vaultPath.includes('/07_Suno_Prompts/') || e.vaultPath.includes('/AUDIO_EXTRACTED_PROMPTS/') || e.vaultPath.includes('/SUNO_PACKAGES/'));
  const audioTakes = pickBy((e) => e.docType === 'take' || e.docType === 'mix_version' || e.docType === 'master_version' || e.vaultPath.includes('/06_Audio/') || e.vaultPath.includes('/TAKES/'));
  const releases = pickBy((e) => e.docType === 'release' || e.vaultPath.includes('/05_Releases/') || e.vaultPath.includes('/RELEASES/'));
  const rightsSplits = pickBy((e) => e.docType === 'rights_split_set' || e.docType === 'rights_split' || e.vaultPath.includes('Rights') || e.vaultPath.includes('/RIGHTS/'));
  const catalogAssignments = pickBy((e) => e.docType === 'isrc_assignment' || e.docType === 'upc_assignment' || e.docType === 'track' || e.docType === 'credit' || e.vaultPath.includes('/Catalog/') || e.vaultPath.includes('/TRACKS/') || e.vaultPath.includes('/CREDITS/'));
  const sessionsDaily = pickBy((e) => e.docType === 'daw_catalog_link' || e.vaultPath.includes('/00_Daily_Notes/') || e.vaultPath.includes('/01_Session_Logs/') || e.vaultPath.includes('/02_Decisions_ADR/') || e.vaultPath.includes('/CATALOG_LINKS/'));

  return {
    ok: true,
    counts: {
      totalRecordsFiles: entries.length,
      songs: songs.length,
      lyrics: lyrics.length,
      vocalDna: vocalDna.length,
      sunoPrompts: sunoPrompts.length,
      audioTakes: audioTakes.length,
      releases: releases.length,
      rightsSplits: rightsSplits.length,
      catalogAssignments: catalogAssignments.length,
      sessionsDaily: sessionsDaily.length,
      recordAgents: recordAgents.length,
    },
    songs: songs.slice(0, 30),
    lyrics: lyrics.slice(0, 30),
    vocalDna: vocalDna.slice(0, 20),
    sunoPrompts: sunoPrompts.slice(0, 30),
    audioTakes: audioTakes.slice(0, 30),
    releases: releases.slice(0, 30),
    rightsSplits: rightsSplits.slice(0, 20),
    catalogAssignments: catalogAssignments.slice(0, 20),
    sessionsDaily: sessionsDaily.slice(0, 20),
    recentRuns: recentRuns.slice(0, 20),
  };
};

export const buildCoreModulesOverview = async (
  runtime: Os3JarvisRuntime,
  dawGateway?: DawGatewayController,
) => {
  const stats = runtime.db.getIndexStats();
  const integrity = runtime.db.isOpen ? runtime.db.checkIntegrity() : null;
  const agentsSnap = runtime.agents.snapshot();
  const workflows = await listWorkflowSummaries(runtime);
  const dawOverview = dawGateway ? await dawGateway.buildOverview() : null;

  const modules = [
    {
      id: 'vault-engine',
      name: 'Obsidian Vault Engine',
      sector: '00_SYSTEM / 01_CORE',
      status: stats.totalFiles > 0 ? 'healthy' : 'degraded',
      summary: `${stats.totalFiles} indexed Markdown notes across ${Object.keys(stats.bySector).length} sectors`,
      sourcePath: 'core/vault-engine/vault-engine.ts',
    },
    {
      id: 'sqlite-runtime',
      name: 'SQLite Runtime & Lock Store',
      sector: '01_CORE',
      status: runtime.db.isOpen && integrity?.ok ? 'healthy' : 'offline',
      summary: `Schema v${integrity?.schemaVersion ?? 0} · ${runtime.db.listLocks().length} active locks · ${runtime.db.listApprovals('pending').length} pending approvals`,
      sourcePath: 'core/sqlite/client.ts',
    },
    {
      id: 'agent-registry',
      name: 'Agent & Tool Registry',
      sector: '04_AGENTS',
      status: agentsSnap.failures.length === 0 ? 'healthy' : 'degraded',
      summary: `${agentsSnap.agents.length} agents loaded · ${agentsSnap.failures.length} failures`,
      sourcePath: 'core/agent-registry/os3-agent-registry.ts',
    },
    {
      id: 'workflow-engine',
      name: 'Deterministic Workflow Engine',
      sector: '05_WORKFLOWS',
      status: workflows.length > 0 ? 'healthy' : 'degraded',
      summary: `${workflows.length} YAML definitions · ${runtime.db.listJobs(50).length} recorded jobs`,
      sourcePath: 'core/workflow-engine/os3-workflow-engine.ts',
    },
    {
      id: 'context-engine',
      name: 'Local Knowledge & Context Engine',
      sector: '02_KNOWLEDGE',
      status: 'healthy',
      summary: 'Hybrid structural/FTS5 retrieval + multi-hop wikilink graph',
      sourcePath: 'core/context-engine/os3-context-engine.ts',
    },
    {
      id: 'research-intelligence',
      name: 'Research Intelligence Subsystem',
      sector: '03_RESEARCH_INTELLIGENCE',
      status: 'healthy',
      summary: `${(stats.bySector['03_RESEARCH_INTELLIGENCE'] ?? 0)} research entities indexed`,
      sourcePath: 'research-intelligence/os3-research-engine.ts',
    },
    {
      id: 'records-music-system',
      name: 'X3LIUS Records + Music System',
      sector: '06_RECORDS / 09_X3LIUS_MUSIC',
      status: 'healthy',
      summary: `${(stats.bySector['06_RECORDS'] ?? 0) + (stats.bySector['09_X3LIUS_MUSIC'] ?? 0) + (stats.bySector['05_XYP3RN_RECORDS'] ?? 0)} catalog & studio notes`,
      sourcePath: 'records/os3-records-engine.ts',
    },
    {
      id: 'daw-brain',
      name: 'Universal DAW Brain & Adapters',
      sector: '10_DAW_BRAIN',
      status: dawOverview?.connectionSummary.state === 'connected' ? 'healthy' : dawOverview ? 'degraded' : 'offline',
      summary: dawOverview
        ? `State: ${dawOverview.connectionSummary.state} · ${dawOverview.adapters.length} adapters · ${dawOverview.capabilities.available.length} available / ${dawOverview.capabilities.unsupported.length} unsupported caps`
        : 'DAW gateway idle',
      sourcePath: 'core/daw-brain/daw-core.ts',
    },
    {
      id: 'plugin-brain',
      name: 'Plugin Brain Subsystem',
      sector: '10_DAW_BRAIN/PLUGINS',
      status: 'healthy',
      summary: `${dawOverview?.pluginBrain.profiles.length ?? 0} verified plugin profiles · edition compatibility checks active`,
      sourcePath: 'core/daw-brain/plugin-brain/plugin-brain.ts',
    },
    {
      id: 'audio-brain',
      name: 'Audio Brain & DSP Analyzer',
      sector: '10_DAW_BRAIN/AUDIO_ANALYSES',
      status: 'healthy',
      summary: `${dawOverview?.audioBrain.recentAnalyses.length ?? 0} session analyses · DSP + probabilistic MIR separation`,
      sourcePath: 'core/daw-brain/audio-brain/audio-brain.ts',
    },
  ];

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    modules,
  };
};

export const buildGovernanceOverview = (runtime: Os3JarvisRuntime) => {
  const legacyGov = runtime.db.listIndexEntries('06_GOVERNANCE', 250);
  const os3Gov = runtime.db.listIndexEntries('08_GOVERNANCE', 250);
  const seen = new Set<string>();
  const govNotes = [...legacyGov, ...os3Gov].filter((e) => {
    if (seen.has(e.vaultPath)) return false;
    seen.add(e.vaultPath);
    return true;
  });

  const policies = govNotes
    .filter((e) => e.vaultPath.includes('Policies') || e.vaultPath.includes('POLICIES') || e.docType === 'policy')
    .map(summarizeEntry);
  const standards = govNotes
    .filter((e) => e.vaultPath.includes('Standards') || e.vaultPath.includes('STANDARDS') || e.vaultPath.includes('Access') || e.vaultPath.includes('ACCESS'))
    .map(summarizeEntry);

  const approvals = runtime.db.listApprovals();
  const locks = runtime.db.listLocks();
  const securityEvents = runtime.db
    .listEvents({ limit: 120 })
    .filter((e) => e.domain === 'GOVERNANCE' || /denied|approval|security|lock/i.test(e.eventType));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    enforcedInvariants: [
      { id: 'F35-D2', name: 'No Self-Approval / Human Gate', enforced: true, detail: 'Agent & proposer identities rejected with 403 on canonical & DAW execution approvals' },
      { id: 'LOCALHOST-BINDING', name: '127.0.0.1 Gateway + CORS Allowlist', enforced: true, detail: 'Rejects non-localhost Host/Origin/Referer requests' },
      { id: 'CAS-NO-OVERWRITE', name: 'Vault Expected-SHA256 & Append-Only Audit', enforced: true, detail: 'Prevents silent overwrites and preserves immutable history' },
    ],
    counts: {
      policies: policies.length,
      standards: standards.length,
      totalGovNotes: govNotes.length,
      activeLocks: locks.length,
      pendingApprovals: approvals.filter((a) => a.status === 'pending').length,
      approvedCount: approvals.filter((a) => a.status === 'approved').length,
      rejectedCount: approvals.filter((a) => a.status === 'rejected').length,
      securityEventsCount: securityEvents.length,
    },
    policies: policies.slice(0, 30),
    standards: standards.slice(0, 30),
    activeLocks: locks,
    recentSecurityEvents: securityEvents.slice(0, 40),
  };
};

export const buildDiagnosticsOverview = async (
  runtime: Os3JarvisRuntime,
  dawGateway?: DawGatewayController,
) => {
  const integrity = runtime.db.isOpen ? runtime.db.checkIntegrity() : { ok: false, schemaVersion: 0, message: 'SQLite offline' };
  const stats = runtime.db.getIndexStats();
  const snap = runtime.agents.snapshot();
  const recentRuns = runtime.db.listAgentRuns(40);
  const recentJobs = runtime.db.listJobs(40);
  const dawOverview = dawGateway ? await dawGateway.buildOverview() : null;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    sqlite: {
      open: runtime.db.isOpen,
      integrityOk: integrity.ok,
      schemaVersion: integrity.schemaVersion,
      dbPath: runtime.db.dbPath,
    },
    vault: {
      vaultRoot: runtime.vault.vaultRoot,
      totalIndexedFiles: stats.totalFiles,
      sectorsCount: Object.keys(stats.bySector).length,
    },
    agents: {
      loadedCount: snap.agents.length,
      failuresCount: snap.failures.length,
      failures: snap.failures,
      skippedCount: snap.skipped.length,
    },
    runtimeHealth: {
      failedRunsCount: recentRuns.filter((r) => r.status === 'error').length,
      failedJobsCount: recentJobs.filter((j) => j.status === 'error').length,
      activeLocksCount: runtime.db.listLocks().length,
    },
    dawHealth: dawOverview
      ? {
          state: dawOverview.connectionSummary.state,
          stale: dawOverview.connectionSummary.stale,
          adaptersRegistered: dawOverview.adapters.length,
          reachableInstances: dawOverview.discoveredInstances.filter((i) => i.reachable).length,
          hostProbes: dawOverview.hostProbes,
        }
      : null,
  };
};
