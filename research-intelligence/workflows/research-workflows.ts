import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Os3Orchestrator, Os3AgentHandler } from '../../core/orchestrator/os3-orchestrator.ts';
import type { SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import type { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import type { Os3WorkflowDefinition, Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';
import type { TrialScorer } from '../experiments/engine.ts';
import type { DawResearchIntegrator, DawResearchIngestionInput } from '../daw-research-integration.ts';
import type { Os3ResearchEngine } from '../os3-research-engine.ts';
import type { DawResearchCategory, EvidenceAttributionTier } from '../os3-research-types.ts';
import type { ResearchSourceKind } from '../sources/verify.ts';

export type ResearchProductionWorkflowSpec = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly domain: 'RESEARCH_INTELLIGENCE' | 'TECH' | 'KNOWLEDGE';
  readonly description: string;
  readonly yaml: string;
};

/**
 * 10 canonical Phase 19 Research Intelligence workflows (`xyp3rn.workflow/v3`)
 * referencing strictly migrated active agents from `04_AGENTS/`.
 */
export const RESEARCH_PRODUCTION_WORKFLOWS: readonly ResearchProductionWorkflowSpec[] = [
  {
    id: 'wf-research-initiation',
    name: 'research-initiation',
    title: '1. Research Initiation Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Creates or resolves the research project, falsifiable question brief, and opens a tracked run.',
    yaml: `id: wf-research-initiation
version: 1
name: research-initiation
description: Initiates a canonical OS3 Research Project, Question Brief, and tracked Run.
input:
  required: [projectSlug, projectTitle, question, intendedUse]
  optional: [specialists, urls]
steps:
  - id: initiate
    agent: research-orchestrator
    input:
      action: initiate
      projectSlug:
        $from: input.projectSlug
      projectTitle:
        $from: input.projectTitle
      question:
        $from: input.question
      intendedUse:
        $from: input.intendedUse
      specialists:
        $from: input.specialists
      urls:
        $from: input.urls
output:
  project:
    $from: steps.initiate.output.project
  question:
    $from: steps.initiate.output.question
  run:
    $from: steps.initiate.output.run
`,
  },
  {
    id: 'wf-research-question-decomposition',
    name: 'research-question-decomposition',
    title: '2. Research Question Decomposition Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Decomposes a parent research question into sub-questions paired with scored specialist selections.',
    yaml: `id: wf-research-question-decomposition
version: 1
name: research-question-decomposition
description: Breaks complex research questions into falsifiable sub-questions and assigns scope-matched specialists.
input:
  required: [questionPathOrId, subQuestions]
  optional: []
steps:
  - id: decompose
    agent: research-orchestrator
    input:
      action: decompose
      questionPathOrId:
        $from: input.questionPathOrId
      subQuestions:
        $from: input.subQuestions
output:
  parentQuestionId:
    $from: steps.decompose.output.parentQuestionId
  subQuestions:
    $from: steps.decompose.output.subQuestions
`,
  },
  {
    id: 'wf-research-source-collection',
    name: 'research-source-collection',
    title: '3. Research Source Collection Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Normalizes URIs, classifies reliability via OS2 rubric, deduplicates by SHA-256, and registers Sources.',
    yaml: `id: wf-research-source-collection
version: 1
name: research-source-collection
description: Collects and deduplicates verified standard or DAW Brain research sources cleanly.
input:
  required: [kind, uri, title, sourceText]
  optional: [dawCategory, evidenceTier]
steps:
  - id: collect
    agent: frontier-tool-scanner-researcher
    input:
      action: collect_source
      kind:
        $from: input.kind
      uri:
        $from: input.uri
      title:
        $from: input.title
      sourceText:
        $from: input.sourceText
      dawCategory:
        $from: input.dawCategory
      evidenceTier:
        $from: input.evidenceTier
output:
  source:
    $from: steps.collect.output.source
`,
  },
  {
    id: 'wf-research-evidence-extraction',
    name: 'research-evidence-extraction',
    title: '4. Research Evidence Extraction Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Extracts verbatim-verified Evidence quotes cleanly separated from analyst interpretation & uncertainty.',
    yaml: `id: wf-research-evidence-extraction
version: 1
name: research-evidence-extraction
description: Records Evidence notes after strict verbatim quote verification against registered Source bytes.
input:
  required: [sourceRef, specialist, verbatimQuote, interpretation, claimTopic, claimValue, modelTag, confidence, confidenceInputs, uncertaintyNote]
  optional: [researchRunId, dawCategory, evidenceTier, hostInstalledVerified]
steps:
  - id: extract
    agent: suno-researcher
    input:
      action: extract_evidence
      sourceRef:
        $from: input.sourceRef
      specialist:
        $from: input.specialist
      verbatimQuote:
        $from: input.verbatimQuote
      interpretation:
        $from: input.interpretation
      claimTopic:
        $from: input.claimTopic
      claimValue:
        $from: input.claimValue
      modelTag:
        $from: input.modelTag
      confidence:
        $from: input.confidence
      confidenceInputs:
        $from: input.confidenceInputs
      uncertaintyNote:
        $from: input.uncertaintyNote
      researchRunId:
        $from: input.researchRunId
      dawCategory:
        $from: input.dawCategory
      evidenceTier:
        $from: input.evidenceTier
      hostInstalledVerified:
        $from: input.hostInstalledVerified
output:
  evidence:
    $from: steps.extract.output.evidence
`,
  },
  {
    id: 'wf-research-finding-creation',
    name: 'research-finding-creation',
    title: '5. Research Finding Creation Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Aggregates evidence into immutable, confidence-capped Finding notes and runs automatic conflict detection.',
    yaml: `id: wf-research-finding-creation
version: 1
name: research-finding-creation
description: Creates non-overwriting Findings with OS2 single-source confidence cap (0.75) and Contradiction checks.
input:
  required: [evidenceIds, claimTopic, claimValue, interpretation, uncertaintyNote, modelTag]
  optional: [researchRunId, dawCategory, evidenceTier]
steps:
  - id: create_finding
    agent: research-orchestrator
    input:
      action: create_finding
      evidenceIds:
        $from: input.evidenceIds
      claimTopic:
        $from: input.claimTopic
      claimValue:
        $from: input.claimValue
      interpretation:
        $from: input.interpretation
      uncertaintyNote:
        $from: input.uncertaintyNote
      modelTag:
        $from: input.modelTag
      researchRunId:
        $from: input.researchRunId
      dawCategory:
        $from: input.dawCategory
      evidenceTier:
        $from: input.evidenceTier
output:
  finding:
    $from: steps.create_finding.output.finding
`,
  },
  {
    id: 'wf-research-contradiction-detection',
    name: 'research-contradiction-detection',
    title: '6. Research Contradiction Detection Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Inspects open Contradictions for a Finding/topic and optionally resolves via controlled experiment.',
    yaml: `id: wf-research-contradiction-detection
version: 1
name: research-contradiction-detection
description: Audits topic and model-scope conflicts and enforces manual or experiment-backed resolution.
input:
  required: [findingPathOrId]
  optional: [resolveContradictionId, resolveMethod, resolveReason, experimentRef, actor]
steps:
  - id: detect_conflicts
    agent: negative-prompt-failure-mode-researcher
    input:
      action: detect_contradictions
      findingPathOrId:
        $from: input.findingPathOrId
      resolveContradictionId:
        $from: input.resolveContradictionId
      resolveMethod:
        $from: input.resolveMethod
      resolveReason:
        $from: input.resolveReason
      experimentRef:
        $from: input.experimentRef
      actor:
        $from: input.actor
output:
  findingId:
    $from: steps.detect_conflicts.output.findingId
  openContradictions:
    $from: steps.detect_conflicts.output.openContradictions
  resolvedContradiction:
    $from: steps.detect_conflicts.output.resolvedContradiction
`,
  },
  {
    id: 'wf-research-verification',
    name: 'research-verification',
    title: '7. Research Verification Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Re-verifies source checksums, verbatim quotes, confidence caps, open conflicts, and experiment validity.',
    yaml: `id: wf-research-verification
version: 1
name: research-verification
description: Audits citation integrity, verbatim quotes, source counts, and Critic experiment validation.
input:
  required: [findingPathOrId]
  optional: [experimentPathOrId]
steps:
  - id: verify
    agent: evaluation-researcher
    input:
      action: verify_finding
      findingPathOrId:
        $from: input.findingPathOrId
      experimentPathOrId:
        $from: input.experimentPathOrId
output:
  verification:
    $from: steps.verify.output.verification
`,
  },
  {
    id: 'wf-research-synthesis',
    name: 'research-synthesis',
    title: '8. Research Synthesis Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Deterministically groups un-synthesized Evidence of a Research Run into idempotent Findings.',
    yaml: `id: wf-research-synthesis
version: 1
name: research-synthesis
description: Synthesizes un-synthesized run Evidence grouped by (claim_topic, claim_value, model_tag).
input:
  required: [researchRunId]
  optional: []
steps:
  - id: synthesize
    agent: extractive-summarizer
    input:
      action: synthesize_run
      researchRunId:
        $from: input.researchRunId
output:
  synthesis:
    $from: steps.synthesize.output.synthesis
`,
  },
  {
    id: 'wf-research-brief-generation',
    name: 'research-brief-generation',
    title: '9. Research Brief Generation Workflow',
    domain: 'RESEARCH_INTELLIGENCE',
    description: 'Generates a structured Research Brief citing findings, verbatim quotes, uncertainties, and open conflicts.',
    yaml: `id: wf-research-brief-generation
version: 1
name: research-brief-generation
description: Compiles grounded Question Briefs in 03_RESEARCH_INTELLIGENCE/BRIEFS/ without blending inference with quotes.
input:
  required: [questionPathOrId]
  optional: [title, findingPathsOrIds]
steps:
  - id: generate_brief
    agent: research-orchestrator
    input:
      action: generate_brief
      questionPathOrId:
        $from: input.questionPathOrId
      title:
        $from: input.title
      findingPathsOrIds:
        $from: input.findingPathsOrIds
output:
  brief:
    $from: steps.generate_brief.output.brief
`,
  },
  {
    id: 'wf-research-human-review-promotion',
    name: 'research-human-review-promotion',
    title: '10. Research Human Review & Canonical Promotion Workflow',
    domain: 'KNOWLEDGE',
    description: 'Enforces contradiction-free verification, Tier-1 decision recording, human approval gate, and canonical promotion.',
    yaml: `id: wf-research-human-review-promotion
version: 1
name: research-human-review-promotion
description: Runs verification, Tier-1 Findings Library accept, approval gate, and Promotion Gate canonical write.
input:
  required: [findingPathOrId, targetSlug, canonicalTitle, humanApprover, decisionReason]
  optional: [approvalId]
steps:
  - id: verify_before_gate
    agent: evaluation-researcher
    input:
      action: verify_finding
      findingPathOrId:
        $from: input.findingPathOrId
  - id: tier1_accept
    agent: vault-curator
    dependsOn: [verify_before_gate]
    input:
      action: tier1_decision
      findingPathOrId:
        $from: input.findingPathOrId
      decision: accept
      approver:
        $from: input.humanApprover
      reason:
        $from: input.decisionReason
  - id: human_promote
    agent: vault-curator
    dependsOn: [tier1_accept]
    approvalGate:
      itemType: knowledge_candidate
      reason: Canonical promotion requires explicit human approval and zero open contradictions
    input:
      action: promote_canonical
      findingPathOrId:
        $from: input.findingPathOrId
      targetSlug:
        $from: input.targetSlug
      canonicalTitle:
        $from: input.canonicalTitle
      humanApprover:
        $from: input.humanApprover
      approvalId:
        $from: input.approvalId
output:
  verification:
    $from: steps.verify_before_gate.output.verification
  tier1Decision:
    $from: steps.tier1_accept.output.tier1Decision
  promoted:
    $from: steps.human_promote.output.promoted
`,
  },
];

const extractStepIds = (yamlBody: string): readonly string[] =>
  [...yamlBody.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)].map((m) => m[1]!).filter(Boolean);

export const renderResearchWorkflowMarkdown = (spec: ResearchProductionWorkflowSpec): string => {
  const stepIds = extractStepIds(spec.yaml);
  return [
    '---',
    'schema: xyp3rn.workflow/v3',
    `id: ${spec.id}`,
    `name: ${spec.name}`,
    `title: "${spec.title}"`,
    `domain: ${spec.domain}`,
    'sector: 05_WORKFLOWS',
    'status: active',
    'version: 1',
    'steps:',
    ...stepIds.map((s) => `  - ${s}`),
    'tags:',
    '  - xyp3rn',
    '  - os3',
    '  - research-intelligence',
    '  - workflow',
    '---',
    '',
    `# ${spec.title}`,
    '',
    spec.description,
    '',
    '```yaml',
    spec.yaml.trimEnd(),
    '```',
    '',
  ].join('\n');
};

export const writeResearchWorkflowDefinitionsToDir = (targetDir: string): readonly string[] => {
  mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];
  for (const spec of RESEARCH_PRODUCTION_WORKFLOWS) {
    const filePath = join(targetDir, `${spec.name}.md`);
    writeFileSync(filePath, renderResearchWorkflowMarkdown(spec), 'utf8');
    written.push(filePath);
  }
  return written;
};

