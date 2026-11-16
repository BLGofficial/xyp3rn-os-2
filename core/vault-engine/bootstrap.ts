import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseObsidianNote } from '../../knowledge/obsidian/parser.ts';
import { validateVaultPath } from './path-guard.ts';
import { sha256Hex, writeFileAtomic } from './revision.ts';

/**
 * The canonical 6-sector directory tree required by XYP3RN OS 3.0 and UI-xyp3rn.
 */
export const CANONICAL_SECTOR_DIRS = [
  '01_CORE/00_Identity',
  '01_CORE/01_System_Prompts',
  '01_CORE/02_Agents',
  '01_CORE/03_Workflows',
  '01_CORE/04_Templates',
  '01_CORE/04_Templates/Records',
  '01_CORE/04_Templates/X3LIUS',
  '01_CORE/05_Dashboards',
  '01_CORE/06_Tasks',
  '01_CORE/07_Tools',
  '02_KNOWLEDGE_LAYER/00_MOCs',
  '02_KNOWLEDGE_LAYER/01_Concepts',
  '02_KNOWLEDGE_LAYER/02_Frameworks',
  '02_KNOWLEDGE_LAYER/03_Playbooks',
  '02_KNOWLEDGE_LAYER/04_Atomic_Notes',
  '02_KNOWLEDGE_LAYER/05_Glossary',
  '02_KNOWLEDGE_LAYER/Prompt_Knowledge',
  '03_RESEARCH_INTELLIGENCE/00_Briefs',
  '03_RESEARCH_INTELLIGENCE/01_Analyses',
  '03_RESEARCH_INTELLIGENCE/02_Competitive_Intel',
  '03_RESEARCH_INTELLIGENCE/03_Trend_Signals',
  '03_RESEARCH_INTELLIGENCE/04_Hypotheses',
  '03_RESEARCH_INTELLIGENCE/05_Syntheses',
  '03_RESEARCH_INTELLIGENCE/06_Specialists',
  '04_RESEARCH_MATERIAL/00_Inbox',
  '04_RESEARCH_MATERIAL/01_Papers',
  '04_RESEARCH_MATERIAL/02_Articles',
  '04_RESEARCH_MATERIAL/03_Books',
  '04_RESEARCH_MATERIAL/04_Transcripts',
  '04_RESEARCH_MATERIAL/05_Datasets',
  '04_RESEARCH_MATERIAL/06_Media',
  '04_RESEARCH_MATERIAL/07_Web_Clippings',
  '05_XYP3RN_RECORDS/00_Daily_Notes',
  '05_XYP3RN_RECORDS/01_Session_Logs',
  '05_XYP3RN_RECORDS/02_Decisions_ADR',
  '05_XYP3RN_RECORDS/03_Projects',
  '05_XYP3RN_RECORDS/04_Meetings',
  '05_XYP3RN_RECORDS/05_Releases',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/00_Songs',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/01_Lyrics',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/02_Vocal_DNA',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/03_Compositions',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/04_Arrangements',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/05_Genres_Styles',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/06_Audio',
  '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/07_Suno_Prompts',
  '05_XYP3RN_RECORDS/99_Archive',
  '06_GOVERNANCE/00_Policies',
  '06_GOVERNANCE/01_Standards',
  '06_GOVERNANCE/02_Access_Control',
  '06_GOVERNANCE/03_Risk_Register',
  '06_GOVERNANCE/04_Compliance',
  '06_GOVERNANCE/05_Audit_Logs',
  '06_GOVERNANCE/06_Changelog',
] as const;

export type VaultBootstrapReport = {
  readonly vaultRoot: string;
  readonly createdDirs: number;
  readonly syncedAgents: number;
  readonly syncedWorkflows: number;
  readonly syncedManifests: number;
  readonly syncedGovernanceDocs: number;
  readonly importedSeedNotes: number;
  readonly unchangedFiles: number;
};

const exists = async (absPath: string): Promise<boolean> =>
  (await stat(absPath).catch(() => null)) !== null;

