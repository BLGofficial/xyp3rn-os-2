import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentRunRecord, IndexEntryRecord, JobRecord } from '../sqlite/client.ts';
import type { Os3JarvisRuntime } from './jarvis-runtime.ts';

const SECTORS = [
  '01_CORE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_RESEARCH_MATERIAL',
  '05_XYP3RN_RECORDS',
  '06_GOVERNANCE',
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
  const targetSectors = options.sector && SECTORS.includes(options.sector as (typeof SECTORS)[number])
    ? [options.sector]
    : [...SECTORS];

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
  const entries = options.sector
    ? runtime.db.listIndexEntries(options.sector, limit)
    : SECTORS.flatMap((sec) => runtime.db.listIndexEntries(sec, Math.max(15, Math.floor(limit / SECTORS.length))));

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
  const entries = runtime.db.listIndexEntries('05_XYP3RN_RECORDS', 400);
  const recordAgents = runtime.agents
    .list()
    .filter((a) => a.domain === 'RECORDS' || a.name.startsWith('x3lius-') || a.name.startsWith('records-'));
  const recentRuns = runtime.db
    .listAgentRuns(100)
    .filter((r) => recordAgents.some((a) => a.name === r.agentName) || r.agentName.startsWith('x3lius-'));

  const pickBy = (matcher: (e: IndexEntryRecord) => boolean) =>
    entries.filter(matcher).map(summarizeEntry);

  const songs = pickBy((e) => e.docType === 'song' || e.vaultPath.includes('/00_Songs/'));
  const lyrics = pickBy((e) => e.docType === 'lyric_version' || e.vaultPath.includes('/01_Lyrics/'));
  const vocalDna = pickBy((e) => e.docType === 'vocal_dna' || e.vaultPath.includes('/02_Vocal_DNA/'));
  const sunoPrompts = pickBy((e) => e.docType === 'suno_package' || e.vaultPath.includes('/07_Suno_Prompts/'));
  const audioTakes = pickBy((e) => e.docType === 'take' || e.vaultPath.includes('/06_Audio/'));
  const releases = pickBy((e) => e.docType === 'release' || e.vaultPath.includes('/05_Releases/'));
  const rightsSplits = pickBy((e) => e.docType === 'rights_split_set' || e.vaultPath.includes('Rights') || e.vaultPath.includes('Split'));
  const catalogAssignments = pickBy((e) => e.docType === 'isrc_assignment' || e.docType === 'upc_assignment' || e.vaultPath.includes('/Catalog/'));
  const sessionsDaily = pickBy((e) => e.vaultPath.includes('/00_Daily_Notes/') || e.vaultPath.includes('/01_Session_Logs/') || e.vaultPath.includes('/02_Decisions_ADR/'));

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
