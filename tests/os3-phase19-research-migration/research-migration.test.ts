import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3VaultAgentRegistry } from '../../core/agent-registry/os3-agent-registry.ts';
import { Os3Orchestrator } from '../../core/orchestrator/os3-orchestrator.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { createOs3BuiltinToolRegistry } from '../../core/tool-registry/os3-tool-registry.ts';
import { provisionOs3Vault } from '../../core/vault-engine/vault-foundation.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { Os3WorkflowEngine } from '../../core/workflow-engine/os3-workflow-engine.ts';
import {
  createVaultTargetChecker,
  DawResearchIntegrator,
  formatResearchMigrationReportMarkdown,
  loadResearchWorkflowsFromVault,
  migrateOs2ResearchToOs3,
  Os3ResearchEngine,
  registerResearchWorkflowHandlers,
  RESEARCH_PRODUCTION_WORKFLOWS,
  validateResearchVaultDocument,
  verifyResearchMigrationParity,
  writeResearchWorkflowDefinitionsToDir,
  type Os2ResearchExportPayload,
} from '../../research-intelligence/index.ts';
import type { TrialScorer } from '../../research-intelligence/experiments/engine.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('Phase 19 — Research Intelligence Migration (Schemas, 10 Workflows, DAW Brain Integration & Idempotent OS2 Parity)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  const createFixture = async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'xyp3rn-os3-p19-'));
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
    const dawIntegrator = new DawResearchIntegrator({ vault, research });
    const workflows = new Os3WorkflowEngine({
      definitionsDir: join(vaultRoot, '05_WORKFLOWS', 'DEFINITIONS'),
      db,
      agents,
      tools,
      orchestrator,
    });

    return { dir, vaultRoot, db, vault, tools, agents, orchestrator, research, dawIntegrator, workflows };
  };

  afterEach(async () => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('1. compiles and executes all 10 canonical Research workflows end-to-end with human approval gate enforcement', async () => {
    const { vaultRoot, db, vault, orchestrator, research, dawIntegrator, workflows } = await createFixture();

    const researchWfDir = join(vaultRoot, '05_WORKFLOWS', 'RESEARCH');
    const writtenPaths = writeResearchWorkflowDefinitionsToDir(researchWfDir);
    expect(RESEARCH_PRODUCTION_WORKFLOWS).toHaveLength(10);
    expect(writtenPaths).toHaveLength(10);

    await vault.scanVault({ full: true });
    for (const spec of RESEARCH_PRODUCTION_WORKFLOWS) {
      const val = await vault.validate(`05_WORKFLOWS/RESEARCH/${spec.name}.md`, { requireSchema: true });
      expect(val.ok, `${spec.name}: ${JSON.stringify(val.issues)}`).toBe(true);
    }

    const loaded = await loadResearchWorkflowsFromVault(vault, workflows, '05_WORKFLOWS/RESEARCH');
    expect(loaded).toHaveLength(10);

    registerResearchWorkflowHandlers(orchestrator, { research, db, dawIntegrator });

    // 1. Research initiation
    const initExec = await workflows.execute('research-initiation', {
      projectSlug: 'suno-v6-vocal-glide',
      projectTitle: 'Suno v6 Vocal & 808 Glide Research',
      question: 'Does explicit portamento wording improve 808 glide articulation in Suno v6?',
      intendedUse: 'Update X3LIUS drill templates after human review',
      specialists: ['suno-researcher'],
    });
    expect(initExec.status).toBe('success');
    const initOut = initExec.output as {
      readonly question: { readonly id: string; readonly vaultPath: string };
      readonly run: { readonly id: string; readonly vaultPath: string };
    };

    // 2. Question decomposition
    const decExec = await workflows.execute('research-question-decomposition', {
      questionPathOrId: initOut.question.vaultPath,
      subQuestions: [
        { question: 'How does Suno v6 handle custom mode portamento tags?' },
        { question: 'Do genre stacking limits conflict with v4.5 baselines?' },
      ],
    });
    expect(decExec.status).toBe('success');
    const decOut = decExec.output as { readonly subQuestions: readonly unknown[] };
    expect(decOut.subQuestions).toHaveLength(2);

    // 3. Source collection (2 independent sources for multi-source corroboration)
    const srcAExec = await workflows.execute('research-source-collection', {
      kind: 'doc',
      uri: 'https://suno.com/docs/v6-portamento',
      title: 'Suno v6 Portamento Docs',
      sourceText: 'Portamento 808 sub-bass cues preserve smooth pitch slides across UK drill bars.',
    });
    const srcBExec = await workflows.execute('research-source-collection', {
      kind: 'changelog',
      uri: 'https://suno.com/changelog/v6.1',
      title: 'Suno v6.1 Release Notes',
      sourceText: 'v6.1 confirms portamento 808 sub-bass descriptors retain glide envelope consistency.',
    });
    expect(srcAExec.status).toBe('success');
    expect(srcBExec.status).toBe('success');
    const srcA = (srcAExec.output as { readonly source: { readonly vaultPath: string } }).source;
    const srcB = (srcBExec.output as { readonly source: { readonly vaultPath: string } }).source;

    // 4. Evidence extraction (linked to same run so synthesis groups them)
    const evAExec = await workflows.execute('research-evidence-extraction', {
      sourceRef: srcA.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'Portamento 808 sub-bass cues preserve smooth pitch slides',
      interpretation: 'Use explicit portamento 808 sub-bass descriptor in Suno v6 custom style prompts.',
      claimTopic: 'suno.808-glide',
      claimValue: { strategy: 'portamento-808' },
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { sourceType: 'official', takesObserved: 6 },
      uncertaintyNote: 'Verified at 138-142 BPM UK drill; slower halftime untested.',
      researchRunId: initOut.run.id,
    });
    const evBExec = await workflows.execute('research-evidence-extraction', {
      sourceRef: srcB.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'portamento 808 sub-bass descriptors retain glide envelope consistency',
      interpretation: 'Use explicit portamento 808 sub-bass descriptor in Suno v6 custom style prompts.',
      claimTopic: 'suno.808-glide',
      claimValue: { strategy: 'portamento-808' },
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { sourceType: 'changelog', takesObserved: 4 },
      uncertaintyNote: 'Requires clean custom mode syntax.',
      researchRunId: initOut.run.id,
    });
    expect(evAExec.status).toBe('success');
    expect(evBExec.status).toBe('success');
    const evA = (evAExec.output as { readonly evidence: { readonly id: string } }).evidence;

    // 8. Deterministic Synthesis groups both run evidences -> one finding (>0.75 corroborated!)
    const synthExec = await workflows.execute('research-synthesis', {
      researchRunId: initOut.run.id,
    });
    expect(synthExec.status).toBe('success');
    const synthOut = synthExec.output as {
      readonly synthesis: { readonly findings: readonly { readonly id: string; readonly vaultPath: string; readonly confidence: number }[] };
    };
    expect(synthOut.synthesis.findings).toHaveLength(1);
    const synthesizedFinding = synthOut.synthesis.findings[0]!;
    expect(synthesizedFinding.confidence).toBeGreaterThan(0.75);

    // Re-running synthesis must be idempotent (0 duplicate findings)
    const synthAgain = await workflows.execute('research-synthesis', { researchRunId: initOut.run.id });
    expect((synthAgain.output as { readonly synthesis: { readonly findings: unknown[] } }).synthesis.findings).toHaveLength(0);

    // 5 & 6. Explicit conflicting finding creation + Contradiction detection workflow
    const srcC = await research.registerSource({
      kind: 'observation',
      uri: 'studio://log/808-outlier',
      title: 'Studio Outlier Observation',
      sourceText: 'In one studio take generic bass outperformed portamento cues.',
    });
    const evC = await research.recordEvidence({
      sourceRef: srcC.vaultPath,
      specialist: 'negative-prompt-failure-mode-researcher',
      verbatimQuote: 'generic bass outperformed portamento cues',
      interpretation: 'Conflicting outlier preferring generic bass tag.',
      claimTopic: 'suno.808-glide',
      claimValue: { strategy: 'generic-bass' },
      modelTag: 'suno-v6',
      confidence: 0.7,
      confidenceInputs: { n: 1 },
      uncertaintyNote: 'Single isolated outlier.',
    });
    const conflictFindExec = await workflows.execute('research-finding-creation', {
      evidenceIds: [evC.id],
      claimTopic: 'suno.808-glide',
      claimValue: { strategy: 'generic-bass' },
      interpretation: 'Single outlier claiming generic bass beats portamento.',
      uncertaintyNote: 'Unverified single take.',
      modelTag: 'suno-v6',
    });
    expect(conflictFindExec.status).toBe('success');
    const conflictFinding = (
      conflictFindExec.output as {
        readonly finding: {
          readonly id: string;
          readonly vaultPath: string;
          readonly contradictions: readonly { readonly id: string }[];
        };
      }
    ).finding;
    expect(conflictFinding.contradictions.length).toBeGreaterThanOrEqual(1);

    const contrDetect = await workflows.execute('research-contradiction-detection', {
      findingPathOrId: conflictFinding.vaultPath,
      resolveContradictionId: conflictFinding.contradictions[0]!.id,
      resolveMethod: 'manual',
      resolveReason: 'Corroborated Suno official docs/changelog win over single studio outlier',
      actor: 'blago',
    });
    expect(contrDetect.status).toBe('success');
    expect((contrDetect.output as { readonly openContradictions: unknown[] }).openContradictions).toHaveLength(0);

    // 7. Verification workflow
    const verifyExec = await workflows.execute('research-verification', {
      findingPathOrId: synthesizedFinding.vaultPath,
    });
    expect(verifyExec.status).toBe('success');
    const ver = (verifyExec.output as { readonly verification: { readonly ok: boolean; readonly verificationStatus: string } }).verification;
    expect(ver.ok).toBe(true);
    expect(ver.verificationStatus).toBe('verified');

    // 9. Brief generation workflow
    const briefExec = await workflows.execute('research-brief-generation', {
      questionPathOrId: initOut.question.vaultPath,
      title: 'Brief: Suno v6 Portamento Sub-Bass Synthesis',
    });
    expect(briefExec.status).toBe('success');
    const brief = (briefExec.output as { readonly brief: { readonly vaultPath: string; readonly evidenceIds: string[] } }).brief;
    expect(brief.evidenceIds).toContain(evA.id);

    // Validate all created entities against strict OS3 research schemas & cross-references
    const targetExists = createVaultTargetChecker(db);
    for (const vp of [initOut.question.vaultPath, initOut.run.vaultPath, srcA.vaultPath, synthesizedFinding.vaultPath, brief.vaultPath]) {
      const doc = await vault.read(vp);
      const schemaRes = validateResearchVaultDocument(vp, doc.rawContent, { targetExists, strictProvenance: true });
      expect(schemaRes.ok, `${vp}: ${JSON.stringify(schemaRes.issues)}`).toBe(true);
    }

    // 10. Human review & canonical promotion workflow (pauses at approvalGate, blocks unapproved/self-approval, succeeds after human approve)
    const paused = await workflows.execute('research-human-review-promotion', {
      findingPathOrId: synthesizedFinding.vaultPath,
      targetSlug: 'suno-v6-portamento-808-canon',
      canonicalTitle: 'Suno v6 Portamento 808 Canonical Rule',
      humanApprover: 'blago',
      decisionReason: 'Verified multi-source docs + resolved outlier conflict',
    });
    expect(paused.status).toBe('awaiting_approval');
    expect(paused.pendingApprovalId).toBeTruthy();

    db.decideApproval({
      approvalId: paused.pendingApprovalId!,
      decision: 'approved',
      approver: 'blago',
      reason: 'Human operator reviewed and approved promotion',
    });

    const promotedExec = await workflows.execute(
      'research-human-review-promotion',
      {
        findingPathOrId: synthesizedFinding.vaultPath,
        targetSlug: 'suno-v6-portamento-808-canon',
        canonicalTitle: 'Suno v6 Portamento 808 Canonical Rule',
        humanApprover: 'blago',
        decisionReason: 'Verified multi-source docs + resolved outlier conflict',
      },
      { stepApprovals: { human_promote: paused.pendingApprovalId! } },
    );
    expect(promotedExec.status).toBe('success');
    const promotedOut = promotedExec.output as { readonly promoted: { readonly vaultPath: string } };
    expect(promotedOut.promoted.vaultPath).toBe('02_KNOWLEDGE/CANONICAL/KNOW-suno-v6-portamento-808-canon.md');
  });

  it('2. integrates DAW Brain docs, plugins, DSP research, audio references, techniques & compatibility while keeping docs separate from installation truth', async () => {
    const { db, vault, dawIntegrator } = await createFixture();

    // Vendor doc claiming hostInstalledVerified=true MUST be rejected strictly!
    await expect(
      dawIntegrator.ingestDawResearch({
        category: 'plugin_documentation',
        sourceKind: 'doc',
        evidenceTier: 'official_vendor_doc',
        uri: 'https://www.fabfilter.com/help/pro-q',
        sourceTitle: 'FabFilter Pro-Q 3 Manual',
        sourceText: 'FabFilter Pro-Q 3 supports Linear Phase and Natural Phase dynamic EQ bands.',
        verbatimQuote: 'Linear Phase and Natural Phase dynamic EQ bands',
        interpretation: 'Pro-Q 3 supports dynamic linear phase bands per vendor manual.',
        uncertaintyNote: 'Manual reference only; local VST3 installation requires host scan.',
        claimTopic: 'daw.plugin.proq3-modes',
        claimValue: ['Zero Latency', 'Natural Phase', 'Linear Phase'],
        hostScope: 'fl-studio-2025-producer',
        confidence: 0.9,
        confidenceInputs: { officialManual: true },
        hostInstalledVerified: true,
        pluginMetadata: {
          pluginName: 'FabFilter Pro-Q 3',
          pluginFormat: 'vst3',
          vendor: 'FabFilter',
          category: 'eq',
          editionRequirement: 'third-party-licensed',
        },
      }),
    ).rejects.toThrow(/official_vendor_doc alone cannot assert host_installed_verified=true/i);

    const dawRes = await dawIntegrator.ingestDawResearch({
      category: 'daw_documentation',
      sourceKind: 'doc',
      evidenceTier: 'official_vendor_doc',
      uri: 'https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/midi_scripting.htm',
      sourceTitle: 'FL Studio MIDI Controller Scripting Docs',
      sourceText: 'FL Studio MIDI controller Python scripts expose mixer.setTrackVolume and transport callbacks.',
      verbatimQuote: 'expose mixer.setTrackVolume and transport callbacks',
      interpretation: 'FL Studio controller Python API allows mixer volume and transport scripting.',
      uncertaintyNote: 'Requires virtual MIDI loopback port configuration on Windows 11.',
      claimTopic: 'daw.fl2025.midi-scripting',
      claimValue: { mixerVolume: true, directPluginLoad: false },
      hostScope: 'fl-studio-2025-producer',
      confidence: 0.9,
      confidenceInputs: { vendorDoc: true },
    });

    const plugRes = await dawIntegrator.ingestDawResearch({
      category: 'plugin_documentation',
      sourceKind: 'doc',
      evidenceTier: 'official_vendor_doc',
      uri: 'https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Fruity%20Limiter.htm',
      sourceTitle: 'Fruity Limiter Official Manual',
      sourceText: 'Fruity Limiter provides Attack, Release, Ahead lookahead ceiling and compressor ratio controls.',
      verbatimQuote: 'Attack, Release, Ahead lookahead ceiling and compressor ratio controls',
      interpretation: 'Stock Fruity Limiter included across Producer Edition+ for true-peak lookahead ceiling.',
      uncertaintyNote: 'Manual specification; actual session slot insertion confirmed via FLP or host scan.',
      claimTopic: 'daw.plugin.fruity-limiter',
      claimValue: { stockIncluded: 'producer', lookahead: true },
      hostScope: 'fl-studio-2025-producer',
      confidence: 0.9,
      confidenceInputs: { officialManual: true },
      hostInstalledVerified: false,
      pluginMetadata: {
        pluginName: 'Fruity Limiter',
        pluginFormat: 'FL Native',
        vendor: 'Image-Line',
        category: 'limiter',
        editionRequirement: 'Producer Edition+',
      },
    });

    const dspRes = await dawIntegrator.ingestDawResearch({
      category: 'dsp_research',
      sourceKind: 'doc',
      evidenceTier: 'dsp_measurement',
      uri: 'https://tech.xyp3rn.local/dsp/sub-bass-group-delay',
      sourceTitle: 'Linear vs Minimum Phase High-Pass Group Delay',
      sourceText: 'Steep minimum-phase 48 dB/oct sub-bass high-pass filters increase peak crest factor via group delay.',
      verbatimQuote: 'Steep minimum-phase 48 dB/oct sub-bass high-pass filters increase peak crest factor',
      interpretation: 'Prefer gentle 12-18 dB/oct sub filters unless linear-phase pre-ringing budget is verified.',
      uncertaintyNote: 'Measured on 45 Hz sine+transient composite test signals at 44.1 kHz.',
      claimTopic: 'dsp.sub-hpf.slope',
      claimValue: { recommendedSlopeDbOct: 12 },
      hostScope: 'model-agnostic',
      confidence: 0.85,
      confidenceInputs: { dspTrials: 12 },
      dspMetadata: {
        category: 'equalization',
        acousticPrinciple: 'Group delay near cutoff amplifies instantaneous sub-bass peak excursion.',
      },
    });

    const refRes = await dawIntegrator.ingestDawResearch({
      category: 'audio_engineering_reference',
      sourceKind: 'ingested',
      evidenceTier: 'independent_benchmark',
      uri: 'records://x3lius/mix-rubric.yaml',
      sourceTitle: 'X3LIUS Dark Trap Master Rubric',
      sourceText: 'Dark trap master target integrates -9.5 to -7.5 LUFS with ceiling <= -1.0 dBTP.',
      verbatimQuote: '-9.5 to -7.5 LUFS with ceiling <= -1.0 dBTP',
      interpretation: 'X3LIUS masters target competitive club loudness within -1.0 dBTP streaming safety.',
      uncertaintyNote: 'Genre-specific to dense dark trap & UK drill masters.',
      claimTopic: 'audio.master.lufs-target',
      claimValue: { minLufs: -9.5, maxLufs: -7.5, maxDbtp: -1.0 },
      hostScope: 'model-agnostic',
      confidence: 0.92,
      confidenceInputs: { referenceCorpus: 18 },
      mixRefMetadata: {
        stage: 'master',
        targetLufsMin: -9.5,
        targetLufsMax: -7.5,
        maxTruePeakDbtp: -1.0,
      },
    });

    const techRes = await dawIntegrator.ingestDawResearch({
      category: 'production_technique',
      sourceKind: 'observation',
      evidenceTier: 'studio_observation',
      uri: 'studio://session/baritone-mud-carve',
      sourceTitle: 'Baritone Vocal 280 Hz Dynamic Cut',
      sourceText: 'Applying -2.5 dB dynamic bell attenuation at 280 Hz clears low-mid masking on baritone hooks.',
      verbatimQuote: '-2.5 dB dynamic bell attenuation at 280 Hz clears low-mid masking',
      interpretation: 'Dynamic low-mid attenuation preserves fundamental warmth on sustained notes while carving congestion.',
      uncertaintyNote: 'Tuned to X3LIUS baritone timbre; re-evaluate on thinner vocalists.',
      claimTopic: 'technique.vocal.low-mid-carve',
      claimValue: { centerHz: 280, cutDb: -2.5 },
      hostScope: 'fl-studio-2025-producer',
      confidence: 0.85,
      confidenceInputs: { studioSessions: 5 },
    });

    const compatRes = await dawIntegrator.ingestDawResearch({
      category: 'daw_compatibility_finding',
      sourceKind: 'observation',
      evidenceTier: 'observed_host_probe',
      uri: 'host://win11/fl-studio-2025-producer/harmor-probe',
      sourceTitle: 'FL Studio 2025 Producer Edition Edition Probe',
      sourceText: 'Observed FL Studio 2025 Producer Edition loads Harmor and Pitcher only in Trial mode unless Signature+ unlocked.',
      verbatimQuote: 'loads Harmor and Pitcher only in Trial mode unless Signature+ unlocked',
      interpretation: 'Do not schedule Harmor/Pitcher dependencies as unlocked without verified Signature+ license.',
      uncertaintyNote: 'Verified on FL Studio 25.1.6.4997 Producer Edition.',
      claimTopic: 'daw.fl2025.producer-exclusions',
      claimValue: { harmor: 'excluded_by_edition', pitcher: 'excluded_by_edition' },
      hostScope: 'fl-studio-2025-producer',
      confidence: 0.98,
      confidenceInputs: { realHostBinaryCheck: true },
      hostInstalledVerified: true,
    });

    const checker = createVaultTargetChecker(db);
    for (const res of [dawRes, plugRes, dspRes, refRes, techRes, compatRes]) {
      expect(res.stagedReferencePath).toBeTruthy();
      expect(res.dawCandidateTargetPath?.startsWith('10_DAW_BRAIN/')).toBe(true);
      expect(res.dawKnowledgeVaultPath).toBeNull();
      const doc = await vault.read(res.stagedReferencePath!);
      const val = await vault.validate(res.stagedReferencePath!, { requireSchema: true });
      expect(val.ok, `${res.stagedReferencePath}: ${JSON.stringify(val.issues)}`).toBe(true);
      const rVal = validateResearchVaultDocument(res.source.vaultPath, (await vault.read(res.source.vaultPath)).rawContent, {
        targetExists: checker,
      });
      expect(rVal.ok).toBe(true);
      expect(doc.frontmatter.evidence_tier).toBe(res.evidenceTier);
    }

    const plugDoc = await vault.read(plugRes.stagedReferencePath!);
    expect(plugDoc.frontmatter.host_installed_verified).toBe(false);
    expect(plugRes.limitations.some((l) => l.includes('unverified until observed_host_probe'))).toBe(true);

    // Promote DSP research after corroboration + explicit human approval gate
    const appr = db.queueApproval({
      itemType: 'vault_promotion',
      itemId: dspRes.finding.id,
      proposer: 'research-orchestrator',
      request: { stagedVaultPath: dspRes.stagedReferencePath },
    });
    db.decideApproval({
      approvalId: appr.id,
      decision: 'approved',
      approver: 'blago',
      reason: 'Corroborated DSP measurement approved for 10_DAW_BRAIN/DSP_CONCEPTS',
    });
    const promotedDsp = await dawIntegrator.promoteStagedDawReference({
      stagedVaultPath: dspRes.stagedReferencePath!,
      approvalId: appr.id,
      confidenceOverride: 0.85,
    });
    expect(promotedDsp.vaultPath.startsWith('10_DAW_BRAIN/DSP_CONCEPTS/')).toBe(true);
    expect((await vault.validate(promotedDsp.vaultPath, { requireSchema: true })).ok).toBe(true);
  });

  it('3. safely migrates OS2 Research exports & scans legacy Markdown idempotently, reporting rejected/conflicting/incomplete without deleting legacy data', async () => {
    const { dir, db, vault, research } = await createFixture();

    // Prepare legacy unstructured pre-OS3 markdown notes on disk (must remain byte-for-byte untouched!)
    const legacyDir = join(dir, 'legacy-os2-research');
    const briefsDir = join(legacyDir, '00_Briefs');
    const analysesDir = join(legacyDir, '01_Analyses');
    await fs.mkdir(briefsDir, { recursive: true });
    await fs.mkdir(analysesDir, { recursive: true });

    const legBriefPath = join(briefsDir, 'legacy-on-device-brief.md');
    const legLedgerPath = join(analysesDir, 'legacy-evidence-ledger.md');
    const legSecretPath = join(analysesDir, 'leaked-secret.md');

    const legBriefRaw = '---\ntype: brief\n---\n# On-Device Model Brief\nPre-OS3 brief missing schema and provenance.\n';
    const legLedgerRaw = '# Evidence Ledger\nNo frontmatter or ID present.\n';
    const legSecretRaw = '# Oops\nsupabase key sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef\n';

    await fs.writeFile(legBriefPath, legBriefRaw, 'utf8');
    await fs.writeFile(legLedgerPath, legLedgerRaw, 'utf8');
    await fs.writeFile(legSecretPath, legSecretRaw, 'utf8');

    const shaBefore = {
      brief: createHash('sha256').update(legBriefRaw).digest('hex'),
      ledger: createHash('sha256').update(legLedgerRaw).digest('hex'),
      secret: createHash('sha256').update(legSecretRaw).digest('hex'),
    };

    const scorer: TrialScorer = {
      id: 'x3lius-evaluation',
      score: async (out) => ({
        score: (out as { pass: boolean }).pass ? 0.91 : 0.42,
        inputs: { rubric: 'mix+cohesion' },
      }),
    };
    void scorer;

    // Seed one pre-existing OS3 finding on topic `suno.v6-tempo` to trigger a genuine claim contradiction during migration
    const preSrc = await research.registerSource({
      kind: 'doc',
      uri: 'https://suno.com/docs/tempo-lock',
      title: 'Suno Tempo Baseline',
      sourceText: 'Explicit BPM number locks UK drill tempo in Suno v6.',
    });
    const preEv = await research.recordEvidence({
      sourceRef: preSrc.vaultPath,
      specialist: 'suno-researcher',
      verbatimQuote: 'Explicit BPM number locks UK drill tempo',
      interpretation: 'Explicit 140 BPM keeps tempo locked.',
      claimTopic: 'suno.v6-tempo',
      claimValue: { lockMethod: 'explicit-bpm' },
      modelTag: 'suno-v6',
      confidence: 0.9,
      confidenceInputs: { n: 5 },
      uncertaintyNote: 'Controlled studio test.',
    });
    await research.recordFinding({
      evidenceIds: [preEv.id],
      claimTopic: 'suno.v6-tempo',
      claimValue: { lockMethod: 'explicit-bpm' },
      interpretation: 'Use explicit BPM descriptor.',
      uncertaintyNote: 'Baseline finding.',
      modelTag: 'suno-v6',
    });

    // Construct comprehensive OS2 SQL export with valid, duplicate, rejected, conflicting & incomplete items
    const payload: Os2ResearchExportPayload = {
      exportedAt: '2026-11-20T12:00:00.000Z',
      sourceSystem: 'supabase-os2-export',
      projects: [
        { id: '11111111-1111-1111-1111-111111111111', slug: 'x3lius-suno-v6', title: 'X3LIUS Suno v6 Study', status: 'open' },
        { id: '11111111-1111-1111-1111-111111111199', slug: '', title: '', status: 'open' }, // REJECTED invalid slug/title
      ],
      questions: [
        {
          id: '22222222-2222-2222-2222-222222222221',
          project_id: '11111111-1111-1111-1111-111111111111',
          question: 'Does half-time phrasing prevent tempo drift on dark trap beats?',
          intended_use: 'Refine X3LIUS dark trap prompt grammar',
          urls: ['https://suno.com/docs/v6-rhythm'],
          specialists: ['suno-researcher'],
          status: 'answered',
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          project_id: '11111111-1111-1111-1111-111111111111',
          question: 'Pre-AOS-04 open question without intended_use',
          intended_use: null, // INCOMPLETE pre-AOS04
          status: 'abandoned',
        },
      ],
      runs: [
        {
          id: '33333333-3333-3333-3333-333333333331',
          question_id: '22222222-2222-2222-2222-222222222221',
          status: 'success',
          selected_specialists: ['suno-researcher'],
          completed_at: '2026-11-20T12:05:00.000Z',
        },
        {
          id: '33333333-3333-3333-3333-333333333332',
          question_id: '22222222-2222-2222-2222-222222222222',
          status: 'running', // INCOMPLETE unsealed open run
          selected_specialists: ['suno-researcher'],
          completed_at: null,
        },
      ],
      sources: [
        {
          id: '44444444-4444-4444-4444-444444444441',
          kind: 'doc',
          uri: 'https://suno.com/docs/v6-rhythm?utm_source=legacy',
          title: 'Suno v6 Rhythm Guide',
          text: 'Half-time phrasing descriptors stabilize groove pocket without tempo drift.',
          reliability: 0.9,
        },
        {
          id: '44444444-4444-4444-4444-444444444442',
          kind: 'doc',
          uri: 'https://suno.com/docs/v6-rhythm',
          title: 'Duplicate Rhythm Guide',
          text: 'Half-time phrasing descriptors stabilize groove pocket without tempo drift.', // IDEMPOTENT DEDUP
          reliability: 0.9,
        },
        {
          id: '44444444-4444-4444-4444-444444444443',
          kind: 'observation',
          uri: 'studio://take/contradict-bpm',
          title: 'Contradictory BPM Log',
          text: 'Omit BPM numbers completely and rely on groove tags only.',
          reliability: 0.7,
        },
      ],
      evidence: [
        {
          id: '55555555-5555-5555-5555-555555555551',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          research_source_id: '44444444-4444-4444-4444-444444444441',
          specialist: 'suno-researcher',
          claim: 'Use half-time phrasing descriptor for pocket stability.',
          quote: 'Half-time phrasing descriptors stabilize groove pocket',
          uncertainty_note: 'Tested on trap/drill percussion.',
          claim_topic: 'suno.v6-rhythm',
          claim_value: { phrasing: 'half-time' },
          model_tag: 'suno-v6',
          confidence: 0.9,
          confidence_inputs: { takes: 6 },
        },
        {
          id: '55555555-5555-5555-5555-555555555552',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          research_source_id: '44444444-4444-4444-4444-444444444441',
          specialist: 'suno-researcher',
          claim: 'Pre-AOS-04 claim without verbatim quote',
          quote: null, // INCOMPLETE pre-AOS04
          uncertainty_note: null,
          claim_topic: 'suno.v6-legacy',
          claim_value: { legacy: true },
          model_tag: 'suno-v6',
          confidence: 0.7,
          confidence_inputs: { legacyObs: 3 },
        },
        {
          id: '55555555-5555-5555-5555-555555555553',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          research_source_id: '44444444-4444-4444-4444-444444444443',
          specialist: 'negative-prompt-failure-mode-researcher',
          claim: 'Omit BPM numbers completely on suno-v6.',
          quote: 'Omit BPM numbers completely',
          uncertainty_note: 'Conflicting hypothesis.',
          claim_topic: 'suno.v6-tempo',
          claim_value: { lockMethod: 'omit-bpm' },
          model_tag: 'suno-v6',
          confidence: 0.85,
          confidence_inputs: { takes: 2 },
        },
        {
          id: '55555555-5555-5555-5555-555555555599',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          research_source_id: '44444444-4444-4444-4444-444444444441',
          specialist: 'suno-researcher',
          claim: 'Hallucinated quote',
          quote: 'This quote never existed in the source document', // REJECTED quote mismatch
          claim_topic: 'suno.v6-rhythm',
          claim_value: { bad: true },
          model_tag: 'suno-v6',
          confidence: 0.9,
          confidence_inputs: { n: 1 },
        },
      ],
      findings: [
        {
          id: '66666666-6666-6666-6666-666666666661',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          claim: 'Half-time phrasing anchors groove pocket on suno-v6.',
          claim_topic: 'suno.v6-rhythm',
          claim_value: { phrasing: 'half-time' },
          model_tag: 'suno-v6',
          confidence: 0.608,
          uncertainty_note: 'Single official doc source.',
          evidence_ids: ['55555555-5555-5555-5555-555555555551'],
        },
        {
          id: '66666666-6666-6666-6666-666666666662',
          research_run_id: '33333333-3333-3333-3333-333333333331',
          claim: 'Conflicting claim to omit BPM numbers.',
          claim_topic: 'suno.v6-tempo', // CONFLICTING vs pre-existing finding!
          claim_value: { lockMethod: 'omit-bpm' },
          model_tag: 'suno-v6',
          confidence: 0.446,
          evidence_ids: ['55555555-5555-5555-5555-555555555553'],
        },
        {
          id: '66666666-6666-6666-6666-666666666699',
          claim: 'Orphaned finding pointing to rejected evidence',
          claim_topic: 'suno.v6-rhythm',
          claim_value: { broken: true },
          model_tag: 'suno-v6',
          confidence: 0.5,
          evidence_ids: ['55555555-5555-5555-5555-555555555599'], // REJECTED parent evidence
        },
      ],
      contradictions: [
        {
          id: '77777777-7777-7777-7777-777777777799',
          finding_id: '66666666-6666-6666-6666-666666666661',
          target_type: 'canonical_prompt',
          target_id: 'old-canon-1',
          status: 'resolved_manual',
          resolution: '', // REJECTED blank resolution reason
        },
      ],
      experiments: [
        {
          id: '88888888-8888-8888-8888-888888888881',
          finding_id: '66666666-6666-6666-6666-666666666661',
          hypothesis: 'half-time outperforms baseline across 2 trials',
          variant_a: 'baseline',
          variant_b: 'half-time',
          n_per_variant: 1,
          scoring_method: 'x3lius-evaluation',
          status: 'complete',
        },
      ],
      experimentRuns: [
        {
          id: '99999999-9999-9999-9999-999999999991',
          experiment_id: '88888888-8888-8888-8888-888888888881',
          variant: 'a',
          trial: 1,
          output: { pass: false },
          score: 0.42,
          scored_by: 'x3lius-evaluation',
        },
        {
          id: '99999999-9999-9999-9999-999999999992',
          experiment_id: '88888888-8888-8888-8888-888888888881',
          variant: 'b',
          trial: 1,
          output: { pass: true },
          score: 0.91,
          scored_by: 'x3lius-evaluation',
        },
      ],
      researchLinks: [
        { id: 'link-1', question_id: '22222222-2222-2222-2222-222222222221', decision_key: 'F20', role: 'baseline' },
        {
          id: 'link-2',
          question_id: '22222222-2222-2222-2222-222222222221',
          workflow_name: 'x3lius-song-to-suno',
          retracted_reason: 'Superseded by v6 workflow',
        },
      ],
      findingDecisions: [
        {
          finding_id: '66666666-6666-6666-6666-666666666661',
          decision: 'accept',
          decided_by: 'blago',
          decision_reason: 'Accepted into Findings Library after OS2 review',
        },
      ],
    };

    const report1 = await migrateOs2ResearchToOs3({
      payload,
      vault,
      db,
      research,
      legacyMarkdownRootDirs: [legacyDir],
      stageIncompleteLegacyMarkdown: true,
    });

    // Verify all 4 safety classifications are populated accurately
    expect(report1.legacyDataUntouched).toBe(true);
    expect(report1.totals.migratedCount).toBeGreaterThanOrEqual(11);
    expect(report1.totals.rejectedCount).toBeGreaterThanOrEqual(5); // project, quote mismatch, finding, contradiction, secret md
    expect(report1.totals.conflictingCount).toBeGreaterThanOrEqual(1); // suno.v6-tempo contradiction
    expect(report1.totals.incompleteCount).toBeGreaterThanOrEqual(5); // pre-AOS04 question, running run, pre-AOS04 evidence, finding uncertainty, 2 legacy md notes
    expect(report1.rejected.some((r) => r.reasonCode === 'VERBATIM_QUOTE_MISMATCH')).toBe(true);
    expect(report1.rejected.some((r) => r.reasonCode === 'INVALID_OR_SECRET_LEGACY_MARKDOWN')).toBe(true);
    expect(report1.conflicting.some((c) => c.conflictKind === 'claim_contradiction' && c.contradictionPath)).toBe(true);

    // Verify legacy source files on disk were NEVER modified or deleted
    expect(createHash('sha256').update(await fs.readFile(legBriefPath, 'utf8')).digest('hex')).toBe(shaBefore.brief);
    expect(createHash('sha256').update(await fs.readFile(legLedgerPath, 'utf8')).digest('hex')).toBe(shaBefore.ledger);
    expect(createHash('sha256').update(await fs.readFile(legSecretPath, 'utf8')).digest('hex')).toBe(shaBefore.secret);

    // Verify Parity Report & full schema/reference validation on every migrated note
    const parity1 = await verifyResearchMigrationParity({ payload, report: report1, vault, db });
    expect(parity1.ok, `Discrepancies: ${JSON.stringify(parity1.discrepancies)}`).toBe(true);
    expect(parity1.vaultValidationFailed).toEqual([]);
    expect(parity1.unresolvedReferences).toEqual([]);

    const mdReport = formatResearchMigrationReportMarkdown(report1, parity1);
    expect(mdReport).toContain('Parity Verdict:** **PASS (Reconciled)**');
    expect(mdReport).toContain('VERBATIM_QUOTE_MISMATCH');

    // Run migration a SECOND time cleanly -> strictly IDEMPOTENT (0 new Vault files written)
    const report2 = await migrateOs2ResearchToOs3({
      payload,
      vault,
      db,
      research,
      legacyMarkdownRootDirs: [legacyDir],
      stageIncompleteLegacyMarkdown: true,
    });
    expect(report2.totals.migratedCount).toBe(0);
    expect(report2.totals.skippedIdempotentCount).toBeGreaterThanOrEqual(10);
    expect(report2.legacyDataUntouched).toBe(true);
  });
});
