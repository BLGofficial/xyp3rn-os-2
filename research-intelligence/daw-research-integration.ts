import type { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import { serializeFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import { sha256Hex } from '../core/vault-engine/revision.ts';
import type { Os3ResearchEngine, ResearchEvidenceRecord, ResearchFindingRecord, ResearchSourceRecord } from './os3-research-engine.ts';
import type { DawResearchCategory, EvidenceAttributionTier } from './os3-research-types.ts';
import type { ResearchSourceKind } from './sources/verify.ts';

export type DawResearchIngestionInput = {
  readonly category: DawResearchCategory;
  readonly projectSlug?: string | undefined;
  readonly researchRunId?: string | undefined;
  readonly specialist?: string | undefined;
  readonly sourceKind: ResearchSourceKind;
  readonly evidenceTier: EvidenceAttributionTier;
  readonly uri: string;
  readonly sourceTitle: string;
  readonly sourceText: string;
  readonly verbatimQuote: string;
  readonly interpretation: string;
  readonly uncertaintyNote: string;
  readonly claimTopic: string;
  readonly claimValue: unknown;
  readonly hostScope: string;
  readonly confidence: number;
  readonly confidenceInputs: Record<string, unknown>;
  readonly hostInstalledVerified?: boolean | undefined;
  readonly pluginMetadata?: {
    readonly pluginName: string;
    readonly pluginFormat: string;
    readonly vendor: string;
    readonly category: string;
    readonly editionRequirement: string;
  } | undefined;
  readonly dspMetadata?: {
    readonly category: string;
    readonly acousticPrinciple: string;
  } | undefined;
  readonly mixRefMetadata?: {
    readonly stage: 'mix' | 'master';
    readonly targetLufsMin: number;
    readonly targetLufsMax: number;
    readonly maxTruePeakDbtp: number;
  } | undefined;
  readonly actor?: string | undefined;
};

export type DawResearchIngestionResult = {
  readonly category: DawResearchCategory;
  readonly evidenceTier: EvidenceAttributionTier;
  readonly source: ResearchSourceRecord;
  readonly evidence: ResearchEvidenceRecord;
  readonly finding: ResearchFindingRecord;
  readonly stagedReferencePath: string | null;
  readonly dawCandidateTargetPath: string | null;
  readonly dawKnowledgeVaultPath: string | null;
  readonly limitations: readonly string[];
};

const CATEGORY_TO_SPECIALIST: Readonly<Record<DawResearchCategory, string>> = {
  daw_documentation: 'frontier-tool-scanner-researcher',
  plugin_documentation: 'mix-master-ai-tooling-researcher',
  dsp_research: 'benchmark-scoring-methodology-researcher',
  audio_engineering_reference: 'mix-master-ai-tooling-researcher',
  production_technique: 'composition-arrangement-researcher',
  daw_compatibility_finding: 'model-version-changelog-researcher',
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'daw-item';

/**
 * Integrates Research Intelligence workflows with DAW Brain (`10_DAW_BRAIN/`),
 * preserving strict source attribution and epistemic separation:
 * - Official vendor documentation (`evidenceTier === 'official_vendor_doc'`) NEVER sets
 *   `host_installed_verified = true` unless observed by an actual host probe.
 * - All 6 DAW Brain categories (DAW docs, plugin docs, DSP research, audio refs,
 *   production techniques, compatibility findings) flow through the scientific
 *   Source -> Verbatim Evidence -> Confidence-Capped Finding -> Contradiction Engine chain.
 */
export class DawResearchIntegrator {
  readonly #vault: VaultEngine;
  readonly #research: Os3ResearchEngine;

  constructor(options: { readonly vault: VaultEngine; readonly research: Os3ResearchEngine }) {
    this.#vault = options.vault;
    this.#research = options.research;
  }

  async ingestDawResearch(input: DawResearchIngestionInput): Promise<DawResearchIngestionResult> {
    if (input.hostInstalledVerified === true && input.evidenceTier === 'official_vendor_doc') {
      throw new Error(
        'DAW research integration rejected: official_vendor_doc alone cannot assert host_installed_verified=true (requires observed_host_probe)',
      );
    }
    if (input.evidenceTier === 'inference_unverified') {
      throw new Error(
        'DAW research integration rejected: unverified inferences cannot be ingested as primary source evidence',
      );
    }

    const limitations: string[] = [];
    if (input.evidenceTier === 'official_vendor_doc') {
      limitations.push(
        'Documented in vendor/official docs only; local host binary installation and edition license remain unverified until observed_host_probe.',
      );
    }
    if (input.category === 'daw_compatibility_finding' && input.evidenceTier === 'community_claim') {
      limitations.push('Community compatibility claim requires local Producer Edition or REAPER host probe corroboration.');
    }

    const specialist = input.specialist ?? CATEGORY_TO_SPECIALIST[input.category];

    const source = await this.#research.registerSource({
      kind: input.sourceKind,
      uri: input.uri,
      title: input.sourceTitle,
      sourceText: input.sourceText,
      dawCategory: input.category,
      evidenceTier: input.evidenceTier,
      domainOverride: input.category === 'production_technique' ? 'RECORDS' : 'TECH',
      actor: input.actor ?? specialist,
    });

    const evidence = await this.#research.recordEvidence({
      sourceRef: source.vaultPath,
      specialist,
      verbatimQuote: input.verbatimQuote,
      interpretation: input.interpretation,
      claimTopic: input.claimTopic,
      claimValue: input.claimValue,
      modelTag: input.hostScope,
      confidence: input.confidence,
      confidenceInputs: {
        ...input.confidenceInputs,
        evidence_tier: input.evidenceTier,
        daw_category: input.category,
        host_installed_verified: Boolean(input.hostInstalledVerified),
      },
      uncertaintyNote: input.uncertaintyNote,
      researchRunId: input.researchRunId,
      evidenceTier: input.evidenceTier,
      dawCategory: input.category,
      hostInstalledVerified: Boolean(input.hostInstalledVerified),
    });

    const finding = await this.#research.recordFinding({
      evidenceIds: [evidence.id],
      claimTopic: input.claimTopic,
      claimValue: input.claimValue,
      interpretation: input.interpretation,
      uncertaintyNote: input.uncertaintyNote,
      modelTag: input.hostScope,
      researchRunId: input.researchRunId,
      dawCategory: input.category,
      evidenceTier: input.evidenceTier,
      actor: input.actor ?? 'research-orchestrator',
    });

    let stagedReferencePath: string | null = null;
    let dawCandidateTargetPath: string | null = null;
    const shortId = sha256Hex(`${input.category}:${input.claimTopic}:${input.hostScope}`).slice(0, 8);
    const now = new Date().toISOString();
    const baseProvenance = {
      origin: 'daw-research-integration',
      category: input.category,
      evidence_tier: input.evidenceTier,
      source_ref: source.vaultPath,
      evidence_ref: evidence.vaultPath,
      finding_ref: finding.vaultPath,
      host_installed_verified: Boolean(input.hostInstalledVerified),
    };

    if (input.category === 'plugin_documentation' && input.pluginMetadata) {
      const fileSlug = `PLG-RES-${shortId}-${slugify(input.pluginMetadata.pluginName)}.md`;
      stagedReferencePath = `03_RESEARCH_INTELLIGENCE/DAW_REFERENCES/${fileSlug}`;
      dawCandidateTargetPath = `10_DAW_BRAIN/PLUGINS/${fileSlug}`;
      const content = serializeFrontmatterDocument(
        {
          schema: 'xyp3rn.daw-plugin/v3',
          id: `plg-res-${shortId}`,
          type: 'plugin',
          title: `Plugin Reference: ${input.pluginMetadata.pluginName}`,
          domain: 'RECORDS',
          sector: '03_RESEARCH_INTELLIGENCE',
          status: 'draft',
          version: 1,
          plugin_format: input.pluginMetadata.pluginFormat,
          vendor: input.pluginMetadata.vendor,
          category: input.pluginMetadata.category,
          edition_requirement: input.pluginMetadata.editionRequirement,
          evidence_tier: input.evidenceTier,
          host_installed_verified: Boolean(input.hostInstalledVerified),
          candidate_target_path: dawCandidateTargetPath,
          finding_ref: finding.vaultPath,
          finding_id: finding.id,
          evidence_ids: [evidence.id],
          source_ref: source.vaultPath,
          confidence: finding.confidence,
          provenance: baseProvenance,
          created_at: now,
          updated_at: now,
          tags: ['xyp3rn', 'os3', 'daw-brain', 'plugin', 'research-backed'],
        },
        [
          `# Plugin Documentation Reference: ${input.pluginMetadata.pluginName}`,
          '',
          `- **Installation Verified Locally:** \`${String(Boolean(input.hostInstalledVerified))}\` (${input.evidenceTier})`,
          `- **Canonical Candidate Target:** \`${dawCandidateTargetPath}\` (awaiting corroboration >= 0.70 + human promotion gate)`,
          `- **Source:** [[${source.vaultPath.replace(/\.md$/, '')}|${source.title}]]`,
          `- **Finding:** [[${finding.vaultPath.replace(/\.md$/, '')}|${finding.id}]]`,
          '',
          '## Verbatim Reference Extract',
          '',
          `> ${input.verbatimQuote.trim()}`,
          '',
          '## Engineering Notes & Uncertainty',
          '',
          input.interpretation.trim(),
          '',
          `_${input.uncertaintyNote.trim()}_`,
        ].join('\n'),
      );
      await this.#vault.write({
        vaultPath: stagedReferencePath,
        content,
        actor: input.actor ?? specialist,
        reason: `Stage documented plugin reference (${input.pluginMetadata.pluginName}) without claiming installation`,
      });
    } else if (input.category === 'dsp_research' && input.dspMetadata) {
      const fileSlug = `DSP-RES-${shortId}-${slugify(input.claimTopic)}.md`;
      stagedReferencePath = `03_RESEARCH_INTELLIGENCE/DAW_REFERENCES/${fileSlug}`;
      dawCandidateTargetPath = `10_DAW_BRAIN/DSP_CONCEPTS/${fileSlug}`;
      const content = serializeFrontmatterDocument(
        {
          schema: 'xyp3rn.dsp-concept/v3',
          id: `dsp-res-${shortId}`,
          type: 'dsp_concept',
          title: `DSP Research: ${source.title}`,
          domain: 'TECH',
          sector: '03_RESEARCH_INTELLIGENCE',
          status: 'draft',
          version: 1,
          category: input.dspMetadata.category,
          acoustic_principle: input.dspMetadata.acousticPrinciple,
          evidence_tier: input.evidenceTier,
          candidate_target_path: dawCandidateTargetPath,
          finding_ref: finding.vaultPath,
          finding_id: finding.id,
          evidence_ids: [evidence.id],
          source_ref: source.vaultPath,
          confidence: finding.confidence,
          provenance: baseProvenance,
          created_at: now,
          updated_at: now,
          tags: ['xyp3rn', 'os3', 'daw-brain', 'dsp', 'research-backed'],
        },
        [
          `# DSP Research Note: ${source.title}`,
          '',
          `- **Principle:** ${input.dspMetadata.acousticPrinciple}`,
          `- **Canonical Candidate Target:** \`${dawCandidateTargetPath}\``,
          `- **Source:** [[${source.vaultPath.replace(/\.md$/, '')}|${source.title}]]`,
          `- **Finding:** [[${finding.vaultPath.replace(/\.md$/, '')}|${finding.id}]]`,
          '',
          '## Verbatim Quote',
          '',
          `> ${input.verbatimQuote.trim()}`,
          '',
          '## Analysis & Limitations',
          '',
          input.interpretation.trim(),
          '',
          `_${input.uncertaintyNote.trim()}_`,
        ].join('\n'),
      );
      await this.#vault.write({
        vaultPath: stagedReferencePath,
        content,
        actor: input.actor ?? specialist,
        reason: `Stage DSP research reference (${shortId})`,
      });
    } else if (input.category === 'audio_engineering_reference' && input.mixRefMetadata) {
      const fileSlug = `MIX-RES-${shortId}-${slugify(input.claimTopic)}.md`;
      stagedReferencePath = `03_RESEARCH_INTELLIGENCE/DAW_REFERENCES/${fileSlug}`;
      dawCandidateTargetPath = `10_DAW_BRAIN/MIX_MASTER_REFS/${fileSlug}`;
      const content = serializeFrontmatterDocument(
        {
          schema: 'xyp3rn.mix-reference/v3',
          id: `mix-res-${shortId}`,
          type: 'mix_reference',
          title: `Audio Reference: ${source.title}`,
          domain: 'RECORDS',
          sector: '03_RESEARCH_INTELLIGENCE',
          status: 'draft',
          version: 1,
          stage: input.mixRefMetadata.stage,
          target_lufs_min: input.mixRefMetadata.targetLufsMin,
          target_lufs_max: input.mixRefMetadata.targetLufsMax,
          max_true_peak_dbtp: input.mixRefMetadata.maxTruePeakDbtp,
          evidence_tier: input.evidenceTier,
          candidate_target_path: dawCandidateTargetPath,
          finding_ref: finding.vaultPath,
          finding_id: finding.id,
          evidence_ids: [evidence.id],
          source_ref: source.vaultPath,
          confidence: finding.confidence,
          provenance: baseProvenance,
          created_at: now,
          updated_at: now,
          tags: ['xyp3rn', 'os3', 'daw-brain', 'mix-reference'],
        },
        [
          `# Audio Engineering Reference: ${source.title}`,
          '',
          `- **Stage:** \`${input.mixRefMetadata.stage}\` · Target: \`${input.mixRefMetadata.targetLufsMin}..${input.mixRefMetadata.targetLufsMax} LUFS\`, max \`${input.mixRefMetadata.maxTruePeakDbtp} dBTP\``,
          `- **Canonical Candidate Target:** \`${dawCandidateTargetPath}\``,
          `- **Source:** [[${source.vaultPath.replace(/\.md$/, '')}|${source.title}]]`,
          `- **Finding:** [[${finding.vaultPath.replace(/\.md$/, '')}|${finding.id}]]`,
          '',
          `> ${input.verbatimQuote.trim()}`,
        ].join('\n'),
      );
      await this.#vault.write({
        vaultPath: stagedReferencePath,
        content,
        actor: input.actor ?? specialist,
        reason: `Stage audio engineering reference (${shortId})`,
      });
    } else if (
      input.category === 'daw_documentation' ||
      input.category === 'daw_compatibility_finding' ||
      input.category === 'production_technique'
    ) {
      const folder =
        input.category === 'daw_documentation' || input.category === 'daw_compatibility_finding'
          ? 'CAPABILITIES'
          : 'WORKFLOWS';
      const prefix =
        input.category === 'daw_documentation' || input.category === 'daw_compatibility_finding'
          ? 'CAP-RES'
          : 'PWF-RES';
      const fileSlug = `${prefix}-${shortId}-${slugify(input.claimTopic)}.md`;
      stagedReferencePath = `03_RESEARCH_INTELLIGENCE/DAW_REFERENCES/${fileSlug}`;
      dawCandidateTargetPath = `10_DAW_BRAIN/${folder}/${fileSlug}`;

      const schema =
        folder === 'CAPABILITIES' ? 'xyp3rn.daw-capability/v3' : 'xyp3rn.production-workflow/v3';
      const content = serializeFrontmatterDocument(
        {
          schema,
          id: `${prefix.toLowerCase()}-${shortId}`,
          type: folder === 'CAPABILITIES' ? 'daw_capability' : 'production_workflow',
          title: `${input.category === 'production_technique' ? 'Technique' : 'DAW Reference'}: ${source.title}`,
          domain: input.category === 'production_technique' ? 'RECORDS' : 'TECH',
          sector: '03_RESEARCH_INTELLIGENCE',
          status: 'draft',
          version: 1,
          ...(folder === 'CAPABILITIES'
            ? {
                capability_id: input.claimTopic,
                permission_tier: input.evidenceTier === 'observed_host_probe' ? 'observe' : 'analyze',
                host_support: {
                  [input.hostScope]: input.category === 'daw_compatibility_finding' ? 'READ_ONLY' : 'SUPPORTED',
                },
              }
            : {
                target_daw: input.hostScope,
                stage: 'mix',
                workflow_steps: ['observe_session', 'extract_evidence', 'apply_manual_or_approved_step'],
              }),
          evidence_tier: input.evidenceTier,
          candidate_target_path: dawCandidateTargetPath,
          finding_ref: finding.vaultPath,
          finding_id: finding.id,
          evidence_ids: [evidence.id],
          source_ref: source.vaultPath,
          confidence: finding.confidence,
          provenance: baseProvenance,
          created_at: now,
          updated_at: now,
          tags: ['xyp3rn', 'os3', 'daw-brain', input.category],
        },
        [
          `# ${source.title}`,
          '',
          `- **Evidence Tier:** \`${input.evidenceTier}\` (distinct from inference)`,
          `- **Canonical Candidate Target:** \`${dawCandidateTargetPath}\``,
          `- **Source:** [[${source.vaultPath.replace(/\.md$/, '')}|${source.title}]]`,
          `- **Finding:** [[${finding.vaultPath.replace(/\.md$/, '')}|${finding.id}]]`,
          '',
          `> ${input.verbatimQuote.trim()}`,
          '',
          input.interpretation.trim(),
          '',
          `_${input.uncertaintyNote.trim()}_`,
        ].join('\n'),
      );
      await this.#vault.write({
        vaultPath: stagedReferencePath,
        content,
        actor: input.actor ?? specialist,
        reason: `Stage ${input.category} note (${shortId})`,
      });
    }

    return {
      category: input.category,
      evidenceTier: input.evidenceTier,
      source,
      evidence,
      finding,
      stagedReferencePath,
      dawCandidateTargetPath,
      dawKnowledgeVaultPath: null,
      limitations,
    };
  }

  /**
   * Promotes a human-approved staged DAW research note into canonical `10_DAW_BRAIN/*`
   * strictly through `VaultEngine.promote()` (enforcing human approval, >=0.70 confidence, and provenance).
   */
  async promoteStagedDawReference(input: {
    readonly stagedVaultPath: string;
    readonly approvalId: string;
    readonly confidenceOverride?: number | undefined;
  }) {
    const doc = await this.#vault.read(input.stagedVaultPath);
    const fm = doc.frontmatter as Record<string, unknown>;
    const targetPath = String(fm.candidate_target_path ?? '').trim();
    if (!targetPath.startsWith('10_DAW_BRAIN/')) {
      throw new Error(`Staged note "${input.stagedVaultPath}" lacks a valid 10_DAW_BRAIN target`);
    }

    const {
      schema,
      id,
      title,
      domain,
      status: _status,
      sector: _sector,
      provenance: _prov,
      source_sha256: _sha,
      evidence_ids: _eids,
      confidence: _conf,
      tags,
      ...extraMetadata
    } = fm;

    return this.#vault.promote({
      approvalId: input.approvalId,
      targetVaultPath: targetPath,
      entityId: String(id),
      schema: String(schema),
      title: String(title),
      body: doc.body,
      domain: String(domain ?? 'TECH'),
      sourceRefs: [String(fm.source_ref ?? input.stagedVaultPath)],
      evidenceIds: Array.isArray(fm.evidence_ids) ? fm.evidence_ids.map(String) : undefined,
      confidence: input.confidenceOverride ?? Number(fm.confidence ?? 0.8),
      provenance: `finding:${String(fm.finding_id ?? id)}`,
      tags: Array.isArray(tags) ? tags.map(String) : ['xyp3rn', 'daw-brain', 'canonical'],
      metadata: extraMetadata,
    });
  }
}
