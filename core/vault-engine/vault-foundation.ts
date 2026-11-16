import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { parseObsidianNote } from '../../knowledge/obsidian/parser.ts';
import { extractContractBullets } from '../agent-registry/os3-agent-registry.ts';
import { OS3_CANONICAL_TOOL_DEFINITIONS } from '../tool-registry/os3-tool-registry.ts';
import { OS3_VAULT_DIRS } from './path-guard.ts';
import { sha256Hex, writeFileAtomic } from './revision.ts';

/**
 * Resolves the external Obsidian Vault path from environment variables without
 * hardcoding any machine-specific absolute path.
 */
export const resolveConfiguredVaultPath = (overridePath?: string): string => {
  const raw =
    overridePath?.trim() ||
    process.env.OBSIDIAN_VAULT_PATH?.trim() ||
    process.env.XYP_OBSIDIAN_VAULT?.trim();
  if (raw) return resolve(raw);
  return resolve(process.cwd(), '..', 'XYP3RN-OS3-Vault');
};

/**
 * All 20 recognized versioned schemas for XYP3RN OS 3.0 Vault entities.
 */
export const RECOGNIZED_OS3_SCHEMAS = [
  'xyp3rn.entity/v3',
  'xyp3rn.agent/v3',
  'xyp3rn.workflow/v3',
  'xyp3rn.skill/v3',
  'xyp3rn.knowledge/v3',
  'xyp3rn.source/v3',
  'xyp3rn.research-project/v3',
  'xyp3rn.research-question/v3',
  'xyp3rn.evidence/v3',
  'xyp3rn.finding/v3',
  'xyp3rn.contradiction/v3',
  'xyp3rn.experiment/v3',
  'xyp3rn.decision-record/v3',
  'xyp3rn.song/v3',
  'xyp3rn.lyric/v3',
  'xyp3rn.track/v3',
  'xyp3rn.release/v3',
  'xyp3rn.rights-split/v3',
  'xyp3rn.policy/v3',
  'xyp3rn.approval/v3',
] as const;

export type Os3SchemaId = (typeof RECOGNIZED_OS3_SCHEMAS)[number];

/**
 * Required OS 3.0 directory hierarchy (top-level + domain subtrees).
 */
export const REQUIRED_OS3_VAULT_SUBDIRS = [
  ...OS3_VAULT_DIRS,
  '00_SYSTEM/SCHEMAS',
  '00_SYSTEM/TEMPLATES',
  '01_CORE/IDENTITY',
  '01_CORE/SYSTEM_PROMPTS',
  '01_CORE/AGENT_REGISTRY',
  '01_CORE/TOOL_REGISTRY',
  '01_CORE/DASHBOARDS',
  '01_CORE/TASKS',
  '02_KNOWLEDGE/CANONICAL',
  '02_KNOWLEDGE/SOURCES',
  '02_KNOWLEDGE/PROMPT_LIBRARY',
  '02_KNOWLEDGE/FRAMEWORKS',
  '02_KNOWLEDGE/GLOSSARY',
  '03_RESEARCH_INTELLIGENCE/PROJECTS',
  '03_RESEARCH_INTELLIGENCE/QUESTIONS',
  '03_RESEARCH_INTELLIGENCE/EVIDENCE',
  '03_RESEARCH_INTELLIGENCE/FINDINGS',
  '03_RESEARCH_INTELLIGENCE/CONTRADICTIONS',
  '03_RESEARCH_INTELLIGENCE/EXPERIMENTS',
  '03_RESEARCH_INTELLIGENCE/RUNS',
  '03_RESEARCH_INTELLIGENCE/SPECIALISTS',
  '05_WORKFLOWS/DEFINITIONS',
  '06_RECORDS/DECISIONS',
  '06_RECORDS/ADR',
  '06_RECORDS/RELEASES',
  '06_RECORDS/TRACKS',
  '06_RECORDS/RIGHTS',
  '06_RECORDS/TASKS',
  '07_TECH/PRODUCTS',
  '07_TECH/AUDIO_TOOLS',
  '07_TECH/AI_SYSTEMS',
  '07_TECH/R_AND_D',
  '07_TECH/TRACE',
  '08_GOVERNANCE/POLICIES',
  '08_GOVERNANCE/STANDARDS',
  '08_GOVERNANCE/ACCESS_CONTROL',
  '08_GOVERNANCE/APPROVALS',
  '08_GOVERNANCE/AUDIT_LOGS',
  '09_X3LIUS_MUSIC/SONGS',
  '09_X3LIUS_MUSIC/LYRICS',
  '09_X3LIUS_MUSIC/VOCAL_DNA',
  '09_X3LIUS_MUSIC/COMPOSITIONS',
  '09_X3LIUS_MUSIC/ARRANGEMENTS',
  '09_X3LIUS_MUSIC/GENRES_STYLES',
  '09_X3LIUS_MUSIC/SUNO_PACKAGES',
  '09_X3LIUS_MUSIC/TAKES',
  '09_X3LIUS_MUSIC/EVALUATION',
] as const;

export type Os3VaultProvisionReport = {
  readonly vaultRoot: string;
  readonly createdDirs: number;
  readonly writtenFiles: number;
  readonly unchangedFiles: number;
};

export type Os3VaultValidationReport = {
  readonly ok: boolean;
  readonly vaultRoot: string;
  readonly missingDirs: readonly string[];
  readonly checkedTemplates: number;
  readonly invalidYamlFiles: readonly { readonly path: string; readonly error: string }[];
  readonly checkedEntities: number;
  readonly missingIdFiles: readonly string[];
  readonly duplicateIds: readonly { readonly id: string; readonly paths: readonly string[] }[];
  readonly unrecognizedSchemaFiles: readonly { readonly path: string; readonly schema: string }[];
  readonly secretViolations: readonly { readonly path: string; readonly match: string }[];
  readonly obsidianConfigValid: boolean;
};

const exists = async (absPath: string): Promise<boolean> =>
  (await stat(absPath).catch(() => null)) !== null;

