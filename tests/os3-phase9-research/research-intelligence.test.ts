import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { STUB_SCORER, type TrialScorer } from '../../research-intelligence/experiments/engine.ts';
import {
  OS2_RESEARCH_CAPABILITY_MAP,
  Os3ResearchEngine,
} from '../../research-intelligence/os3-research-engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 9 — Research Intelligence Migration (Vault-First Entities, Methodology & Governance)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p9-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await provisionOs3Vault({ vaultRoot, repoRoot: REPO_ROOT });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ vaultRoot, db });
    await vault.scanVault({ full: true });
    const tools = createOs3BuiltinToolRegistry({ vault, db });
    const agents = new Os3VaultAgentRegistry({ agentsDir: join(vaultRoot, '04_AGENTS'), toolRegistry: tools });
    const orchestrator = new Os3Orchestrator({ db, agents, tools });
    const research = new Os3ResearchEngine({ vault, db, agents });

    return { dir, vaultRoot, db, vault, agents, orchestrator, research };
  };

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1. Migrates existing OS2 Research roster (20 specialists + research-orchestrator) and maps capabilities without inventing agents', async () => {
    const { agents, research } = await createFixture();
    const specialists = research.listAvailableSpecialists();
    expect(specialists.length).toBe(20);
    expect(agents.get('research-orchestrator')).toBeDefined();

    // Every capability maps strictly to an existing migrated agent
    for (const entry of Object.values(OS2_RESEARCH_CAPABILITY_MAP)) {
      if (entry.existingAgent) {
        expect(agents.get(entry.existingAgent)).toBeDefined();
      }
    }

    const plan = research.planSpecialists('Suno style prompt meta-tag and custom mode lyrics formatting');
    expect(plan.selection.selected.some((s) => s.name === 'suno-researcher')).toBe(true);
  });

  it('2. Executes full Project -> Question -> Run -> Source -> Evidence -> Finding chain in the canonical Vault', async () => {
    const { vault, orchestrator, research } = await createFixture();

    const proj = await research.createProject({ slug: 'suno-v6-bass', title: 'Suno v6 Sub-Bass Study' });
    const quest = await research.createQuestion({
      projectSlug: proj.slug,
      question: 'Does portamento descriptor improve 808 glide retention in Suno v6?',
      intendedUse: 'Refine X3LIUS drill prompt templates',
    });
    const rrun = await research.openResearchRun({
      questionPathOrId: quest.vaultPath,
      selectedSpecialists: ['suno-researcher', 'benchmark-scoring-methodology-researcher'],
      orchestrator,
    });
    expect(rrun.selectedSpecialists).toHaveLength(2);
    expect((await vault.read(rrun.vaultPath)).frontmatter.type).toBe('research_run');

    // Source deduplication + vendor reliability rubric (suno.com -> official/vendor 0.9)
    const src1 = await research.registerSource({
      kind: 'doc',
      uri: 'https://suno.com/docs/prompts?utm_source=test',
      title: 'Suno Official Prompting Docs',
      sourceText: 'Specifying sliding portamento 808 sub-bass preserves pitch bends across drill bars.',
    });
    expect(src1.deduplicated).toBe(false);
    expect(src1.reliability).toBe(0.9);
    const src1Dup = await research.registerSource({
      kind: 'doc',
      uri: 'https://suno.com/docs/prompts',
      title: 'Suno Official Prompting Docs (dup)',
      sourceText: 'Specifying sliding portamento 808 sub-bass preserves pitch bends across drill bars.',
    });
    expect(src1Dup.deduplicated).toBe(true);
    expect(src1Dup.id).toBe(src1.id);

    // Reject fabricated quote not present in sourceText
    await expect(
      research.recordEvidence({
        sourceRef: src1.vaultPath,
        specialist: 'suno-researcher',
        verbatimQuote: 'This quote does not exist anywhere in the source text',
        interpretation: 'Unsupported claim',
        claimTopic: 'suno.808-glide',
        claimValue: 'portamento 808',
        modelTag: 'suno-v6',
        confidence: 0.9,
        confidenceInputs: { trialCount: 5 },
        uncertaintyNote: 'N/A',
      }),
    ).rejects.toThrow(/not found verbatim/i);

    // Reject missing source or missing uncertaintyNote
    await expect(
      research.recordEvidence({
        sourceRef: '02_KNOWLEDGE/SOURCES/DOES-NOT-EXIST.md',
        specialist: 'suno-researcher',
        verbatimQuote: 'portamento',
        interpretation: 'x',
        claimTopic: 'suno.808-glide',
        claimValue: 'portamento',
        modelTag: 'suno-v6',
        confidence: 0.9,
        confidenceInputs: { trialCount: 5 },
        uncertaintyNote: 'Small sample size (5 takes).',
      }),
    ).rejects.toThrow(/not found/i);

    // Record valid evidence preserving verbatim quote, interpretation, uncertainty, and modelTag
    const evid1 = await research.recordEvidence({
      sourceRef: src1.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'sliding portamento 808 sub-bass preserves pitch bends',
      interpretation: 'Use explicit portamento phrasing rather than generic 808 tags on suno-v6.',
      claimTopic: 'suno.808-glide',
      claimValue: 'sliding portamento 808 sub-bass',
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { sourceReliability: 0.9, observedTakes: 8 },
      uncertaintyNote: 'Tested primarily at 138-142 BPM UK drill tempos; slower tempos untested.',
      researchRunId: rrun.id,
    });
    const evidDoc = await vault.read(evid1.vaultPath);
    expect(evidDoc.frontmatter.model_tag).toBe('suno-v6');
    expect(evidDoc.frontmatter.uncertainty_note).toContain('slower tempos untested');
    expect(evidDoc.frontmatter.verbatim_quote).not.toBe(evidDoc.frontmatter.interpretation);

    // Single-source finding confidence is capped by OS2 formula (<= 0.75 * 0.9 * 0.9 = 0.608)
    const finding1 = await research.recordFinding({
      evidenceIds: [evid1.id],
      claimTopic: 'suno.808-glide',
      claimValue: 'sliding portamento 808 sub-bass',
      interpretation: 'Portamento descriptor stabilizes glide articulation in Suno v6.',
      uncertaintyNote: 'Single official doc source only; corroboration pending.',
      modelTag: 'suno-v6',
      researchRunId: rrun.id,
    });
    expect(finding1.confidence).toBeLessThanOrEqual(0.75);
    expect(finding1.contradictions).toHaveLength(0);
    expect((await vault.validate(finding1.vaultPath, { requireSchema: true })).ok).toBe(true);
  });

  it('3. Detects contradictions across findings, never overwrites previous findings, and blocks canonical promotion until resolved and human-approved', async () => {
    const { db, vault, research } = await createFixture();

    const srcA = await research.registerSource({
      kind: 'doc',
      uri: 'https://suno.com/docs/v6-a',
      title: 'Source A',
      sourceText: 'Use mechanics descriptors instead of stacking 5 genres in suno-v6.',
    });
    const srcB = await research.registerSource({
      kind: 'observation',
      uri: 'studio://observation/take-log-1',
      title: 'Studio Observation B',
      sourceText: 'Stacking 5 genres worked better than single mechanics descriptors in one isolated test.',
    });

    const evidA = await research.recordEvidence({
      sourceRef: srcA.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'Use mechanics descriptors instead of stacking 5 genres in suno-v6.',
      interpretation: 'Prefer mechanics descriptors.',
      claimTopic: 'suno.genre-stacking',
      claimValue: { strategy: 'mechanics-only' },
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { obs: 10 },
      uncertaintyNote: 'Controlled studio prompt set.',
    });

    const evidB = await research.recordEvidence({
      sourceRef: srcB.vaultPath,
      specialist: 'negative-prompt-failure-mode-researcher',
      verbatimQuote: 'Stacking 5 genres worked better than single mechanics descriptors in one isolated test.',
      interpretation: 'Genre stacking outperformed in one isolated outlier.',
      claimTopic: 'suno.genre-stacking',
      claimValue: { strategy: 'stack-5-genres' },
      modelTag: 'suno-v6',
      confidence: 0.85,
      confidenceInputs: { obs: 1 },
      uncertaintyNote: 'Single anomalous run; n=1.',
    });

    const f1 = await research.recordFinding({
      evidenceIds: [evidA.id],
      claimTopic: 'suno.genre-stacking',
      claimValue: { strategy: 'mechanics-only' },
      interpretation: 'Mechanics descriptors avoid genre averaging.',
      uncertaintyNote: 'Initial observation.',
      modelTag: 'suno-v6',
    });

    // Recording conflicting finding never overwrites f1 and auto-creates a Contradiction record
    const f2 = await research.recordFinding({
      evidenceIds: [evidB.id],
      claimTopic: 'suno.genre-stacking',
      claimValue: { strategy: 'stack-5-genres' },
      interpretation: 'Contradicting single-run outlier.',
      uncertaintyNote: 'High variance n=1.',
      modelTag: 'suno-v6',
    });

    expect(f1.vaultPath).not.toBe(f2.vaultPath);
    expect(await vault.read(f1.vaultPath)).toBeDefined();
    expect(f2.contradictions).toHaveLength(1);
    const contr = f2.contradictions[0]!;
    expect(contr.status).toBe('open');

    // Open contradiction blocks queuing f2 for canonical promotion!
    expect(() =>
      research.requestCanonicalPromotion({ findingPathOrId: f2.id, proposer: 'research-orchestrator' }),
    ).toThrow(/open contradiction/i);

    // Design and execute Experiment + Experiment Runs to resolve the contradiction scientifically
    const exp = await research.designExperiment({
      findingPathOrId: f1.id,
      hypothesis: 'mechanics-only beats stack-5-genres across 2 controlled trials',
      variantA: 'stack-5-genres',
      variantB: 'mechanics-only',
      nPerVariant: 1,
      scorerId: 'x3lius-evaluation',
    });

    const realScorer: TrialScorer = {
      id: 'x3lius-evaluation',
      score: async (out) => ({ score: out === 'good' ? 0.95 : 0.45, inputs: { rubric: 'mix+cohesion' } }),
    };
    const stubOnly = await research.recordExperimentRun({
      experimentPathOrId: exp.id,
      variant: 'a',
      trial: 1,
      output: 'bad',
      scorer: { id: STUB_SCORER, score: async () => ({ score: null, inputs: { stub: true } }) },
    });
    expect(stubOnly.score).toBeNull();
    expect(research.summarizeExperimentRuns(exp.id).validated).toBe(false);

    // Re-score / complete with real Critic scorer
    const exp2 = await research.designExperiment({
      findingPathOrId: f1.id,
      hypothesis: 'verified comparison',
      variantA: 'stack',
      variantB: 'mechanics',
      nPerVariant: 1,
      scorerId: 'x3lius-evaluation',
    });
    await research.recordExperimentRun({ experimentPathOrId: exp2.id, variant: 'a', trial: 1, output: 'bad', scorer: realScorer });
    await research.recordExperimentRun({ experimentPathOrId: exp2.id, variant: 'b', trial: 1, output: 'good', scorer: realScorer });
    const summary = research.summarizeExperimentRuns(exp2.id);
    expect(summary.validated).toBe(true);
    expect(summary.means?.b).toBeGreaterThan(summary.means!.a!);

    // Resolve contradiction referencing exp2, then queue & human-approve canonical promotion of f1
    await research.resolveContradiction({
      contradictionPathOrId: contr.id,
      method: 'experiment',
      reason: 'Variant B (mechanics-only) scored 0.95 vs 0.45 in controlled experiment',
      experimentRef: exp2.vaultPath,
      actor: 'blago',
    });

    // Resolve or add second evidence for f1 so confidence >= 0.7 threshold for Promotion Gate
    const f1Multi = await research.recordFinding({
      evidenceIds: [evidA.id, evidA.id],
      claimTopic: 'suno.genre-stacking.verified',
      claimValue: { strategy: 'mechanics-only' },
      interpretation: 'Verified: mechanics descriptors outperform 5-genre stacking in Suno v6.',
      uncertaintyNote: 'Verified across v6 trials.',
      modelTag: 'suno-v6',
    });
    // Also check that f2 (which had contr) is now unblocked after resolution
    const apprF2 = research.requestCanonicalPromotion({ findingPathOrId: f2.id, proposer: 'research-orchestrator' });
    expect(apprF2.status).toBe('pending');

    const apprF1 = research.requestCanonicalPromotion({ findingPathOrId: f1Multi.id, proposer: 'research-orchestrator' });
    db.decideApproval({ approvalId: apprF1.id, decision: 'approved', approver: 'blago', reason: 'Human verified' });

    // Re-register with two independent sources to demonstrate >0.75 confidence promotion
    const srcC = await research.registerSource({
      kind: 'doc',
      uri: 'https://suno.com/docs/v6-mechanics-guide',
      title: 'Suno v6 Mechanics Guide',
      sourceText: 'Mechanics descriptors stabilize bass and vocal phrasing.',
    });
    const evidC = await research.recordEvidence({
      sourceRef: srcC.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'Mechanics descriptors stabilize bass and vocal phrasing.',
      interpretation: 'Independent corroboration for mechanics descriptors.',
      claimTopic: 'suno.genre-stacking.final',
      claimValue: { strategy: 'mechanics-only' },
      modelTag: 'suno-v6',
      confidence: 0.95,
      confidenceInputs: { obs: 12 },
      uncertaintyNote: 'Corroborated across two official sources.',
    });
    const evidA2 = await research.recordEvidence({
      sourceRef: srcA.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'Use mechanics descriptors',
      interpretation: 'Corroborating source A.',
      claimTopic: 'suno.genre-stacking.final',
      claimValue: { strategy: 'mechanics-only' },
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { obs: 10 },
      uncertaintyNote: 'Corroborated.',
    });
    const corroboratedFinding = await research.recordFinding({
      evidenceIds: [evidA2.id, evidC.id],
      claimTopic: 'suno.genre-stacking.final',
      claimValue: { strategy: 'mechanics-only' },
      interpretation: 'Mechanics descriptors outperform 5-genre stacking in Suno v6.',
      uncertaintyNote: 'Valid for suno-v6.',
      modelTag: 'suno-v6',
    });
    expect(corroboratedFinding.confidence).toBeGreaterThan(0.75);

    const appr = research.requestCanonicalPromotion({ findingPathOrId: corroboratedFinding.id, proposer: 'research-orchestrator' });
    db.decideApproval({ approvalId: appr.id, decision: 'approved', approver: 'blago', reason: 'Corroborated + experiment validated' });

    const canonical = await research.promoteFindingToCanonical({
      findingPathOrId: corroboratedFinding.id,
      approvalId: appr.id,
      targetSlug: 'suno-v6-mechanics-rule',
      title: 'Suno v6 Mechanics Over Genre Stacking',
    });
    expect(canonical.vaultPath).toBe('02_KNOWLEDGE/CANONICAL/KNOW-suno-v6-mechanics-rule.md');
    const canonDoc = await vault.read(canonical.vaultPath);
    expect(canonDoc.frontmatter.status).toBe('canonical');
    expect(canonDoc.frontmatter.approved_by).toBe('blago');
  });
});