export const loadResearchWorkflowsFromVault = async (
  vault: VaultEngine,
  workflowEngine: Os3WorkflowEngine,
  vaultSubdir = '05_WORKFLOWS/RESEARCH',
): Promise<readonly Os3WorkflowDefinition[]> => {
  const loaded: Os3WorkflowDefinition[] = [];
  for (const spec of RESEARCH_PRODUCTION_WORKFLOWS) {
    const wf = await workflowEngine.loadFromVault(vault, `${vaultSubdir}/${spec.name}.md`);
    loaded.push(wf);
  }
  return loaded;
};

/**
 * Registers deterministic Research Intelligence handlers on `Os3Orchestrator` so every
 * workflow in `RESEARCH_PRODUCTION_WORKFLOWS` (including DAW Brain research ingestion)
 * executes end-to-end against real VaultEngine + SQLite + Os3ResearchEngine state.
 */
export const registerResearchWorkflowHandlers = (
  orchestrator: Os3Orchestrator,
  deps: {
    readonly research: Os3ResearchEngine;
    readonly db: SqliteRuntimeDb;
    readonly dawIntegrator?: DawResearchIntegrator | undefined;
    readonly scorer?: TrialScorer | undefined;
  },
): void => {
  const { research, db } = deps;

  const orchHandler: Os3AgentHandler = async (_ctx, input) => {
    const action = String(input.action ?? 'initiate');
    if (action === 'initiate') {
      const proj = await research.createProject({
        slug: String(input.projectSlug),
        title: String(input.projectTitle),
      });
      const question = await research.createQuestion({
        projectSlug: proj.slug,
        question: String(input.question),
        intendedUse: String(input.intendedUse),
        specialists: Array.isArray(input.specialists) ? input.specialists.map(String) : undefined,
        urls: Array.isArray(input.urls) ? input.urls.map(String) : undefined,
      });
      const run = await research.openResearchRun({
        questionPathOrId: question.vaultPath,
        selectedSpecialists: Array.isArray(input.specialists) ? input.specialists.map(String) : undefined,
      });
      return { output: { project: proj, question, run } };
    }
    if (action === 'decompose') {
      const res = await research.decomposeQuestion({
        questionPathOrId: String(input.questionPathOrId),
        subQuestions: input.subQuestions as ReadonlyArray<{
          readonly question: string;
          readonly intendedUse?: string;
          readonly specialists?: readonly string[];
        }>,
      });
      return { output: res };
    }
    if (action === 'create_finding') {
      const finding = await research.recordFinding({
        evidenceIds: (input.evidenceIds as readonly unknown[]).map(String),
        claimTopic: String(input.claimTopic),
        claimValue: input.claimValue,
        interpretation: String(input.interpretation),
        uncertaintyNote: String(input.uncertaintyNote),
        modelTag: String(input.modelTag),
        researchRunId: typeof input.researchRunId === 'string' ? input.researchRunId : undefined,
        dawCategory: typeof input.dawCategory === 'string' ? (input.dawCategory as DawResearchCategory) : undefined,
        evidenceTier: typeof input.evidenceTier === 'string' ? (input.evidenceTier as EvidenceAttributionTier) : undefined,
      });
      return { output: { finding } };
    }
    if (action === 'generate_brief') {
      const brief = await research.generateBrief({
        questionPathOrId: String(input.questionPathOrId),
        title: typeof input.title === 'string' ? input.title : undefined,
        findingPathsOrIds: Array.isArray(input.findingPathsOrIds)
          ? input.findingPathsOrIds.map(String)
          : undefined,
      });
      return { output: { brief } };
    }
    throw new Error(`Unsupported research-orchestrator workflow action "${action}"`);
  };

  orchestrator.registerHandler('research-orchestrator', orchHandler);

  orchestrator.registerHandler('frontier-tool-scanner-researcher', async (_ctx, input) => {
    if (input.action === 'ingest_daw_research' && deps.dawIntegrator) {
      const ingested = await deps.dawIntegrator.ingestDawResearch(input as unknown as DawResearchIngestionInput);
      return { output: { ingested } };
    }
    const source = await research.registerSource({
      kind: String(input.kind) as ResearchSourceKind,
      uri: String(input.uri),
      title: String(input.title),
      sourceText: String(input.sourceText),
      dawCategory: typeof input.dawCategory === 'string' ? (input.dawCategory as DawResearchCategory) : undefined,
      evidenceTier: typeof input.evidenceTier === 'string' ? (input.evidenceTier as EvidenceAttributionTier) : undefined,
    });
    return { output: { source } };
  });

  orchestrator.registerHandler('suno-researcher', async (_ctx, input) => {
    const evidence = await research.recordEvidence({
      sourceRef: String(input.sourceRef),
      specialist: String(input.specialist ?? 'suno-researcher'),
      verbatimQuote: String(input.verbatimQuote),
      interpretation: String(input.interpretation),
      claimTopic: String(input.claimTopic),
      claimValue: input.claimValue,
      modelTag: String(input.modelTag),
      confidence: Number(input.confidence),
      confidenceInputs: (input.confidenceInputs as Record<string, unknown>) ?? {},
      uncertaintyNote: String(input.uncertaintyNote),
      researchRunId: typeof input.researchRunId === 'string' ? input.researchRunId : undefined,
      dawCategory: typeof input.dawCategory === 'string' ? (input.dawCategory as DawResearchCategory) : undefined,
      evidenceTier: typeof input.evidenceTier === 'string' ? (input.evidenceTier as EvidenceAttributionTier) : undefined,
      hostInstalledVerified:
        typeof input.hostInstalledVerified === 'boolean' ? input.hostInstalledVerified : undefined,
    });
    return { output: { evidence } };
  });

  orchestrator.registerHandler('negative-prompt-failure-mode-researcher', async (_ctx, input) => {
    const targetRef = String(input.findingPathOrId);
    const findingIdMatch = db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .find(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/') &&
          (e.vaultPath === targetRef || e.frontmatter.id === targetRef),
      );
    const findingId = String(findingIdMatch?.frontmatter.id ?? targetRef);

    let resolvedContradiction: unknown = null;
    if (typeof input.resolveContradictionId === 'string' && input.resolveContradictionId.trim()) {
      resolvedContradiction = await research.resolveContradiction({
        contradictionPathOrId: input.resolveContradictionId,
        method: input.resolveMethod === 'experiment' ? 'experiment' : 'manual',
        reason: String(input.resolveReason ?? 'Resolved in research verification workflow'),
        experimentRef: typeof input.experimentRef === 'string' ? input.experimentRef : undefined,
        actor: String(input.actor ?? 'blago'),
      });
    }

    const openContradictions = db
      .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/CONTRADICTIONS/') &&
          e.frontmatter.status === 'open' &&
          (e.frontmatter.finding_id === findingId || e.frontmatter.target_path === findingIdMatch?.vaultPath),
      )
      .map((e) => ({ id: e.frontmatter.id, vaultPath: e.vaultPath, claimTopic: e.frontmatter.claim_topic }));

    return { output: { findingId, openContradictions, resolvedContradiction } };
  });

  orchestrator.registerHandler('evaluation-researcher', async (_ctx, input) => {
    const verification = await research.verifyFinding(
      String(input.findingPathOrId),
      typeof input.experimentPathOrId === 'string' ? input.experimentPathOrId : undefined,
    );
    return { output: { verification } };
  });

  orchestrator.registerHandler('extractive-summarizer', async (_ctx, input) => {
    const synthesis = await research.synthesizeRun(String(input.researchRunId));
    return { output: { synthesis } };
  });

  orchestrator.registerHandler('vault-curator', async (_ctx, input) => {
    const action = String(input.action ?? '');
    if (action === 'tier1_decision') {
      const fId = String(input.findingPathOrId);
      const existing = db
        .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
        .find(
          (e) =>
            e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/') &&
            (e.vaultPath === fId || e.frontmatter.id === fId),
        );
      if (existing?.frontmatter.owner_decision === 'accepted') {
        return {
          output: {
            tier1Decision: {
              findingId: String(existing.frontmatter.id),
              decision: 'accept',
              alreadyDecided: true,
            },
          },
        };
      }
      const tier1Decision = await research.recordFindingDecision({
        findingPathOrId: fId,
        decision: input.decision === 'reject' ? 'reject' : 'accept',
        approver: String(input.approver),
        reason: String(input.reason),
      });
      return { output: { tier1Decision } };
    }
    if (action === 'promote_canonical') {
      const findingRef = String(input.findingPathOrId);
      const fEntry = db
        .listIndexEntries('03_RESEARCH_INTELLIGENCE', 5_000)
        .find(
          (e) =>
            e.vaultPath.startsWith('03_RESEARCH_INTELLIGENCE/FINDINGS/') &&
            (e.vaultPath === findingRef || e.frontmatter.id === findingRef),
        );
      const findingId = String(fEntry?.frontmatter.id ?? findingRef);

      let approvalId = typeof input.approvalId === 'string' ? input.approvalId.trim() : '';
      if (!approvalId) {
        const latestApproved = [...db.listApprovals('approved')]
          .reverse()
          .find(
            (a) =>
              a.itemType === 'knowledge_candidate' &&
              a.itemId.startsWith('research-human-review-promotion:') &&
              a.approver,
          );
        if (latestApproved) {
          approvalId = latestApproved.id;
        }
      }
      if (!approvalId) {
        throw new Error(
          `Canonical promotion rejected: human approvalId is required for finding "${findingId}"`,
        );
      }

      const promoted = await research.promoteFindingToCanonical({
        findingPathOrId: findingId,
        approvalId,
        targetSlug: String(input.targetSlug),
        title: String(input.canonicalTitle),
      });
      return { output: { promoted } };
    }
    throw new Error(`Unsupported vault-curator action "${action}"`);
  });
};