const writeNoteWithFrontmatter = async (
  absPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<'written' | 'unchanged'> => {
  const cleanBody = body.trim();
  const bodySha = sha256Hex(cleanBody);
  const fullFm = {
    ...frontmatter,
    source_sha256: frontmatter.source_sha256 ?? bodySha,
    updated_at: frontmatter.updated_at ?? '2026-11-16T00:00:00.000Z',
    created_at: frontmatter.created_at ?? '2026-11-16T00:00:00.000Z',
  };
  const yamlBlock = toYaml(fullFm, { lineWidth: 0 }).trimEnd();
  const content = `---\n${yamlBlock}\n---\n\n${cleanBody}\n`;

  const existing = await readFile(absPath, 'utf8').catch(() => null);
  if (existing !== null && sha256Hex(existing) === sha256Hex(content)) {
    return 'unchanged';
  }
  await writeFileAtomic(absPath, content);
  return 'written';
};

const TEMPLATE_SPECS: ReadonlyArray<{
  readonly file: string;
  readonly id: string;
  readonly schema: Os3SchemaId;
  readonly type: string;
  readonly domain: string;
  readonly title: string;
  readonly extraFm?: Record<string, unknown>;
  readonly body: string;
}> = [
  {
    file: 'entity.template.md',
    id: 'tpl-entity-v3',
    schema: 'xyp3rn.entity/v3',
    type: 'entity',
    domain: 'CORE',
    title: 'Template: Base Entity',
    body: '# {{title}}\n\n## Summary\nDescribe the entity purpose and links.',
  },
  {
    file: 'agent.template.md',
    id: 'tpl-agent-v3',
    schema: 'xyp3rn.agent/v3',
    type: 'agent',
    domain: 'CORE',
    title: 'Template: Agent Definition',
    extraFm: {
      name: 'template-agent',
      class: 'Execution',
      model: 'none',
      capabilities: ['context.read', 'log.write'],
      tools: ['retrieve_context', 'log_message'],
      inputSchema: { type: 'object', required: ['request'] },
      outputSchema: { type: 'object', required: ['status'] },
    },
    body: '# Agent Instructions\n\n## Role\nDefine the single-responsibility instructions for this agent.',
  },
  {
    file: 'workflow.template.md',
    id: 'tpl-workflow-v3',
    schema: 'xyp3rn.workflow/v3',
    type: 'workflow',
    domain: 'CORE',
    title: 'Template: Workflow Specification',
    extraFm: {
      name: 'template-workflow',
      requiredInput: ['request'],
      optionalInput: [],
      steps: [{ id: 'step-1', agent: 'health-check', dependsOn: [], input: { ping: '$input.request' } }],
    },
    body: '# Workflow: {{title}}\n\nDescribe the pipeline stages and expected artifacts.',
  },
  {
    file: 'skill.template.md',
    id: 'tpl-skill-v3',
    schema: 'xyp3rn.skill/v3',
    type: 'skill',
    domain: 'CORE',
    title: 'Template: Tool & Skill Contract',
    extraFm: {
      name: 'vault_operation',
      capability: 'vault.read',
      allowed_classes: ['Knowledge', 'Creative', 'Execution'],
      install_cmd: 'xyp3rn> read 00_SYSTEM/SYSTEM_MANIFEST.md',
    },
    body: '# Skill Contract\n\n## Preconditions & Guards\nDocument path safety and capability checks.',
  },
  {
    file: 'knowledge.template.md',
    id: 'tpl-knowledge-v3',
    schema: 'xyp3rn.knowledge/v3',
    type: 'knowledge',
    domain: 'KNOWLEDGE',
    title: 'Template: Canonical Knowledge Note',
    extraFm: {
      promoted_via: 'gate',
      model_scope: 'model-agnostic',
      claims: [{ topic: 'example.claim-topic', value: true, model_scope: 'model-agnostic' }],
    },
    body: '# Canonical Rule\n\n## Rule Statement\nState the verified rule and its scope.\n\n## Provenance\nLink supporting findings and sources.',
  },
  {
    file: 'source.template.md',
    id: 'tpl-source-v3',
    schema: 'xyp3rn.source/v3',
    type: 'source',
    domain: 'KNOWLEDGE',
    title: 'Template: Ingested Source',
    extraFm: {
      origin: 'first_party',
      uri: 'https://example.org/source',
      media_class: 'document',
    },
    body: '# Source Material\n\n## Verbatim Excerpts\nRecord extracted text and checksum metadata.',
  },
  {
    file: 'research-project.template.md',
    id: 'tpl-research-project-v3',
    schema: 'xyp3rn.research-project/v3',
    type: 'research_project',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Research Project',
    extraFm: { slug: 'template-research-project' },
    body: '# Research Project\n\n## Objective\nDefine the research scope and target questions.',
  },
  {
    file: 'research-question.template.md',
    id: 'tpl-research-question-v3',
    schema: 'xyp3rn.research-question/v3',
    type: 'research_question',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Research Question Brief',
    extraFm: {
      intended_use: 'Ground creative agent rules',
      allowed_urls: [],
      specialists: ['suno-researcher'],
    },
    body: '# Research Brief\n\n## Question\nState the falsifiable question and allowed sources.',
  },
  {
    file: 'evidence.template.md',
    id: 'tpl-evidence-v3',
    schema: 'xyp3rn.evidence/v3',
    type: 'evidence',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Verified Research Evidence',
    extraFm: {
      specialist: 'suno-researcher',
      verbatim_quote: 'Exact verbatim passage from source text.',
      claim_topic: 'suno.example-topic',
      claim_value: 'example-value',
      model_tag: 'suno-v6',
      confidence: 0.85,
    },
    body: '# Evidence Record\n\n## Verbatim Quote & Source Link\nCite the exact passage.',
  },
  {
    file: 'finding.template.md',
    id: 'tpl-finding-v3',
    schema: 'xyp3rn.finding/v3',
    type: 'finding',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Synthesized Finding',
    extraFm: {
      claim_topic: 'suno.example-topic',
      claim_value: 'example-value',
      model_tag: 'suno-v6',
      confidence: 0.88,
      evidence_ids: [],
    },
    body: '# Research Finding\n\n## Synthesis\nSummarize the converged specialist evidence.',
  },
  {
    file: 'contradiction.template.md',
    id: 'tpl-contradiction-v3',
    schema: 'xyp3rn.contradiction/v3',
    type: 'contradiction',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Contradiction Record',
    extraFm: {
      claim_topic: 'suno.example-topic',
      model_scope: 'suno-v6',
      resolution: null,
    },
    body: '# Contradiction Alert\n\n## Conflicting Claims\nDocument the two conflicting claims and model scopes.',
  },
  {
    file: 'experiment.template.md',
    id: 'tpl-experiment-v3',
    schema: 'xyp3rn.experiment/v3',
    type: 'experiment',
    domain: 'RESEARCH_INTELLIGENCE',
    title: 'Template: Controlled Experiment',
    extraFm: {
      control_score: 0.0,
      candidate_score: 0.0,
      trial_count: 0,
      scorer: 'x3lius-evaluation',
    },
    body: '# Controlled Experiment\n\n## Protocol & Results\nDocument control vs candidate prompts and Critic scores.',
  },
  {
    file: 'decision-record.template.md',
    id: 'tpl-decision-record-v3',
    schema: 'xyp3rn.decision-record/v3',
    type: 'decision_record',
    domain: 'GOVERNANCE',
    title: 'Template: Architecture Decision Record (ADR)',
    extraFm: { decision_key: 'ADR-0000', decided_by: 'owner' },
    body: '# ADR: {{title}}\n\n## Context\n\n## Decision\n\n## Consequences',
  },
  {
    file: 'song.template.md',
    id: 'tpl-song-v3',
    schema: 'xyp3rn.song/v3',
    type: 'song',
    domain: 'RECORDS',
    title: 'Template: X3LIUS Song Workspace',
    extraFm: {
      artist: 'X3LIUS',
      language: 'en',
      genre: 'UK Drill',
      bpm: 140,
      revision: 1,
    },
    body: '# Song Workspace\n\n## Linked Lineages\n- Lyrics:\n- Style Recipe:\n- Suno Package:\n- Audio Takes:',
  },
  {
    file: 'lyric.template.md',
    id: 'tpl-lyric-v3',
    schema: 'xyp3rn.lyric/v3',
    type: 'lyric',
    domain: 'RECORDS',
    title: 'Template: X3LIUS Lyric Sheet',
    extraFm: {
      author: 'X3LIUS',
      language: 'en',
      mixed_script_checked: true,
      version: 1,
    },
    body: '# Lyrics\n\n## [INTRO]\n\n## [VERSE 1]\n\n## [CHORUS]\n\n## [OUTRO]',
  },
  {
    file: 'track.template.md',
    id: 'tpl-track-v3',
    schema: 'xyp3rn.track/v3',
    type: 'track',
    domain: 'RECORDS',
    title: 'Template: Release Track Record',
    extraFm: {
      position: 1,
      isrc: null,
      recording_kind: 'vault_audio',
      duration_seconds: 180,
    },
    body: '# Track Record\n\n## Master & Audio Provenance',
  },
  {
    file: 'release.template.md',
    id: 'tpl-release-v3',
    schema: 'xyp3rn.release/v3',
    type: 'release',
    domain: 'RECORDS',
    title: 'Template: Catalog Release',
    extraFm: {
      artist: 'X3LIUS',
      kind: 'single',
      upc: null,
      release_date: '2026-12-01',
    },
    body: '# Release Checklist & Tracks\n\n## Readiness Checks\n- [ ] Tracks registered\n- [ ] Splits sum to 100%\n- [ ] Artwork linked',
  },
  {
    file: 'rights-split.template.md',
    id: 'tpl-rights-split-v3',
    schema: 'xyp3rn.rights-split/v3',
    type: 'rights_split',
    domain: 'RECORDS',
    title: 'Template: Rights Split Sheet',
    extraFm: {
      version: 1,
      total_percentage: 100.0,
      has_unassigned_share: false,
      shares: [{ payee: 'X3LIUS', role: 'master_and_publishing', percentage: 100.0 }],
    },
    body: '# Rights Split Sheet\n\n> Invariant F31: Every committed split set must sum to exactly 100.000%.',
  },
  {
    file: 'policy.template.md',
    id: 'tpl-policy-v3',
    schema: 'xyp3rn.policy/v3',
    type: 'policy',
    domain: 'GOVERNANCE',
    title: 'Template: Governance Policy',
    extraFm: { enforcement: 'mandatory' },
    body: '# Governance Policy\n\n## Rules & Enforcement Points',
  },
  {
    file: 'approval.template.md',
    id: 'tpl-approval-v3',
    schema: 'xyp3rn.approval/v3',
    type: 'approval',
    domain: 'GOVERNANCE',
    title: 'Template: Human Approval Record',
    extraFm: {
      item_type: 'vault_promotion',
      proposer: 'research-orchestrator',
      approver: 'owner',
      reason: 'Approved after verification.',
    },
    body: '# Human Approval Decision\n\n## Audit Trail',
  },
];

/**
 * Provisions the complete XYP3RN OS 3.0 Obsidian Vault structure, schemas, templates,
 * manifests, registries, and canonical example documents at `vaultRoot`.
 */
export const provisionOs3Vault = async (options: {
  readonly vaultRoot?: string | undefined;
  readonly repoRoot?: string | undefined;
}): Promise<Os3VaultProvisionReport> => {
  const vaultRoot = resolveConfiguredVaultPath(options.vaultRoot);
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dirname, '..', '..'));
  let createdDirs = 0;
  let writtenFiles = 0;
  let unchangedFiles = 0;

  const trackWrite = (res: 'written' | 'unchanged'): void => {
    if (res === 'written') writtenFiles += 1;
    else unchangedFiles += 1;
  };

  // 1. Create all required directories + .obsidian config directory
  for (const relDir of [...REQUIRED_OS3_VAULT_SUBDIRS, '.obsidian']) {
    const absDir = join(vaultRoot, ...relDir.split('/'));
    if (!(await exists(absDir))) {
      await mkdir(absDir, { recursive: true });
      createdDirs += 1;
    }
  }

  // 2. Write standard Obsidian configuration files (.obsidian/) so the Vault opens cleanly in Obsidian
  const obsidianConfigs: ReadonlyArray<{ readonly name: string; readonly json: unknown }> = [
    {
      name: 'app.json',
      json: {
        alwaysUpdateLinks: true,
        newFileLocation: 'folder',
        newFileFolderPath: '10_INBOX',
        attachmentFolderPath: '_attachments',
        showUnsupportedFiles: true,
      },
    },
    {
      name: 'appearance.json',
      json: { baseFontSize: 15, theme: 'obsidian' },
    },
    {
      name: 'templates.json',
      json: { folder: '00_SYSTEM/TEMPLATES' },
    },
    {
      name: 'graph.json',
      json: {
        'collapse-filter': false,
        search: '',
        showTags: false,
        showAttachments: false,
        hideUnresolved: false,
        colorGroups: [
          { query: 'path:"01_CORE"', color: { a: 1, rgb: 3718648 } },
          { query: 'path:"02_KNOWLEDGE"', color: { a: 1, rgb: 9141494 } },
          { query: 'path:"03_RESEARCH_INTELLIGENCE"', color: { a: 1, rgb: 15493788 } },
          { query: 'path:"04_AGENTS"', color: { a: 1, rgb: 2282478 } },
          { query: 'path:"05_WORKFLOWS"', color: { a: 1, rgb: 16096092 } },
          { query: 'path:"06_RECORDS"', color: { a: 1, rgb: 4116402 } },
          { query: 'path:"07_TECH"', color: { a: 1, rgb: 1096065 } },
          { query: 'path:"08_GOVERNANCE"', color: { a: 1, rgb: 15026253 } },
          { query: 'path:"09_X3LIUS_MUSIC"', color: { a: 1, rgb: 16727538 } },
        ],
      },
    },
  ];

  for (const cfg of obsidianConfigs) {
    const cfgPath = join(vaultRoot, '.obsidian', cfg.name);
    if (!(await exists(cfgPath))) {
      await writeFileAtomic(cfgPath, `${JSON.stringify(cfg.json, null, 2)}\n`);
      writtenFiles += 1;
    } else {
      unchangedFiles += 1;
    }
  }

  // 3. Vault README.md, 00_SYSTEM/SYSTEM_MANIFEST.md, and 00_SYSTEM/TAXONOMY.md
  trackWrite(
    await writeNoteWithFrontmatter(
      join(vaultRoot, 'README.md'),
      {
        schema: 'xyp3rn.entity/v3',
        id: 'vault-readme-os3',
        type: 'entity',
        title: 'XYP3RN OS 3.0 — Canonical Obsidian Vault',
        domain: 'CORE',
        sector: '00_SYSTEM',
        status: 'canonical',
        version: 1,
        tags: ['xyp3rn', 'os3', 'vault-root'],
      },
      [
        '# XYP3RN OS 3.0 — Canonical Obsidian Vault',
        '',
        'This Obsidian Vault is the **canonical source of truth** for XYP3RN OS 3.0.',
        '',
        '## Directory Structure',
        '- `00_SYSTEM/` — System Manifest ([[00_SYSTEM/SYSTEM_MANIFEST|SYSTEM_MANIFEST]]), [[00_SYSTEM/TAXONOMY|TAXONOMY]], `SCHEMAS/`, and `TEMPLATES/`',
        '- `01_CORE/` — Identity, System Prompts, [[01_CORE/AGENT_REGISTRY/AGENT_REGISTRY|AGENT_REGISTRY]], [[01_CORE/TOOL_REGISTRY/TOOL_REGISTRY|TOOL_REGISTRY]], Dashboards, Tasks',
        '- `02_KNOWLEDGE/` — `CANONICAL/`, `SOURCES/`, `PROMPT_LIBRARY/`, `FRAMEWORKS/`, `GLOSSARY/`',
        '- `03_RESEARCH_INTELLIGENCE/` — `PROJECTS/`, `QUESTIONS/`, `EVIDENCE/`, `FINDINGS/`, `CONTRADICTIONS/`, `EXPERIMENTS/`, `SPECIALISTS/`',
        '- `04_AGENTS/` — 52 validated Markdown/YAML Agent definitions',
        '- `05_WORKFLOWS/` — Validated YAML/Markdown Workflow definitions',
        '- `06_RECORDS/` — `DECISIONS/`, `ADR/`, `RELEASES/`, `TRACKS/`, `RIGHTS/`, `TASKS/`',
        '- `07_TECH/` — `PRODUCTS/`, `AUDIO_TOOLS/`, `AI_SYSTEMS/`, `R_AND_D/`, `TRACE/`',
        '- `08_GOVERNANCE/` — `POLICIES/`, `STANDARDS/`, `ACCESS_CONTROL/`, `APPROVALS/`, `AUDIT_LOGS/`',
        '- `09_X3LIUS_MUSIC/` — `SONGS/`, `LYRICS/`, `VOCAL_DNA/`, `COMPOSITIONS/`, `ARRANGEMENTS/`, `GENRES_STYLES/`, `SUNO_PACKAGES/`, `TAKES/`, `EVALUATION/`',
        '- `10_INBOX/` — Unprocessed operator notes & incoming staging',
        '- `11_ARCHIVE/` — Historical & retired records',
        '- `_attachments/` — Linked binary attachments',
      ].join('\n'),
    ),
  );

  trackWrite(
    await writeNoteWithFrontmatter(
      join(vaultRoot, '00_SYSTEM', 'SYSTEM_MANIFEST.md'),
      {
        schema: 'xyp3rn.policy/v3',
        id: 'sys-manifest-os3',
        type: 'policy',
        title: 'XYP3RN OS 3.0 — System Manifest',
        domain: 'CORE',
        sector: '00_SYSTEM',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'manifest', 'canonical'],
      },
      [
        '# XYP3RN OS 3.0 — System Manifest',
        '',
        '## Architectural Invariants',
        '1. **Local-First & Obsidian-First:** All canonical knowledge, agents, workflows, research, and creative records reside as Markdown/YAML files inside this Vault.',
        '2. **Minimal Local SQLite Runtime:** Operational state (`agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`) lives in local SQLite (`node:sqlite`).',
        '3. **Single File Authority (`VaultEngine`):** No agent may bypass `VaultEngine` or overwrite existing files silently.',
        '4. **Human Promotion Gate (`F35 D2`):** Nothing auto-approves. Canonical writes require an explicit `approved` human decision.',
        '5. **Zero Secrets in Vault:** API keys and tokens never enter this Vault.',
      ].join('\n'),
    ),
  );

  trackWrite(
    await writeNoteWithFrontmatter(
      join(vaultRoot, '00_SYSTEM', 'TAXONOMY.md'),
      {
        schema: 'xyp3rn.policy/v3',
        id: 'sys-taxonomy-os3',
        type: 'policy',
        title: 'XYP3RN OS 3.0 — Domain & Vault Taxonomy',
        domain: 'CORE',
        sector: '00_SYSTEM',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'taxonomy', 'canonical'],
      },
      [
        '# XYP3RN OS 3.0 — Domain & Vault Taxonomy',
        '',
        '## Six Functional Domains',
        '- `CORE` — Orchestrator, Agent Registry, Tool Registry, Workflow Engine, Context Engine, Memory, Runtime',
        '- `KNOWLEDGE` — Canonical Knowledge, Source Registry, Prompt Library, Vector/Structural Index, Promotion Gate',
        '- `RESEARCH_INTELLIGENCE` — Research Orchestrator, 20 Specialists, Evidence, Verbatim Quote Verifier, Contradictions, Experiments',
        '- `RECORDS` — X3LIUS Music System (10 creative sub-domains) + Records Ops (Songs, Releases, Tracks, Rights Splits)',
        '- `TECH` — Products, Audio Tools (`TRACE`), AI Systems, R&D Backlog',
        '- `GOVERNANCE` — Policies, Access Control, Human Approvals, Audit Trail',
        '',
        '## Separation Rule',
        'Research source material (`02_KNOWLEDGE/SOURCES/` & `04_RESEARCH_MATERIAL/`) is never merged with `07_TECH/`.',
      ].join('\n'),
    ),
  );

  // 4. Write all 20 Schema Reference Documents in 00_SYSTEM/SCHEMAS/
  for (const schemaId of RECOGNIZED_OS3_SCHEMAS) {
    const shortName = schemaId.replace(/^xyp3rn\./, '').replace(/\/v3$/, '');
    trackWrite(
      await writeNoteWithFrontmatter(
        join(vaultRoot, '00_SYSTEM', 'SCHEMAS', `${shortName}.schema.md`),
        {
          schema: 'xyp3rn.policy/v3',
          id: `schema-def-${shortName}-v3`,
          type: 'policy',
          title: `Schema Contract: ${schemaId}`,
          domain: 'CORE',
          sector: '00_SYSTEM',
          status: 'canonical',
          version: 1,
          target_schema: schemaId,
          tags: ['xyp3rn', 'os3', 'schema', 'canonical'],
        },
        `# Schema Definition: \`${schemaId}\`\n\nDefines required YAML frontmatter fields (` +
          `\`schema: "${schemaId}"\`, \`id\`, \`type\`, \`title\`, \`domain\`, \`status\`, \`version\`, \`source_sha256\`, \`tags\`) for \`${shortName}\` entities.`,
      ),
    );
  }

  // 5. Write all 20 Entity/Agent/Workflow/Knowledge/Research/Records Templates in 00_SYSTEM/TEMPLATES/
  for (const tpl of TEMPLATE_SPECS) {
    trackWrite(
      await writeNoteWithFrontmatter(
        join(vaultRoot, '00_SYSTEM', 'TEMPLATES', tpl.file),
        {
          schema: tpl.schema,
          id: tpl.id,
          type: tpl.type,
          title: tpl.title,
          domain: tpl.domain,
          sector: '00_SYSTEM',
          status: 'draft',
          version: 1,
          ...(tpl.extraFm ?? {}),
          tags: ['xyp3rn', 'os3', 'template', `template/${tpl.type}`],
        },
        tpl.body,
      ),
    );
  }

  // 6. Sync all 52 Repo Agents into 04_AGENTS/ (and specialists into 03_RESEARCH_INTELLIGENCE/SPECIALISTS/) with stable IDs and xyp3rn.agent/v3 schema
  const agentsDir = join(repoRoot, 'agents');
  const agentRows: { readonly id: string; readonly name: string; readonly cls: string; readonly domain: string; readonly model: string }[] = [];
  const toolCapMap = new Map<string, string>(
    OS3_CANONICAL_TOOL_DEFINITIONS.map((t) => [t.name, t.capability]),
  );

  if (await exists(agentsDir)) {
    const files = (await readdir(agentsDir)).filter((f) => f.endsWith('.agent.md') && !f.startsWith('_')).sort();
    for (const file of files) {
      const raw = await readFile(join(agentsDir, file), 'utf8');
      const parsed = parseObsidianNote(raw);
      const name = file.replace(/\.agent\.md$/, '');
      const id = `agent-${name}`;
      const cls = String(parsed.frontmatter.class ?? 'Execution');
      const domain = String(parsed.frontmatter.domain ?? 'CORE');
      const model = String(parsed.frontmatter.model ?? 'none');
      const tools = Array.isArray(parsed.frontmatter.tools)
        ? parsed.frontmatter.tools.map((t) => String(t))
        : [];
      const capabilities = [
        ...new Set(tools.map((t) => toolCapMap.get(t)).filter((c): c is string => Boolean(c))),
      ];

      const bodyParts = parsed.body.split(/^## (.+)$/m);
      const secMap = new Map<string, string>();
      for (let i = 1; i < bodyParts.length; i += 2) {
        secMap.set(bodyParts[i]!.trim(), (bodyParts[i + 1] ?? '').trim());
      }
      const roleText = secMap.get('Role') ?? '';
      const contractText = secMap.get('Contract') ?? '';
      const refusesText = secMap.get('Refuses') ?? '';
      const contractBullets = extractContractBullets(contractText);

      agentRows.push({ id, name, cls, domain, model });

      const fm: Record<string, unknown> = {
        ...parsed.frontmatter,
        schema: 'xyp3rn.agent/v3',
        id,
        type: 'agent',
        title: `Agent: ${name}`,
        name,
        class: cls,
        domain,
        sector: '04_AGENTS',
        status: 'live',
        version: 1,
        capabilities,
        responsibilities: roleText,
        input_contract: contractBullets.inputs,
        output_contract: contractBullets.outputs,
        read_permissions: contractBullets.reads,
        write_permissions: contractBullets.writes,
        refusals: refusesText,
        tags: [...new Set(['xyp3rn', 'os3', 'agent', `domain/${domain.toLowerCase()}`, ...parsed.frontmatter.tags])],
      };

      trackWrite(await writeNoteWithFrontmatter(join(vaultRoot, '04_AGENTS', `${name}.md`), fm, parsed.body));

      if (cls === 'Research' && name.endsWith('-researcher')) {
        const specFm: Record<string, unknown> = {
          ...fm,
          id: `specialist-${name}`,
          sector: '03_RESEARCH_INTELLIGENCE',
        };
        trackWrite(
          await writeNoteWithFrontmatter(
            join(vaultRoot, '03_RESEARCH_INTELLIGENCE', 'SPECIALISTS', `${name}.md`),
            specFm,
            parsed.body,
          ),
        );
      }
    }
  }

  // 7. Write 01_CORE/AGENT_REGISTRY/AGENT_REGISTRY.md and 01_CORE/TOOL_REGISTRY/TOOL_REGISTRY.md
  trackWrite(
    await writeNoteWithFrontmatter(
      join(vaultRoot, '01_CORE', 'AGENT_REGISTRY', 'AGENT_REGISTRY.md'),
      {
        schema: 'xyp3rn.entity/v3',
        id: 'core-agent-registry-os3',
        type: 'entity',
        title: 'XYP3RN OS 3.0 — Agent Registry',
        domain: 'CORE',
        sector: '01_CORE',
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'agent-registry'],
      },
      [
        '# XYP3RN OS 3.0 — Canonical Agent Registry',
        '',
        `Total validated agents: **${agentRows.length}**`,
        '',
        '| ID | Agent Name | Class | Domain | Model | Definition |',
        '|---|---|---|---|---|---|',
        ...agentRows.map(
          (a) =>
            `| \`${a.id}\` | \`${a.name}\` | ${a.cls} | ${a.domain} | \`${a.model}\` | [[04_AGENTS/${a.name}\\|${a.name}]] |`,
        ),
      ].join('\n'),
    ),
  );

  trackWrite(
    await writeNoteWithFrontmatter(
      join(vaultRoot, '01_CORE', 'TOOL_REGISTRY', 'TOOL_REGISTRY.md'),
      {
        schema: 'xyp3rn.skill/v3',
        id: 'core-tool-registry-os3',
        type: 'skill',
        name: 'tool_registry',
        title: 'XYP3RN OS 3.0 — Tool & Capability Registry',
        domain: 'CORE',
        sector: '01_CORE',
        capability: 'context.read',
        allowed_classes: ['Research', 'Knowledge', 'Planning', 'Creative', 'Critic', 'Revision', 'Execution', 'Governance'],
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'tool-registry'],
      },
      [
        '# XYP3RN OS 3.0 — Tool & Capability Registry',
        '',
        'Deny-by-default authorization matrix enforced by `core/tool-registry/registry.ts`.',
        '',
        '- `vault_read` (`vault.read`) — Read validated note via `VaultEngine`',
        '- `vault_write` (`vault.write`) — Write non-canonical note with No-Overwrite Guard',
        '- `vault_append` (`vault.write`) — Append to non-canonical note via `VaultEngine`',
        '- `vault_search` (`context.read`) — Search structural/semantic Vault index',
        '- `retrieve_context` (`context.read`) — Retrieve ranked knowledge/vault bundle',
        '- `retrieve_claims` (`context.read`) — Retrieve canonical structured claims',
        '- `write_artifact` (`artifact.write`) — Write versioned creative artifact',
        '- `read_artifact` (`artifact.read`) — Read creative artifact version',
        '- `log_message` (`log.write`) — Emit structured agent run log',
      ].join('\n'),
    ),
  );

  // 8. Sync all 7 Workflows into 05_WORKFLOWS/ with stable IDs and xyp3rn.workflow/v3 schema
  const workflowRelPaths = [
    'core/workflows/retrieve-and-summarize.workflow.yaml',
    'records/workflows/build-suno-package.workflow.yaml',
    'records/workflows/register-track.workflow.yaml',
    'records/workflows/schedule-release.workflow.yaml',
    'records/x3lius/song-to-suno.workflow.yaml',
    'records/x3lius/write-lyrics.workflow.yaml',
    'tech/workflows/trace-intake.workflow.yaml',
  ];

  for (const relWf of workflowRelPaths) {
    const srcAbs = join(repoRoot, ...relWf.split('/'));
    if (!(await exists(srcAbs))) continue;
    const rawYaml = await readFile(srcAbs, 'utf8');
    const wfName = basename(relWf).replace(/\.workflow\.yaml$/, '');
    const parsedYaml = (parseYaml(rawYaml, { logLevel: 'silent' }) as Record<string, unknown> | null) ?? {};

    trackWrite(
      await writeNoteWithFrontmatter(
        join(vaultRoot, '05_WORKFLOWS', `${wfName}.md`),
        {
          schema: 'xyp3rn.workflow/v3',
          id: `wf-${wfName}`,
          type: 'workflow',
          name: typeof parsedYaml.name === 'string' ? parsedYaml.name : wfName,
          title: `Workflow: ${wfName}`,
          domain: relWf.startsWith('records/') ? 'RECORDS' : relWf.startsWith('tech/') ? 'TECH' : 'CORE',
          sector: '05_WORKFLOWS',
          status: 'live',
          version: 1,
          spec_sha256: sha256Hex(rawYaml),
          requiredInput: parsedYaml.requiredInput ?? [],
          optionalInput: parsedYaml.optionalInput ?? [],
          steps: parsedYaml.steps ?? [],
          tags: ['xyp3rn', 'os3', 'workflow'],
        },
        `# Workflow: ${wfName}\n\n\`\`\`yaml\n${rawYaml.trimEnd()}\n\`\`\``,
      ),
    );

    const yamlDefPath = join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS', `${wfName}.workflow.yaml`);
    const existingYaml = await readFile(yamlDefPath, 'utf8').catch(() => null);
    if (existingYaml !== null && sha256Hex(existingYaml) === sha256Hex(rawYaml)) {
      unchangedFiles += 1;
    } else {
      await writeFileAtomic(yamlDefPath, rawYaml);
      writtenFiles += 1;
    }
  }

  // 9. Canonical Example Documents across all required domains & directories
  const canonicalExamples: ReadonlyArray<{
    readonly relPath: string;
    readonly fm: Record<string, unknown> & { readonly schema: Os3SchemaId; readonly id: string };
    readonly body: string;
  }> = [
    {
      relPath: '01_CORE/IDENTITY/ID-0001-Mission-and-Identity.md',
      fm: {
        schema: 'xyp3rn.policy/v3',
        id: 'core-id-0001-mission',
        type: 'policy',
        title: 'XYP3RN Mission & Operator Identity',
        domain: 'CORE',
        sector: '01_CORE',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'identity', 'canonical'],
      },
      body: '# XYP3RN Mission & Operator Identity\n\nLocal-first, evidence-grounded six-domain agentic operating system for XYP3RN and X3LIUS.',
    },
    {
      relPath: '01_CORE/SYSTEM_PROMPTS/SYS-0001-Jarvis-Routing-Gateway.md',
      fm: {
        schema: 'xyp3rn.policy/v3',
        id: 'core-sys-0001-jarvis-gateway',
        type: 'policy',
        title: 'Jarvis Routing Gateway System Prompt',
        domain: 'CORE',
        sector: '01_CORE',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'system-prompt', 'canonical'],
      },
      body: '# Jarvis Routing Gateway\n\nRoutes operator directives across `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, and `GOVERNANCE` while enforcing `PENDING_HUMAN_APPROVAL`.',
    },
    {
      relPath: '02_KNOWLEDGE/CANONICAL/KNOW-0001-Suno-v6-Gravity-Escape.md',
      fm: {
        schema: 'xyp3rn.knowledge/v3',
        id: 'know-0001-suno-v6-gravity-escape',
        type: 'knowledge',
        title: 'Suno v6 Genre Gravity Escape Rule',
        domain: 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'canonical',
        version: 1,
        promoted_via: 'gate',
        approval_id: 'appr-0001-example-promotion',
        approved_by: 'blago',
        model_scope: 'suno-v6',
        claims: [
          {
            topic: 'suno.genre-gravity-escape',
            value: { describeSoundMechanics: true, avoidEqualGenreDominance: true },
            model_scope: 'suno-v6',
          },
        ],
        tags: ['xyp3rn', 'os3', 'knowledge', 'canonical', 'model/suno-v6'],
      },
      body: '# Suno v6 Genre Gravity Escape Rule\n\nDescribe physical sound mechanics (BPM, drum transients, 808 portamento glide, vocal register) rather than stacking equally weighted genre labels. Supported by [[03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-0001-Portamento-Tag-Retention|FIND-0001]].',
    },
    {
      relPath: '02_KNOWLEDGE/SOURCES/SRC-0001-Suno-v6-Signal-Fieldnotes.md',
      fm: {
        schema: 'xyp3rn.source/v3',
        id: 'src-0001-suno-v6-fieldnotes',
        type: 'source',
        title: 'XYP3RN Suno v6 Signal Fieldnotes',
        domain: 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'canonical',
        version: 1,
        origin: 'first_party',
        uri: 'vault://02_KNOWLEDGE/SOURCES/SRC-0001-Suno-v6-Signal-Fieldnotes.md',
        media_class: 'document',
        tags: ['xyp3rn', 'os3', 'source', 'model/suno-v6'],
      },
      body: '# XYP3RN Suno v6 Signal Fieldnotes\n\nVerbatim source text: "Explicit portamento 808 sub-bass descriptors preserve glide articulation in UK drill x acoustic guitar hybrids on Suno v6."',
    },
    {
      relPath: '02_KNOWLEDGE/PROMPT_LIBRARY/PRM-0001-X3LIUS-UK-Drill-Baseline.md',
      fm: {
        schema: 'xyp3rn.knowledge/v3',
        id: 'prm-0001-x3lius-uk-drill-baseline',
        type: 'knowledge',
        title: 'X3LIUS UK Drill + Acoustic Guitar Hybrid Baseline Prompt',
        domain: 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'canonical',
        version: 1,
        promoted_via: 'gate',
        model_scope: 'suno-v6',
        tags: ['xyp3rn', 'os3', 'prompt-library', 'canonical', 'model/suno-v6'],
      },
      body: '# X3LIUS UK Drill Baseline Prompt\n\n`UK drill, modern trap, grime bar cadence, acoustic guitar hybrid production, 140 BPM, sliding portamento 808 sub-bass, cold baritone vocal delivery`',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/PROJECTS/RPRJ-0001-Suno-v6-808-Glide.md',
      fm: {
        schema: 'xyp3rn.research-project/v3',
        id: 'rprj-0001-suno-v6-808-glide',
        slug: 'suno-v6-808-glide',
        type: 'research_project',
        title: 'Suno v6 808 Glide & Hybrid Instrumentation Research',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'active',
        version: 1,
        tags: ['xyp3rn', 'os3', 'research-project'],
      },
      body: '# Research Project: Suno v6 808 Glide\n\nInvestigates low-end glide preservation across Suno v6 hybrid arrangements.',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/QUESTIONS/RQST-0001-808-Portamento-Articulation.md',
      fm: {
        schema: 'xyp3rn.research-question/v3',
        id: 'rqst-0001-808-portamento-articulation',
        project_slug: 'suno-v6-808-glide',
        type: 'research_question',
        title: 'Does specifying portamento 808 sub-bass prevent bassline flattening in Suno v6?',
        intended_use: 'Refine X3LIUS style recipe for Night Signals EP',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'answered',
        version: 1,
        specialists: ['suno-researcher', 'production-sound-design-researcher'],
        tags: ['xyp3rn', 'os3', 'research-question'],
      },
      body: '# Research Question RQST-0001\n\nAnswered by [[03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-0001-Portamento-Tag-Retention|FIND-0001]].',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-0001-Portamento-Sub-Bass-Quote.md',
      fm: {
        schema: 'xyp3rn.evidence/v3',
        id: 'evid-0001-portamento-sub-bass-quote',
        type: 'evidence',
        title: 'Evidence: Portamento 808 Sub-Bass Descriptor Retention',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'approved',
        version: 1,
        specialist: 'suno-researcher',
        source_ref: '02_KNOWLEDGE/SOURCES/SRC-0001-Suno-v6-Signal-Fieldnotes.md',
        verbatim_quote: 'Explicit portamento 808 sub-bass descriptors preserve glide articulation in UK drill x acoustic guitar hybrids on Suno v6.',
        claim_topic: 'suno.808-glide-descriptor',
        claim_value: 'portamento 808 sub-bass',
        model_tag: 'suno-v6',
        confidence: 0.9,
        tags: ['xyp3rn', 'os3', 'evidence', 'model/suno-v6'],
      },
      body: '# Evidence EVID-0001\n\nVerbatim quote verified against [[02_KNOWLEDGE/SOURCES/SRC-0001-Suno-v6-Signal-Fieldnotes|SRC-0001]].',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/FINDINGS/FIND-0001-Portamento-Tag-Retention.md',
      fm: {
        schema: 'xyp3rn.finding/v3',
        id: 'find-0001-portamento-tag-retention',
        type: 'finding',
        title: 'Finding: Portamento 808 Descriptor Retains UK Drill Glide in Suno v6',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'approved',
        version: 1,
        claim_topic: 'suno.808-glide-descriptor',
        claim_value: 'portamento 808 sub-bass',
        model_tag: 'suno-v6',
        confidence: 0.9,
        evidence_ids: ['evid-0001-portamento-sub-bass-quote'],
        owner_decision: 'accepted',
        canonical_status: 'promoted',
        tags: ['xyp3rn', 'os3', 'finding', 'model/suno-v6'],
      },
      body: '# Finding FIND-0001\n\nSynthesized from [[03_RESEARCH_INTELLIGENCE/EVIDENCE/EVID-0001-Portamento-Sub-Bass-Quote|EVID-0001]] and validated in [[03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-0001-Portamento-AB-Trial|EXPR-0001]].',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/CNTR-0001-Genre-Stack-Limit.md',
      fm: {
        schema: 'xyp3rn.contradiction/v3',
        id: 'cntr-0001-genre-stack-limit',
        type: 'contradiction',
        title: 'Contradiction: v4.5 Genre Stacking vs v6 Mechanics Descriptions',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'resolved',
        version: 1,
        claim_topic: 'suno.genre-gravity-escape',
        model_scope: 'suno-v6',
        resolution: 'Resolved by version-scoping (F20): v4.5 stacking rules apply only to suno-v4.5; suno-v6 uses mechanics descriptors.',
        tags: ['xyp3rn', 'os3', 'contradiction'],
      },
      body: '# Contradiction CNTR-0001\n\nResolved via model-version scoping (`F20`).',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/EXPERIMENTS/EXPR-0001-Portamento-AB-Trial.md',
      fm: {
        schema: 'xyp3rn.experiment/v3',
        id: 'expr-0001-portamento-ab-trial',
        type: 'experiment',
        title: 'Experiment: Portamento 808 vs Generic 808 Tag (Suno v6)',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'validated',
        version: 1,
        control_score: 0.6,
        candidate_score: 0.92,
        trial_count: 10,
        scorer: 'x3lius-evaluation',
        tags: ['xyp3rn', 'os3', 'experiment'],
      },
      body: '# Experiment EXPR-0001\n\nCandidate variant (`portamento 808 sub-bass`) beat control (`0.92` vs `0.60`) across 10 takes.',
    },
    {
      relPath: '06_RECORDS/ADR/ADR-0001-Local-First-Obsidian-Vault.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'adr-0001-local-first-obsidian-vault',
        decision_key: 'OS3-ADR-0001',
        type: 'decision_record',
        title: 'ADR-0001: Local-First and Obsidian-First Canonical Architecture',
        domain: 'CORE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'adr', 'canonical'],
      },
      body: '# ADR-0001: Local-First and Obsidian-First Canonical Architecture\n\nApproved decision establishing the external Obsidian Vault as the sole canonical knowledge and creative store, backed by minimal local SQLite for runtime state.',
    },
    {
      relPath: '06_RECORDS/ADR/ADR-0002-Minimal-Local-SQLite.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'adr-0002-minimal-local-sqlite',
        decision_key: 'OS3-ADR-0002',
        type: 'decision_record',
        title: 'ADR-0002: Minimal Local SQLite (node:sqlite) Runtime Store',
        domain: 'CORE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'adr', 'canonical'],
      },
      body: '# ADR-0002: Minimal Local SQLite (node:sqlite) Runtime Store\n\nReplaces 42 PostgreSQL tables with 8 focused SQLite WAL tables (`agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`, `index_meta`).',
    },
    {
      relPath: '06_RECORDS/ADR/ADR-0003-Six-Domain-Twelve-Folder-Vault-Mapping.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'adr-0003-six-domain-twelve-folder-vault-mapping',
        decision_key: 'OS3-ADR-0003',
        type: 'decision_record',
        title: 'ADR-0003: Six-Domain and Twelve-Folder Vault Mapping',
        domain: 'CORE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'adr', 'canonical'],
      },
      body: '# ADR-0003: Six-Domain and Twelve-Folder Vault Mapping\n\nPreserves the 6 functional domains (`CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`) distinct from the 12 physical Vault directories (`00_SYSTEM`..`11_ARCHIVE`).',
    },
    {
      relPath: '06_RECORDS/ADR/ADR-0004-No-Overwrite-and-Promotion-Gate.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'adr-0004-no-overwrite-and-promotion-gate',
        decision_key: 'OS3-ADR-0004',
        type: 'decision_record',
        title: 'ADR-0004: No-Overwrite Guard, Revision Backups & Promotion Gate',
        domain: 'GOVERNANCE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'adr', 'canonical'],
      },
      body: '# ADR-0004: No-Overwrite Guard, Revision Backups & Promotion Gate\n\nEnforces atomic `.tmp` + rename writes, `.vault-revisions/` SHA-256 backups, and human approval before canonical promotion.',
    },
    {
      relPath: '06_RECORDS/ADR/ADR-0005-UI-XYP3RN-Gateway-Contract.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'adr-0005-ui-xyp3rn-gateway-contract',
        decision_key: 'OS3-ADR-0005',
        type: 'decision_record',
        title: 'ADR-0005: UI-xyp3rn Local HTTP Gateway Contract (127.0.0.1:8077)',
        domain: 'CORE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'adr', 'canonical'],
      },
      body: '# ADR-0005: UI-xyp3rn Local HTTP Gateway Contract\n\nConnects `UI-xyp3rn` to `xyp3rn-os3-gateway` on `http://127.0.0.1:8077` with PNA CORS headers and deterministic fallback.',
    },
    {
      relPath: '01_CORE/DASHBOARDS/DASH-0001-OS3-Command-Center.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'core-dash-0001-command-center',
        type: 'entity',
        title: 'XYP3RN OS 3.0 Command Center Dashboard',
        domain: 'CORE',
        sector: '01_CORE',
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'dashboard'],
      },
      body: '# XYP3RN OS 3.0 Command Center\n\n- [[00_SYSTEM/SYSTEM_MANIFEST|System Manifest]]\n- [[00_SYSTEM/TAXONOMY|Domain & Sector Taxonomy]]\n- [[01_CORE/AGENT_REGISTRY/AGENT_REGISTRY|Agent Registry (80 Agents)]]\n- [[01_CORE/TOOL_REGISTRY/TOOL_REGISTRY|Tool Registry]]',
    },
    {
      relPath: '01_CORE/TASKS/TASK-0001-OS3-Vault-Foundation.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'core-task-0001-vault-foundation',
        type: 'entity',
        title: 'Phase 3: Obsidian Vault Foundation Verification',
        domain: 'CORE',
        sector: '01_CORE',
        status: 'approved',
        version: 1,
        tags: ['xyp3rn', 'os3', 'task'],
      },
      body: '# Task: Phase 3 Obsidian Vault Foundation\n\n- [x] 12 top-level directories + `_attachments/`\n- [x] 20 versioned schemas (`xyp3rn.*/v3`)\n- [x] 20 entity templates\n- [x] 80 agent definitions + 7 workflows',
    },
    {
      relPath: '02_KNOWLEDGE/FRAMEWORKS/FRMW-0001-X3LIUS-Mix-Rubric.md',
      fm: {
        schema: 'xyp3rn.knowledge/v3',
        id: 'frmw-0001-x3lius-mix-rubric',
        type: 'knowledge',
        title: 'X3LIUS Mix & Audio Evaluation Rubric',
        domain: 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'canonical',
        version: 1,
        promoted_via: 'gate',
        tags: ['xyp3rn', 'os3', 'framework', 'canonical'],
      },
      body: '# X3LIUS Mix & Audio Evaluation Rubric\n\nDefines target LUFS (`-14` to `-9` LUFS integrated), true-peak ceiling (`<= -1.0 dBTP`), and vocal intelligibility thresholds.',
    },
    {
      relPath: '02_KNOWLEDGE/GLOSSARY/GLOS-0001-OS3-Core-Glossary.md',
      fm: {
        schema: 'xyp3rn.knowledge/v3',
        id: 'glos-0001-os3-core-glossary',
        type: 'knowledge',
        title: 'XYP3RN OS 3.0 Core Glossary',
        domain: 'KNOWLEDGE',
        sector: '02_KNOWLEDGE',
        status: 'canonical',
        version: 1,
        promoted_via: 'gate',
        tags: ['xyp3rn', 'os3', 'glossary', 'canonical'],
      },
      body: '# XYP3RN OS 3.0 Core Glossary\n\n- **Promotion Gate:** Automated + human-approved pipeline required before writing to `02_KNOWLEDGE/CANONICAL/`.\n- **No-Overwrite Guard:** Rejects silent file clobbering without `allowOverwrite: true` and `.vault-revisions/` backup.',
    },
    {
      relPath: '03_RESEARCH_INTELLIGENCE/SPECIALISTS/SPEC-0001-Specialist-Index.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'spec-0001-specialist-index',
        type: 'entity',
        title: 'Research Intelligence — 11 Specialist Researchers Index',
        domain: 'RESEARCH_INTELLIGENCE',
        sector: '03_RESEARCH_INTELLIGENCE',
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'research-specialists'],
      },
      body: [
        '# Research Intelligence — 11 Specialist Researchers',
        '',
        '- [[04_AGENTS/suno-researcher|suno-researcher]]',
        '- [[04_AGENTS/lyric-structure-researcher|lyric-structure-researcher]]',
        '- [[04_AGENTS/genre-style-researcher|genre-style-researcher]]',
        '- [[04_AGENTS/vocal-arrangement-researcher|vocal-arrangement-researcher]]',
        '- [[04_AGENTS/production-sound-design-researcher|production-sound-design-researcher]]',
        '- [[04_AGENTS/hit-song-dissection-researcher|hit-song-dissection-researcher]]',
        '- [[04_AGENTS/ai-music-ecosystem-researcher|ai-music-ecosystem-researcher]]',
        '- [[04_AGENTS/prompt-craft-meta-researcher|prompt-craft-meta-researcher]]',
        '- [[04_AGENTS/cultural-linguistic-researcher|cultural-linguistic-researcher]]',
        '- [[04_AGENTS/Workflow-Agentic-Researcher|Workflow-Agentic-Researcher]]',
        '- [[04_AGENTS/Tech-AI-Dev-Researcher|Tech-AI-Dev-Researcher]]',
      ].join('\n'),
    },
    {
      relPath: '08_GOVERNANCE/STANDARDS/STD-0001-Single-Kernel-Invariants.md',
      fm: {
        schema: 'xyp3rn.policy/v3',
        id: 'std-0001-single-kernel-invariants',
        type: 'policy',
        title: 'Single-Kernel Architecture Invariants (F01-F36)',
        domain: 'GOVERNANCE',
        sector: '08_GOVERNANCE',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'governance', 'standards', 'canonical'],
      },
      body: '# Single-Kernel Architecture Invariants\n\nEnforces single-owner definitions for registries, capabilities, workflow compiler, orchestrator dispatch, and 6-domain boundaries.',
    },
    {
      relPath: '08_GOVERNANCE/ACCESS_CONTROL/ACL-0001-Agent-Capability-Matrix.md',
      fm: {
        schema: 'xyp3rn.policy/v3',
        id: 'acl-0001-agent-capability-matrix',
        type: 'policy',
        title: 'Agent Class Capability Authorization Matrix',
        domain: 'GOVERNANCE',
        sector: '08_GOVERNANCE',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'governance', 'access-control', 'canonical'],
      },
      body: '# Agent Class Capability Matrix\n\nDefines deny-by-default capabilities across `Research`, `Knowledge`, `Planning`, `Creative`, `Critic`, `Revision`, `Execution`, and `Governance` classes.',
    },
    {
      relPath: '06_RECORDS/DECISIONS/DEC-0001-No-Auto-Approval-F35-D2.md',
      fm: {
        schema: 'xyp3rn.decision-record/v3',
        id: 'dec-0001-no-auto-approval-f35-d2',
        decision_key: 'F35-D2',
        type: 'decision_record',
        title: 'Decision F35 D2: Permanent Disablement of Auto-Approval',
        domain: 'GOVERNANCE',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        decided_by: 'blago',
        tags: ['xyp3rn', 'os3', 'decision', 'governance'],
      },
      body: '# Decision F35 D2: No Auto-Approval\n\nEvery canonical promotion and rights-split change requires explicit human operator approval in `pending_approvals`.',
    },
    {
      relPath: '06_RECORDS/RELEASES/REL-0001-Night-Signals-EP.md',
      fm: {
        schema: 'xyp3rn.release/v3',
        id: 'rel-0001-night-signals-ep',
        type: 'release',
        title: 'Night Signals EP',
        domain: 'RECORDS',
        sector: '06_RECORDS',
        artist: 'X3LIUS',
        kind: 'ep',
        upc: '012345678905',
        status: 'draft',
        version: 1,
        release_date: '2026-12-01',
        tracks: ['[[06_RECORDS/TRACKS/TRK-0001-Neon-Static|Neon Static]]'],
        tags: ['xyp3rn', 'os3', 'release'],
      },
      body: '# Release: Night Signals EP\n\n- Lead Track: [[06_RECORDS/TRACKS/TRK-0001-Neon-Static|Neon Static]]\n- Splits: [[06_RECORDS/RIGHTS/SPLT-0001-Neon-Static-v1|SPLT-0001]]',
    },
    {
      relPath: '06_RECORDS/TRACKS/TRK-0001-Neon-Static.md',
      fm: {
        schema: 'xyp3rn.track/v3',
        id: 'trk-0001-neon-static',
        type: 'track',
        title: 'Neon Static',
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        position: 1,
        isrc: 'QZAB12600001',
        recording_kind: 'vault_audio',
        duration_seconds: 194,
        tags: ['xyp3rn', 'os3', 'track'],
      },
      body: '# Track: Neon Static\n\nLinked Song: [[09_X3LIUS_MUSIC/SONGS/SONG-0001-Neon-Static|SONG-0001-Neon-Static]].',
    },
    {
      relPath: '06_RECORDS/RIGHTS/SPLT-0001-Neon-Static-v1.md',
      fm: {
        schema: 'xyp3rn.rights-split/v3',
        id: 'splt-0001-neon-static-v1',
        type: 'rights_split',
        title: 'Rights Splits: Neon Static (v1)',
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'approved',
        version: 1,
        total_percentage: 100.0,
        has_unassigned_share: false,
        shares: [{ payee: 'X3LIUS', role: 'master_and_publishing', percentage: 100.0 }],
        tags: ['xyp3rn', 'os3', 'rights-split'],
      },
      body: '# Rights Splits: Neon Static (v1)\n\n- **X3LIUS:** 100.000% (Master & Publishing)\n- **Unassigned Share:** 0.000%',
    },
    {
      relPath: '07_TECH/TRACE/TECH-0001-TRACE-Audio-Analyzer.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'tech-0001-trace-audio-analyzer',
        type: 'entity',
        title: 'TRACE Audio Analysis Contract (trace.analysis/v1)',
        domain: 'TECH',
        sector: '07_TECH',
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'tech', 'trace'],
      },
      body: '# TRACE Audio Analyzer (`127.0.0.1:8787`)\n\nValidates 29 loudness (BS.1770/R128), 7-band tonal balance, stereo width/correlation, and crest factor metrics (`trace.analysis/v1` -> `trace.report/v1`).',
    },
    {
      relPath: '08_GOVERNANCE/POLICIES/POL-0001-Localhost-Binding-and-Path-Safety.md',
      fm: {
        schema: 'xyp3rn.policy/v3',
        id: 'pol-0001-localhost-binding-and-path-safety',
        type: 'policy',
        title: 'Localhost Binding & Vault Path Safety Policy',
        domain: 'GOVERNANCE',
        sector: '08_GOVERNANCE',
        status: 'canonical',
        version: 1,
        enforcement: 'mandatory',
        tags: ['xyp3rn', 'os3', 'governance', 'policy', 'canonical'],
      },
      body: '# Localhost Binding & Vault Path Safety Policy\n\n1. All local HTTP services bind strictly to `127.0.0.1`.\n2. All Vault operations reject traversal (`..`), absolute paths, and executable extensions.\n3. Canonical paths require Promotion Gate + human approval.',
    },
    {
      relPath: '08_GOVERNANCE/APPROVALS/APPR-0001-Example-Approved-Promotion.md',
      fm: {
        schema: 'xyp3rn.approval/v3',
        id: 'appr-0001-example-promotion',
        type: 'approval',
        title: 'Approval APPR-0001: Promote KNOW-0001 Suno v6 Gravity Escape Rule',
        domain: 'GOVERNANCE',
        sector: '08_GOVERNANCE',
        status: 'approved',
        version: 1,
        item_type: 'vault_promotion',
        item_id: 'know-0001-suno-v6-gravity-escape',
        proposer: 'research-orchestrator',
        approver: 'blago',
        reason: 'Verified across 10 controlled Suno v6 takes in EXPR-0001.',
        tags: ['xyp3rn', 'os3', 'approval', 'governance'],
      },
      body: '# Approval Record APPR-0001\n\nApproved promotion of [[02_KNOWLEDGE/CANONICAL/KNOW-0001-Suno-v6-Gravity-Escape|KNOW-0001]].',
    },
    {
      relPath: '09_X3LIUS_MUSIC/SONGS/SONG-0001-Neon-Static.md',
      fm: {
        schema: 'xyp3rn.song/v3',
        id: 'song-0001-neon-static',
        type: 'song',
        title: 'Neon Static',
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        artist: 'X3LIUS',
        language: 'en',
        genre: 'UK Drill / Dark Synthwave',
        bpm: 128,
        status: 'released',
        version: 1,
        revision: 1,
        tags: ['xyp3rn', 'os3', 'x3lius', 'song'],
      },
      body: '# Song: Neon Static\n\n- Lyrics: [[09_X3LIUS_MUSIC/LYRICS/LYR-0001-Neon-Static-v1|LYR-0001-Neon-Static-v1]]\n- Track: [[06_RECORDS/TRACKS/TRK-0001-Neon-Static|TRK-0001-Neon-Static]]',
    },
    {
      relPath: '09_X3LIUS_MUSIC/LYRICS/LYR-0001-Neon-Static-v1.md',
      fm: {
        schema: 'xyp3rn.lyric/v3',
        id: 'lyr-0001-neon-static-v1',
        lineage_id: 'lin-0001-neon-static',
        type: 'lyric',
        title: 'Neon Static (Lyrics v1)',
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        author: 'X3LIUS',
        language: 'en',
        genre: 'UK Drill',
        status: 'approved',
        version: 1,
        mixed_script_checked: true,
        tags: ['xyp3rn', 'os3', 'x3lius', 'lyrics'],
      },
      body: '# Neon Static\n\n## [VERSE 1]\n mercury rain on the overpass glass\n sub-bass glide when the patrol cars pass\n\n## [CHORUS]\n neon static in the midnight wire\n cold baritone over 808 fire',
    },
    {
      relPath: '10_INBOX/INBX-0001-Welcome-Inbox-Note.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'inbx-0001-welcome-inbox',
        type: 'entity',
        title: 'Inbox Staging Area',
        domain: 'CORE',
        sector: '10_INBOX',
        status: 'draft',
        version: 1,
        tags: ['xyp3rn', 'os3', 'inbox'],
      },
      body: '# 10_INBOX\n\nDrop uncategorized notes, voice transcripts, or rough lyric ideas here for staging.',
    },
    {
      relPath: '11_ARCHIVE/ARCH-0001-Archive-Index.md',
      fm: {
        schema: 'xyp3rn.entity/v3',
        id: 'arch-0001-archive-index',
        type: 'entity',
        title: 'Archive Index',
        domain: 'CORE',
        sector: '11_ARCHIVE',
        status: 'archived',
        version: 1,
        tags: ['xyp3rn', 'os3', 'archive'],
      },
      body: '# 11_ARCHIVE\n\nSuperseded and historical records are preserved here and never deleted.',
    },
  ];

  for (const ex of canonicalExamples) {
    trackWrite(
      await writeNoteWithFrontmatter(join(vaultRoot, ...ex.relPath.split('/')), ex.fm, ex.body),
    );
  }

  return {
    vaultRoot,
    createdDirs,
    writtenFiles,
    unchangedFiles,
  };
};