const writeIfChanged = async (absPath: string, content: string): Promise<'written' | 'unchanged'> => {
  const existing = await readFile(absPath, 'utf8').catch(() => null);
  if (existing !== null && sha256Hex(existing) === sha256Hex(content)) {
    return 'unchanged';
  }
  await writeFileAtomic(absPath, content);
  return 'written';
};

/**
 * Ensures the 6-sector folder hierarchy exists inside `vaultRoot`, copies absent seed notes
 * from `seedVaultRoot` (if provided), and synchronizes first-party agents, workflows, manifests,
 * and governance documentation from `repoRoot` without deleting or overwriting user notes.
 */
export const bootstrapAndSyncVault = async (options: {
  readonly vaultRoot: string;
  readonly repoRoot: string;
  readonly seedVaultRoot?: string | undefined;
  readonly uiMapPath?: string | undefined;
}): Promise<VaultBootstrapReport> => {
  const vaultRoot = resolve(options.vaultRoot);
  const repoRoot = resolve(options.repoRoot);
  let createdDirs = 0;
  let syncedAgents = 0;
  let syncedWorkflows = 0;
  let syncedManifests = 0;
  let syncedGovernanceDocs = 0;
  let importedSeedNotes = 0;
  let unchangedFiles = 0;

  // 1. Create the 6 canonical sector directories
  for (const relDir of CANONICAL_SECTOR_DIRS) {
    const absDir = join(vaultRoot, ...relDir.split('/'));
    if (!(await exists(absDir))) {
      await mkdir(absDir, { recursive: true });
      createdDirs += 1;
    }
  }

  // 2. Copy missing seed notes from MAIN-XYP3RN-OS-Vault (never overwrites existing files)
  if (options.seedVaultRoot && (await exists(options.seedVaultRoot))) {
    const seedRoot = resolve(options.seedVaultRoot);
    const copySeedTree = async (dirAbs: string): Promise<void> => {
      const entries = await readdir(dirAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'OS VAULT' || entry.name === 'Project_Audits') {
          continue;
        }
        const srcAbs = join(dirAbs, entry.name);
        if (entry.isDirectory()) {
          await copySeedTree(srcAbs);
          continue;
        }
        if (!entry.isFile()) continue;

        const rel = relative(seedRoot, srcAbs).split(sep).join('/');
        const check = validateVaultPath(vaultRoot, rel, { requireSectorPrefix: true });
        if (!check.ok) continue;

        if (!(await exists(check.absPath))) {
          await mkdir(join(check.absPath, '..'), { recursive: true });
          await copyFile(srcAbs, check.absPath);
          importedSeedNotes += 1;
        } else {
          unchangedFiles += 1;
        }
      }
    };
    await copySeedTree(seedRoot);
  }

  // 2b. Import the 60 written canonical notes from UI-xyp3rn/data/map.ts when absent
  const defaultUiMap = resolve(repoRoot, '..', 'UI-xyp3rn', 'data', 'map.ts');
  const uiMapPath = resolve(options.uiMapPath ?? process.env.XYP_UI_MAP_PATH ?? defaultUiMap);
  if (await exists(uiMapPath)) {
    try {
      const mod = (await import(`file:///${uiMapPath.replace(/\\/g, '/')}`)) as {
        departments?: ReadonlyArray<{
          readonly jobs: ReadonlyArray<{
            readonly file: string;
            readonly stub?: boolean;
            readonly skill: { readonly markdown: string };
          }>;
        }>;
      };
      for (const dept of mod.departments ?? []) {
        for (const job of dept.jobs) {
          if (job.stub || !job.skill?.markdown) continue;
          const check = validateVaultPath(vaultRoot, job.file, { requireSectorPrefix: true });
          if (!check.ok) continue;
          if (!(await exists(check.absPath))) {
            await writeFileAtomic(
              check.absPath,
              job.skill.markdown.endsWith('\n') ? job.skill.markdown : `${job.skill.markdown}\n`,
            );
            importedSeedNotes += 1;
          }
        }
      }
    } catch {
      // Optional UI map import skipped if unavailable in isolated test environments.
    }
  }

  // 3. Synchronize first-party Agent definitions (`agents/*.agent.md` -> `01_CORE/02_Agents/<name>.md`)
  const agentsDir = join(repoRoot, 'agents');
  const agentSummaryRows: { readonly name: string; readonly agentClass: string; readonly domain: string; readonly model: string }[] = [];

  if (await exists(agentsDir)) {
    const agentFiles = (await readdir(agentsDir)).filter((f) => f.endsWith('.agent.md') && !f.startsWith('_')).sort();
    for (const file of agentFiles) {
      const srcAbs = join(agentsDir, file);
      const raw = await readFile(srcAbs, 'utf8');
      const parsed = parseObsidianNote(raw);
      const agentName = file.replace(/\.agent\.md$/, '');
      const agentClass = String(parsed.frontmatter.class ?? 'Unknown');
      const domain = String(parsed.frontmatter.domain ?? 'CORE');
      const model = String(parsed.frontmatter.model ?? 'none');

      agentSummaryRows.push({ name: agentName, agentClass, domain, model });

      const dstCoreAbs = join(vaultRoot, '01_CORE', '02_Agents', `${agentName}.md`);
      const res = await writeIfChanged(dstCoreAbs, raw);
      if (res === 'written') syncedAgents += 1;
      else unchangedFiles += 1;

      if (agentClass === 'Research' && agentName.endsWith('-researcher')) {
        const dstSpecAbs = join(vaultRoot, '03_RESEARCH_INTELLIGENCE', '06_Specialists', `${agentName}.md`);
        await writeIfChanged(dstSpecAbs, raw);
      }
    }
  }

  // 4. Synchronize first-party Workflows (`**/*.workflow.yaml` -> `01_CORE/03_Workflows/<name>.yaml` + `.md`)
  const workflowPaths = [
    'core/workflows/retrieve-and-summarize.workflow.yaml',
    'records/workflows/build-suno-package.workflow.yaml',
    'records/workflows/register-track.workflow.yaml',
    'records/workflows/schedule-release.workflow.yaml',
    'records/x3lius/song-to-suno.workflow.yaml',
    'records/x3lius/write-lyrics.workflow.yaml',
    'tech/workflows/trace-intake.workflow.yaml',
  ];
  const workflowNames: string[] = [];

  for (const relWf of workflowPaths) {
    const srcAbs = join(repoRoot, ...relWf.split('/'));
    if (!(await exists(srcAbs))) continue;
    const raw = await readFile(srcAbs, 'utf8');
    const wfName = basename(relWf).replace(/\.workflow\.yaml$/, '');
    workflowNames.push(wfName);

    const dstYamlAbs = join(vaultRoot, '01_CORE', '03_Workflows', `${wfName}.workflow.yaml`);
    const res = await writeIfChanged(dstYamlAbs, raw);
    if (res === 'written') syncedWorkflows += 1;
    else unchangedFiles += 1;

    const mdNote = [
      '---',
      `title: "${wfName}"`,
      'type: workflow',
      'domain: CORE',
      'status: canonical',
      'tags: [xyp3rn, workflow, canonical]',
      `source_file: "${relWf}"`,
      `spec_sha256: "${sha256Hex(raw)}"`,
      '---',
      '',
      `# Workflow: ${wfName}`,
      '',
      `- **Source YAML:** \`01_CORE/03_Workflows/${wfName}.workflow.yaml\``,
      `- **Origin:** \`${relWf}\``,
      '',
      '```yaml',
      raw.trimEnd(),
      '```',
      '',
    ].join('\n');

    await writeIfChanged(join(vaultRoot, '01_CORE', '03_Workflows', `${wfName}.md`), mdNote);
  }

  // 5. Synchronize X3LIUS & Tech Manifests + Rubrics
  const manifests: readonly { readonly src: string; readonly dst: string }[] = [
    {
      src: 'records/x3lius/music-system.manifest.yaml',
      dst: '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/music-system.manifest.yaml',
    },
    {
      src: 'records/x3lius/vocal-dna.yaml',
      dst: '05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/02_Vocal_DNA/vocal-dna.yaml',
    },
    {
      src: 'records/x3lius/mix-rubric.yaml',
      dst: '02_KNOWLEDGE_LAYER/02_Frameworks/mix-rubric.yaml',
    },
    {
      src: 'tech/tech.manifest.yaml',
      dst: '02_KNOWLEDGE_LAYER/02_Frameworks/tech.manifest.yaml',
    },
  ];

  for (const m of manifests) {
    const srcAbs = join(repoRoot, ...m.src.split('/'));
    if (!(await exists(srcAbs))) continue;
    const raw = await readFile(srcAbs, 'utf8');
    const dstAbs = join(vaultRoot, ...m.dst.split('/'));
    const res = await writeIfChanged(dstAbs, raw);
    if (res === 'written') syncedManifests += 1;
    else unchangedFiles += 1;
  }

  // 6. Synchronize Governance & Architecture Standards
  const govDocs: readonly { readonly src: string; readonly dst: string }[] = [
    { src: 'docs/ARCHITECTURE.md', dst: '06_GOVERNANCE/01_Standards/OS-2-Architecture.md' },
    { src: 'docs/OS3-ARCHITECTURE.md', dst: '06_GOVERNANCE/01_Standards/OS-3-Architecture.md' },
    { src: 'docs/AGENT_CLASSES.md', dst: '06_GOVERNANCE/02_Access_Control/Agent-Classes-and-Capabilities.md' },
    { src: 'docs/SCHEMA.md', dst: '06_GOVERNANCE/01_Standards/Canonical-Schema-Reference.md' },
  ];

  for (const g of govDocs) {
    const srcAbs = join(repoRoot, ...g.src.split('/'));
    if (!(await exists(srcAbs))) continue;
    const raw = await readFile(srcAbs, 'utf8');
    const dstAbs = join(vaultRoot, ...g.dst.split('/'));
    const res = await writeIfChanged(dstAbs, raw);
    if (res === 'written') syncedGovernanceDocs += 1;
    else unchangedFiles += 1;
  }

  // 7. Update Agent Registry & Workflow Dashboards in 01_CORE/05_Dashboards/
  if (agentSummaryRows.length > 0) {
    const registryMd = [
      '---',
      'title: "Agent Registry"',
      'type: dashboard',
      'domain: CORE',
      'status: live',
      'tags: [xyp3rn, dashboard, agents]',
      '---',
      '',
      '# XYP3RN OS 3.0 — Agent Registry',
      '',
      `Total registered agents: **${agentSummaryRows.length}**`,
      '',
      '| Agent | Class | Domain | Model | Vault Note |',
      '|---|---|---|---|---|',
      ...agentSummaryRows.map(
        (a) => `| \`${a.name}\` | ${a.agentClass} | ${a.domain} | \`${a.model}\` | [[01_CORE/02_Agents/${a.name}\\|${a.name}]] |`,
      ),
      '',
    ].join('\n');
    await writeIfChanged(join(vaultRoot, '01_CORE', '05_Dashboards', 'Agent Registry.md'), registryMd);
  }

  if (workflowNames.length > 0) {
    const wfDashMd = [
      '---',
      'title: "Workflow Engine"',
      'type: dashboard',
      'domain: CORE',
      'status: live',
      'tags: [xyp3rn, dashboard, workflows]',
      '---',
      '',
      '# XYP3RN OS 3.0 — Workflow Registry',
      '',
      `Total registered workflows: **${workflowNames.length}**`,
      '',
      ...workflowNames.map((w) => `- [[01_CORE/03_Workflows/${w}|${w}]] (\`01_CORE/03_Workflows/${w}.workflow.yaml\`)`),
      '',
    ].join('\n');
    await writeIfChanged(join(vaultRoot, '01_CORE', '05_Dashboards', 'Workflow Engine.md'), wfDashMd);
  }

  return {
    vaultRoot,
    createdDirs,
    syncedAgents,
    syncedWorkflows,
    syncedManifests,
    syncedGovernanceDocs,
    importedSeedNotes,
    unchangedFiles,
  };
};