const SECRET_REGEXES: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'OpenRouter key (sk-or-v1-...)', re: /\bsk-or-v1-[a-f0-9]{32,}\b/i },
  { label: 'Anthropic key (sk-ant-...)', re: /\bsk-ant-[a-z0-9_-]{20,}\b/i },
  { label: 'Groq key (gsk_...)', re: /\bgsk_[a-z0-9]{20,}\b/i },
  { label: 'PEM Private Key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/**
 * Validates the OS 3.0 Obsidian Vault foundation:
 * 1. Every required directory exists.
 * 2. Every template has valid YAML.
 * 3. Every OS 3.0 entity has a unique ID.
 * 4. Every OS 3.0 document has a recognized schema.
 * 5. No secrets are stored in the Vault.
 * 6. .obsidian/ configuration files are valid JSON so the Vault opens as a normal Obsidian Vault.
 */
export const validateOs3Vault = async (vaultRootInput?: string): Promise<Os3VaultValidationReport> => {
  const vaultRoot = resolveConfiguredVaultPath(vaultRootInput);
  const missingDirs: string[] = [];

  for (const relDir of REQUIRED_OS3_VAULT_SUBDIRS) {
    const absDir = join(vaultRoot, ...relDir.split('/'));
    if (!(await exists(absDir))) {
      missingDirs.push(relDir);
    }
  }

  let obsidianConfigValid = true;
  for (const cfgName of ['app.json', 'appearance.json', 'templates.json', 'graph.json']) {
    const cfgAbs = join(vaultRoot, '.obsidian', cfgName);
    if (!(await exists(cfgAbs))) {
      obsidianConfigValid = false;
      continue;
    }
    try {
      JSON.parse(await readFile(cfgAbs, 'utf8'));
    } catch {
      obsidianConfigValid = false;
    }
  }

  const invalidYamlFiles: { readonly path: string; readonly error: string }[] = [];
  const missingIdFiles: string[] = [];
  const unrecognizedSchemaFiles: { readonly path: string; readonly schema: string }[] = [];
  const secretViolations: { readonly path: string; readonly match: string }[] = [];
  const idToPaths = new Map<string, string[]>();
  const recognizedSet = new Set<string>(RECOGNIZED_OS3_SCHEMAS);

  let checkedTemplates = 0;
  let checkedEntities = 0;

  const scanDir = async (dirAbs: string): Promise<void> => {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const d of entries) {
      if (d.name.startsWith('.')) continue;
      const abs = join(dirAbs, d.name);
      if (d.isDirectory()) {
        await scanDir(abs);
        continue;
      }
      if (!d.isFile() || !d.name.endsWith('.md')) continue;

      const rel = relative(vaultRoot, abs).split(sep).join('/');
      const raw = await readFile(abs, 'utf8');

      // Check for secrets across all scanned Markdown files
      for (const pat of SECRET_REGEXES) {
        if (pat.re.test(raw)) {
          secretViolations.push({ path: rel, match: pat.label });
        }
      }

      const parsed = parseObsidianNote(raw);
      if (rel.startsWith('00_SYSTEM/TEMPLATES/')) {
        checkedTemplates += 1;
      }
      if (parsed.frontmatterError) {
        invalidYamlFiles.push({ path: rel, error: parsed.frontmatterError });
        continue;
      }

      const topFolder = rel.split('/')[0] ?? '';
      const isOs3ManagedDir =
        rel === 'README.md' ||
        [
          '00_SYSTEM',
          '01_CORE',
          '02_KNOWLEDGE',
          '03_RESEARCH_INTELLIGENCE',
          '04_AGENTS',
          '05_WORKFLOWS',
          '06_RECORDS',
          '07_TECH',
          '08_GOVERNANCE',
          '09_X3LIUS_MUSIC',
          '10_INBOX',
          '11_ARCHIVE',
        ].includes(topFolder);

      // Validate OS 3.0 managed documents that carry a `schema` or sit in any OS 3.0 subtree
      const fmSchema = typeof parsed.frontmatter.schema === 'string' ? parsed.frontmatter.schema.trim() : '';
      const fmId =
        typeof parsed.frontmatter.id === 'string' || typeof parsed.frontmatter.id === 'number'
          ? String(parsed.frontmatter.id).trim()
          : '';

      const isOs3Subtree =
        topFolder === '00_SYSTEM' ||
        topFolder === '02_KNOWLEDGE' ||
        topFolder === '04_AGENTS' ||
        topFolder === '05_WORKFLOWS' ||
        topFolder === '06_RECORDS' ||
        topFolder === '07_TECH' ||
        topFolder === '08_GOVERNANCE' ||
        topFolder === '09_X3LIUS_MUSIC' ||
        topFolder === '10_INBOX' ||
        topFolder === '11_ARCHIVE' ||
        rel.startsWith('01_CORE/IDENTITY/') ||
        rel.startsWith('01_CORE/SYSTEM_PROMPTS/') ||
        rel.startsWith('01_CORE/AGENT_REGISTRY/') ||
        rel.startsWith('01_CORE/TOOL_REGISTRY/') ||
        rel.startsWith('01_CORE/DASHBOARDS/') ||
        rel.startsWith('01_CORE/TASKS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/PROJECTS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/QUESTIONS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/EVIDENCE/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/EXPERIMENTS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/RUNS/') ||
        rel.startsWith('03_RESEARCH_INTELLIGENCE/SPECIALISTS/') ||
        rel === 'README.md';

      if (fmSchema || isOs3Subtree) {
        if (!isOs3ManagedDir) continue;
        checkedEntities += 1;

        if (!fmId) {
          missingIdFiles.push(rel);
        } else {
          const list = idToPaths.get(fmId) ?? [];
          list.push(rel);
          idToPaths.set(fmId, list);
        }

        if (!recognizedSet.has(fmSchema)) {
          unrecognizedSchemaFiles.push({ path: rel, schema: fmSchema || '(missing)' });
        }
      }
    }
  };

  for (const topDir of [
    '00_SYSTEM',
    '01_CORE',
    '02_KNOWLEDGE',
    '03_RESEARCH_INTELLIGENCE',
    '04_AGENTS',
    '05_WORKFLOWS',
    '06_RECORDS',
    '07_TECH',
    '08_GOVERNANCE',
    '09_X3LIUS_MUSIC',
    '10_INBOX',
    '11_ARCHIVE',
  ]) {
    const abs = join(vaultRoot, topDir);
    if (await exists(abs)) {
      await scanDir(abs);
    }
  }

  const readmeAbs = join(vaultRoot, 'README.md');
  if (await exists(readmeAbs)) {
    const raw = await readFile(readmeAbs, 'utf8');
    const parsed = parseObsidianNote(raw);
    checkedEntities += 1;
    const fmId = typeof parsed.frontmatter.id === 'string' ? parsed.frontmatter.id.trim() : '';
    const fmSchema = typeof parsed.frontmatter.schema === 'string' ? parsed.frontmatter.schema.trim() : '';
    if (!fmId) missingIdFiles.push('README.md');
    else {
      const list = idToPaths.get(fmId) ?? [];
      list.push('README.md');
      idToPaths.set(fmId, list);
    }
    if (!recognizedSet.has(fmSchema)) {
      unrecognizedSchemaFiles.push({ path: 'README.md', schema: fmSchema || '(missing)' });
    }
  }

  const duplicateIds: { readonly id: string; readonly paths: readonly string[] }[] = [];
  for (const [id, paths] of idToPaths.entries()) {
    if (paths.length > 1) {
      duplicateIds.push({ id, paths });
    }
  }

  const ok =
    missingDirs.length === 0 &&
    checkedTemplates >= TEMPLATE_SPECS.length &&
    invalidYamlFiles.length === 0 &&
    missingIdFiles.length === 0 &&
    duplicateIds.length === 0 &&
    unrecognizedSchemaFiles.length === 0 &&
    secretViolations.length === 0 &&
    obsidianConfigValid;

  return {
    ok,
    vaultRoot,
    missingDirs,
    checkedTemplates,
    invalidYamlFiles,
    checkedEntities,
    missingIdFiles,
    duplicateIds,
    unrecognizedSchemaFiles,
    secretViolations,
    obsidianConfigValid,
  };
};
